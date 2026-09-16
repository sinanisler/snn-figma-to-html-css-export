import type { Format, RawAsset } from '../shared/types';
import { fontLinkTags, googleFontsUrl } from './fonts';
import { escapeHtml, pascalCase } from './format';
import type { IRDocument, IRLink } from './ir';
import { assetResolver, cssText, indent, renderMarkup, type AssetMode, type Dialect, type Styling } from './emit';

export type OutLang = 'html' | 'css' | 'jsx' | 'vue' | 'svelte' | 'json' | 'js';

export type OutFile = {
	/** Path inside a zip; null for views that are not files (e.g. body markup only). */
	path: string | null;
	label: string;
	lang: OutLang;
	content: string;
	/** Page index, or null for files shared by every page. */
	page: number | null;
	/** A complete HTML document (skipped in Dev Mode, which shows fragments). */
	document?: boolean;
};

export type GenerateOptions = {
	format: Format;
	assets: Map<string, RawAsset>;
	assetMode: AssetMode;
	googleFonts: boolean;
	inlineSvg: boolean;
	/** Tailwind HTML loads the browser build from a CDN unless a starter project compiles it. */
	tailwindCdn?: boolean;
};

export const FORMAT_LABELS: Record<Format, string> = {
	html: 'HTML + CSS',
	tailwind: 'HTML + Tailwind',
	react: 'React + CSS',
	'react-tailwind': 'React + Tailwind',
	vue: 'Vue + CSS',
	'vue-tailwind': 'Vue + Tailwind',
	svelte: 'Svelte + CSS',
	email: 'Email HTML (inline styles)',
};

const TAILWIND_CDN = '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>';

export function formatParts(format: Format): { framework: 'html' | 'react' | 'vue' | 'svelte' | 'email'; styling: Styling } {
	const styling: Styling = format.includes('tailwind') ? 'tailwind' : 'css';
	const framework = format === 'tailwind' ? 'html' : (format.split('-')[0] as 'html' | 'react' | 'vue' | 'svelte' | 'email');
	return { framework, styling };
}

export function componentName(doc: IRDocument, page: number): string {
	return pascalCase(doc.pages[page].name);
}

/** href for a prototype link rendered on page `from`. */
function hrefFor(doc: IRDocument, link: IRLink, from: number, hashRoutes: boolean): string {
	if (link.url) return link.url;
	if (link.unresolved || link.page === undefined) return '#';
	const page = doc.pages[link.page];
	const anchor = link.anchor?.attrs.id;
	if (hashRoutes) {
		if (link.page === from) return anchor ? `#${anchor}` : '#/';
		return page.slug === 'index' ? '#/' : `#/${page.slug}`;
	}
	if (link.page === from) return anchor ? `#${anchor}` : '#';
	return `${page.slug}.html${anchor ? `#${anchor}` : ''}`;
}

export function htmlDocument(title: string, head: string[], body: string, bodyAttrs = ''): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
${indent(head.filter(Boolean).join('\n'), 2)}
</head>
<body${bodyAttrs}>
${indent(body, 2)}
</body>
</html>
`;
}

export function generate(doc: IRDocument, opts: GenerateOptions): OutFile[] {
	const { framework, styling } = formatParts(opts.format);
	const files: OutFile[] = [];
	const fontUrl = opts.googleFonts ? googleFontsUrl(doc.fonts) : null;
	const hashRoutes = framework === 'react' || framework === 'vue' || framework === 'svelte';
	const dialect: Dialect = framework === 'react' ? 'jsx' : framework === 'email' ? 'email' : 'html';
	const assetPrefix = hashRoutes ? '/assets/' : 'assets/';
	const resolve = assetResolver(opts.assets, opts.assetMode, assetPrefix);
	const markup = (page: number) =>
		renderMarkup(doc, page, {
			assets: opts.assets,
			assetMode: opts.assetMode,
			assetPrefix,
			inlineSvg: opts.inlineSvg,
			dialect,
			styling,
			linkHref: (link) => hrefFor(doc, link, page, hashRoutes),
		});

	if (framework === 'email') {
		doc.pages.forEach((p, i) => {
			const head = [fontLinkTags(fontUrl)];
			const body = markup(i);
			files.push({ path: `${p.slug}.html`, label: doc.pages.length > 1 ? `${p.slug}.html` : 'HTML file', lang: 'html', content: htmlDocument(p.title, head, body, ' style="margin: 0;"'), page: i, document: true });
		});
		return files;
	}

	if (framework === 'html') {
		const tailwind = styling === 'tailwind';
		const cdn = tailwind && opts.tailwindCdn !== false;
		const css = cssText(doc, resolve, { tailwind: tailwind && !cdn, tailwindVarsOnly: cdn });
		doc.pages.forEach((p, i) => {
			const body = markup(i);
			const styles =
				opts.assetMode === 'files'
					? '<link rel="stylesheet" href="styles.css">'
					: `<style>\n${indent(css.trimEnd(), 2)}\n</style>`;
			const head = [fontLinkTags(fontUrl), styles, cdn ? TAILWIND_CDN : ''];
			const multi = doc.pages.length > 1;
			files.push({ path: `${p.slug}.html`, label: multi ? `${p.slug}.html` : 'HTML file', lang: 'html', content: htmlDocument(p.title, head, body), page: i, document: true });
			files.push({ path: null, label: 'HTML', lang: 'html', content: body + '\n', page: i });
		});
		files.push({ path: 'styles.css', label: 'CSS', lang: 'css', content: css, page: null });
		return files;
	}

	const css = cssText(doc, resolve, { tailwind: styling === 'tailwind', fontImport: fontUrl });
	doc.pages.forEach((p, i) => {
		const name = componentName(doc, i);
		const body = markup(i);
		if (framework === 'react') {
			const root = doc.pages[i].roots.length > 1 ? `<>\n${indent(body, 2)}\n</>` : body;
			const content = `import '../styles.css';\n\nexport default function ${name}() {\n  return (\n${indent(root, 4)}\n  );\n}\n`;
			files.push({ path: `src/pages/${name}.jsx`, label: `${name}.jsx`, lang: 'jsx', content, page: i });
		} else if (framework === 'vue') {
			files.push({ path: `src/pages/${name}.vue`, label: `${name}.vue`, lang: 'vue', content: `<template>\n${indent(body, 2)}\n</template>\n`, page: i });
		} else {
			const escaped = body.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));
			files.push({ path: `src/pages/${name}.svelte`, label: `${name}.svelte`, lang: 'svelte', content: escaped + '\n', page: i });
		}
	});
	files.push({ path: 'src/styles.css', label: 'CSS', lang: 'css', content: css, page: null });
	return files;
}

/** Self-contained HTML for the in-plugin preview; link clicks are reported to the parent window. */
export function previewDocument(doc: IRDocument, page: number, assets: Map<string, RawAsset>, inlineSvg: boolean): string {
	const files = generate(doc, { format: 'html', assets, assetMode: 'inline', googleFonts: true, inlineSvg });
	const html = files.find((f) => f.page === page && f.document)?.content ?? '';
	const script = `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(h.charAt(0)==='#'&&h.length>1){return;}e.preventDefault();parent.postMessage({previewNav:h},'*');});</script>`;
	return html.replace('</body>', `${script}\n</body>`);
}

const CODEGEN_LANG: Record<OutLang, CodegenLanguage> = {
	html: 'HTML',
	css: 'CSS',
	jsx: 'JAVASCRIPT',
	vue: 'HTML',
	svelte: 'HTML',
	json: 'JSON',
	js: 'JAVASCRIPT',
};

type CodegenLanguage = 'HTML' | 'CSS' | 'JAVASCRIPT' | 'JSON';

export function codegenSections(files: OutFile[]): { title: string; code: string; language: CodegenLanguage }[] {
	return files
		.filter((f) => (f.page === 0 || f.page === null) && !f.document)
		.map((f) => ({ title: f.label, code: f.content, language: CODEGEN_LANG[f.lang] }));
}

import type { Format, RawAsset } from '../shared/types';
import { extractComponents, type ComponentDef, type ComponentSet } from './components';
import { fontLinkTags, googleFontsUrl } from './fonts';
import { escapeHtml, pascalCase } from './format';
import { walk, type IRDocument, type IRLink, type IRNode } from './ir';
import { assetResolver, cssText, indent, renderNodes, type AssetMode, type Dialect, type Styling, type Templating } from './emit';

export type OutLang = 'html' | 'css' | 'jsx' | 'tsx' | 'vue' | 'svelte' | 'json' | 'js' | 'ts';

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

/** Where framework files go: a Vite app (src/…) or a Next.js app (views/, components/, app/). */
export type Layout = 'vite' | 'next';

export type GenerateOptions = {
	format: Format;
	assets: Map<string, RawAsset>;
	assetMode: AssetMode;
	googleFonts: boolean;
	inlineSvg: boolean;
	/** Tailwind HTML loads the browser build from a CDN unless a starter project compiles it. */
	tailwindCdn?: boolean;
	/** React/Vue/Svelte: component instances become component files with props. */
	components?: boolean;
	typescript?: boolean;
	/** A variable mode named "dark" follows the operating system. */
	systemDark?: boolean;
	layout?: Layout;
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

export const TAILWIND_CDN = '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>';

export type Framework = 'html' | 'react' | 'vue' | 'svelte' | 'email';

export function formatParts(format: Format): { framework: Framework; styling: Styling } {
	const styling: Styling = format.includes('tailwind') ? 'tailwind' : 'css';
	const framework = format === 'tailwind' ? 'html' : (format.split('-')[0] as Framework);
	return { framework, styling };
}

export function componentName(doc: IRDocument, page: number): string {
	return pascalCase(doc.pages[page].name);
}

export type Paths = { pages: string; components: string; css: string; cssImport: string | null };

export function pathsFor(layout: Layout = 'vite'): Paths {
	return layout === 'next'
		? { pages: 'views/', components: 'components/', css: 'app/globals.css', cssImport: null }
		: { pages: 'src/pages/', components: 'src/components/', css: 'src/styles.css', cssImport: '../styles.css' };
}

/** File extension for a framework file. */
export function extFor(framework: Framework, typescript = false): string {
	if (framework === 'react') return typescript ? 'tsx' : 'jsx';
	return framework;
}

/** href for a prototype link rendered on page `from`. */
export function hrefFor(doc: IRDocument, link: IRLink, from: number, routing: 'files' | 'hash' | 'path'): string {
	if (link.url) return link.url;
	if (link.unresolved || link.page === undefined) return '#';
	const page = doc.pages[link.page];
	const anchor = link.anchor?.attrs.id;
	if (routing === 'hash') {
		if (link.page === from) return anchor ? `#${anchor}` : '#/';
		return page.slug === 'index' ? '#/' : `#/${page.slug}`;
	}
	if (routing === 'path') {
		const path = page.slug === 'index' ? '/' : `/${page.slug}`;
		if (link.page === from) return anchor ? `#${anchor}` : path;
		return `${path}${anchor ? `#${anchor}` : ''}`;
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
	const routing = framework === 'html' || framework === 'email' ? 'files' : opts.layout === 'next' ? 'path' : 'hash';
	const dialect: Dialect = framework === 'react' ? 'jsx' : framework === 'email' ? 'email' : 'html';
	const templating: Templating | undefined = framework === 'vue' || framework === 'svelte' ? framework : undefined;
	const assetPrefix = routing === 'files' ? 'assets/' : '/assets/';
	const resolve = assetResolver(opts.assets, opts.assetMode, assetPrefix);
	const svgSeq = { n: 0 };
	const base = {
		assets: opts.assets,
		assetMode: opts.assetMode,
		assetPrefix,
		inlineSvg: opts.inlineSvg,
		dialect,
		styling,
		templating,
		svgSeq,
	};
	const markup = (page: number, extra: Partial<Parameters<typeof renderNodes>[2]> = {}) =>
		renderNodes(doc, doc.pages[page].roots, { ...base, linkHref: (link) => hrefFor(doc, link, page, routing), ...extra });

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
		const css = cssText(doc, resolve, { tailwind: tailwind && !cdn, tailwindVarsOnly: cdn, systemDark: opts.systemDark });
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

	const paths = pathsFor(opts.layout);
	const ts = opts.typescript === true;
	const ext = extFor(framework, ts);
	const lang: OutLang = framework === 'react' ? (ts ? 'tsx' : 'jsx') : framework;
	const css = cssText(doc, resolve, { tailwind: styling === 'tailwind', fontImport: fontUrl, systemDark: opts.systemDark });
	const pageNames = doc.pages.map((_, i) => componentName(doc, i));

	let set: ComponentSet = { defs: [], uses: new Map() };
	const pageOf = new Map<IRNode, number>();
	if (opts.components !== false) {
		doc.pages.forEach((p, i) => walk(p.roots, (n) => pageOf.set(n, i)));
		set = extractComponents(
			doc.pages.map((p) => p.roots),
			(n, link) => hrefFor(doc, link, pageOf.get(n) ?? 0, routing),
			pageNames,
		);
	}
	const use = (n: IRNode) => {
		const u = set.uses.get(n);
		return u ? { name: u.def.name, props: u.props.map(([k, v]): [string, string] => [k, resolve(v)]) } : null;
	};

	for (const def of set.defs) {
		const body = renderNodes(doc, [def.template], {
			...base,
			linkHref: (link) => hrefFor(doc, link, pageOf.get(def.template) ?? 0, routing),
			bind: (n) => def.bindings.get(n) ?? null,
		});
		files.push({
			path: `${paths.components}${def.name}.${ext}`,
			label: `${def.name}.${ext}`,
			lang,
			content: componentFile(framework, def, body, ts, resolve),
			page: null,
		});
	}

	doc.pages.forEach((p, i) => {
		const name = pageNames[i];
		const body = markup(i, { use });
		const usedDefs = new Set<ComponentDef>();
		walk(p.roots, (n) => {
			const u = set.uses.get(n);
			if (u) usedDefs.add(u.def);
		});
		const imports = [...usedDefs].map((d) => {
			const from = `../${paths.components}${d.name}`.replace('../src/', '../');
			return `import ${d.name} from '${from}${framework === 'react' ? '' : `.${ext}`}';`;
		});
		let content: string;
		if (framework === 'react') {
			const root = p.roots.length > 1 ? `<>\n${indent(body, 2)}\n</>` : body;
			const head = [paths.cssImport ? `import '${paths.cssImport}';` : '', ...imports].filter(Boolean);
			content = `${head.length ? head.join('\n') + '\n\n' : ''}export default function ${name}() {\n  return (\n${indent(root, 4)}\n  );\n}\n`;
		} else if (framework === 'vue') {
			const script = imports.length ? `<script setup${ts ? ' lang="ts"' : ''}>\n${imports.join('\n')}\n</script>\n\n` : '';
			content = `${script}<template>\n${indent(body, 2)}\n</template>\n`;
		} else {
			const script = imports.length ? `<script${ts ? ' lang="ts"' : ''}>\n${indent(imports.join('\n'), 2)}\n</script>\n\n` : '';
			content = `${script}${body}\n`;
		}
		files.push({ path: `${paths.pages}${name}.${ext}`, label: `${name}.${ext}`, lang, content, page: i });
	});
	files.push({ path: paths.css, label: 'CSS', lang: 'css', content: css, page: null });
	return files;
}

/** Source of one component file; props default to the first instance's values. */
function componentFile(framework: Framework, def: ComponentDef, body: string, ts: boolean, resolve: (v: string) => string): string {
	const defaults = def.props.map((p) => ({ name: p.name, value: JSON.stringify(resolve(p.fallback)) }));
	if (framework === 'react') {
		const params = ['className', ...defaults.map((d) => `${d.name} = ${d.value}`)].join(', ');
		if (!ts) return `export default function ${def.name}({ ${params} }) {\n  return (\n${indent(body, 4)}\n  );\n}\n`;
		const type = `type ${def.name}Props = {\n${['className', ...def.props.map((p) => p.name)].map((n) => `  ${n}?: string;`).join('\n')}\n};\n\n`;
		return `${type}export default function ${def.name}({ ${params} }: ${def.name}Props) {\n  return (\n${indent(body, 4)}\n  );\n}\n`;
	}
	if (framework === 'vue') {
		let script = '';
		if (defaults.length && ts) {
			script = `<script setup lang="ts">\nwithDefaults(defineProps<{ ${def.props.map((p) => `${p.name}?: string`).join('; ')} }>(), {\n${defaults.map((d) => `  ${d.name}: ${d.value},`).join('\n')}\n});\n</script>\n\n`;
		} else if (defaults.length) {
			script = `<script setup>\ndefineProps({\n${defaults.map((d) => `  ${d.name}: { type: String, default: ${d.value} },`).join('\n')}\n});\n</script>\n\n`;
		}
		return `${script}<template>\n${indent(body, 2)}\n</template>\n`;
	}
	const fields = [`class: className = ''`, ...defaults.map((d) => `${d.name} = ${d.value}`)].join(', ');
	const type = ts ? `: { ${['class', ...def.props.map((p) => p.name)].map((n) => `${n}?: string`).join('; ')} }` : '';
	return `<script${ts ? ' lang="ts"' : ''}>\n  let { ${fields} }${type} = $props();\n</script>\n\n${body}\n`;
}

/** Self-contained HTML for the in-plugin preview; link clicks are reported to the parent window. */
export function previewDocument(doc: IRDocument, page: number, assets: Map<string, RawAsset>, inlineSvg: boolean, systemDark = false): string {
	const files = generate(doc, { format: 'html', assets, assetMode: 'inline', googleFonts: true, inlineSvg, systemDark });
	const html = files.find((f) => f.page === page && f.document)?.content ?? '';
	return withPreviewScript(html);
}

/** Reports link clicks to the plugin and accepts a theme attribute for variable modes. */
export function withPreviewScript(html: string): string {
	const script = `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(h.charAt(0)==='#'&&h.length>1){return;}e.preventDefault();parent.postMessage({previewNav:h},'*');});addEventListener('message',function(e){var d=e.data||{};if(d.theme===undefined)return;var r=document.documentElement;if(d.theme){r.setAttribute(d.attr||'data-theme',d.theme);}else{r.removeAttribute(d.attr||'data-theme');}});</script>`;
	return html.replace('</body>', `${script}\n</body>`);
}

const CODEGEN_LANG: Record<OutLang, CodegenLanguage> = {
	html: 'HTML',
	css: 'CSS',
	jsx: 'JAVASCRIPT',
	tsx: 'TYPESCRIPT',
	vue: 'HTML',
	svelte: 'HTML',
	json: 'JSON',
	js: 'JAVASCRIPT',
	ts: 'TYPESCRIPT',
};

type CodegenLanguage = 'HTML' | 'CSS' | 'JAVASCRIPT' | 'TYPESCRIPT' | 'JSON';

export function codegenSections(files: OutFile[]): { title: string; code: string; language: CodegenLanguage }[] {
	return files
		.filter((f) => (f.page === 0 || f.page === null) && !f.document)
		.map((f) => ({ title: f.label, code: f.content, language: CODEGEN_LANG[f.lang] }));
}

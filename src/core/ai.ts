/**
 * AI rebuild, section by section. Figma places layers on a free canvas, so wherever a
 * design lacks Auto Layout the standard converter can only reproduce absolute positions.
 * Here each section's literal export (HTML + CSS) is handed to a language model that
 * rewrites it as flowing, responsive markup; the page is then stitched back together.
 * This module is pure: planning, prompts, parsing and assembly. The network lives in the UI.
 */
import type { RawAsset } from '../shared/types';
import { fontLinkTags, googleFontsUrl } from './fonts';
import { cssSlug, type Style } from './format';
import {
	componentName,
	extFor,
	formatParts,
	hrefFor,
	htmlDocument,
	pathsFor,
	TAILWIND_CDN,
	type Framework,
	type GenerateOptions,
	type OutFile,
	type OutLang,
} from './generate';
import { classList, primaryClass, walk, type IRDocument, type IRNode } from './ir';
import { assetResolver, indent, RESET, renderNodes, ruleBlocks, variablesCss, type AssetMode, type Styling } from './emit';
import { PLACEMENT_KEYS } from './diff';

export const PROMPT_VERSION = 1;

/** Sections above this size (HTML + CSS characters) are split into their children. */
export const SECTION_LIMIT = 24_000;

/** Frames at least this tall with two or more blocks are treated as pages and split into sections. */
const PAGE_HEIGHT = 900;

export type SectionPlan = {
	/** Stable across rebuilds: page plus Figma layer ids. */
	key: string;
	page: number;
	index: number;
	label: string;
	/** Every class the model writes starts with this. */
	prefix: string;
	nodes: IRNode[];
	/** Layers to screenshot / select in Figma. */
	layerIds: string[];
	/** The literal export the model rewrites. */
	html: string;
	css: string;
	/** Words that should survive the rewrite. */
	words: string[];
	/** Where the section sits on the page and how its parent lays it out, for the model. */
	layout: string[];
	/** Page-relative box of the section's layers. */
	box?: { x: number; y: number; width: number; height: number };
};

export type PlanNode =
	| { kind: 'section'; section: SectionPlan }
	| { kind: 'wrapper'; node: IRNode; className: string; style: Style; children: PlanNode[] }
	| { kind: 'static'; node: IRNode };

export type PagePlan = { page: number; name: string; width: number; roots: PlanNode[]; sections: SectionPlan[] };

export type SectionResult = { html: string; css: string };

const WRAPPER_DROP = new Set([...PLACEMENT_KEYS, 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']);
const BACKGROUND_KEYS = ['background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat'];

const len = (v: string | undefined) => {
	const n = v ? parseFloat(v) : NaN;
	return Number.isFinite(n) ? n : 0;
};

function mergedStyle(doc: IRDocument, n: IRNode): Style {
	const shared = new Map(doc.sharedClasses.map((c) => [c.name, c.style]));
	return Object.assign({}, ...n.shared.map((s) => shared.get(s) ?? {}), n.style);
}

/** Temporarily renders nodes without their position in the parent (they flow in a wrapper). */
function withoutPlacement<T>(nodes: IRNode[], fn: () => T): T {
	const saved = nodes.map((n) => n.style);
	nodes.forEach((n) => {
		const s: Style = {};
		for (const [k, v] of Object.entries(n.style)) if (!PLACEMENT_KEYS.has(k)) s[k] = v;
		if (s.width && !s['max-width']) s['max-width'] = '100%';
		// Stay the containing block for absolutely positioned children, or they escape to the page.
		if (n.style.position) s.position = 'relative';
		n.style = s;
	});
	try {
		return fn();
	} finally {
		nodes.forEach((n, i) => (n.style = saved[i]));
	}
}

function textWords(nodes: IRNode[]): string[] {
	const words = new Set<string>();
	const add = (s: string | undefined) => {
		for (const w of (s ?? '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []) words.add(w);
	};
	walk(nodes, (n) => {
		for (const r of n.runs ?? []) add(r.text);
		add(n.attrs.placeholder);
	});
	return [...words];
}

export type PlanOptions = { assets: Map<string, RawAsset>; limit?: number };

/** Splits every page into sections small enough for one model call. */
export function planPages(doc: IRDocument, opts: PlanOptions): PagePlan[] {
	const limit = opts.limit ?? SECTION_LIMIT;
	const resolve = assetResolver(opts.assets, 'files', 'assets/');
	const allNodes: IRNode[] = [];
	walk(doc.pages.flatMap((p) => p.roots), (n) => allNodes.push(n));
	const prefixes = new Set<string>();
	/** Classes that stay in the page when `nodes` are rewritten: a prefix must not collide with them. */
	const takenOutside = (nodes: IRNode[]) => {
		const inside = new Set<IRNode>();
		walk(nodes, (n) => inside.add(n));
		const taken = new Set(prefixes);
		for (const n of allNodes) if (!inside.has(n)) for (const c of classList(n)) taken.add(c);
		return taken;
	};

	return doc.pages.map((page, pageIndex) => {
		const sections: SectionPlan[] = [];
		const root = page.roots[0];
		const pageWidth = root?.box?.width || len(root?.style.width) || 1440;
		/** Layer boxes relative to the page frame. */
		const boxes = new Map<IRNode, { x: number; y: number; width: number; height: number }>();
		const place = (n: IRNode, ox: number, oy: number, isRoot: boolean) => {
			const x = isRoot ? 0 : ox + (n.box?.x ?? 0);
			const y = isRoot ? 0 : oy + (n.box?.y ?? 0);
			if (n.box) boxes.set(n, { x, y, width: n.box.width, height: n.box.height });
			for (const c of n.children) place(c, n.box ? x : ox, n.box ? y : oy, false);
		};
		for (const r of page.roots) place(r, 0, 0, true);

		const boxOf = (nodes: IRNode[]) => {
			const list = nodes.map((n) => boxes.get(n)).filter((b) => !!b);
			if (!list.length) return undefined;
			const x = Math.min(...list.map((b) => b.x));
			const y = Math.min(...list.map((b) => b.y));
			return { x, y, width: Math.max(...list.map((b) => b.x + b.width)) - x, height: Math.max(...list.map((b) => b.y + b.height)) - y };
		};

		const describe = (nodes: IRNode[], parent: IRNode | null): string[] => {
			const box = boxOf(nodes);
			if (!box) return [];
			const { x, y, width: w, height: h } = box;
			const r = Math.round;
			const share = w / pageWidth;
			const lines = [
				`Box on the page: x ${r(x)}, y ${r(y)}, ${r(w)}×${r(h)}px — ${r(share * 100)}% of the ${r(pageWidth)}px page width, ${r(x)}px from the left and ${r(pageWidth - x - w)}px from the right edge.`,
			];
			if (share >= 0.9) lines.push('It spans (almost) the whole page width: build it full width; if the design shows side gaps, treat them as page padding.');
			else if (Math.abs(x - (pageWidth - x - w)) <= Math.max(8, pageWidth * 0.02)) lines.push('It is horizontally centered on the page.');
			if (parent) {
				const ps = mergedStyle(doc, parent);
				const flow = ps.display === 'flex' || ps.display === 'grid';
				const keys = ['display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'padding'];
				const desc = keys.filter((k) => ps[k]).map((k) => `${k}: ${ps[k]}`).join('; ');
				lines.push(
					flow
						? `Parent layer "${parent.name}" lays out its children with ${desc}.`
						: `Parent layer "${parent.name}" is a free canvas (children placed at absolute positions)${desc ? ` — ${desc}` : ''}.`,
				);
			}
			return lines;
		};
		const input = (nodes: IRNode[]) => {
			const html = renderNodes(doc, nodes, {
				assets: opts.assets,
				assetMode: 'files',
				assetPrefix: 'assets/',
				linkHref: (link) => hrefFor(doc, link, pageIndex, 'files'),
			});
			return { html, css: ruleBlocks(doc, resolve, nodes).join('\n\n') };
		};

		const section = (nodes: IRNode[], parent: IRNode | null): PlanNode => {
			const { html, css } = input(nodes);
			const label = nodes.map((n) => n.name).join(' + ');
			const base = cssSlug(primaryClass(nodes[0]) || nodes[0].name, 'section').slice(0, 24).replace(/-+$/, '');
			const taken = takenOutside(nodes);
			let prefix = base;
			for (let i = 2; taken.has(prefix); i++) prefix = `${base}-${i}`;
			prefixes.add(prefix);
			const plan: SectionPlan = {
				key: `${pageIndex}:${nodes.map((n) => n.id).join('+')}`,
				page: pageIndex,
				index: sections.length,
				label,
				prefix,
				nodes,
				layerIds: nodes.map((n) => n.id).filter((id) => !id.includes(':li')),
				html,
				css,
				words: textWords(nodes),
				layout: describe(nodes, parent),
				box: boxOf(nodes),
			};
			sections.push(plan);
			return { kind: 'section', section: plan };
		};

		const size = (nodes: IRNode[]) => {
			const { html, css } = input(nodes);
			return html.length + css.length;
		};

		const wrapper = (node: IRNode): PlanNode => {
			const style = mergedStyle(doc, node);
			const flow = style.display === 'flex' || style.display === 'grid';
			const out: Style = {};
			for (const [k, v] of Object.entries(style)) if (!WRAPPER_DROP.has(k)) out[k] = v;
			if (!flow) {
				out.display = 'flex';
				out['flex-direction'] = 'column';
			}
			out.width = '100%';
			const children = planChildren(node, style, out);
			return { kind: 'wrapper', node, className: primaryClass(node) || `wrap-${cssSlug(node.name, 'x')}`, style: out, children };
		};

		const planChildren = (parent: IRNode, parentStyle: Style, wrapperStyle: Style): PlanNode[] => {
			const flow = parentStyle.display === 'flex' || parentStyle.display === 'grid';
			let kids = parent.children.map((c) => (c.wrapper && c.children[0] ? c.children[0] : c));
			if (!flow) {
				const pw = len(parentStyle.width);
				const ph = len(parentStyle.height) || len(parentStyle['min-height']);
				kids = kids.filter((k) => {
					const covers = k.children.length === 0 && !k.runs && pw > 0 && ph > 0 && len(k.style.width) >= pw * 0.85 && len(k.style.height) >= ph * 0.85;
					if (!covers) return true;
					// A full-size background layer sits above the frame's own fill: it becomes the wrapper's background.
					if (k.tag === 'img' && k.attrs.src) {
						for (const key of BACKGROUND_KEYS) delete wrapperStyle[key];
						wrapperStyle.background = `url("${k.attrs.src}") center / cover no-repeat`;
					} else if (BACKGROUND_KEYS.some((key) => k.style[key])) {
						for (const key of BACKGROUND_KEYS) delete wrapperStyle[key];
						for (const key of BACKGROUND_KEYS) if (k.style[key]) wrapperStyle[key] = k.style[key];
					}
					return false;
				});
				kids.sort((a, b) => len(a.style.top) - len(b.style.top) || len(a.style.left) - len(b.style.left));
			}

			// Layers that overlap vertically on a free canvas belong together (e.g. text over an image).
			const clusters: IRNode[][] = [];
			let bottom = -Infinity;
			for (const k of kids) {
				const top = len(k.style.top);
				const last = clusters[clusters.length - 1];
				if (!flow && last && top < bottom - 1) last.push(k);
				else clusters.push([k]);
				bottom = Math.max(flow ? -Infinity : bottom, top + len(k.style.height));
			}

			return clusters.map((cluster) => {
				if (cluster.length === 1 && cluster[0].children.length === 0) return { kind: 'static', node: cluster[0] } as PlanNode;
				if (cluster.length > 1 || size(cluster) <= limit) return section(cluster, parent);
				return wrapper(cluster[0]);
			});
		};

		const roots: PlanNode[] = page.roots.map((root) => {
			if (root.children.length === 0) return { kind: 'static', node: root } as PlanNode;
			// A page-sized frame is always rebuilt one top-level section at a time; smaller pieces
			// (a navbar, a card) stay whole unless they are too large for one call.
			const style = mergedStyle(doc, root);
			const tall = Math.max(len(style.height), len(style['min-height'])) >= PAGE_HEIGHT;
			const blocks = root.children.filter((c) => c.children.length > 0 || (c.wrapper && c.children[0]?.children.length)).length;
			if (tall && blocks >= 2) return wrapper(root);
			return size([root]) <= limit ? section([root], null) : wrapper(root);
		});
		const width = pageWidth;
		return { page: pageIndex, name: page.name, width, roots, sections };
	});
}

// ---------- prompts ----------

export type PromptContext = {
	doc: IRDocument;
	plan: PagePlan;
	styling: Styling;
	instructions?: string;
	/** data: URL of a JPG screenshot of the section. */
	screenshot?: string | null;
	/** data: URL of a small JPG of the whole page, when the section is only part of it. */
	pageScreenshot?: string | null;
};

export type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
};

export function systemPrompt(styling: Styling, custom?: string): string {
	const styleRules =
		styling === 'tailwind'
			? `- Style with Tailwind CSS v4 utility classes (arbitrary values like w-[372px] or bg-[#0f172a] are fine). Design mobile-first: base classes for phones, then sm:, md:, lg:, xl: for larger screens.
- The CSS block may stay empty. Only put rules there that utilities cannot express, and give them classes that start with the prefix.`
			: `- Write plain CSS. Every class you create must start with the prefix given (e.g. "hero", "hero-title", "hero__cta"). Never style bare element selectors, html, body or :root, and do not add a reset — one is already loaded.
- Add @media queries so the section works from 360px phones up to the design width. Prefer min-width/max-width, clamp() and fluid units over fixed pixel sizes.`;
	return `You are a senior front-end engineer. You rebuild ONE section of a web page that was exported literally from a Figma design.

The input is machine-generated: layers are often positioned absolutely with fixed pixel sizes because Figma is a free canvas. Your job is to rewrite it as clean, semantic, responsive, production-quality code that looks the same at the design width.

Rules:
- Layout with normal flow, flexbox and grid. Use absolute positioning only for genuinely overlapping decoration (badges, background shapes).
- The outermost element gets exactly the class prefix given and fills the full width of its parent: never give it a fixed width or let it shrink to its content. Center inner content with a max-width container where the design suggests one; let backgrounds run full width.
- Keep every visible text exactly as given — same words, same order. Do not invent, translate, shorten or drop content.
- Keep every image src, alt text and link href exactly as given. Do not add external images, fonts, icons or scripts.
- Match colors, font families, font sizes, weights, line heights, spacing, radii, borders and shadows of the input at the design width.
- The input is a literal export and designers are not always tidy: layer names, stray offsets, fixed pixel sizes and odd nesting are accidents. Use the layout context and screenshots to understand what the design is meant to be (full-width band, centered container, card grid, split columns…) and build that intent, not the quirks.
- Use the CSS custom properties from the input (var(--…)) instead of repeating their values.
- Use semantic HTML (header, nav, main content sections, ul/li for lists, button for actions, a for links, h1–h6 matching the input's heading levels) and make it accessible (alt text, labels, aria-label on icon-only controls, visible focus styles).
${styleRules}
- No JavaScript, no <script>, no <style> elements, no inline event handlers. Return only this section's markup: no <html>, <head> or <body>.

Answer with exactly two fenced code blocks and nothing else:
\`\`\`html
…section markup…
\`\`\`
\`\`\`css
…section CSS…
\`\`\`${
		custom?.trim()
			? `

Project-specific instructions from the developer. Follow them, as long as the answer keeps the two-block format above:
${custom.trim()}`
			: ''
	}`;
}

export function sectionMessages(section: SectionPlan, ctx: PromptContext): ChatMessage[] {
	const { doc, plan, styling } = ctx;
	const vars = doc.variables.filter((v) => section.css.includes(`var(${v.name})`) || section.html.includes(`var(${v.name})`));
	const neighbours = [plan.sections[section.index - 1]?.label, plan.sections[section.index + 1]?.label];
	const lines = [
		`Page: "${plan.name}" — design width ${Math.round(plan.width)}px.`,
		`Section ${section.index + 1} of ${plan.sections.length}: "${section.label}".`,
		neighbours[0] ? `Previous section: "${neighbours[0]}".` : 'This is the first section on the page.',
		neighbours[1] ? `Next section: "${neighbours[1]}".` : 'This is the last section on the page.',
		`Output: HTML + ${styling === 'tailwind' ? 'Tailwind CSS v4' : 'plain CSS'}.`,
		`Class prefix: "${section.prefix}".`,
	];
	if (section.layout.length) lines.push(`Layout context from the Figma file:\n${section.layout.map((l) => `- ${l}`).join('\n')}`);
	if (plan.sections.length > 1) {
		const outline = [...plan.sections]
			.sort((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0))
			.map((s) => {
				const box = s.box ? ` — y ${Math.round(s.box.y)}, ${Math.round(s.box.width)}×${Math.round(s.box.height)}px` : '';
				return `- "${s.label}"${box}${s === section ? '  ← this one' : ''}`;
			});
		lines.push(`All sections of this page, top to bottom as they appear visually:\n${outline.join('\n')}`);
	}
	if (doc.fonts.length) lines.push(`Fonts already loaded: ${doc.fonts.map((f) => f.family).join(', ')}.`);
	if (vars.length) lines.push(`CSS custom properties available:\n${vars.map((v) => `${v.name}: ${v.value};`).join('\n')}`);
	if (doc.media.length && section.css.includes('@media'))
		lines.push('The input CSS already has @media rules taken from the designer\'s smaller breakpoint frames — keep that behaviour.');
	if (ctx.screenshot) lines.push('A screenshot of the section as designed is attached.');
	if (ctx.pageScreenshot) lines.push('A small screenshot of the whole page is attached too, for context only — rebuild just this section.');
	lines.push(`Input HTML:\n\`\`\`html\n${section.html}\n\`\`\``);
	lines.push(`Input CSS:\n\`\`\`css\n${section.css || '/* none */'}\n\`\`\``);
	const text = lines.join('\n\n');
	const images = [ctx.screenshot, ctx.pageScreenshot].filter((u): u is string => !!u);
	const content: ChatMessage['content'] = images.length
		? [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
		: text;
	return [
		{ role: 'system', content: systemPrompt(styling, ctx.instructions) },
		{ role: 'user', content },
	];
}

// ---------- parsing ----------

/** Pulls the html and css blocks out of a model answer and strips anything a page must not contain. */
export function parseSectionResponse(answer: string): SectionResult {
	const blocks = [...answer.matchAll(/```([a-z]*)[^\n]*\n([\s\S]*?)(?:```|$)/gi)].map((m) => ({ lang: m[1].toLowerCase(), code: m[2].trim() }));
	let html = blocks.find((b) => b.lang === 'html' || b.lang === 'xml' || b.lang === 'vue' || b.lang === 'svelte')?.code;
	let css = blocks.find((b) => b.lang === 'css')?.code ?? '';
	if (!html) {
		const untagged = blocks.find((b) => !b.lang && b.code.trimStart().startsWith('<'));
		html = untagged?.code ?? (answer.trimStart().startsWith('<') ? answer.trim() : undefined);
	}
	if (!html) throw new Error('The model did not return an HTML code block.');

	html = html
		.replace(/<!doctype[^>]*>/gi, '')
		.replace(/<head[\s\S]*?<\/head>/gi, '')
		.replace(/<\/?(html|body)\b[^>]*>/gi, '')
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
	html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, inner: string) => {
		css += `\n${inner.trim()}`;
		return '';
	});
	css = css.replace(/<\/?style[^>]*>/gi, '');
	html = html.trim();
	if (!/<[a-z]/i.test(html)) throw new Error('The HTML block is empty.');
	return { html, css: css.trim() };
}

/** Share (0–1) of the design's words that appear in the model's markup. */
export function textCoverage(section: SectionPlan, html: string): number {
	if (!section.words.length) return 1;
	const text = html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.toLowerCase();
	const attrs = [...html.matchAll(/(?:placeholder|alt|aria-label)="([^"]*)"/gi)].map((m) => m[1].toLowerCase()).join(' ');
	const hay = `${text} ${attrs}`;
	return section.words.filter((w) => hay.includes(w)).length / section.words.length;
}

// ---------- assembly ----------

export type AssembleOptions = {
	doc: IRDocument;
	plans: PagePlan[];
	results: Map<string, SectionResult>;
	assets: Map<string, RawAsset>;
	styling: Styling;
};

export type AssembledPage = { body: string };

/** Stitches wrappers, unchanged layers and section results into one body per page, with asset paths "assets/…". */
export function assemblePages(opts: AssembleOptions): { pages: AssembledPage[]; css: string } {
	const { doc, plans, results, assets } = opts;
	const resolve = assetResolver(assets, 'files', 'assets/');
	const cssParts: string[] = [];
	const pages = plans.map((plan) => {
		const renderPlan = (p: PlanNode, depth: number): string => {
			const pad = '  '.repeat(depth);
			if (p.kind === 'static') {
				return withoutPlacement([p.node], () => {
					cssParts.push(...ruleBlocks(doc, resolve, [p.node]));
					return indent(render([p.node], plan.page), depth * 2);
				});
			}
			if (p.kind === 'wrapper') {
				const decl = Object.entries(p.style).map(([k, v]) => `  ${k}: ${resolve(v)};`);
				cssParts.push(`.${p.className} {\n${decl.join('\n')}\n}`);
				// Rebuilt sections span the wrapper even when it centers its children (align-items: center).
				const rebuilt = p.children.flatMap((c) => (c.kind === 'section' && results.has(c.section.key) ? [c.section.prefix] : []));
				if (rebuilt.length) cssParts.push(`${rebuilt.map((x) => `.${p.className} > .${x}`).join(',\n')} {\n  align-self: stretch;\n  min-width: 0;\n}`);
				const tag = /^(section|header|footer|main|nav|aside|article|div|form|ul|ol)$/.test(p.node.tag) ? p.node.tag : 'div';
				const id = p.node.attrs.id ? ` id="${p.node.attrs.id}"` : '';
				return [`${pad}<${tag} class="${p.className}"${id}>`, ...p.children.map((c) => renderPlan(c, depth + 1)), `${pad}</${tag}>`].join('\n');
			}
			const s = p.section;
			const result = results.get(s.key);
			if (result) {
				cssParts.push(`/* ${s.label} */\n${result.css || ''}`.trim());
				return indent(result.html, depth * 2);
			}
			return withoutPlacement(s.nodes, () => {
				cssParts.push(`/* ${s.label} (standard output) */`, ...ruleBlocks(doc, resolve, s.nodes));
				return indent(render(s.nodes, plan.page), depth * 2);
			});
		};
		const render = (nodes: IRNode[], page: number) =>
			renderNodes(doc, nodes, {
				assets,
				assetMode: 'files',
				assetPrefix: 'assets/',
				linkHref: (link) => hrefFor(doc, link, page, 'files'),
			});
		return { body: plan.roots.map((r) => renderPlan(r, 0)).join('\n') };
	});
	return { pages, css: cssParts.filter((c) => c.trim()).join('\n\n') };
}

/** Rewrites "assets/name.png" references for the chosen asset mode. */
export function resolveAssetPaths(text: string, assets: Map<string, RawAsset>, mode: AssetMode, prefix: string): string {
	const byName = new Map([...assets.values()].map((a) => [a.name, a]));
	const resolve = assetResolver(assets, mode, prefix);
	return text.replace(/(^|["'(\s])(?:\.\/|\/)?assets\/([^"')\s?#]+)/g, (m, lead: string, name: string) => {
		const asset = byName.get(decodeURIComponent(name));
		return asset ? lead + resolve(`__ASSET__${asset.id}__`) : m;
	});
}

/** Page links written as "about.html#x" become hash or path routes. */
export function rewriteLinks(text: string, doc: IRDocument, routing: 'files' | 'hash' | 'path'): string {
	if (routing === 'files') return text;
	const slugs = new Set(doc.pages.map((p) => p.slug));
	return text.replace(/href="([a-z0-9-]+)\.html(#[^"]*)?"/gi, (m, slug: string, hash?: string) => {
		if (!slugs.has(slug)) return m;
		if (routing === 'hash') return `href="${slug === 'index' ? '#/' : `#/${slug}`}"`;
		return `href="${slug === 'index' ? '/' : `/${slug}`}${hash ?? ''}"`;
	});
}

// ---------- HTML → JSX ----------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const JSX_ATTRS: Record<string, string> = {
	class: 'className',
	for: 'htmlFor',
	tabindex: 'tabIndex',
	readonly: 'readOnly',
	maxlength: 'maxLength',
	minlength: 'minLength',
	colspan: 'colSpan',
	rowspan: 'rowSpan',
	srcset: 'srcSet',
	crossorigin: 'crossOrigin',
	autocomplete: 'autoComplete',
	autofocus: 'autoFocus',
	enctype: 'encType',
	datetime: 'dateTime',
	allowfullscreen: 'allowFullScreen',
	novalidate: 'noValidate',
	frameborder: 'frameBorder',
	contenteditable: 'contentEditable',
	spellcheck: 'spellCheck',
	playsinline: 'playsInline',
	'xlink:href': 'xlinkHref',
	'xml:space': 'xmlSpace',
	value: 'defaultValue',
	checked: 'defaultChecked',
	selected: 'defaultSelected',
};

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function styleObject(css: string): string {
	const entries = css
		.split(';')
		.map((d) => d.trim())
		.filter(Boolean)
		.map((d) => {
			const i = d.indexOf(':');
			if (i < 0) return null;
			const prop = d.slice(0, i).trim();
			const key = prop.startsWith('--') ? JSON.stringify(prop) : camel(prop.replace(/^-webkit-/, 'Webkit-').replace(/^-ms-/, 'ms-'));
			return `${key}: ${JSON.stringify(d.slice(i + 1).trim())}`;
		})
		.filter(Boolean);
	return `{{ ${entries.join(', ')} }}`;
}

/** Converts an HTML fragment to JSX: attribute names, style objects, self-closing void tags, escaped braces. */
export function htmlToJsx(html: string): string {
	let out = '';
	let i = 0;
	let rawUntil: string | null = null;
	while (i < html.length) {
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i);
			const body = html.slice(i + 4, end < 0 ? html.length : end).replace(/\*\//g, '* /');
			out += `{/*${body}*/}`;
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		if (html[i] === '<' && /[a-zA-Z/]/.test(html[i + 1] ?? '')) {
			const end = findTagEnd(html, i);
			const tag = html.slice(i, end + 1);
			const closing = tag.startsWith('</');
			const m = /^<\/?\s*([a-zA-Z][\w:-]*)/.exec(tag);
			const name = m ? m[1] : '';
			if (closing) {
				if (!VOID.has(name.toLowerCase())) out += `</${name}>`;
				if (rawUntil && name.toLowerCase() === rawUntil) rawUntil = null;
			} else {
				const selfClosing = /\/\s*>$/.test(tag) || VOID.has(name.toLowerCase());
				const attrSrc = tag.slice(1 + name.length, selfClosing && tag.endsWith('/>') ? -2 : -1);
				const attrs: string[] = [];
				for (const a of attrSrc.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
					const raw = a[1];
					const lower = raw.toLowerCase();
					if (lower.startsWith('on')) continue;
					const value = a[2] ?? a[3] ?? a[4];
					let key = JSX_ATTRS[lower] ?? (lower.startsWith('data-') || lower.startsWith('aria-') ? lower : raw.includes('-') ? camel(raw) : raw);
					if ((lower === 'value' || lower === 'checked' || lower === 'selected') && !/^(input|textarea|select|option)$/i.test(name)) key = lower;
					if (value === undefined) attrs.push(key);
					else if (lower === 'style') attrs.push(`style=${styleObject(value)}`);
					else attrs.push(`${key}="${value.replace(/"/g, '&quot;')}"`);
				}
				out += `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClosing ? ' />' : '>'}`;
				if (!selfClosing && /^(textarea|pre)$/i.test(name)) rawUntil = name.toLowerCase();
			}
			i = end + 1;
			continue;
		}
		const next = html.indexOf('<', i + 1);
		const text = html.slice(i, next < 0 ? html.length : next);
		out += text.replace(/[{}]/g, (c) => `{'${c}'}`);
		i = next < 0 ? html.length : next;
	}
	return out;
}

function findTagEnd(html: string, start: number): number {
	let quote: string | null = null;
	for (let i = start + 1; i < html.length; i++) {
		const c = html[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === '>') return i;
	}
	return html.length - 1;
}

// ---------- output files ----------

/** Output files for AI-assembled pages, mirroring `generate` for every format except email. */
export function aiFiles(doc: IRDocument, assembled: { pages: AssembledPage[]; css: string }, opts: GenerateOptions): OutFile[] {
	const { framework, styling } = formatParts(opts.format);
	if (framework === 'email') return [];
	const files: OutFile[] = [];
	const fontUrl = opts.googleFonts ? googleFontsUrl(doc.fonts) : null;
	const routing = framework === 'html' ? 'files' : opts.layout === 'next' ? 'path' : 'hash';
	const prefix = routing === 'files' ? 'assets/' : '/assets/';
	const fix = (s: string) => rewriteLinks(resolveAssetPaths(s, opts.assets, opts.assetMode, prefix), doc, routing);
	const tailwind = styling === 'tailwind';
	const cdn = tailwind && framework === 'html' && opts.tailwindCdn !== false;

	const head: string[] = [];
	if (tailwind && !cdn) head.push('@import "tailwindcss";');
	if (fontUrl && framework !== 'html') head.push(`@import url("${fontUrl}");`);
	head.push('/* Generated by SNN Design to HTML/CSS — AI rebuild */');
	if (!tailwind) head.push(RESET);
	head.push(...variablesCss(doc, opts.systemDark));
	const css = fix([...head, assembled.css].filter(Boolean).join('\n\n')) + '\n';

	if (framework === 'html') {
		doc.pages.forEach((p, i) => {
			const body = fix(assembled.pages[i]?.body ?? '');
			const styles = opts.assetMode === 'files' ? '<link rel="stylesheet" href="styles.css">' : `<style>\n${indent(css.trimEnd(), 2)}\n</style>`;
			const docHead = [fontLinkTags(fontUrl), styles, cdn ? TAILWIND_CDN : ''];
			const multi = doc.pages.length > 1;
			files.push({ path: `${p.slug}.html`, label: multi ? `${p.slug}.html` : 'HTML file', lang: 'html', content: htmlDocument(p.title, docHead, body), page: i, document: true });
			files.push({ path: null, label: 'HTML', lang: 'html', content: body + '\n', page: i });
		});
		files.push({ path: 'styles.css', label: 'CSS', lang: 'css', content: css, page: null });
		return files;
	}

	const paths = pathsFor(opts.layout);
	const ts = opts.typescript === true;
	const ext = extFor(framework as Framework, ts);
	const lang: OutLang = framework === 'react' ? (ts ? 'tsx' : 'jsx') : (framework as OutLang);
	doc.pages.forEach((p, i) => {
		const name = componentName(doc, i);
		const body = fix(assembled.pages[i]?.body ?? '');
		let content: string;
		if (framework === 'react') {
			const jsx = htmlToJsx(body);
			const multiple = (rootCount(body) ?? 2) > 1;
			const root = multiple ? `<>\n${indent(jsx, 2)}\n</>` : jsx;
			const imp = paths.cssImport ? `import '${paths.cssImport}';\n\n` : '';
			content = `${imp}export default function ${name}() {\n  return (\n${indent(root, 4)}\n  );\n}\n`;
		} else if (framework === 'vue') {
			const safe = body.replace(/\{\{/g, '&#123;&#123;').replace(/\}\}/g, '&#125;&#125;');
			content = `<template>\n${indent(safe, 2)}\n</template>\n`;
		} else {
			content = body.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;')) + '\n';
		}
		files.push({ path: `${paths.pages}${name}.${ext}`, label: `${name}.${ext}`, lang, content, page: i });
	});
	files.push({ path: paths.css, label: 'CSS', lang: 'css', content: css, page: null });
	return files;
}

/** Number of top-level elements in a fragment, or null when it cannot tell. */
function rootCount(html: string): number | null {
	let depth = 0;
	let roots = 0;
	for (const m of html.matchAll(/<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
		if (m[0].startsWith('<!--')) continue;
		const name = m[1].toLowerCase();
		if (m[0].startsWith('</')) depth--;
		else {
			if (depth === 0) roots++;
			if (!m[2] && !VOID.has(name)) depth++;
		}
		if (depth < 0) return null;
	}
	return roots;
}

/** Stable short hash for caching section results. */
export function hashText(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

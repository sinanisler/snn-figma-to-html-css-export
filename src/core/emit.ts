import type { RawAsset } from '../shared/types';
import { cssSlug, escapeAttr, escapeHtml, type Style } from './format';
import { classList, primaryClass, walk, type IRDocument, type IRLink, type IRNode, type IRRule } from './ir';
import { toUtilities } from './tailwind';

/** inline: data URIs · files: relative asset paths (zip) · preview: shortened data URIs for display */
export type AssetMode = 'inline' | 'files' | 'preview';
export type Dialect = 'html' | 'jsx' | 'email';
export type Styling = 'css' | 'tailwind';
/** How dynamic values are written: JSX `{x}`, Vue `{{ x }}` / `:attr`, Svelte `{x}`. */
export type Templating = 'jsx' | 'vue' | 'svelte';

/** Prop names that replace a node's literal text, src, alt or href. */
export type Binding = { text?: string; src?: string; alt?: string; href?: string; className?: string };

export type RenderOptions = {
	assets: Map<string, RawAsset>;
	assetMode: AssetMode;
	/** Path prefix for assets in files mode ("assets/" or "/assets/"). */
	assetPrefix?: string;
	inlineSvg?: boolean;
	dialect?: Dialect;
	styling?: Styling;
	/** Vue and Svelte templates (JSX is implied by the jsx dialect). */
	templating?: Templating;
	linkHref?: (link: IRLink) => string;
	/** Renders a node as a component tag, e.g. <Card title="…" />. */
	use?: (node: IRNode) => { name: string; props: [string, string][] } | null;
	/** Inside a component template: which values come from props. */
	bind?: (node: IRNode) => Binding | null;
	/** Replaces a node's markup entirely (padding is the indentation to use). */
	replace?: (node: IRNode, pad: string) => string | null;
	/** Shared counter so inline SVG ids stay unique across several render calls. */
	svgSeq?: { n: number };
};

export const RESET = `*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

img,
svg {
  display: block;
}

button,
input,
textarea,
select {
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: inherit;
}

button {
  cursor: pointer;
}

a {
  color: inherit;
  text-decoration: none;
}

ul,
ol {
  list-style: none;
}

ul > li:not([class]),
ol > li:not([class]) {
  display: contents;
}`;

const TOKEN = /__ASSET__(.+?)__/g;
const VOID_TAGS = new Set(['img', 'input']);

export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
	}
	return btoa(binary);
}

export type Resolver = (value: string) => string;

export function assetResolver(assets: Map<string, RawAsset>, mode: AssetMode, prefix = 'assets/'): Resolver {
	const cache = new Map<string, string>();
	return (value: string) =>
		value.replace(TOKEN, (_, id: string) => {
			const asset = assets.get(id);
			if (!asset) return '';
			if (mode === 'files') return `${prefix}${asset.name}`;
			if (mode === 'preview') {
				const kb = Math.max(1, Math.round(asset.bytes.length / 1024));
				return `data:${asset.mime};base64,…(${asset.name}, ${kb} KB)`;
			}
			let uri = cache.get(id);
			if (!uri) {
				uri = `data:${asset.mime};base64,${toBase64(asset.bytes)}`;
				cache.set(id, uri);
			}
			return uri;
		});
}

export const indent = (text: string, spaces: number) =>
	text
		.split('\n')
		.map((line) => (line ? ' '.repeat(spaces) + line : line))
		.join('\n');

function declarations(style: Style, resolve: Resolver, pad = '  '): string[] {
	return Object.entries(style).map(([k, v]) => `${pad}${k}: ${resolve(v)};`);
}

function rule(selector: string, style: Style, resolve: Resolver): string {
	const lines = declarations(style, resolve);
	return lines.length ? `${selector} {\n${lines.join('\n')}\n}` : '';
}

/** List wrappers have no class; rules aimed at them apply to the element inside. */
const ruleTarget = (n: IRNode) => (n.wrapper && n.children[0] ? n.children[0] : n);

function selectorFor(r: IRRule): string | null {
	const target = primaryClass(ruleTarget(r.target));
	if (!target) return null;
	let sel = `.${target}${r.pseudo ?? ''}`;
	if (r.scope) {
		const scope = primaryClass(r.scope.node);
		if (!scope) return null;
		sel = r.scope.node === r.target ? `.${scope}${r.scope.pseudo}${r.pseudo ?? ''}` : `.${scope}${r.scope.pseudo} ${sel}`;
	}
	return sel;
}

export type CssOptions = {
	fontImport?: string | null;
	/** Compiled Tailwind: `@import "tailwindcss"` plus variables. */
	tailwind?: boolean;
	/** Tailwind from the browser CDN: variables only. */
	tailwindVarsOnly?: boolean;
	/** Variable modes named "dark" apply under prefers-color-scheme: dark. */
	systemDark?: boolean;
};

/** Custom properties: the design's values on :root, other variable modes behind data attributes. */
export function variablesCss(doc: IRDocument, systemDark = false): string[] {
	const parts: string[] = [];
	if (!doc.variables.length) return parts;
	parts.push(`:root {\n${doc.variables.map((v) => `  ${v.name}: ${v.value};`).join('\n')}\n}`);
	const moded = doc.variables.filter((v) => v.modes?.length);
	if (!moded.length) return parts;
	const collections = new Set(moded.map((v) => v.collection ?? ''));
	const attr = (col: string) => (collections.size > 1 ? `data-${cssSlug(col, 'theme')}` : 'data-theme');
	const blocks = new Map<string, { attr: string; mode: string; lines: string[] }>();
	for (const v of moded) {
		for (const m of v.modes!) {
			const a = attr(v.collection ?? '');
			const key = `${a}|${m.mode}`;
			const block = blocks.get(key) ?? { attr: a, mode: m.mode, lines: [] };
			block.lines.push(`${v.name}: ${m.value};`);
			blocks.set(key, block);
		}
	}
	for (const b of blocks.values()) {
		parts.push(`[${b.attr}="${cssSlug(b.mode, 'mode')}"] {\n${b.lines.map((l) => `  ${l}`).join('\n')}\n}`);
		if (systemDark && /dark/i.test(b.mode))
			parts.push(`@media (prefers-color-scheme: dark) {\n  :root:not([${b.attr}]) {\n${b.lines.map((l) => `    ${l}`).join('\n')}\n  }\n}`);
	}
	return parts;
}

/** Stylesheet for the whole document. With tailwind, only what utilities can't express. */
export function cssText(doc: IRDocument, resolve: Resolver, opts: CssOptions = {}): string {
	const parts: string[] = [];
	if (opts.tailwind) parts.push('@import "tailwindcss";');
	if (opts.fontImport) parts.push(`@import url("${opts.fontImport}");`);
	const header = ['/* Generated by SNN Design to HTML/CSS */'];
	if (doc.fonts.length) header.push(`/* Fonts: ${doc.fonts.map((f) => `${f.family} ${[...new Set([...f.weights, ...f.italicWeights])].join('/')}`).join(', ')} */`);
	parts.push(header.join('\n'));
	const utilities = opts.tailwind || opts.tailwindVarsOnly;
	if (!utilities) parts.push(RESET);
	parts.push(...variablesCss(doc, opts.systemDark));
	if (utilities) return parts.join('\n\n') + '\n';
	parts.push(...ruleBlocks(doc, resolve));
	return parts.filter(Boolean).join('\n\n') + '\n';
}

/** Class, state and media rules; with `nodes`, only those that style that subtree. */
export function ruleBlocks(doc: IRDocument, resolve: Resolver, nodes?: IRNode[]): string[] {
	const parts: string[] = [];
	let inScope: Set<IRNode> | null = null;
	let sharedUsed: Set<string> | null = null;
	if (nodes) {
		const scope = new Set<IRNode>();
		const shared = new Set<string>();
		walk(nodes, (n) => {
			scope.add(n);
			for (const s of n.shared) shared.add(s);
		});
		inScope = scope;
		sharedUsed = shared;
	}

	for (const c of doc.sharedClasses) if (!sharedUsed || sharedUsed.has(c.name)) parts.push(rule(`.${c.name}`, c.style, resolve));

	const emitted = new Set<string>();
	const runClasses = new Set<string>();
	const roots = nodes ?? doc.pages.flatMap((p) => p.roots);
	walk(roots, (node) => {
		if (node.className && !emitted.has(node.className)) {
			emitted.add(node.className);
			parts.push(rule(`.${node.className}`, node.style, resolve));
		}
		for (const run of node.runs ?? []) {
			if (!run.className || runClasses.has(run.className)) continue;
			runClasses.add(run.className);
			parts.push(rule(`.${run.className}`, run.style, resolve));
		}
	});

	const byMedia = new Map<string, string[]>();
	for (const r of doc.rules) {
		if (inScope && !inScope.has(r.target)) continue;
		const sel = selectorFor(r);
		if (!sel) continue;
		if (!r.media) {
			parts.push(rule(sel, r.style, resolve));
			continue;
		}
		const lines = declarations(r.style, resolve, '    ');
		if (lines.length) byMedia.set(r.media, [...(byMedia.get(r.media) ?? []), `  ${sel} {\n${lines.join('\n')}\n  }`]);
	}
	for (const m of doc.media) {
		const blocks = byMedia.get(m);
		if (blocks) parts.push(`@media ${m} {\n${blocks.join('\n\n')}\n}`);
	}
	return parts.filter(Boolean);
}

// ---------- markup ----------

const PSEUDO_VARIANT: Record<string, string> = {
	':hover': 'hover',
	':focus-visible': 'focus-visible',
	':active': 'active',
	'::placeholder': 'placeholder',
};

type TailwindIndex = { extra: Map<IRNode, string[]>; groups: Map<IRNode, string> };

/** Media, state and pseudo rules become variant-prefixed utilities on the nodes they target. */
function tailwindIndex(doc: IRDocument): TailwindIndex {
	const extra = new Map<IRNode, string[]>();
	const groups = new Map<IRNode, string>();
	const add = (n: IRNode, cls: string[]) => extra.set(n, [...(extra.get(n) ?? []), ...cls]);
	for (const r of doc.rules) {
		const target = ruleTarget(r.target);
		let variant = '';
		if (r.media) {
			const m = /max-width:\s*(\d+)px/.exec(r.media);
			if (!m) continue;
			variant = `max-[${m[1]}px]:`;
		}
		if (r.scope) {
			const pseudo = PSEUDO_VARIANT[r.scope.pseudo];
			if (!pseudo) continue;
			if (r.scope.node === r.target) variant += `${pseudo}:`;
			else {
				let g = groups.get(r.scope.node);
				if (!g) {
					g = `g${groups.size + 1}`;
					groups.set(r.scope.node, g);
				}
				variant += `group-${pseudo}/${g}:`;
			}
		}
		if (r.pseudo) variant += `${PSEUDO_VARIANT[r.pseudo] ?? ''}:`;
		add(target, toUtilities(r.style).classes.map((c) => variant + c));
	}
	return { extra, groups };
}

const camel = (k: string) => k.replace(/^-webkit-/, 'Webkit-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function jsxText(s: string): string {
	return escapeHtml(s).replace(/[{}]/g, (c) => `{'${c}'}`);
}

function svgMarkup(bytes: Uint8Array, cls: string, alt: string, dialect: Dialect, seq: number): string | null {
	if (!bytes.length || typeof TextDecoder === 'undefined') return null;
	let svg = new TextDecoder().decode(bytes).replace(/<\?xml[^>]*>\s*/, '').trim();
	if (!svg.startsWith('<svg')) return null;
	const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
	for (const id of ids) {
		const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		svg = svg
			.replace(new RegExp(`id="${safe}"`, 'g'), `id="s${seq}-${id}"`)
			.replace(new RegExp(`url\\(#${safe}\\)`, 'g'), `url(#s${seq}-${id})`)
			.replace(new RegExp(`href="#${safe}"`, 'g'), `href="#s${seq}-${id}"`);
	}
	const label = alt ? ` role="img" aria-label="${escapeAttr(alt)}"` : ' aria-hidden="true"';
	svg = svg.replace(/<svg\b/, `<svg class="${cls}"${label}`);
	if (dialect === 'jsx') {
		svg = svg
			.replace(/\sclass="/g, ' className="')
			.replace(/\s(xlink|xml):([a-z]+)=/g, (_, ns: string, name: string) => ` ${ns}${name[0].toUpperCase()}${name.slice(1)}=`)
			.replace(/\s((?!data-|aria-)[a-z]+(?:-[a-z]+)+)=/g, (_, name: string) => ` ${camel(name)}=`);
	}
	return svg.replace(/>\s+</g, '><');
}

export function renderMarkup(doc: IRDocument, pageIndex: number, opts: RenderOptions): string {
	return renderNodes(doc, doc.pages[pageIndex].roots, opts);
}

/** Braces and mustaches that a framework template would otherwise read as expressions. */
function escapeTemplate(s: string, templating: Templating | undefined): string {
	if (templating === 'svelte') return s.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));
	if (templating === 'vue') return s.replace(/\{\{/g, '&#123;&#123;').replace(/\}\}/g, '&#125;&#125;');
	return s;
}

function expression(name: string, templating: Templating | undefined, attr?: string): string {
	if (templating === 'vue') return attr ? ` :${attr}="${name}"` : `{{ ${name} }}`;
	return attr ? ` ${attr}={${name}}` : `{${name}}`;
}

export function renderNodes(doc: IRDocument, roots: IRNode[], opts: RenderOptions): string {
	const dialect = opts.dialect ?? 'html';
	const styling = opts.styling ?? 'css';
	const templating: Templating | undefined = dialect === 'jsx' ? 'jsx' : opts.templating;
	const resolve = assetResolver(opts.assets, opts.assetMode, opts.assetPrefix);
	const shared = new Map(doc.sharedClasses.map((c) => [c.name, c.style]));
	const tw = styling === 'tailwind' ? tailwindIndex(doc) : null;
	const classAttr = dialect === 'jsx' ? 'className' : 'class';
	const seq = opts.svgSeq ?? { n: 0 };

	const merged = (n: IRNode): Style => Object.assign({}, ...n.shared.map((s) => shared.get(s) ?? {}), n.style);

	const styleAttr = (style: Style): string => {
		const entries = Object.entries(style);
		if (!entries.length) return '';
		if (dialect === 'jsx') return ` style={{ ${entries.map(([k, v]) => `${camel(k)}: ${JSON.stringify(resolve(v))}`).join(', ')} }}`;
		return ` style="${escapeAttr(entries.map(([k, v]) => `${k}: ${resolve(v)}`).join('; '))}"`;
	};

	/** class and style attributes for a node or run. */
	const presentation = (node: IRNode | null, style: Style, classes: string[]): string => {
		if (dialect === 'email') return styleAttr(style);
		if (tw) {
			const u = toUtilities(style);
			const list = [...u.classes];
			if (node) {
				const g = tw.groups.get(node);
				if (g) list.unshift(`group/${g}`);
				list.push(...(tw.extra.get(node) ?? []));
			}
			return (list.length ? ` ${classAttr}="${list.join(' ')}"` : '') + styleAttr(u.inline);
		}
		return classes.length ? ` ${classAttr}="${classes.join(' ')}"` : '';
	};

	const text = (s: string) =>
		dialect === 'jsx'
			? jsxText(s).replace(/\r\n|\n|\u2028|\u2029/g, '<br />')
			: escapeTemplate(escapeHtml(s), templating).replace(/\r\n|\n|\u2028|\u2029/g, '<br>');
	const attrValue = (v: string) => escapeTemplate(escapeAttr(v), templating === 'jsx' ? undefined : templating);

	const renderRuns = (node: IRNode, bound?: string): string => {
		const inner = (node.runs ?? [])
			.map((run, i) => {
				const body = bound && i === 0 ? expression(bound, templating) : text(run.text);
				const attrs = presentation(null, run.style, run.className ? [run.className] : []);
				if (run.href) return `<a href="${attrValue(run.href)}"${attrs}>${body}</a>`;
				return attrs ? `<span${attrs}>${body}</span>` : body;
			})
			.join('');
		if (node.tag === 'select') return `<option>${inner}</option>`;
		return node.wrapRuns ? `<span>${inner}</span>` : inner;
	};

	const renderNode = (node: IRNode, depth: number): string => {
		const pad = '  '.repeat(depth);
		const replaced = opts.replace?.(node, pad);
		if (replaced != null) return replaced;
		const style = dialect === 'email' || tw ? merged(node) : {};
		const usage = opts.use?.(node);
		if (usage) {
			const cls = /\b(?:class|className)="([^"]*)"/.exec(presentation(node, style, classList(node)))?.[1];
			const classProp = cls ? ` ${templating === 'jsx' ? 'className' : 'class'}="${cls}"` : '';
			const props = usage.props.map(([k, v]) => ` ${k}="${attrValue(v)}"`).join('');
			return `${pad}<${usage.name}${classProp}${props} />`;
		}
		const binding = opts.bind?.(node) ?? null;
		const alt = node.attrs.alt ?? '';
		if (node.svgAsset && opts.inlineSvg && dialect !== 'email' && !binding?.src) {
			const asset = opts.assets.get(node.svgAsset);
			const cls = tw ? toUtilities(style).classes.join(' ') : classList(node).join(' ');
			const svg = asset && svgMarkup(asset.bytes, cls, alt, dialect, ++seq.n);
			if (svg) return pad + escapeTemplate(svg, templating === 'jsx' ? undefined : templating);
		}

		// Classless list wrappers get display: contents from the reset stylesheet.
		let attrs = node.wrapper && !tw && dialect !== 'email' ? '' : presentation(node, style, classList(node));
		if (binding?.className) {
			// Vue passes a class given to the component through to its root element on its own.
			const cls = templating === 'vue' ? '' : expression(binding.className, templating, templating === 'jsx' ? 'className' : 'class');
			attrs = attrs.replace(/\s(?:class|className)="[^"]*"/, '') + cls;
		}
		for (const [k, v] of Object.entries(node.attrs)) {
			const name = dialect === 'jsx' && k === 'for' ? 'htmlFor' : k;
			const bound = binding?.[k as keyof Binding];
			attrs += bound ? expression(bound, templating, name) : ` ${name}="${attrValue(resolve(v))}"`;
		}
		if (node.link) {
			attrs += binding?.href
				? expression(binding.href, templating, 'href')
				: ` href="${attrValue(opts.linkHref ? opts.linkHref(node.link) : '#')}"`;
		}

		const open = `<${node.tag}${attrs}`;
		if (VOID_TAGS.has(node.tag)) return `${pad}${open}${dialect === 'jsx' ? ' />' : '>'}`;
		if (node.runs) return `${pad}${open}>${renderRuns(node, binding?.text)}</${node.tag}>`;
		if (node.children.length === 0) return `${pad}${open}></${node.tag}>`;
		return [`${pad}${open}>`, ...node.children.map((c) => renderNode(c, depth + 1)), `${pad}</${node.tag}>`].join('\n');
	};

	return roots.map((n) => renderNode(n, 0)).join('\n');
}

import type { RawAutoLayout, RawNode, ReadResult } from '../shared/types';
import { mergeBreakpoint, mergeState, type MergeCtx } from './diff';
import { effectStyle, strokeStyle } from './effects';
import { isCommercial } from './fonts';
import { cssColor, cssSlug, num, px, slugify, type Style, type StyleCtx, type Units } from './format';
import { primaryClass, walk, type FontUse, type IRDocument, type IRNode, type IRPage, type IRRule, type IRVariable, type IRWarning } from './ir';
import { backgroundStyle, imageElementStyle } from './paint';
import { shareClasses } from './share';
import { buildText } from './text';

export type BuildOptions = { decimals: number; useVariables: boolean; units?: Units; shareClasses?: boolean };

/** real: registers classes · dry: temporary tree for diffing · silent: dry without warnings */
type Mode = 'real' | 'dry' | 'silent';

const BLEND: Record<string, string> = {
	DARKEN: 'darken',
	MULTIPLY: 'multiply',
	COLOR_BURN: 'color-burn',
	LIGHTEN: 'lighten',
	SCREEN: 'screen',
	LINEAR_DODGE: 'plus-lighter',
	COLOR_DODGE: 'color-dodge',
	OVERLAY: 'overlay',
	SOFT_LIGHT: 'soft-light',
	HARD_LIGHT: 'hard-light',
	DIFFERENCE: 'difference',
	EXCLUSION: 'exclusion',
	HUE: 'hue',
	SATURATION: 'saturation',
	COLOR: 'color',
	LUMINOSITY: 'luminosity',
};

const CONTROL_TAGS = new Set(['input', 'textarea', 'select']);

const TAG_RULES: [RegExp, string][] = [
	[/\b(textarea|text area|message field|message box)\b/, 'textarea'],
	[/\b(input|text field|textfield|search field|search bar|search box|email field|password field)\b/, 'input'],
	[/\b(select|dropdown|drop down|combobox)\b/, 'select'],
	[/\bform\b/, 'form'],
	[/\b(ol|ordered list)\b/, 'ol'],
	[/\b(ul|list|links|menu items|nav items)\b/, 'ul'],
	[/\b(header|topbar|top bar)\b/, 'header'],
	[/\bfooter\b/, 'footer'],
	[/\b(nav|navbar|navigation)\b/, 'nav'],
	[/\bmain\b/, 'main'],
	[/\bsection\b/, 'section'],
	[/\b(aside|sidebar)\b/, 'aside'],
	[/\barticle\b/, 'article'],
	[/\bfigure\b/, 'figure'],
	[/\b(button|btn|cta)\b/, 'button'],
	[/\blink\b/, 'a'],
];

const INPUT_TYPES: [RegExp, string][] = [
	[/email/, 'email'],
	[/password/, 'password'],
	[/search/, 'search'],
	[/\b(phone|tel)\b/, 'tel'],
	[/\b(number|qty|quantity)\b/, 'number'],
	[/\b(url|website)\b/, 'url'],
];

const CONTROL_TEXT_KEYS = [
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'line-height',
	'letter-spacing',
	'text-transform',
	'text-align',
	'color',
];

const PSEUDO = { hover: ':hover', focus: ':focus-visible', active: ':active' } as const;

const ALIGN_ITEMS = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' } as const;
const JUSTIFY = { MIN: '', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' } as const;
const SELF_ALIGN: Record<string, string> = { MIN: 'start', CENTER: 'center', MAX: 'end' };

const PAGE_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE']);
const BP_WORDS = 'desktop|laptop|tablet|ipad|mobile|phone|iphone|android';
const BP_SUFFIX = new RegExp(`[\\s/|:@(\\[_–—-]+(${BP_WORDS}|\\d{3,4}\\s*px)[\\])]?\\s*$`, 'i');
const BP_PREFIX = new RegExp(`^\\s*(${BP_WORDS}|\\d{3,4}\\s*px)[\\s/|:@_–—-]+`, 'i');
const BP_BOUNDS = [768, 1024, 1280, 1440, 1920];

/** Page name without a breakpoint marker: "Home / Mobile" → "Home". */
export function pageKey(name: string): string {
	const t = name.trim();
	return t.replace(BP_SUFFIX, '').replace(BP_PREFIX, '').trim() || t;
}

/** max-width for a frame of width `small` next to a larger frame: snaps to common device boundaries. */
export function breakpointFor(small: number, large: number): number {
	const bound = BP_BOUNDS.find((b) => b > small) ?? Math.ceil(small) + 1;
	return Math.min(Math.floor(large) - 1, bound - 1);
}

type Group = { key: string; frames: RawNode[] };

/** Several top-level frames become a site: one page per name, frames sharing a name become breakpoints. */
function groupPages(roots: RawNode[]): Group[] | null {
	if (roots.length < 2 || !roots.every((r) => r.topLevel && PAGE_TYPES.has(r.type))) return null;
	const map = new Map<string, RawNode[]>();
	for (const r of roots) {
		const key = pageKey(r.name).toLowerCase();
		map.set(key, [...(map.get(key) ?? []), r]);
	}
	const groups: Group[] = [];
	for (const list of map.values()) {
		const sorted = [...list].sort((a, b) => b.width - a.width);
		const widths = new Set<number>();
		const frames: RawNode[] = [];
		const extra: RawNode[] = [];
		for (const f of sorted) {
			const w = Math.round(f.width);
			if (widths.has(w)) extra.push(f);
			else {
				widths.add(w);
				frames.push(f);
			}
		}
		groups.push({ key: pageKey(frames[0].name), frames });
		for (const e of extra) groups.push({ key: e.name, frames: [e] });
	}
	return groups;
}

export function buildDocument(result: ReadResult, opts: BuildOptions): IRDocument {
	const units = opts.units ?? 'px';
	const classes = new Set<string>();
	const counters = new Map<string, number>();
	const vars = new Map<string, IRVariable>();
	const varNames = new Set<string>();
	const warnings: IRWarning[] = [];
	const warnKeys = new Set<string>();
	const fonts = new Map<string, { weights: Set<number>; italic: Set<number>; nodeId: string; nodeName: string }>();
	const rules: IRRule[] = [];
	const irById = new Map<string, IRNode>();
	const svgAssets = new Set(result.assets.filter((a) => a.ext === 'svg').map((a) => a.id));

	const addWarning = (nodeId: string, nodeName: string, code: string, detail?: string) => {
		const key = `${code}|${nodeId}|${detail ?? ''}`;
		if (warnKeys.has(key)) return;
		warnKeys.add(key);
		warnings.push({ nodeId, nodeName, code, detail });
	};
	for (const w of result.warnings) addWarning(w.nodeId, w.nodeName, w.code, w.detail);

	const length = (n: number) => px(n, opts.decimals, units);

	const variableRef = (id: string, literal: string, raw: RawNode): string => {
		const meta = result.variables[id];
		if (!opts.useVariables || !meta) return literal;
		const existing = vars.get(id);
		if (existing) {
			if (existing.value === literal) return `var(${existing.name})`;
			addWarning(raw.id, raw.name, 'VARIABLE_MODE_CONFLICT', meta.name);
			return literal;
		}
		let name = `--${cssSlug(meta.name)}`;
		if (varNames.has(name)) name = `--${cssSlug(meta.collection)}-${cssSlug(meta.name)}`;
		for (let i = 2; varNames.has(name); i++) name = `--${cssSlug(meta.name)}-${i}`;
		varNames.add(name);
		vars.set(id, { name, value: literal });
		return `var(${name})`;
	};

	const makeCtx = (raw: RawNode, mode: Mode): StyleCtx => ({
		px: length,
		len: (n, varId) => (varId ? variableRef(varId, length(n), raw) : length(n)),
		color: (c, varId) => (varId ? variableRef(varId, cssColor(c), raw) : cssColor(c)),
		asset: (id) => `__ASSET__${id}__`,
		warn: (code, detail) => {
			if (mode !== 'silent') addWarning(raw.id, raw.name, code, detail);
		},
	});

	const claim = (base: string): string => {
		if (base.endsWith('-?')) {
			const prefix = base.slice(0, -2);
			let name: string;
			do {
				const n = (counters.get(prefix) ?? 0) + 1;
				counters.set(prefix, n);
				name = `${prefix}-${n}`;
			} while (classes.has(name));
			classes.add(name);
			return name;
		}
		let name = base;
		for (let i = 2; classes.has(name); i++) name = `${base}-${i}`;
		classes.add(name);
		return name;
	};

	const classBase = (raw: RawNode, tag: string): string => {
		let base = slugify(raw.name);
		if (base && raw.type === 'TEXT') base = base.split('-').slice(0, 4).join('-');
		if (base) return base;
		return `${raw.type === 'TEXT' ? 'text' : tag === 'img' ? 'img' : 'box'}-?`;
	};

	/** Gives a dry-built subtree real class names (used for layers that only exist at a smaller breakpoint). */
	const realize = (root: IRNode) =>
		walk([root], (n) => {
			irById.set(n.id, n);
			if (!n.className) return;
			const old = n.className;
			n.className = claim(old);
			for (const r of n.runs ?? []) if (r.className?.startsWith(`${old}-span-`)) r.className = n.className + r.className.slice(old.length);
		});

	const onFont = (raw: RawNode) => (family: string, weight: number, italic: boolean) => {
		const entry = fonts.get(family) ?? { weights: new Set<number>(), italic: new Set<number>(), nodeId: raw.id, nodeName: raw.name };
		(italic ? entry.italic : entry.weights).add(weight);
		fonts.set(family, entry);
	};

	const buildNode = (raw: RawNode, parent: RawNode | null, parentTag: string, interactive: boolean, mode: Mode): IRNode | null => {
		const ctx = makeCtx(raw, mode);
		if (raw.isMask) {
			ctx.warn('MASK_SKIPPED');
			return null;
		}
		const attrs: Record<string, string> = {};
		const alt = slugify(raw.name) ? raw.name : '';
		const leafShape = (raw.type === 'RECTANGLE' || raw.type === 'ELLIPSE') && raw.children.length === 0;
		const image = leafShape && !raw.exportAsset ? imageElementStyle(raw.fills, ctx) : null;

		let tag: string;
		let textHref: string | undefined;
		if (raw.exportAsset) {
			tag = 'img';
			attrs.src = ctx.asset(raw.exportAsset);
			attrs.alt = alt;
		} else if (image?.assetId) {
			tag = 'img';
			attrs.src = ctx.asset(image.assetId);
			attrs.alt = alt;
		} else if (raw.type === 'TEXT') {
			tag = textTag(raw, interactive, parentTag);
		} else {
			tag = containerTag(raw, interactive, parentTag);
		}
		const control = CONTROL_TAGS.has(tag);

		const base = classBase(raw, tag);
		const cls = mode === 'real' ? claim(base) : base;
		const style: Style = {};
		Object.assign(style, layoutStyle(raw, parent, ctx));
		if (raw.autoLayout) Object.assign(style, containerStyle(raw, raw.autoLayout, ctx));

		if (!raw.exportAsset) {
			if (raw.type === 'ELLIPSE') style['border-radius'] = '50%';
			else Object.assign(style, radiusStyle(raw, ctx));
			if (raw.clips) style.overflow = 'hidden';
			if (raw.opacity < 1) style.opacity = num(raw.opacity, 3);
		}
		if (raw.blendMode !== 'PASS_THROUGH' && raw.blendMode !== 'NORMAL') {
			if (BLEND[raw.blendMode]) style['mix-blend-mode'] = BLEND[raw.blendMode];
			else ctx.warn('BLEND_MODE_UNSUPPORTED', raw.blendMode);
		}

		let runs: IRNode['runs'];
		let wrapRuns = false;
		if (!raw.exportAsset) {
			if (tag === 'img' && image) Object.assign(style, image.style);
			else if (raw.type !== 'TEXT') Object.assign(style, backgroundStyle(raw.fills, raw.width, raw.height, ctx));

			const stroke = strokeStyle(raw, ctx);
			const effects = effectStyle(raw, ctx);
			Object.assign(style, stroke.style, effects.style);
			const shadows = [...stroke.shadows, ...effects.shadows];
			if (shadows.length) style['box-shadow'] = shadows.join(', ');
			if (effects.textShadows.length) style['text-shadow'] = effects.textShadows.join(', ');

			if (raw.text) {
				const t = buildText(raw, cls, ctx, onFont(raw));
				Object.assign(style, t.style);
				runs = t.runs;
				wrapRuns = t.wrapRuns;
				textHref = t.href;
			}
		}

		let placeholderColor: string | undefined;
		if (control) {
			const textRaw = firstText(raw);
			const label = textRaw?.text?.segments.map((s) => s.text).join('') ?? '';
			if (textRaw) {
				const t = buildNode(textRaw, null, 'p', false, 'silent');
				for (const k of CONTROL_TEXT_KEYS) if (t?.style[k]) style[k] = t.style[k];
				placeholderColor = t?.style.color;
			}
			if (tag === 'select') {
				style.appearance = 'none';
				runs = [{ text: label, style: {} }];
			} else {
				if (tag === 'input') attrs.type = INPUT_TYPES.find(([re]) => re.test(words(raw.name)))?.[1] ?? 'text';
				attrs.placeholder = label;
			}
			ctx.warn('FORM_CONTROL_SIMPLIFIED');
		}

		const link = raw.link;
		const linkable = tag !== 'img' && !control && !interactive;
		if (raw.type === 'TEXT' && textHref && !interactive) {
			tag = 'a';
			attrs.href = textHref;
			runs = runs?.map((r) => ({ ...r, href: undefined }));
		} else if (link && linkable) {
			tag = 'a';
		}
		let linkNodeId: string | undefined;
		if (tag === 'a' && !attrs.href) {
			if (link?.url) {
				attrs.href = link.url;
				if (link.newTab) {
					attrs.target = '_blank';
					attrs.rel = 'noopener';
				}
			} else if (link?.nodeId) {
				linkNodeId = link.nodeId;
			} else {
				attrs.href = '#';
				ctx.warn('PLACEHOLDER_HREF');
			}
		}
		if (tag === 'a' && raw.type !== 'TEXT' && !style.display) style.display = 'block';
		if (tag === 'button') attrs.type = 'button';

		const node: IRNode = { id: raw.id, name: raw.name, tag, className: cls, shared: [], style, attrs, children: [] };
		if (runs) {
			node.runs = runs;
			node.wrapRuns = wrapRuns;
		}
		if (raw.exportAsset && svgAssets.has(raw.exportAsset)) node.svgAsset = raw.exportAsset;
		if (linkNodeId) node.linkNodeId = linkNodeId;
		if (raw.component) {
			node.componentKey = raw.component.id;
			node.componentName = raw.component.name;
		}
		if (raw.text?.styleName) node.textStyle = raw.text.styleName;
		if (mode === 'real') {
			irById.set(raw.id, node);
			if (placeholderColor) rules.push({ target: node, pseudo: '::placeholder', style: { color: placeholderColor, opacity: '1' } });
		}
		if (control) return node;

		const childInteractive = interactive || tag === 'button' || tag === 'a';
		const list = tag === 'ul' || tag === 'ol';
		for (const child of raw.children) {
			const ir = buildNode(child, raw, tag, childInteractive, mode);
			if (!ir) continue;
			if (ir.style.position === 'absolute' && !style.position) style.position = 'relative';
			if (list && ir.tag !== 'li') {
				node.children.push({
					id: `${ir.id}:li`,
					name: ir.name,
					tag: 'li',
					className: '',
					shared: [],
					style: { display: 'contents' },
					attrs: {},
					wrapper: true,
					children: [ir],
				});
			} else node.children.push(ir);
		}

		if (mode === 'real' && raw.states) {
			for (const s of raw.states) {
				const tree = buildNode(s.node, null, parentTag, interactive, 'silent');
				if (tree) mergeState(node, tree, PSEUDO[s.state], rules);
			}
		}
		return node;
	};

	const fluidRoot = (node: IRNode, raw: RawNode) => {
		node.style.width = '100%';
		delete node.style.height;
		if (raw.height > 0) node.style['min-height'] = length(raw.height);
	};

	const pages: IRPage[] = [];
	const media: { query: string; width: number }[] = [];
	const rootPage = new Map<string, number>();
	const slugs = new Set<string>();
	const groups = groupPages(result.roots);

	if (!groups) {
		const roots = result.roots.map((r) => buildNode(r, null, 'body', false, 'real')).filter((n): n is IRNode => n !== null);
		const title = result.roots[0]?.name ?? 'Export';
		pages.push({ name: title, slug: 'index', title, roots });
	} else {
		groups.forEach((group, pageIndex) => {
			const [baseRaw, ...others] = group.frames;
			const root = buildNode(baseRaw, null, 'body', false, 'real');
			rootPage.set(baseRaw.id, pageIndex);
			if (!root) return;
			const effective = new Map<IRNode, Style>();
			if (others.length) fluidRoot(root, baseRaw);
			const ctx: MergeCtx = {
				rules,
				effective,
				realize,
				warn: (n, code) => addWarning(n.id, n.name, code),
			};
			others.forEach((raw, i) => {
				rootPage.set(raw.id, pageIndex);
				const tree = buildNode(raw, null, 'body', false, 'dry');
				if (!tree) return;
				fluidRoot(tree, raw);
				const width = breakpointFor(raw.width, group.frames[i].width);
				const query = `(max-width: ${width}px)`;
				if (!media.some((m) => m.query === query)) media.push({ query, width });
				mergeBreakpoint(root, tree, query, ctx);
			});
			let slug = pages.length === 0 ? 'index' : cssSlug(group.key, 'page');
			for (let i = 2; slugs.has(slug); i++) slug = `${cssSlug(group.key, 'page')}-${i}`;
			slugs.add(slug);
			pages.push({ name: group.key, slug, title: group.key, roots: [root] });
		});
	}

	// Resolve prototype links now that every page and element exists.
	const pageOf = new Map<IRNode, number>();
	pages.forEach((p, i) => walk(p.roots, (n) => pageOf.set(n, i)));
	const ids = new Set<string>();
	pages.forEach((p) =>
		walk(p.roots, (n) => {
			const id = n.linkNodeId;
			if (!id) return;
			delete n.linkNodeId;
			const page = groups ? rootPage.get(id) : undefined;
			const target = irById.get(id);
			if (page !== undefined) n.link = { page };
			else if (target && pageOf.has(target)) {
				if (!target.attrs.id) {
					let anchor = primaryClass(target) || 'section';
					for (let i = 2; ids.has(anchor); i++) anchor = `${primaryClass(target)}-${i}`;
					ids.add(anchor);
					target.attrs.id = anchor;
				}
				n.link = { page: pageOf.get(target)!, anchor: target };
			} else {
				n.link = { unresolved: true };
				addWarning(n.id, n.name, 'LINK_TARGET_OUTSIDE');
			}
		}),
	);

	const fontList: FontUse[] = [];
	for (const [family, use] of fonts) {
		const sort = (s: Set<number>) => [...s].sort((a, b) => a - b);
		fontList.push({ family, weights: sort(use.weights), italicWeights: sort(use.italic) });
		if (isCommercial(family)) addWarning(use.nodeId, use.nodeName, 'CUSTOM_FONT_NOT_EMBEDDED', family);
	}

	const doc: IRDocument = {
		title: pages[0]?.title ?? 'Export',
		pages,
		rules,
		sharedClasses: [],
		media: media.sort((a, b) => b.width - a.width).map((m) => m.query),
		variables: [...vars.values()],
		fonts: fontList,
		warnings,
	};
	if (opts.shareClasses) shareClasses(doc);
	return doc;
}

function firstText(raw: RawNode): RawNode | undefined {
	for (const c of raw.children) {
		if (c.type === 'TEXT') return c;
		const found = firstText(c);
		if (found) return found;
	}
	return undefined;
}

function words(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function containerTag(raw: RawNode, interactive: boolean, parentTag: string): string {
	if (raw.type === 'SECTION') return 'section';
	const w = words(raw.name);
	if ((parentTag === 'ul' || parentTag === 'ol') && /\b(li|list item|item)\b/.test(w)) return 'li';
	for (const [re, tag] of TAG_RULES) {
		if (!re.test(w)) continue;
		if (interactive && (tag === 'button' || tag === 'a' || CONTROL_TAGS.has(tag) || tag === 'form')) continue;
		return tag;
	}
	return 'div';
}

function textTag(raw: RawNode, interactive: boolean, parentTag: string): string {
	if (interactive) return 'span';
	for (const source of [raw.name, raw.text?.styleName ?? '']) {
		const m = /^h([1-6])\b/i.exec(source.trim()) ?? /heading[\s/_-]*([1-6])/i.exec(source);
		if (m) return `h${m[1]}`;
	}
	const w = words(raw.name);
	if (parentTag === 'figure' && /\bcaption\b/.test(w)) return 'figcaption';
	if (/\blabel\b/.test(w)) return 'label';
	return 'p';
}

function transformStyle(linear: [number, number, number, number], inFlow: boolean, ctx: StyleCtx): Style {
	const [a, b, c, d] = linear;
	const identity = Math.abs(a - 1) < 1e-6 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && Math.abs(d - 1) < 1e-6;
	if (identity) return {};
	const isRotation = Math.abs(a - d) < 1e-4 && Math.abs(b + c) < 1e-4 && Math.abs(a * a + b * b - 1) < 1e-3;
	const rotate = `rotate(${num((Math.atan2(b, a) * 180) / Math.PI, 2)}deg)`;
	if (inFlow) {
		ctx.warn('ROTATION_APPROXIMATE');
		return { transform: isRotation ? rotate : `matrix(${[a, b, c, d].map((v) => num(v, 4)).join(', ')}, 0, 0)` };
	}
	return {
		'transform-origin': '0 0',
		transform: isRotation ? rotate : `matrix(${[a, b, c, d].map((v) => num(v, 4)).join(', ')}, 0, 0)`,
	};
}

function layoutStyle(raw: RawNode, parent: RawNode | null, ctx: StyleCtx): Style {
	const s: Style = {};
	const pl: RawAutoLayout | undefined = parent?.autoLayout;
	const ch = raw.child;
	const hugW = raw.text?.autoResize === 'WIDTH_AND_HEIGHT';
	const hugH = hugW || raw.text?.autoResize === 'HEIGHT';
	const width = () => ctx.len(raw.width, raw.vars.width);
	const height = () => ctx.len(raw.height, raw.vars.height);

	if (pl && ch && !ch.absolute) {
		if (pl.mode === 'GRID') {
			if (ch.grid) {
				s['grid-row'] = `${ch.grid.row + 1} / span ${ch.grid.rowSpan}`;
				s['grid-column'] = `${ch.grid.col + 1} / span ${ch.grid.colSpan}`;
			}
			const h = SELF_ALIGN[ch.grid?.hAlign ?? ''];
			const v = SELF_ALIGN[ch.grid?.vAlign ?? ''];
			if (ch.sizingH === 'FIXED') s.width = width();
			if (ch.sizingH !== 'FILL' || h) s['justify-self'] = h ?? 'start';
			if (ch.sizingV === 'FIXED') s.height = height();
			if (ch.sizingV !== 'FILL' || v) s['align-self'] = v ?? 'start';
		} else {
			const horizontal = pl.mode === 'HORIZONTAL';
			const main = horizontal ? ch.sizingH : ch.sizingV;
			const cross = horizontal ? ch.sizingV : ch.sizingH;
			const mainDim = horizontal ? 'width' : 'height';
			const crossDim = horizontal ? 'height' : 'width';
			if (main === 'FILL') {
				s.flex = '1 1 0';
				s[`min-${mainDim}`] = '0';
			} else {
				s['flex-shrink'] = '0';
				if (main === 'FIXED') s[mainDim] = horizontal ? width() : height();
			}
			if (cross === 'FILL') s['align-self'] = 'stretch';
			else if (cross === 'FIXED') s[crossDim] = horizontal ? height() : width();
		}
		Object.assign(s, transformStyle(raw.linear, true, ctx));
	} else if (parent) {
		s.position = 'absolute';
		s.left = ctx.px(raw.x);
		s.top = ctx.px(raw.y);
		if (!hugW) s.width = width();
		if (!hugH) s.height = height();
		Object.assign(s, transformStyle(raw.linear, false, ctx));
	} else {
		if (!hugW) s.width = width();
		if (!hugH) s.height = height();
	}

	const { minW, maxW, minH, maxH } = raw.minMax;
	if (minW != null) s['min-width'] = ctx.len(minW, raw.vars.minWidth);
	if (maxW != null) s['max-width'] = ctx.len(maxW, raw.vars.maxWidth);
	if (minH != null) s['min-height'] = ctx.len(minH, raw.vars.minHeight);
	if (maxH != null) s['max-height'] = ctx.len(maxH, raw.vars.maxHeight);
	return s;
}

function boxShorthand(values: string[]): string {
	const [t, r, b, l] = values;
	if (t === r && r === b && b === l) return t;
	if (t === b && r === l) return `${t} ${r}`;
	return values.join(' ');
}

function containerStyle(raw: RawNode, al: RawAutoLayout, ctx: StyleCtx): Style {
	const s: Style = {};
	const v = raw.vars;
	if (al.mode === 'GRID' && al.grid) {
		const track = (t: { type: string; value?: number }) =>
			t.type === 'FIXED' ? ctx.px(t.value ?? 0) : t.type === 'HUG' ? 'auto' : `minmax(0, ${num(t.value ?? 1, 2)}fr)`;
		s.display = 'grid';
		if (al.grid.cols.length) s['grid-template-columns'] = al.grid.cols.map(track).join(' ');
		if (al.grid.rows.length) s['grid-template-rows'] = al.grid.rows.map(track).join(' ');
		const rowGap = ctx.len(al.grid.rowGap, v.gridRowGap);
		const colGap = ctx.len(al.grid.colGap, v.gridColumnGap);
		if (rowGap !== '0' || colGap !== '0') s.gap = rowGap === colGap ? rowGap : `${rowGap} ${colGap}`;
	} else {
		s.display = 'flex';
		if (al.mode === 'VERTICAL') s['flex-direction'] = 'column';
		const justify = JUSTIFY[al.primaryAlign];
		if (justify) s['justify-content'] = justify;
		s['align-items'] = ALIGN_ITEMS[al.counterAlign];
		const between = al.primaryAlign === 'SPACE_BETWEEN';
		if (al.itemSpacing < 0) ctx.warn('NEGATIVE_SPACING');
		const item = between || al.itemSpacing <= 0 ? '0' : ctx.len(al.itemSpacing, v.itemSpacing);
		if (al.wrap) {
			s['flex-wrap'] = 'wrap';
			s['align-content'] = al.alignContentBetween ? 'space-between' : 'flex-start';
			const counter = al.counterSpacing > 0 ? ctx.len(al.counterSpacing, v.counterAxisSpacing) : '0';
			if (counter !== '0' || item !== '0') s.gap = counter === item ? item : `${counter} ${item}`;
		} else if (item !== '0') {
			s.gap = item;
		}
	}
	const [t, r, b, l] = al.padding;
	if (t || r || b || l) {
		s.padding = boxShorthand([
			ctx.len(t, v.paddingTop),
			ctx.len(r, v.paddingRight),
			ctx.len(b, v.paddingBottom),
			ctx.len(l, v.paddingLeft),
		]);
	}
	if (al.reverseZ) ctx.warn('REVERSE_Z_IGNORED');
	return s;
}

function radiusStyle(raw: RawNode, ctx: StyleCtx): Style {
	const [tl, tr, br, bl] = raw.radii;
	if (!tl && !tr && !br && !bl) return {};
	const v = raw.vars;
	if (tl === tr && tr === br && br === bl)
		return { 'border-radius': ctx.len(tl, v.cornerRadius ?? v.topLeftRadius) };
	return {
		'border-radius': [
			ctx.len(tl, v.topLeftRadius),
			ctx.len(tr, v.topRightRadius),
			ctx.len(br, v.bottomRightRadius),
			ctx.len(bl, v.bottomLeftRadius),
		].join(' '),
	};
}

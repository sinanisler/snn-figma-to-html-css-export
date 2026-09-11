import type { RawAutoLayout, RawNode, ReadResult } from '../shared/types';
import { effectStyle, strokeStyle } from './effects';
import { cssColor, num, px, slugify, type Style, type StyleCtx } from './format';
import type { FontUse, IRDocument, IRNode, IRVariable, IRWarning } from './ir';
import { backgroundStyle, imageElementStyle } from './paint';
import { buildText } from './text';

export type BuildOptions = { decimals: number; useVariables: boolean };

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

const TAG_RULES: [RegExp, string][] = [
	[/\b(header|topbar|top bar)\b/, 'header'],
	[/\bfooter\b/, 'footer'],
	[/\b(nav|navbar|navigation)\b/, 'nav'],
	[/\bmain\b/, 'main'],
	[/\bsection\b/, 'section'],
	[/\b(aside|sidebar)\b/, 'aside'],
	[/\barticle\b/, 'article'],
	[/\b(button|btn|cta)\b/, 'button'],
	[/\blink\b/, 'a'],
];

const WEB_SAFE_FONTS = new Set([
	'arial',
	'helvetica',
	'helvetica neue',
	'georgia',
	'times',
	'times new roman',
	'verdana',
	'tahoma',
	'trebuchet ms',
	'courier',
	'courier new',
	'system-ui',
]);

const ALIGN_ITEMS = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' } as const;
const JUSTIFY = { MIN: '', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' } as const;
const SELF_ALIGN: Record<string, string> = { MIN: 'start', CENTER: 'center', MAX: 'end' };

const cssSlug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'var';

export function buildDocument(result: ReadResult, opts: BuildOptions): IRDocument {
	const classes = new Set<string>();
	const counters = new Map<string, number>();
	const vars = new Map<string, IRVariable>();
	const varNames = new Set<string>();
	const warnings: IRWarning[] = [];
	const warnKeys = new Set<string>();
	const fonts = new Map<string, { weights: Set<number>; nodeId: string; nodeName: string }>();

	const addWarning = (nodeId: string, nodeName: string, code: string, detail?: string) => {
		const key = `${code}|${nodeId}|${detail ?? ''}`;
		if (warnKeys.has(key)) return;
		warnKeys.add(key);
		warnings.push({ nodeId, nodeName, code, detail });
	};
	for (const w of result.warnings) addWarning(w.nodeId, w.nodeName, w.code, w.detail);

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

	const makeCtx = (raw: RawNode): StyleCtx => ({
		px: (n) => px(n, opts.decimals),
		len: (n, varId) => (varId ? variableRef(varId, px(n, opts.decimals), raw) : px(n, opts.decimals)),
		color: (c, varId) => (varId ? variableRef(varId, cssColor(c), raw) : cssColor(c)),
		asset: (id) => `__ASSET__${id}__`,
		warn: (code, detail) => addWarning(raw.id, raw.name, code, detail),
	});

	const className = (raw: RawNode, tag: string): string => {
		let base = slugify(raw.name);
		if (base && raw.type === 'TEXT') base = base.split('-').slice(0, 4).join('-');
		if (!base) {
			const prefix = raw.type === 'TEXT' ? 'text' : tag === 'img' ? 'img' : 'box';
			const n = (counters.get(prefix) ?? 0) + 1;
			counters.set(prefix, n);
			base = `${prefix}-${n}`;
		}
		let name = base;
		for (let i = 2; classes.has(name); i++) name = `${base}-${i}`;
		classes.add(name);
		return name;
	};

	const onFont = (raw: RawNode) => (family: string, weight: number) => {
		const entry = fonts.get(family) ?? { weights: new Set<number>(), nodeId: raw.id, nodeName: raw.name };
		entry.weights.add(weight);
		fonts.set(family, entry);
	};

	const buildNode = (raw: RawNode, parent: RawNode | null, interactive: boolean): IRNode | null => {
		if (raw.isMask) {
			addWarning(raw.id, raw.name, 'MASK_SKIPPED');
			return null;
		}
		const ctx = makeCtx(raw);
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
			tag = textTag(raw, interactive);
		} else {
			tag = containerTag(raw, interactive);
		}

		const cls = className(raw, tag);
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

		if (raw.type === 'TEXT' && textHref && !interactive) {
			tag = 'a';
			attrs.href = textHref;
			runs = runs?.map((r) => ({ ...r, href: undefined }));
		} else if (tag === 'a') {
			attrs.href = '#';
			ctx.warn('PLACEHOLDER_HREF');
		}
		if (tag === 'button') attrs.type = 'button';

		const node: IRNode = { id: raw.id, name: raw.name, tag, className: cls, style, attrs, children: [] };
		if (runs) {
			node.runs = runs;
			node.wrapRuns = wrapRuns;
		}

		const childInteractive = interactive || tag === 'button' || tag === 'a';
		for (const child of raw.children) {
			const ir = buildNode(child, raw, childInteractive);
			if (!ir) continue;
			node.children.push(ir);
			if (ir.style.position === 'absolute' && !style.position) style.position = 'relative';
		}
		return node;
	};

	const roots = result.roots.map((r) => buildNode(r, null, false)).filter((n): n is IRNode => n !== null);

	const fontList: FontUse[] = [];
	for (const [family, use] of fonts) {
		fontList.push({ family, weights: [...use.weights].sort((a, b) => a - b) });
		if (!WEB_SAFE_FONTS.has(family.toLowerCase()))
			addWarning(use.nodeId, use.nodeName, 'CUSTOM_FONT_NOT_EMBEDDED', family);
	}

	return {
		title: result.roots[0]?.name ?? 'Export',
		roots,
		variables: [...vars.values()],
		fonts: fontList,
		warnings,
	};
}

function words(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function containerTag(raw: RawNode, interactive: boolean): string {
	if (raw.type === 'SECTION') return 'section';
	const w = words(raw.name);
	for (const [re, tag] of TAG_RULES) {
		if (!re.test(w)) continue;
		if ((tag === 'button' || tag === 'a') && interactive) continue;
		return tag;
	}
	return 'div';
}

function textTag(raw: RawNode, interactive: boolean): string {
	if (interactive) return 'span';
	for (const source of [raw.name, raw.text?.styleName ?? '']) {
		const m = /^h([1-6])\b/i.exec(source.trim()) ?? /heading[\s/_-]*([1-6])/i.exec(source);
		if (m) return `h${m[1]}`;
	}
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

import type { RawNode, RawTextSegment } from '../shared/types';
import { num, type Style, type StyleCtx } from './format';
import type { IRRun } from './ir';
import { textFillStyle } from './paint';

function genericFamily(family: string): string {
	if (/mono|code|courier|consol/i.test(family)) return 'monospace';
	if (/serif/i.test(family) && !/sans/i.test(family)) return 'serif';
	return 'sans-serif';
}

export function fontFamilyCss(family: string): string {
	return `'${family.replace(/'/g, "\\'")}', ${genericFamily(family)}`;
}

const TEXT_TRANSFORM: Record<string, [string, string]> = {
	UPPER: ['text-transform', 'uppercase'],
	LOWER: ['text-transform', 'lowercase'],
	TITLE: ['text-transform', 'capitalize'],
	SMALL_CAPS: ['font-variant', 'small-caps'],
	SMALL_CAPS_FORCED: ['font-variant', 'all-small-caps'],
};

const RESET_VALUES: Record<string, string> = {
	'font-style': 'normal',
	'line-height': 'normal',
	'letter-spacing': 'normal',
	'text-transform': 'none',
	'font-variant': 'normal',
	'text-decoration': 'none',
	background: 'none',
	'-webkit-background-clip': 'border-box',
	'background-clip': 'border-box',
};

function segmentStyle(seg: RawTextSegment, node: RawNode, ctx: StyleCtx): Style {
	const s: Style = {
		'font-family': fontFamilyCss(seg.fontFamily),
		'font-size': ctx.len(seg.fontSize, seg.vars.fontSize),
		'font-weight': String(seg.fontWeight),
	};
	if (seg.italic) s['font-style'] = 'italic';
	if (seg.lineHeight.unit === 'PIXELS') s['line-height'] = ctx.len(seg.lineHeight.value, seg.vars.lineHeight);
	else if (seg.lineHeight.unit === 'PERCENT') s['line-height'] = ctx.px((seg.lineHeight.value / 100) * seg.fontSize);
	const spacing =
		seg.letterSpacing.unit === 'PERCENT' ? (seg.letterSpacing.value / 100) * seg.fontSize : seg.letterSpacing.value;
	if (Math.abs(spacing) >= 0.005) s['letter-spacing'] = ctx.px(spacing);
	const transform = TEXT_TRANSFORM[seg.textCase];
	if (transform) s[transform[0]] = transform[1];
	if (seg.decoration === 'UNDERLINE') s['text-decoration'] = 'underline';
	else if (seg.decoration === 'STRIKETHROUGH') s['text-decoration'] = 'line-through';
	Object.assign(s, textFillStyle(seg.fills, node.width, node.height, ctx));
	return s;
}

export type TextResult = { style: Style; runs: IRRun[]; wrapRuns: boolean; href?: string };

export function buildText(
	node: RawNode,
	className: string,
	ctx: StyleCtx,
	onFont: (family: string, weight: number, italic: boolean) => void,
): TextResult {
	const text = node.text!;
	const segs = text.segments;
	const styles = segs.map((seg) => {
		onFont(seg.fontFamily, seg.fontWeight, seg.italic);
		return segmentStyle(seg, node, ctx);
	});

	// The element carries the dominant value of each property (weighted by characters);
	// runs only carry what differs, resetting properties they lack.
	const base: Style = {};
	const keys = new Set(styles.flatMap((s) => Object.keys(s)));
	for (const k of keys) {
		const weights = new Map<string | undefined, number>();
		styles.forEach((s, i) => weights.set(s[k], (weights.get(s[k]) ?? 0) + segs[i].text.length));
		let best: string | undefined;
		let bestWeight = -1;
		for (const [value, weight] of weights) {
			if (weight > bestWeight) {
				best = value;
				bestWeight = weight;
			}
		}
		if (best !== undefined) base[k] = best;
	}

	const runClasses = new Map<string, string>();
	const runs: IRRun[] = segs.map((seg, i) => {
		const diff: Style = {};
		for (const [k, v] of Object.entries(styles[i])) if (base[k] !== v) diff[k] = v;
		for (const k of Object.keys(base)) if (!(k in styles[i])) diff[k] = RESET_VALUES[k] ?? 'initial';
		let cls: string | undefined;
		if (Object.keys(diff).length) {
			const key = JSON.stringify(diff);
			cls = runClasses.get(key) ?? `${className}-span-${runClasses.size + 1}`;
			runClasses.set(key, cls);
		}
		return { text: seg.text, className: cls, style: diff, href: seg.href };
	});

	if (segs.some((s) => s.listType !== 'NONE')) ctx.warn('TEXT_LIST_SIMPLIFIED');
	if (segs.some((s) => s.paragraphSpacing > 0) && segs.some((s) => /\n/.test(s.text))) ctx.warn('PARAGRAPH_SPACING_IGNORED');

	const style: Style = { ...base };
	const align = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify', LEFT: '' }[text.alignH];
	if (align) style['text-align'] = align;

	let wrapRuns = false;
	const fixedHeight =
		(text.autoResize === 'NONE' || text.autoResize === 'TRUNCATE') && node.child?.sizingV !== 'HUG';
	if (text.truncate) {
		const lines = text.maxLines ?? 1;
		style.overflow = 'hidden';
		if (lines > 1) {
			style.display = '-webkit-box';
			style['-webkit-line-clamp'] = String(lines);
			style['-webkit-box-orient'] = 'vertical';
		} else {
			style['white-space'] = 'nowrap';
			style['text-overflow'] = 'ellipsis';
		}
	} else {
		if (text.autoResize === 'WIDTH_AND_HEIGHT') style['white-space'] = 'nowrap';
		if (fixedHeight && text.alignV !== 'TOP') {
			style.display = 'flex';
			style['flex-direction'] = 'column';
			style['justify-content'] = text.alignV === 'CENTER' ? 'center' : 'flex-end';
			wrapRuns = true;
		}
	}

	const hrefs = new Set(segs.map((s) => s.href));
	const href = hrefs.size === 1 ? segs[0]?.href : undefined;
	return { style, runs, wrapRuns, href };
}

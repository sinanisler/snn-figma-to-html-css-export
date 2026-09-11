import type { RawNode, RawPaint, RGBA } from '../shared/types';
import type { Style, StyleCtx } from './format';

export type EffectResult = { style: Style; shadows: string[]; textShadows: string[] };

function strokeColor(strokes: RawPaint[], ctx: StyleCtx): string | null {
	if (strokes.length > 1) ctx.warn('MULTIPLE_STROKES_SIMPLIFIED');
	const top = strokes[strokes.length - 1];
	if (!top) return null;
	if (top.type === 'SOLID') return ctx.color(top.color, top.colorVar);
	if (top.type === 'IMAGE' || top.type === 'UNSUPPORTED') {
		ctx.warn('STROKE_PAINT_UNSUPPORTED');
		return null;
	}
	ctx.warn('GRADIENT_STROKE_SIMPLIFIED');
	const first = top.stops[0];
	return first ? ctx.color(first.color, first.colorVar) : null;
}

/**
 * Figma strokes never affect layout unless "strokes included in layout" is on, so the
 * default mapping uses outline / inset shadows rather than border.
 */
export function strokeStyle(node: RawNode, ctx: StyleCtx): EffectResult {
	const out: EffectResult = { style: {}, shadows: [], textShadows: [] };
	const [t, r, b, l] = node.strokeWeights;
	if (node.strokes.length === 0 || (t === 0 && r === 0 && b === 0 && l === 0)) return out;
	const color = strokeColor(node.strokes, ctx);
	if (!color) return out;
	const lineStyle = node.dashed ? 'dashed' : 'solid';
	if (node.dashed) ctx.warn('DASH_PATTERN_APPROXIMATE');

	if (node.type === 'TEXT') {
		if (node.strokeAlign !== 'CENTER') ctx.warn('TEXT_STROKE_APPROXIMATE');
		out.style['-webkit-text-stroke'] = `${ctx.px(t)} ${color}`;
		return out;
	}

	const uniform = t === r && r === b && b === l;
	const weightVar = node.vars.strokeWeight;

	if (node.autoLayout?.strokesIncluded) {
		out.style.border = uniform
			? `${ctx.len(t, weightVar)} ${lineStyle} ${color}`
			: `${lineStyle} ${color}`;
		if (!uniform) out.style['border-width'] = [t, r, b, l].map((v) => ctx.px(v)).join(' ');
		return out;
	}

	if (uniform) {
		const offset = node.strokeAlign === 'INSIDE' ? -t : node.strokeAlign === 'CENTER' ? -t / 2 : 0;
		out.style.outline = `${ctx.len(t, weightVar)} ${lineStyle} ${color}`;
		if (offset !== 0) out.style['outline-offset'] = ctx.px(offset);
		return out;
	}

	if (node.strokeAlign !== 'INSIDE') ctx.warn('STROKE_ALIGN_APPROXIMATE');
	if (t) out.shadows.push(`inset 0 ${ctx.px(t)} 0 0 ${color}`);
	if (r) out.shadows.push(`inset ${ctx.px(-r)} 0 0 0 ${color}`);
	if (b) out.shadows.push(`inset 0 ${ctx.px(-b)} 0 0 ${color}`);
	if (l) out.shadows.push(`inset ${ctx.px(l)} 0 0 0 ${color}`);
	return out;
}

export function effectStyle(node: RawNode, ctx: StyleCtx): EffectResult {
	const out: EffectResult = { style: {}, shadows: [], textShadows: [] };
	const isText = node.type === 'TEXT';
	const filters: string[] = [];
	for (const e of [...node.effects].reverse()) {
		if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
			const c = ctx.color(e.color as RGBA, e.colorVar);
			if (isText) {
				if (e.type === 'INNER_SHADOW') {
					ctx.warn('TEXT_INNER_SHADOW_UNSUPPORTED');
					continue;
				}
				if (e.spread) ctx.warn('TEXT_SHADOW_SPREAD_IGNORED');
				out.textShadows.push(`${ctx.px(e.x)} ${ctx.px(e.y)} ${ctx.px(e.radius)} ${c}`);
				continue;
			}
			const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
			out.shadows.push(`${inset}${ctx.px(e.x)} ${ctx.px(e.y)} ${ctx.px(e.radius)} ${ctx.px(e.spread)} ${c}`);
		} else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
			if (e.progressive) ctx.warn('PROGRESSIVE_BLUR_APPROXIMATE');
			ctx.warn('BLUR_APPROXIMATE');
			const blur = `blur(${ctx.px(e.radius / 2)})`;
			if (e.type === 'LAYER_BLUR') filters.push(blur);
			else {
				out.style['-webkit-backdrop-filter'] = blur;
				out.style['backdrop-filter'] = blur;
			}
		} else if (e.type === 'UNSUPPORTED') {
			ctx.warn('EFFECT_UNSUPPORTED', e.kind);
		}
	}
	if (filters.length) out.style.filter = filters.join(' ');
	return out;
}

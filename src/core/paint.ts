import type { Mat, RawPaint } from '../shared/types';
import { num, type Style, type StyleCtx } from './format';

type Gradient = Extract<RawPaint, { transform: Mat }>;
type Pt = [number, number];

function invertApply(m: Mat, x: number, y: number): Pt {
	const [[a, c, e], [b, d, f]] = m;
	const det = a * d - c * b || 1;
	const ia = d / det, ic = -c / det, ib = -b / det, id = a / det;
	const ix = x - e, iy = y - f;
	return [ia * ix + ic * iy, ib * ix + id * iy];
}

/** Maps a point in gradient space to layer pixels. */
function handle(p: Gradient, gx: number, gy: number, w: number, h: number): Pt {
	const [nx, ny] = invertApply(p.transform, gx, gy);
	return [nx * w, ny * h];
}

function stopsCss(p: Gradient, ctx: StyleCtx, pos: (t: number) => number, unit = '%'): string {
	return p.stops.map((s) => `${ctx.color(s.color, s.colorVar)} ${num(pos(s.position), 2)}${unit}`).join(', ');
}

export function gradientCss(p: Gradient, w: number, h: number, ctx: StyleCtx): string {
	if (p.type === 'GRADIENT_LINEAR') {
		const [sx, sy] = handle(p, 0, 0.5, w, h);
		const [ex, ey] = handle(p, 1, 0.5, w, h);
		const dx = ex - sx, dy = ey - sy;
		const a = Math.atan2(dx, -dy);
		const deg = ((a * 180) / Math.PI + 360) % 360;
		const dirX = Math.sin(a), dirY = -Math.cos(a);
		const length = Math.abs(w * dirX) + Math.abs(h * dirY) || 1;
		const cx = w / 2, cy = h / 2;
		const toCss = (t: number) => {
			const x = sx + t * dx, y = sy + t * dy;
			return (((x - cx) * dirX + (y - cy) * dirY) / length + 0.5) * 100;
		};
		return `linear-gradient(${num(deg, 1)}deg, ${stopsCss(p, ctx, toCss)})`;
	}

	const [cx, cy] = handle(p, 0.5, 0.5, w, h);
	const [ax, ay] = handle(p, 1, 0.5, w, h);
	const [bx, by] = handle(p, 0.5, 1, w, h);
	const at = `at ${num((cx / (w || 1)) * 100, 1)}% ${num((cy / (h || 1)) * 100, 1)}%`;

	if (p.type === 'GRADIENT_ANGULAR') {
		const from = ((Math.atan2(ax - cx, -(ay - cy)) * 180) / Math.PI + 360) % 360;
		ctx.warn('GRADIENT_APPROXIMATE', 'angular');
		return `conic-gradient(from ${num(from, 1)}deg ${at}, ${stopsCss(p, ctx, (t) => t * 100)})`;
	}

	const rx = Math.hypot(ax - cx, ay - cy);
	const ry = Math.hypot(bx - cx, by - cy);
	if (Math.abs(ay - cy) > 0.5 || p.type === 'GRADIENT_DIAMOND') ctx.warn('GRADIENT_APPROXIMATE', p.type === 'GRADIENT_DIAMOND' ? 'diamond' : 'rotated radial');
	return `radial-gradient(${ctx.px(rx)} ${ctx.px(ry)} ${at}, ${stopsCss(p, ctx, (t) => t * 100)})`;
}

const SIZE_BY_MODE = { FILL: 'cover', FIT: 'contain', CROP: 'cover', TILE: 'auto' } as const;

function imageWarnings(p: Extract<RawPaint, { type: 'IMAGE' }>, ctx: StyleCtx) {
	if (p.scaleMode === 'CROP') ctx.warn('IMAGE_CROP_APPROXIMATE');
	if (p.scaleMode === 'TILE') ctx.warn('IMAGE_TILE_APPROXIMATE');
	if (p.hasFilters) ctx.warn('IMAGE_FILTERS_IGNORED');
	if (!p.assetId) ctx.warn('IMAGE_MISSING');
}

/** CSS `background` for a container's fills (Figma lists paints bottom-to-top, CSS top-to-bottom). */
export function backgroundStyle(fills: RawPaint[], w: number, h: number, ctx: StyleCtx): Style {
	const layers: string[] = [];
	const ordered = [...fills].reverse();
	ordered.forEach((p, i) => {
		const isBottom = i === ordered.length - 1;
		if (p.type === 'SOLID') {
			if (p.blendMode && p.blendMode !== 'NORMAL' && p.blendMode !== 'PASS_THROUGH') ctx.warn('PAINT_BLEND_IGNORED');
			const c = ctx.color(p.color, p.colorVar);
			layers.push(isBottom ? c : `linear-gradient(${c}, ${c})`);
		} else if (p.type === 'IMAGE') {
			imageWarnings(p, ctx);
			if (p.opacity < 1) ctx.warn('IMAGE_OPACITY_IGNORED');
			if (!p.assetId) return;
			const repeat = p.scaleMode === 'TILE' ? 'repeat' : 'no-repeat';
			layers.push(`url("${ctx.asset(p.assetId)}") center / ${SIZE_BY_MODE[p.scaleMode]} ${repeat}`);
		} else if (p.type === 'UNSUPPORTED') {
			ctx.warn('PAINT_UNSUPPORTED', p.kind);
		} else {
			layers.push(gradientCss(p, w, h, ctx));
		}
	});
	if (layers.length === 0) return {};
	if (layers.length === 1 && ordered.length === 1 && ordered[0].type === 'SOLID') return { 'background-color': layers[0] };
	return { background: layers.join(', ') };
}

/** Styles for an <img> element whose source is the topmost image fill. */
export function imageElementStyle(fills: RawPaint[], ctx: StyleCtx): { assetId: string | null; style: Style } {
	const image = [...fills].reverse().find((p) => p.type === 'IMAGE') as Extract<RawPaint, { type: 'IMAGE' }> | undefined;
	if (!image) return { assetId: null, style: {} };
	imageWarnings(image, ctx);
	const style: Style = { 'object-fit': image.scaleMode === 'FIT' ? 'contain' : 'cover' };
	const solidBelow = fills.find((p) => p.type === 'SOLID') as Extract<RawPaint, { type: 'SOLID' }> | undefined;
	if (solidBelow) style['background-color'] = ctx.color(solidBelow.color, solidBelow.colorVar);
	if (fills.length > 2) ctx.warn('MULTIPLE_FILLS_SIMPLIFIED');
	return { assetId: image.assetId, style };
}

/** Text color: solid → color, gradient → clipped background. */
export function textFillStyle(fills: RawPaint[], w: number, h: number, ctx: StyleCtx): Style {
	const top = [...fills].reverse().find((p) => p.type !== 'UNSUPPORTED');
	if (!top) return {};
	if (fills.length > 1) ctx.warn('MULTIPLE_FILLS_SIMPLIFIED');
	if (top.type === 'SOLID') return { color: ctx.color(top.color, top.colorVar) };
	if (top.type === 'IMAGE') {
		ctx.warn('TEXT_IMAGE_FILL_UNSUPPORTED');
		return {};
	}
	return {
		background: gradientCss(top, w, h, ctx),
		'-webkit-background-clip': 'text',
		'background-clip': 'text',
		color: 'transparent',
	};
}

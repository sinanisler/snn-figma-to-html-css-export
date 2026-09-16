import type { RGBA } from '../shared/types';

/** Per-node helpers handed to every style builder. */
export type StyleCtx = {
	px(n: number): string;
	/** Length that may be bound to a variable; falls back to the literal. */
	len(n: number, varId?: string): string;
	color(c: RGBA, varId?: string): string;
	asset(id: string): string;
	warn(code: string, detail?: string): void;
};

export type Style = Record<string, string>;

export function num(n: number, decimals = 2): string {
	const f = 10 ** decimals;
	const v = Math.round(n * f) / f;
	return Object.is(v, -0) ? '0' : String(v);
}

export type Units = 'px' | 'rem';

export function px(n: number, decimals: number, units: Units = 'px'): string {
	if (units === 'rem') {
		const v = num(n / 16, Math.max(3, decimals + 2));
		return v === '0' ? '0' : `${v}rem`;
	}
	const v = num(n, decimals);
	return v === '0' ? '0' : `${v}px`;
}

export function cssSlug(s: string, fallback = 'var'): string {
	return (
		s
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || fallback
	);
}

export function pascalCase(s: string, fallback = 'Page'): string {
	const out = cssSlug(s, '')
		.split('-')
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join('');
	return /^[A-Z]/.test(out) ? out : fallback + out;
}

const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

export function cssColor(c: RGBA): string {
	if (c.a >= 0.999) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
	const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
	return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${num(c.a, 2)})`;
}

const GENERIC_NAME =
	/^(rectangle|ellipse|frame|group|vector|polygon|star|line|component|instance|section|image|union|subtract|intersect|exclude|boolean( operation)?|text|layer|slice)\s*\d*$/i;

/** Turns a layer name into a CSS-safe slug, or null when the name is a Figma default. */
export function slugify(name: string): string | null {
	const trimmed = name.trim();
	if (GENERIC_NAME.test(trimmed)) return null;
	const slug = trimmed
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
		.replace(/-+$/, '');
	if (!slug || /^\d/.test(slug)) return null;
	return slug;
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/"/g, '&quot;');
}

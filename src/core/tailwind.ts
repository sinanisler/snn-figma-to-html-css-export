import type { Style } from './format';

/** Values Tailwind utilities can't hold cleanly (data URIs, url()) stay in a style attribute. */
export type Utilities = { classes: string[]; inline: Style };

const KEYWORDS: Record<string, Record<string, string>> = {
	display: { flex: 'flex', grid: 'grid', block: 'block', none: 'hidden', contents: 'contents', '-webkit-box': '[display:-webkit-box]', 'inline-block': 'inline-block' },
	position: { absolute: 'absolute', relative: 'relative', static: 'static', fixed: 'fixed' },
	'flex-direction': { column: 'flex-col', row: 'flex-row' },
	'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
	'justify-content': { center: 'justify-center', 'flex-end': 'justify-end', 'flex-start': 'justify-start', 'space-between': 'justify-between', normal: 'justify-normal' },
	'align-items': { center: 'items-center', 'flex-end': 'items-end', 'flex-start': 'items-start', baseline: 'items-baseline', stretch: 'items-stretch' },
	'align-content': { 'space-between': 'content-between', 'flex-start': 'content-start' },
	'align-self': { stretch: 'self-stretch', start: 'self-start', center: 'self-center', end: 'self-end', auto: 'self-auto' },
	'justify-self': { start: 'justify-self-start', center: 'justify-self-center', end: 'justify-self-end' },
	'flex-shrink': { '0': 'shrink-0', '1': 'shrink' },
	flex: { '1 1 0': 'flex-1', '0 1 auto': 'flex-initial' },
	overflow: { hidden: 'overflow-hidden', visible: 'overflow-visible' },
	'text-align': { center: 'text-center', right: 'text-right', justify: 'text-justify', start: 'text-start' },
	'font-style': { italic: 'italic', normal: 'not-italic' },
	'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
	'text-decoration': { underline: 'underline', 'line-through': 'line-through', none: 'no-underline' },
	'white-space': { nowrap: 'whitespace-nowrap', normal: 'whitespace-normal' },
	'text-overflow': { ellipsis: 'text-ellipsis' },
	'object-fit': { cover: 'object-cover', contain: 'object-contain' },
	'-webkit-box-orient': { vertical: '[-webkit-box-orient:vertical]' },
	'border-radius': { '50%': 'rounded-full' },
	'font-weight': { '100': 'font-thin', '200': 'font-extralight', '300': 'font-light', '400': 'font-normal', '500': 'font-medium', '600': 'font-semibold', '700': 'font-bold', '800': 'font-extrabold', '900': 'font-black' },
};

/** Properties with a utility prefix taking an arbitrary value. */
const PREFIX: Record<string, string> = {
	width: 'w',
	height: 'h',
	'min-width': 'min-w',
	'min-height': 'min-h',
	'max-width': 'max-w',
	'max-height': 'max-h',
	left: 'left',
	top: 'top',
	right: 'right',
	bottom: 'bottom',
	gap: 'gap',
	padding: 'p',
	'border-radius': 'rounded',
	opacity: 'opacity',
	'line-height': 'leading',
	'letter-spacing': 'tracking',
	'box-shadow': 'shadow',
	'z-index': 'z',
	'grid-template-columns': 'grid-cols',
	'grid-template-rows': 'grid-rows',
	'grid-row': 'row',
	'grid-column': 'col',
	'-webkit-line-clamp': 'line-clamp',
};

const SPACING_PREFIXES = new Set(['w', 'h', 'min-w', 'min-h', 'max-w', 'max-h', 'left', 'top', 'right', 'bottom', 'gap', 'p']);

/** Arbitrary values use underscores for spaces; literal underscores are escaped. */
const arb = (v: string) => `[${v.replace(/_/g, '\\_').replace(/\s+/g, '_')}]`;

/** Spacing steps present in both Tailwind 3 and 4 (1 unit = 4px). */
const SCALE = new Set([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96]);

function spacing(prefix: string, value: string): string {
	if (SPACING_PREFIXES.has(prefix) || /^p[xytrbl]$/.test(prefix)) {
		if (value === '0') return `${prefix}-0`;
		if (value === '100%') return `${prefix}-full`;
		const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
		if (m && SCALE.has(Number(m[1]) / 4)) return `${prefix}-${Number(m[1]) / 4}`;
	}
	return `${prefix}-${arb(value)}`;
}

function paddingClasses(value: string): string[] {
	const parts = value.split(/\s+/);
	if (parts.length === 1) return [spacing('p', parts[0])];
	if (parts.length === 2) return [spacing('py', parts[0]), spacing('px', parts[1])];
	const [t, r, b = t, l = r] = parts;
	return [spacing('pt', t), spacing('pr', r), spacing('pb', b), spacing('pl', l)];
}

function gapClasses(value: string): string[] {
	const parts = value.split(/\s+/);
	if (parts.length === 2) return [`gap-y-${arb(parts[0])}`, `gap-x-${arb(parts[1])}`];
	return [spacing('gap', value)];
}

const isColor = (v: string) => /^(#|rgba?\(|var\()/.test(v) && !/\s/.test(v.replace(/,\s*/g, ','));

export function toUtilities(style: Style): Utilities {
	const classes: string[] = [];
	const inline: Style = {};
	for (const [k, raw] of Object.entries(style)) {
		const v = raw.trim();
		if (/url\(/.test(v)) {
			inline[k] = v;
			continue;
		}
		const keyword = KEYWORDS[k]?.[v];
		if (keyword) {
			classes.push(keyword);
			continue;
		}
		if (k === 'padding') classes.push(...paddingClasses(v));
		else if (k === 'gap') classes.push(...gapClasses(v));
		else if (k === 'background-color' || (k === 'background' && isColor(v))) classes.push(`bg-${arb(v)}`);
		else if (k === 'color') classes.push(`text-${arb(v)}`);
		else if (k === 'font-size') classes.push(`text-${arb(`length:${v}`)}`);
		else if (k === 'font-family') classes.push(`font-${arb(v)}`);
		else if (k === 'font-weight') classes.push(`font-${arb(v)}`);
		else if (PREFIX[k]) classes.push(spacing(PREFIX[k], v));
		else classes.push(arb(`${k}:${v}`));
	}
	return { classes, inline };
}

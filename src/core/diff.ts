import type { Style } from './format';
import type { IRNode, IRRule } from './ir';

/** Properties that describe where a node sits in its parent rather than how it looks. */
export const PLACEMENT_KEYS = new Set([
	'position',
	'left',
	'top',
	'right',
	'bottom',
	'transform',
	'transform-origin',
	'flex',
	'flex-shrink',
	'flex-grow',
	'align-self',
	'justify-self',
	'grid-row',
	'grid-column',
]);

/** Placement plus size: skipped when diffing a component root against its variant. */
export const STATE_ROOT_SKIP = new Set([
	...PLACEMENT_KEYS,
	'width',
	'height',
	'min-width',
	'min-height',
	'max-width',
	'max-height',
]);

export const TYPO_KEYS = new Set([
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'line-height',
	'letter-spacing',
	'text-transform',
	'font-variant',
	'text-decoration',
]);

const RESETS: Record<string, string> = {
	position: 'static',
	left: 'auto',
	top: 'auto',
	right: 'auto',
	bottom: 'auto',
	width: 'auto',
	height: 'auto',
	'min-width': '0',
	'min-height': '0',
	'max-width': 'none',
	'max-height': 'none',
	display: 'block',
	flex: '0 1 auto',
	'flex-shrink': '1',
	'flex-grow': '0',
	'flex-direction': 'row',
	'flex-wrap': 'nowrap',
	'align-self': 'auto',
	'justify-self': 'auto',
	'align-items': 'normal',
	'justify-content': 'normal',
	'align-content': 'normal',
	gap: '0',
	padding: '0',
	'grid-row': 'auto',
	'grid-column': 'auto',
	'grid-template-columns': 'none',
	'grid-template-rows': 'none',
	background: 'none',
	'background-color': 'transparent',
	'box-shadow': 'none',
	outline: 'none',
	'outline-offset': '0',
	border: 'none',
	'border-width': '0',
	'border-radius': '0',
	opacity: '1',
	transform: 'none',
	'transform-origin': '50% 50%',
	overflow: 'visible',
	filter: 'none',
	'backdrop-filter': 'none',
	'-webkit-backdrop-filter': 'none',
	'mix-blend-mode': 'normal',
	'text-align': 'start',
	'white-space': 'normal',
	'text-shadow': 'none',
	'text-overflow': 'clip',
	'object-fit': 'fill',
	'font-style': 'normal',
	'font-variant': 'normal',
	'text-transform': 'none',
	'text-decoration': 'none',
	'letter-spacing': 'normal',
	'line-height': 'normal',
	color: 'inherit',
	'-webkit-text-stroke': '0',
	'-webkit-line-clamp': 'none',
	'-webkit-box-orient': 'horizontal',
	'-webkit-background-clip': 'border-box',
	'background-clip': 'border-box',
};

/** Declarations that turn `base` into `other`; resets come first so shorthands never wipe later values. */
export function styleDiff(base: Style, other: Style, skip?: Set<string>): Style {
	const d: Style = {};
	for (const k of Object.keys(base)) if (!skip?.has(k) && !(k in other)) d[k] = RESETS[k] ?? 'initial';
	for (const [k, v] of Object.entries(other)) if (!skip?.has(k) && base[k] !== v) d[k] = v;
	return d;
}

const isEmpty = (s: Style) => Object.keys(s).length === 0;

const textOf = (n: IRNode) => (n.runs ?? []).map((r) => r.text).join('');

/** Pairs children by layer name (then position), reporting unmatched ones on either side. */
export function matchChildren(a: IRNode[], b: IRNode[]) {
	const used = new Set<IRNode>();
	const pairs: [IRNode, IRNode][] = [];
	const added: { node: IRNode; index: number }[] = [];
	b.forEach((bc, i) => {
		let match = a.find((ac) => !used.has(ac) && ac.name === bc.name && ac.tag === bc.tag);
		if (!match && a[i] && !used.has(a[i]) && a[i].tag === bc.tag) match = a[i];
		if (match) {
			used.add(match);
			pairs.push([match, bc]);
		} else added.push({ node: bc, index: i });
	});
	return { pairs, added, removed: a.filter((ac) => !used.has(ac)) };
}

export type MergeCtx = {
	rules: IRRule[];
	/** What each base node looks like at the previous (larger) breakpoint. */
	effective: Map<IRNode, Style>;
	/** Gives a subtree built in dry mode real, unique class names. */
	realize(node: IRNode): void;
	warn(node: IRNode, code: string): void;
};

/** Folds a smaller breakpoint's tree into the base tree as media-query rules. */
export function mergeBreakpoint(base: IRNode, other: IRNode, media: string, ctx: MergeCtx): void {
	const current = ctx.effective.get(base) ?? base.style;
	const d = styleDiff(current, other.style);
	if (!isEmpty(d)) ctx.rules.push({ target: base, media, style: d });
	ctx.effective.set(base, other.style);
	if (base.runs && other.runs && textOf(base) !== textOf(other)) ctx.warn(base, 'BREAKPOINT_CONTENT_DIFFERS');

	const { pairs, added, removed } = matchChildren(base.children, other.children);
	for (const [a, b] of pairs) mergeBreakpoint(a, b, media, ctx);
	for (const r of removed) {
		const eff = ctx.effective.get(r) ?? r.style;
		if (eff.display === 'none') continue;
		ctx.rules.push({ target: r, media, style: { display: 'none' } });
		ctx.effective.set(r, { ...eff, display: 'none' });
	}
	for (const { node, index } of added) {
		ctx.realize(node);
		const shown = node.style.display ?? 'block';
		ctx.effective.set(node, { ...node.style });
		node.style = { ...node.style, display: 'none' };
		ctx.rules.push({ target: node, media, style: { display: shown } });
		base.children.splice(Math.min(index, base.children.length), 0, node);
	}
}

/** Turns a component variant (Hover, Focus, Pressed) into rules scoped to the instance root. */
export function mergeState(root: IRNode, state: IRNode, pseudo: string, rules: IRRule[]): void {
	const visit = (a: IRNode, b: IRNode, isRoot: boolean) => {
		const d = styleDiff(a.style, b.style, isRoot ? STATE_ROOT_SKIP : PLACEMENT_KEYS);
		if (!isEmpty(d)) rules.push({ target: a, scope: { node: root, pseudo }, style: d });
		const { pairs, removed } = matchChildren(a.children, b.children);
		for (const [x, y] of pairs) visit(x, y, false);
		for (const r of removed) rules.push({ target: r, scope: { node: root, pseudo }, style: { display: 'none' } });
	};
	visit(root, state, true);
}

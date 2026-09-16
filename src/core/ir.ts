import type { Style } from './format';

export type IRRun = { text: string; className?: string; style: Style; href?: string };

/** Resolved prototype link: another page, or an element on a page. */
export type IRLink = { url?: string; newTab?: boolean; page?: number; anchor?: IRNode; unresolved?: boolean };

export type IRNode = {
	id: string;
	name: string;
	tag: string;
	/** The node's own class; empty when every property moved to a shared class. */
	className: string;
	/** Shared classes (component or text style) listed before the own class. */
	shared: string[];
	style: Style;
	attrs: Record<string, string>;
	runs?: IRRun[];
	/** Wrap text runs in one inner span (needed when the text box is a flex column). */
	wrapRuns?: boolean;
	/** Asset id of an exported SVG that may be inlined. */
	svgAsset?: string;
	/** Figma prototype link, resolved after all pages are built. */
	link?: IRLink;
	/** Node id of a prototype destination, before resolution. */
	linkNodeId?: string;
	/** Classless <li> added around list children (display: contents). */
	wrapper?: boolean;
	/** Layer box in px, relative to the parent layer (Figma geometry, before any CSS). */
	box?: { x: number; y: number; width: number; height: number };
	componentKey?: string;
	componentName?: string;
	textStyle?: string;
	children: IRNode[];
};

/**
 * An extra rule for a node: a media query override, a pseudo-element, or a
 * state (`scope` is the component root carrying :hover etc.).
 */
export type IRRule = {
	target: IRNode;
	style: Style;
	media?: string;
	pseudo?: string;
	scope?: { node: IRNode; pseudo: string };
};

export type IRSharedClass = { name: string; style: Style };

export type IRPage = { name: string; slug: string; title: string; roots: IRNode[] };

export type IRWarning = { nodeId: string; nodeName: string; code: string; detail?: string };
/** `modes` lists the values of other modes of the variable's collection that differ from `value`. */
export type IRVariable = { name: string; value: string; collection?: string; modes?: { mode: string; value: string }[] };
export type FontUse = { family: string; weights: number[]; italicWeights: number[] };

export type IRDocument = {
	title: string;
	pages: IRPage[];
	rules: IRRule[];
	sharedClasses: IRSharedClass[];
	/** Media queries in the order they must appear (largest max-width first). */
	media: string[];
	variables: IRVariable[];
	fonts: FontUse[];
	warnings: IRWarning[];
};

export function primaryClass(node: IRNode): string {
	return node.className || node.shared[node.shared.length - 1] || '';
}

export function classList(node: IRNode): string[] {
	return node.className ? [...node.shared, node.className] : [...node.shared];
}

export function walk(nodes: IRNode[], fn: (node: IRNode, parent: IRNode | null) => void, parent: IRNode | null = null) {
	for (const n of nodes) {
		fn(n, parent);
		walk(n.children, fn, n);
	}
}

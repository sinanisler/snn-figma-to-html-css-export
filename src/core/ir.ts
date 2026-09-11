import type { Style } from './format';

export type IRRun = { text: string; className?: string; style: Style; href?: string };

export type IRNode = {
	id: string;
	name: string;
	tag: string;
	className: string;
	style: Style;
	attrs: Record<string, string>;
	runs?: IRRun[];
	/** Wrap text runs in one inner span (needed when the text box is a flex column). */
	wrapRuns?: boolean;
	children: IRNode[];
};

export type IRWarning = { nodeId: string; nodeName: string; code: string; detail?: string };
export type IRVariable = { name: string; value: string };
export type FontUse = { family: string; weights: number[] };

export type IRDocument = {
	title: string;
	roots: IRNode[];
	variables: IRVariable[];
	fonts: FontUse[];
	warnings: IRWarning[];
};

export type RGBA = { r: number; g: number; b: number; a: number };
export type Mat = [[number, number, number], [number, number, number]];

export type RawStop = { position: number; color: RGBA; colorVar?: string };

export type RawPaint =
	| { type: 'SOLID'; color: RGBA; opacity: number; colorVar?: string; blendMode?: string }
	| {
			type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
			transform: Mat;
			stops: RawStop[];
			opacity: number;
	  }
	| {
			type: 'IMAGE';
			assetId: string | null;
			scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
			opacity: number;
			scalingFactor?: number;
			hasFilters: boolean;
	  }
	| { type: 'UNSUPPORTED'; kind: string };

export type RawEffect =
	| {
			type: 'DROP_SHADOW' | 'INNER_SHADOW';
			color: RGBA;
			x: number;
			y: number;
			radius: number;
			spread: number;
			colorVar?: string;
	  }
	| { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number; progressive: boolean }
	| { type: 'UNSUPPORTED'; kind: string };

export type Sizing = 'FIXED' | 'HUG' | 'FILL';

export type RawAutoLayout = {
	mode: 'HORIZONTAL' | 'VERTICAL' | 'GRID';
	inferred: boolean;
	primaryAlign: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
	counterAlign: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
	wrap: boolean;
	alignContentBetween: boolean;
	itemSpacing: number;
	counterSpacing: number;
	padding: [number, number, number, number];
	reverseZ: boolean;
	strokesIncluded: boolean;
	grid?: {
		rows: { type: 'FLEX' | 'FIXED' | 'HUG'; value?: number }[];
		cols: { type: 'FLEX' | 'FIXED' | 'HUG'; value?: number }[];
		rowGap: number;
		colGap: number;
	};
};

export type RawChildLayout = {
	absolute: boolean;
	sizingH: Sizing;
	sizingV: Sizing;
	grow: number;
	alignSelf: 'STRETCH' | 'INHERIT' | 'MIN' | 'CENTER' | 'MAX';
	grid?: { row: number; col: number; rowSpan: number; colSpan: number; hAlign: string; vAlign: string };
};

export type RawTextSegment = {
	text: string;
	fontFamily: string;
	fontWeight: number;
	italic: boolean;
	fontSize: number;
	lineHeight: { unit: 'PIXELS' | 'PERCENT' | 'AUTO'; value: number };
	letterSpacing: { unit: 'PIXELS' | 'PERCENT'; value: number };
	textCase: string;
	decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
	fills: RawPaint[];
	href?: string;
	listType: 'ORDERED' | 'UNORDERED' | 'NONE';
	paragraphSpacing: number;
	vars: Record<string, string>;
};

export type RawText = {
	segments: RawTextSegment[];
	alignH: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
	alignV: 'TOP' | 'CENTER' | 'BOTTOM';
	autoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
	truncate: boolean;
	maxLines: number | null;
	styleName?: string;
};

export type RawNode = {
	id: string;
	name: string;
	type: string;
	/** Element box relative to parent's box origin (unrotated frame of the element). */
	x: number;
	y: number;
	width: number;
	height: number;
	/** 2x2 linear part of the transform relative to the parent: [a, b, c, d] as in CSS matrix(). */
	linear: [number, number, number, number];
	opacity: number;
	blendMode: string;
	clips: boolean;
	isMask: boolean;
	radii: [number, number, number, number];
	fills: RawPaint[];
	strokes: RawPaint[];
	strokeWeights: [number, number, number, number];
	strokeAlign: 'INSIDE' | 'OUTSIDE' | 'CENTER';
	dashed: boolean;
	effects: RawEffect[];
	vars: Record<string, string>;
	minMax: { minW: number | null; maxW: number | null; minH: number | null; maxH: number | null };
	autoLayout?: RawAutoLayout;
	child?: RawChildLayout;
	text?: RawText;
	/** Set when the node is exported as a single asset (SVG vector or raster image). */
	exportAsset?: string;
	children: RawNode[];
};

export type VariableMeta = { name: string; collection: string };

export type RawAsset = {
	id: string;
	name: string;
	mime: string;
	ext: string;
	bytes: Uint8Array;
};

export type ReadWarning = { nodeId: string; nodeName: string; code: string; detail?: string };

export type ReadResult = {
	roots: RawNode[];
	assets: RawAsset[];
	variables: Record<string, VariableMeta>;
	warnings: ReadWarning[];
	nodeCount: number;
	ms: number;
};

export type Settings = {
	decimals: 0 | 1 | 2;
	useVariables: boolean;
	inlineImages: boolean;
};

export const DEFAULT_SETTINGS: Settings = { decimals: 0, useVariables: true, inlineImages: true };

export type MainToUi =
	| { type: 'INIT'; settings: Settings; size: { w: number; h: number } }
	| { type: 'SELECTION'; ids: string[]; names: string[] }
	| { type: 'PROGRESS'; done: number; total: number }
	| { type: 'RESULT'; result: ReadResult }
	| { type: 'ERROR'; message: string };

export type UiToMain =
	| { type: 'GENERATE' }
	| { type: 'FOCUS'; nodeId: string }
	| { type: 'RESIZE'; w: number; h: number }
	| { type: 'SAVE_SETTINGS'; settings: Settings }
	| { type: 'NOTIFY'; message: string };

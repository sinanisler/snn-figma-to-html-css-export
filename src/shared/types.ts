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
	/** Prototype click action: an external URL or another node. */
	link?: RawLink;
	/** Instances: the component (or component set) they come from. */
	component?: { id: string; name: string };
	/** Instances of a variant with State=Default: the Hover/Focus/Pressed siblings. */
	states?: RawState[];
	/** Prototype animation between the default variant and its states. */
	stateTransition?: RawTransition;
	/** Roots only: the node sits directly on the page. */
	topLevel?: boolean;
	children: RawNode[];
};

export type RawLink = { url?: string; nodeId?: string; newTab?: boolean };
export type PseudoState = 'hover' | 'focus' | 'active';
export type RawState = { state: PseudoState; node: RawNode };

/** duration in seconds; easing is a Figma easing type; bezier only for CUSTOM_CUBIC_BEZIER. */
export type RawTransition = { duration: number; easing: string; bezier?: [number, number, number, number] };

export type ModeValue = RGBA | number | string | boolean;

export type VariableMeta = {
	name: string;
	collection: string;
	/** Resolved value in every mode, when the collection has more than one. */
	modes?: { name: string; value: ModeValue }[];
};

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

export type Format =
	| 'html'
	| 'tailwind'
	| 'react'
	| 'react-tailwind'
	| 'vue'
	| 'vue-tailwind'
	| 'svelte'
	| 'email';

export type Settings = {
	format: Format;
	decimals: 0 | 1 | 2;
	units: 'px' | 'rem';
	useVariables: boolean;
	inlineImages: boolean;
	googleFonts: boolean;
	shareClasses: boolean;
	inlineSvg: boolean;
	rasterScale: 1 | 2 | 3;
	/** React/Vue/Svelte: Figma components become component files with props. */
	components: boolean;
	/** React/Vue/Svelte: TypeScript output. */
	typescript: boolean;
	/** A variable mode named "Dark" follows prefers-color-scheme. */
	systemDarkMode: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
	format: 'html',
	decimals: 0,
	units: 'px',
	useVariables: true,
	inlineImages: true,
	googleFonts: true,
	shareClasses: true,
	inlineSvg: false,
	rasterScale: 2,
	components: true,
	typescript: false,
	systemDarkMode: false,
};

export type ReadOptions = {
	rasterScale: number;
	/** false skips image bytes (Dev Mode codegen only needs file names). */
	assetBytes: boolean;
};

// ---------- design tokens ----------

export type TokenValue = string | number | boolean | RGBA | { alias: string };

export type TokenVariable = {
	id: string;
	name: string;
	type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
	values: Record<string, TokenValue>;
};

export type TokenCollection = { name: string; modes: { id: string; name: string }[]; variables: TokenVariable[] };

export type TokenTextStyle = {
	name: string;
	fontFamily: string;
	fontWeight: number;
	italic: boolean;
	fontSize: number;
	lineHeight: { unit: 'PIXELS' | 'PERCENT' | 'AUTO'; value: number };
	letterSpacing: { unit: 'PIXELS' | 'PERCENT'; value: number };
	textCase: string;
	decoration: string;
};

export type TokensResult = {
	collections: TokenCollection[];
	paintStyles: { name: string; paints: RawPaint[] }[];
	textStyles: TokenTextStyle[];
	effectStyles: { name: string; effects: RawEffect[] }[];
};

export type MainToUi =
	| { type: 'INIT'; settings: Settings; size: { w: number; h: number } }
	| { type: 'SELECTION'; ids: string[]; names: string[] }
	| { type: 'PROGRESS'; done: number; total: number }
	| { type: 'RESULT'; result: ReadResult }
	| { type: 'TOKENS'; tokens: TokensResult }
	| { type: 'ERROR'; message: string };

export type UiToMain =
	| { type: 'GENERATE'; options: ReadOptions }
	| { type: 'TOKENS' }
	| { type: 'FOCUS'; nodeId: string }
	| { type: 'RESIZE'; w: number; h: number }
	| { type: 'SAVE_SETTINGS'; settings: Settings }
	| { type: 'OPEN_URL'; url: string }
	| { type: 'NOTIFY'; message: string };

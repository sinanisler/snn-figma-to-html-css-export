import type {
	Mat,
	RawAsset,
	RawAutoLayout,
	RawChildLayout,
	RawEffect,
	RawLink,
	RawNode,
	RawPaint,
	RawText,
	RawTextSegment,
	RawState,
	RawTransition,
	ModeValue,
	PseudoState,
	ReadOptions,
	ReadResult,
	ReadWarning,
	RGBA,
	Sizing,
	VariableMeta,
} from '../shared/types';

// Figma node objects expose many optional mixins; reading through `any` keeps the serializer compact.
type N = any;

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']);
const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
const KNOWN_TYPES = new Set([...VECTOR_TYPES, ...CONTAINER_TYPES, 'RECTANGLE', 'ELLIPSE', 'TEXT']);
const IDENTITY: Mat = [
	[1, 0, 0],
	[0, 1, 0],
];

export type Ctx = {
	options: ReadOptions;
	/** Variant state trees per main component id. */
	stateCache: Map<string, RawState[]>;
	inState: boolean;
	assets: Map<string, RawAsset>;
	assetNames: Set<string>;
	variables: Record<string, VariableMeta>;
	styleNames: Map<string, string>;
	warnings: ReadWarning[];
	done: number;
	total: number;
	onProgress: (done: number, total: number) => void;
};

export function createCtx(
	options: ReadOptions,
	total = 0,
	onProgress: (done: number, total: number) => void = () => {},
): Ctx {
	return {
		options,
		stateCache: new Map(),
		inState: false,
		assets: new Map(),
		assetNames: new Set(),
		variables: {},
		styleNames: new Map(),
		warnings: [],
		done: 0,
		total,
		onProgress,
	};
}

export async function readSelection(
	nodes: readonly SceneNode[],
	onProgress: (done: number, total: number) => void,
	options: ReadOptions,
): Promise<ReadResult> {
	const start = Date.now();
	const total = nodes.reduce((sum, n: N) => sum + 1 + (typeof n.findAll === 'function' ? n.findAll().length : 0), 0);
	const ctx = createCtx(options, total, onProgress);
	const roots: RawNode[] = [];
	for (const node of nodes) {
		const raw = await readNode(node, null, undefined, ctx, true);
		if (raw) roots.push(raw);
	}
	return {
		roots,
		assets: [...ctx.assets.values()],
		variables: ctx.variables,
		warnings: ctx.warnings,
		nodeCount: ctx.done,
		ms: Date.now() - start,
	};
}

async function readNode(
	n: N,
	parent: N | null,
	parentLayout: RawAutoLayout | undefined,
	ctx: Ctx,
	isRoot = false,
): Promise<RawNode | null> {
	if (!isRoot && n.visible === false) return null;
	if (n.type === 'SLICE') return null;
	ctx.done++;
	if (ctx.done % 25 === 0) ctx.onProgress(ctx.done, ctx.total);

	const warn = (code: string, detail?: string) =>
		ctx.warnings.push({ nodeId: n.id, nodeName: n.name, code, detail });

	let exportKind: 'SVG' | 'PNG' | null = null;
	if (!KNOWN_TYPES.has(n.type)) {
		exportKind = 'PNG';
		warn('UNSUPPORTED_NODE', n.type);
	} else if (isVectorLike(n)) {
		exportKind = 'SVG';
	} else if (CONTAINER_TYPES.has(n.type) && hasMaskChild(n)) {
		exportKind = 'PNG';
		warn('MASK_RASTERIZED');
	}

	const geometry = exportKind ? boundsGeometry(n, parent, isRoot) : transformGeometry(n, parent, isRoot);

	const raw: RawNode = {
		id: n.id,
		name: n.name,
		type: n.type,
		...geometry,
		opacity: typeof n.opacity === 'number' ? n.opacity : 1,
		blendMode: typeof n.blendMode === 'string' ? n.blendMode : 'PASS_THROUGH',
		clips: n.clipsContent === true,
		isMask: n.isMask === true,
		radii: readRadii(n),
		fills: [],
		strokes: [],
		strokeWeights: readStrokeWeights(n),
		strokeAlign: n.strokeAlign ?? 'INSIDE',
		dashed: Array.isArray(n.dashPattern) && n.dashPattern.length > 0,
		effects: [],
		vars: await readNodeVars(n, ctx),
		minMax: {
			minW: n.minWidth ?? null,
			maxW: n.maxWidth ?? null,
			minH: n.minHeight ?? null,
			maxH: n.maxHeight ?? null,
		},
		children: [],
	};

	if (parentLayout && !isRoot) raw.child = readChildLayout(n, parentLayout);
	if (isRoot) raw.topLevel = n.parent?.type === 'PAGE';
	const link = readLink(n);
	if (link) raw.link = link;
	if (n.type === 'INSTANCE') await readComponent(n, raw, ctx);

	if (exportKind) {
		raw.exportAsset = await exportNodeAsset(n, exportKind, ctx);
		if (!raw.exportAsset) warn('EXPORT_FAILED');
		// The exported image already contains fills, strokes and effects.
		raw.effects = [];
		return raw;
	}

	raw.fills = await readPaints(n.fills, n, ctx);
	raw.strokes = await readPaints(n.strokes, n, ctx);
	raw.effects = await readEffects(n.effects, ctx);

	if (n.type === 'TEXT') {
		raw.text = await readText(n, ctx);
		return raw;
	}

	if ('children' in n) {
		raw.autoLayout = readAutoLayout(n);
		for (const child of n.children) {
			const c = await readNode(child, n, raw.autoLayout, ctx);
			if (c) raw.children.push(c);
		}
		// A guessed layout flows in canvas order; layer order is whatever the designer left behind.
		const al = raw.autoLayout;
		if (al?.inferred) {
			const byRow = al.mode === 'HORIZONTAL' && !al.wrap;
			const main = (c: RawNode) => (byRow ? c.x : c.y);
			const cross = (c: RawNode) => (byRow ? c.y : c.x);
			raw.children.sort((a, b) => Math.round(main(a) - main(b)) || Math.round(cross(a) - cross(b)));
		}
	}
	return raw;
}

// ---------- prototype links & components ----------

function readLink(n: N): RawLink | undefined {
	let reactions: Reaction[];
	try {
		reactions = Array.isArray(n.reactions) ? n.reactions : [];
	} catch {
		return undefined;
	}
	for (const r of reactions) {
		const trigger = r.trigger?.type;
		if (trigger && trigger !== 'ON_CLICK' && trigger !== 'ON_PRESS') continue;
		for (const a of r.actions ?? (r.action ? [r.action] : [])) {
			if (a.type === 'URL' && a.url) return { url: a.url, newTab: a.openInNewTab === true };
			if (a.type === 'NODE' && a.destinationId && (a.navigation === 'NAVIGATE' || a.navigation === 'SCROLL_TO'))
				return { nodeId: a.destinationId };
		}
	}
	return undefined;
}

const STATE_PROP = /^(state|status|interaction|mode)$/i;
const DEFAULT_STATE = /^(default|rest|normal|idle|enabled|base)$/i;
const STATE_VALUES: [RegExp, PseudoState][] = [
	[/^hover(ed)?$/i, 'hover'],
	[/^focus(ed)?$/i, 'focus'],
	[/^(pressed|active|press)$/i, 'active'],
];

async function readComponent(n: N, raw: RawNode, ctx: Ctx): Promise<void> {
	let main: N = null;
	try {
		main = await n.getMainComponentAsync();
	} catch {
		main = null;
	}
	if (!main) return;
	const set = main.parent?.type === 'COMPONENT_SET' ? main.parent : null;
	raw.component = { id: (set ?? main).id, name: (set ?? main).name };
	if (!set || ctx.inState) return;

	const props: Record<string, string> = main.variantProperties ?? {};
	const stateKey = Object.keys(props).find((k) => STATE_PROP.test(k));
	if (!stateKey || !DEFAULT_STATE.test(props[stateKey])) return;

	if (!ctx.stateCache.has(main.id)) {
		const states: RawState[] = [];
		ctx.inState = true;
		const warningCount = ctx.warnings.length;
		try {
			for (const sibling of set.children as N[]) {
				const sp: Record<string, string> = sibling.variantProperties ?? {};
				const same = Object.keys(props).every((k) => k === stateKey || sp[k] === props[k]);
				const state = same ? STATE_VALUES.find(([re]) => re.test(sp[stateKey] ?? ''))?.[1] : undefined;
				if (!state || states.some((s) => s.state === state)) continue;
				const node = await readNode(sibling, null, undefined, ctx, true);
				if (node) states.push({ state, node });
			}
		} finally {
			ctx.inState = false;
			ctx.warnings.length = warningCount;
		}
		ctx.stateCache.set(main.id, states);
	}
	const states = ctx.stateCache.get(main.id)!;
	if (states.length) {
		raw.states = states;
		const transition = readStateTransition(n) || readStateTransition(main);
		if (transition) raw.stateTransition = transition;
	}
}

const STATE_TRIGGERS = new Set(['ON_HOVER', 'WHILE_HOVERING', 'ON_PRESS', 'WHILE_PRESSING', 'MOUSE_ENTER']);

/** The animation of a "Change to" interaction between variants. */
function readStateTransition(n: N): RawTransition | undefined {
	let reactions: Reaction[];
	try {
		reactions = Array.isArray(n.reactions) ? n.reactions : [];
	} catch {
		return undefined;
	}
	for (const r of reactions) {
		const trigger = r.trigger ? r.trigger.type : '';
		if (!STATE_TRIGGERS.has(trigger)) continue;
		const actions: N[] = r.actions ? (r.actions as N[]) : r.action ? [r.action] : [];
		for (const a of actions) {
			if (a.type !== 'NODE' || a.navigation !== 'CHANGE_TO') continue;
			const t = a.transition;
			if (!t || t.type === 'INSTANT') return { duration: 0, easing: 'LINEAR' };
			const easing = t.easing ? t.easing.type : 'EASE_OUT';
			const out: RawTransition = { duration: typeof t.duration === 'number' ? t.duration : 0.3, easing: easing };
			const fn = t.easing ? t.easing.easingFunctionCubicBezier : null;
			if (fn) out.bezier = [fn.x1, fn.y1, fn.x2, fn.y2];
			return out;
		}
	}
	return undefined;
}

function isVectorLike(n: N): boolean {
	if (VECTOR_TYPES.has(n.type)) return true;
	if (n.type === 'ELLIPSE') {
		const arc = n.arcData;
		return !!arc && (arc.startingAngle !== 0 || Math.abs(arc.endingAngle - Math.PI * 2) > 1e-3 || arc.innerRadius !== 0);
	}
	if (!CONTAINER_TYPES.has(n.type) || n.type === 'SECTION') return false;
	if (hasImageFill(n)) return false;
	let hasTrueVector = false;
	const walk = (node: N): boolean => {
		for (const c of node.children ?? []) {
			if (c.visible === false) continue;
			if (VECTOR_TYPES.has(c.type)) hasTrueVector = true;
			else if (c.type === 'RECTANGLE' || c.type === 'ELLIPSE') {
				if (hasImageFill(c)) return false;
			} else if (CONTAINER_TYPES.has(c.type)) {
				if (hasImageFill(c) || !walk(c)) return false;
			} else return false;
		}
		return true;
	};
	return (n.children?.length ?? 0) > 0 && walk(n) && hasTrueVector;
}

function hasImageFill(n: N): boolean {
	return Array.isArray(n.fills) && n.fills.some((p: Paint) => p.type === 'IMAGE' && p.visible !== false);
}

function hasMaskChild(n: N): boolean {
	return (n.children ?? []).some((c: N) => c.isMask === true && c.visible !== false);
}

// ---------- geometry ----------

function invert(m: Mat): Mat {
	const [[a, c, e], [b, d, f]] = m;
	const det = a * d - c * b || 1;
	const ia = d / det, ic = -c / det, ib = -b / det, id = a / det;
	return [
		[ia, ic, -(ia * e + ic * f)],
		[ib, id, -(ib * e + id * f)],
	];
}

function multiply(p: Mat, q: Mat): Mat {
	return [
		[p[0][0] * q[0][0] + p[0][1] * q[1][0], p[0][0] * q[0][1] + p[0][1] * q[1][1], p[0][0] * q[0][2] + p[0][1] * q[1][2] + p[0][2]],
		[p[1][0] * q[0][0] + p[1][1] * q[1][0], p[1][0] * q[0][1] + p[1][1] * q[1][1], p[1][0] * q[0][2] + p[1][1] * q[1][2] + p[1][2]],
	];
}

function transformGeometry(n: N, parent: N | null, isRoot: boolean) {
	const rel = isRoot || !parent ? IDENTITY : multiply(invert(parent.absoluteTransform), n.absoluteTransform);
	return {
		x: isRoot ? 0 : rel[0][2],
		y: isRoot ? 0 : rel[1][2],
		width: n.width ?? 0,
		height: n.height ?? 0,
		linear: [rel[0][0], rel[1][0], rel[0][1], rel[1][1]] as [number, number, number, number],
	};
}

function boundsGeometry(n: N, parent: N | null, isRoot: boolean) {
	const box = n.absoluteBoundingBox ?? { x: 0, y: 0, width: n.width ?? 0, height: n.height ?? 0 };
	let x = 0, y = 0;
	if (!isRoot && parent) {
		const inv = invert(parent.absoluteTransform);
		x = inv[0][0] * box.x + inv[0][1] * box.y + inv[0][2];
		y = inv[1][0] * box.x + inv[1][1] * box.y + inv[1][2];
	}
	return { x, y, width: box.width, height: box.height, linear: [1, 0, 0, 1] as [number, number, number, number] };
}

function readRadii(n: N): [number, number, number, number] {
	if (typeof n.topLeftRadius === 'number')
		return [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
	if (typeof n.cornerRadius === 'number') return [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius];
	return [0, 0, 0, 0];
}

function readStrokeWeights(n: N): [number, number, number, number] {
	if (typeof n.strokeTopWeight === 'number')
		return [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight];
	const w = typeof n.strokeWeight === 'number' ? n.strokeWeight : 0;
	return [w, w, w, w];
}

// ---------- layout ----------

function readAutoLayout(n: N): RawAutoLayout | undefined {
	if (!('layoutMode' in n)) return undefined;
	let src: N = n;
	let inferred = false;
	if (n.layoutMode === 'NONE') {
		let inf: N = null;
		try {
			inf = n.inferredAutoLayout;
		} catch {
			inf = null;
		}
		if (!inf || !inf.layoutMode || inf.layoutMode === 'NONE') return undefined;
		src = inf;
		inferred = true;
	}
	const layout: RawAutoLayout = {
		mode: src.layoutMode,
		inferred,
		primaryAlign: src.primaryAxisAlignItems ?? 'MIN',
		counterAlign: src.counterAxisAlignItems ?? 'MIN',
		wrap: src.layoutWrap === 'WRAP',
		alignContentBetween: src.counterAxisAlignContent === 'SPACE_BETWEEN',
		itemSpacing: src.itemSpacing ?? 0,
		counterSpacing: src.counterAxisSpacing ?? 0,
		padding: [src.paddingTop ?? 0, src.paddingRight ?? 0, src.paddingBottom ?? 0, src.paddingLeft ?? 0],
		reverseZ: src.itemReverseZIndex === true,
		strokesIncluded: src.strokesIncludedInLayout === true,
	};
	if (layout.mode === 'GRID') {
		const track = (t: N) => ({ type: t.type, value: t.value });
		layout.grid = {
			rows: (src.gridRowSizes ?? []).map(track),
			cols: (src.gridColumnSizes ?? []).map(track),
			rowGap: src.gridRowGap ?? 0,
			colGap: src.gridColumnGap ?? 0,
		};
	}
	return layout;
}

function readChildLayout(n: N, parent: RawAutoLayout): RawChildLayout {
	const absolute = n.layoutPositioning === 'ABSOLUTE';
	if (!parent.inferred) {
		const child: RawChildLayout = {
			absolute,
			sizingH: n.layoutSizingHorizontal ?? 'FIXED',
			sizingV: n.layoutSizingVertical ?? 'FIXED',
			grow: n.layoutGrow ?? 0,
			alignSelf: n.layoutAlign ?? 'INHERIT',
		};
		if (parent.mode === 'GRID') {
			child.grid = {
				row: n.gridRowAnchorIndex ?? 0,
				col: n.gridColumnAnchorIndex ?? 0,
				rowSpan: n.gridRowSpan ?? 1,
				colSpan: n.gridColumnSpan ?? 1,
				hAlign: n.gridChildHorizontalAlign ?? 'AUTO',
				vAlign: n.gridChildVerticalAlign ?? 'AUTO',
			};
		}
		return child;
	}

	// Inferred parent: Figma only reports child sizing when the child is itself a frame.
	let inf: N = null;
	try {
		inf = n.inferredAutoLayout;
	} catch {
		inf = null;
	}
	let sizingH: Sizing = 'FIXED';
	let sizingV: Sizing = 'FIXED';
	if (n.type === 'TEXT') {
		if (n.textAutoResize === 'WIDTH_AND_HEIGHT') sizingH = sizingV = 'HUG';
		else if (n.textAutoResize === 'HEIGHT') sizingV = 'HUG';
	}
	const grow = inf?.layoutGrow ?? 0;
	const alignSelf = inf?.layoutAlign ?? 'INHERIT';
	const horizontal = parent.mode === 'HORIZONTAL';
	if (grow > 0) horizontal ? (sizingH = 'FILL') : (sizingV = 'FILL');
	if (alignSelf === 'STRETCH') horizontal ? (sizingV = 'FILL') : (sizingH = 'FILL');
	return { absolute, sizingH, sizingV, grow, alignSelf };
}

// ---------- paints, effects, variables ----------

async function ensureVar(id: string | undefined, ctx: Ctx): Promise<string | undefined> {
	if (!id) return undefined;
	if (ctx.variables[id]) return id;
	try {
		const v = await figma.variables.getVariableByIdAsync(id);
		if (!v) return undefined;
		const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
		const meta: VariableMeta = { name: v.name, collection: col ? col.name : '' };
		if (col && col.modes.length > 1) {
			const modes: { name: string; value: ModeValue }[] = [];
			for (const mode of col.modes) {
				const value = await resolveModeValue(v.valuesByMode[mode.modeId], mode.name, 0);
				if (value !== undefined) modes.push({ name: mode.name, value: value });
			}
			meta.modes = modes;
		}
		ctx.variables[id] = meta;
		return id;
	} catch {
		return undefined;
	}
}

/** Follows aliases, preferring the mode with the same name in the aliased collection. */
async function resolveModeValue(value: unknown, modeName: string, depth: number): Promise<ModeValue | undefined> {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== 'object') return value as ModeValue;
	const obj = value as N;
	if (obj.type === 'VARIABLE_ALIAS') {
		if (depth > 8) return undefined;
		const target = await figma.variables.getVariableByIdAsync(obj.id);
		if (!target) return undefined;
		const col = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
		if (!col) return undefined;
		let modeId = col.defaultModeId;
		for (const m of col.modes) if (m.name === modeName) modeId = m.modeId;
		return resolveModeValue(target.valuesByMode[modeId], modeName, depth + 1);
	}
	if (typeof obj.r === 'number') return { r: obj.r, g: obj.g, b: obj.b, a: typeof obj.a === 'number' ? obj.a : 1 };
	return undefined;
}

async function readNodeVars(n: N, ctx: Ctx): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const bound = n.boundVariables;
	if (!bound) return out;
	for (const [field, alias] of Object.entries(bound)) {
		if (!alias || Array.isArray(alias)) continue;
		const id = await ensureVar((alias as VariableAlias).id, ctx);
		if (id) out[field] = id;
	}
	return out;
}

const rgba = (c: { r: number; g: number; b: number; a?: number }, opacity = 1): RGBA => ({
	r: c.r,
	g: c.g,
	b: c.b,
	a: (c.a ?? 1) * opacity,
});

export async function readPaints(paints: unknown, n: N, ctx: Ctx): Promise<RawPaint[]> {
	if (!Array.isArray(paints)) return [];
	const out: RawPaint[] = [];
	for (const p of paints as Paint[]) {
		if (p.visible === false) continue;
		const opacity = p.opacity ?? 1;
		if (p.type === 'SOLID') {
			out.push({
				type: 'SOLID',
				color: rgba(p.color, opacity),
				opacity,
				colorVar: await ensureVar(p.boundVariables?.color?.id, ctx),
				blendMode: p.blendMode,
			});
		} else if (
			p.type === 'GRADIENT_LINEAR' ||
			p.type === 'GRADIENT_RADIAL' ||
			p.type === 'GRADIENT_ANGULAR' ||
			p.type === 'GRADIENT_DIAMOND'
		) {
			const stops = [];
			for (const s of p.gradientStops) {
				stops.push({
					position: s.position,
					color: rgba(s.color, opacity),
					colorVar: await ensureVar(s.boundVariables?.color?.id, ctx),
				});
			}
			out.push({ type: p.type, transform: p.gradientTransform as Mat, stops, opacity });
		} else if (p.type === 'IMAGE') {
			out.push({
				type: 'IMAGE',
				assetId: p.imageHash ? await imageAsset(p.imageHash, n.name, ctx) : null,
				scaleMode: p.scaleMode,
				opacity,
				scalingFactor: p.scalingFactor,
				hasFilters: !!p.filters && Object.values(p.filters).some((v) => v !== 0),
			});
		} else {
			out.push({ type: 'UNSUPPORTED', kind: p.type });
		}
	}
	return out;
}

export async function readEffects(effects: unknown, ctx: Ctx): Promise<RawEffect[]> {
	if (!Array.isArray(effects)) return [];
	const out: RawEffect[] = [];
	for (const e of effects as Effect[]) {
		if (!e.visible) continue;
		if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
			out.push({
				type: e.type,
				color: rgba(e.color),
				x: e.offset.x,
				y: e.offset.y,
				radius: e.radius,
				spread: e.spread ?? 0,
				colorVar: await ensureVar(e.boundVariables?.color?.id, ctx),
			});
		} else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
			out.push({ type: e.type, radius: e.radius, progressive: e.blurType === 'PROGRESSIVE' });
		} else {
			out.push({ type: 'UNSUPPORTED', kind: e.type });
		}
	}
	return out;
}

// ---------- text ----------

async function readText(n: N, ctx: Ctx): Promise<RawText> {
	const segments: RawTextSegment[] = [];
	const styled = n.getStyledTextSegments([
		'fontName',
		'fontSize',
		'fontWeight',
		'lineHeight',
		'letterSpacing',
		'textCase',
		'textDecoration',
		'fills',
		'hyperlink',
		'listOptions',
		'paragraphSpacing',
		'boundVariables',
		'textStyleId',
	]) as StyledTextSegment[];

	let styleName: string | undefined;
	for (const s of styled) {
		const vars: Record<string, string> = {};
		for (const [field, alias] of Object.entries(s.boundVariables ?? {})) {
			const id = await ensureVar((alias as VariableAlias | undefined)?.id, ctx);
			if (id) vars[field] = id;
		}
		if (!styleName && s.textStyleId) styleName = await styleNameOf(s.textStyleId, ctx);
		segments.push({
			text: s.characters,
			fontFamily: s.fontName.family,
			fontWeight: s.fontWeight,
			italic: /italic|oblique/i.test(s.fontName.style),
			fontSize: s.fontSize,
			lineHeight: s.lineHeight.unit === 'AUTO' ? { unit: 'AUTO', value: 0 } : { unit: s.lineHeight.unit, value: s.lineHeight.value },
			letterSpacing: { unit: s.letterSpacing.unit, value: s.letterSpacing.value },
			textCase: s.textCase,
			decoration: s.textDecoration,
			fills: await readPaints(s.fills, n, ctx),
			href: s.hyperlink?.type === 'URL' ? s.hyperlink.value : undefined,
			listType: s.listOptions?.type ?? 'NONE',
			paragraphSpacing: s.paragraphSpacing ?? 0,
			vars,
		});
	}

	return {
		segments,
		alignH: n.textAlignHorizontal,
		alignV: n.textAlignVertical,
		autoResize: n.textAutoResize,
		truncate: n.textTruncation === 'ENDING' || n.textAutoResize === 'TRUNCATE',
		maxLines: n.maxLines ?? null,
		styleName,
	};
}

async function styleNameOf(id: string, ctx: Ctx): Promise<string | undefined> {
	if (ctx.styleNames.has(id)) return ctx.styleNames.get(id);
	try {
		const style = await figma.getStyleByIdAsync(id);
		const name = style?.name ?? '';
		ctx.styleNames.set(id, name);
		return name || undefined;
	} catch {
		return undefined;
	}
}

// ---------- assets ----------

function sniffImage(bytes: Uint8Array): { mime: string; ext: string } {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45)
		return { mime: 'image/webp', ext: 'webp' };
	return { mime: 'image/png', ext: 'png' };
}

function assetName(base: string, ext: string, ctx: Ctx): string {
	const slug =
		base
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'asset';
	let name = `${slug}.${ext}`;
	for (let i = 2; ctx.assetNames.has(name); i++) name = `${slug}-${i}.${ext}`;
	ctx.assetNames.add(name);
	return name;
}

async function imageAsset(hash: string, nodeName: string, ctx: Ctx): Promise<string | null> {
	const id = `img-${hash}`;
	if (ctx.assets.has(id)) return id;
	const image = figma.getImageByHash(hash);
	if (!image) return null;
	if (!ctx.options.assetBytes) {
		ctx.assets.set(id, { id, name: assetName(nodeName, 'png', ctx), mime: 'image/png', ext: 'png', bytes: new Uint8Array() });
		return id;
	}
	try {
		const bytes = await image.getBytesAsync();
		const { mime, ext } = sniffImage(bytes);
		ctx.assets.set(id, { id, name: assetName(nodeName, ext, ctx), mime, ext, bytes });
		return id;
	} catch {
		return null;
	}
}

/** A layer with a stroke paint but 0 width on every side (common in HTML → Figma imports). */
function hasZeroWidthStroke(n: N): boolean {
	const own = Array.isArray(n.strokes) && n.strokes.some((p: N) => p.visible !== false) && readStrokeWeights(n).every((w) => !w);
	return own || (Array.isArray(n.children) && n.children.some((c: N) => c.visible !== false && hasZeroWidthStroke(c)));
}

/**
 * Figma's SVG export still draws strokes whose side widths are all 0, as an outline path
 * of the layer's rectangle. Drop those unfilled rectangle outlines when such a layer is inside.
 */
function stripZeroWidthStrokes(n: N, bytes: Uint8Array): Uint8Array {
	if (!hasZeroWidthStroke(n)) return bytes;
	// Byte-wise string keeps any UTF-8 text intact; the pattern only matches ASCII.
	let text = '';
	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	const rect = /<path d="M-?[\d.]+ -?[\d.]+H-?[\d.]+V-?[\d.]+H-?[\d.]+V-?[\d.]+Z" stroke="[^"]*"(?: stroke-width="[^"]*")?\/>\s*/g;
	const cleaned = text.replace(rect, (m) => (/\sfill=/.test(m) ? m : ''));
	if (cleaned === text) return bytes;
	const out = new Uint8Array(cleaned.length);
	for (let i = 0; i < cleaned.length; i++) out[i] = cleaned.charCodeAt(i);
	return out;
}

async function exportNodeAsset(n: N, kind: 'SVG' | 'PNG', ctx: Ctx): Promise<string | undefined> {
	const id = `node-${n.id}`;
	if (!ctx.options.assetBytes) {
		const ext = kind === 'SVG' ? 'svg' : 'png';
		const mime = kind === 'SVG' ? 'image/svg+xml' : 'image/png';
		ctx.assets.set(id, { id, name: assetName(n.name, ext, ctx), mime, ext, bytes: new Uint8Array() });
		return id;
	}
	try {
		const bytes: Uint8Array =
			kind === 'SVG'
				? stripZeroWidthStrokes(n, await n.exportAsync({ format: 'SVG', useAbsoluteBounds: true }))
				: await n.exportAsync({ format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'SCALE', value: ctx.options.rasterScale } });
		const ext = kind === 'SVG' ? 'svg' : 'png';
		ctx.assets.set(id, {
			id,
			name: assetName(n.name, ext, ctx),
			mime: kind === 'SVG' ? 'image/svg+xml' : 'image/png',
			ext,
			bytes,
		});
		return id;
	} catch {
		return undefined;
	}
}

import type { TokenCollection, TokensResult, TokenTextStyle, TokenValue } from '../shared/types';
import { createCtx, readEffects, readPaints } from './read';

/** Reads every local variable collection and local style, independent of the selection. */
export async function readTokens(): Promise<TokensResult> {
	const ctx = createCtx({ rasterScale: 1, assetBytes: false });
	const collections: TokenCollection[] = [];
	const variables = await figma.variables.getLocalVariablesAsync();
	for (const col of await figma.variables.getLocalVariableCollectionsAsync()) {
		collections.push({
			name: col.name,
			modes: col.modes.map((m) => ({ id: m.modeId, name: m.name })),
			variables: variables
				.filter((v) => v.variableCollectionId === col.id && v.resolvedType !== 'EASING')
				.map((v) => ({
					id: v.id,
					name: v.name,
					type: v.resolvedType as TokenCollection['variables'][number]['type'],
					values: Object.fromEntries(
						Object.entries(v.valuesByMode).map(([mode, value]) => [mode, tokenValue(value)]),
					),
				})),
		});
	}

	const paintStyles = [];
	for (const style of await figma.getLocalPaintStylesAsync())
		paintStyles.push({ name: style.name, paints: await readPaints(style.paints, { name: style.name }, ctx) });

	const effectStyles = [];
	for (const style of await figma.getLocalEffectStylesAsync())
		effectStyles.push({ name: style.name, effects: await readEffects(style.effects, ctx) });

	const textStyles: TokenTextStyle[] = (await figma.getLocalTextStylesAsync()).map((t) => ({
		name: t.name,
		fontFamily: t.fontName.family,
		fontWeight: weightOf(t.fontName.style),
		italic: /italic|oblique/i.test(t.fontName.style),
		fontSize: t.fontSize,
		lineHeight: t.lineHeight.unit === 'AUTO' ? { unit: 'AUTO', value: 0 } : { unit: t.lineHeight.unit, value: t.lineHeight.value },
		letterSpacing: { unit: t.letterSpacing.unit, value: t.letterSpacing.value },
		textCase: t.textCase,
		decoration: t.textDecoration,
	}));

	return { collections, paintStyles, textStyles, effectStyles };
}

function tokenValue(value: VariableValue): TokenValue {
	if (typeof value === 'object' && value !== null) {
		if ('type' in value && value.type === 'VARIABLE_ALIAS') return { alias: value.id };
		if ('r' in value) return { r: value.r, g: value.g, b: value.b, a: 'a' in value ? value.a : 1 };
	}
	return value as string | number | boolean;
}

const WEIGHTS: [RegExp, number][] = [
	[/thin|hairline/i, 100],
	[/extra ?light|ultra ?light/i, 200],
	[/light/i, 300],
	[/medium/i, 500],
	[/semi ?bold|demi ?bold/i, 600],
	[/extra ?bold|ultra ?bold/i, 800],
	[/black|heavy/i, 900],
	[/bold/i, 700],
];

function weightOf(style: string): number {
	return WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;
}

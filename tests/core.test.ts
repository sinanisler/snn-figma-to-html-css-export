import { describe, expect, it } from 'vitest';
import { buildDocument } from '../src/core/build';
import { emit } from '../src/core/emit';
import { slugify } from '../src/core/format';
import type { RawNode, RawTextSegment, ReadResult } from '../src/shared/types';

const black = { r: 0, g: 0, b: 0, a: 1 };

function node(partial: Partial<RawNode>): RawNode {
	return {
		id: partial.id ?? Math.random().toString(36).slice(2),
		name: 'Frame 1',
		type: 'FRAME',
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		linear: [1, 0, 0, 1],
		opacity: 1,
		blendMode: 'PASS_THROUGH',
		clips: false,
		isMask: false,
		radii: [0, 0, 0, 0],
		fills: [],
		strokes: [],
		strokeWeights: [0, 0, 0, 0],
		strokeAlign: 'INSIDE',
		dashed: false,
		effects: [],
		vars: {},
		minMax: { minW: null, maxW: null, minH: null, maxH: null },
		children: [],
		...partial,
	};
}

function segment(text: string, extra: Partial<RawTextSegment> = {}): RawTextSegment {
	return {
		text,
		fontFamily: 'Inter',
		fontWeight: 400,
		italic: false,
		fontSize: 16,
		lineHeight: { unit: 'AUTO', value: 0 },
		letterSpacing: { unit: 'PERCENT', value: 0 },
		textCase: 'ORIGINAL',
		decoration: 'NONE',
		fills: [{ type: 'SOLID', color: black, opacity: 1 }],
		listType: 'NONE',
		paragraphSpacing: 0,
		vars: {},
		...extra,
	};
}

function textNode(name: string, segments: RawTextSegment[], extra: Partial<RawNode> = {}): RawNode {
	return node({
		name,
		type: 'TEXT',
		text: { segments, alignH: 'LEFT', alignV: 'TOP', autoResize: 'WIDTH_AND_HEIGHT', truncate: false, maxLines: null },
		...extra,
	});
}

function result(roots: RawNode[], variables: ReadResult['variables'] = {}): ReadResult {
	return { roots, assets: [], variables, warnings: [], nodeCount: 0, ms: 0 };
}

const build = (r: ReadResult, useVariables = true) => buildDocument(r, { decimals: 0, useVariables });

describe('class names', () => {
	it('rejects Figma default names and slugifies real ones', () => {
		expect(slugify('Rectangle 12')).toBeNull();
		expect(slugify('Frame')).toBeNull();
		expect(slugify('Hero Section')).toBe('hero-section');
		expect(slugify('  Café / Card  ')).toBe('cafe-card');
	});

	it('numbers generic layers and de-duplicates collisions', () => {
		const doc = build(
			result([
				node({
					name: 'Card',
					children: [node({ name: 'Card' }), node({ name: 'Rectangle 3', type: 'RECTANGLE' })],
				}),
			]),
		);
		const [root] = doc.roots;
		expect(root.className).toBe('card');
		expect(root.children.map((c) => c.className)).toEqual(['card-2', 'box-1']);
	});
});

describe('layout', () => {
	it('maps Auto Layout to flexbox', () => {
		const child = node({
			name: 'Item',
			child: { absolute: false, sizingH: 'FILL', sizingV: 'FIXED', grow: 1, alignSelf: 'INHERIT' },
		});
		const doc = build(
			result([
				node({
					name: 'Row',
					autoLayout: {
						mode: 'HORIZONTAL',
						inferred: false,
						primaryAlign: 'CENTER',
						counterAlign: 'MIN',
						wrap: false,
						alignContentBetween: false,
						itemSpacing: 12,
						counterSpacing: 0,
						padding: [8, 16, 8, 16],
						reverseZ: false,
						strokesIncluded: false,
					},
					children: [child],
				}),
			]),
		);
		const [row] = doc.roots;
		expect(row.style).toMatchObject({
			display: 'flex',
			'justify-content': 'center',
			'align-items': 'flex-start',
			gap: '12px',
			padding: '8px 16px',
		});
		expect(row.style['flex-direction']).toBeUndefined();
		expect(row.children[0].style).toMatchObject({ flex: '1 1 0', 'min-width': '0', height: '50px' });
	});

	it('positions non-Auto-Layout children absolutely inside a relative parent', () => {
		const doc = build(
			result([node({ name: 'Canvas', children: [node({ name: 'Badge', x: 10.4, y: 20.6, width: 30, height: 30 })] })]),
		);
		const [root] = doc.roots;
		expect(root.style.position).toBe('relative');
		expect(root.children[0].style).toMatchObject({ position: 'absolute', left: '10px', top: '21px' });
	});

	it('emits a rotation with a top-left origin for rotated absolute children', () => {
		const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
		const doc = build(result([node({ children: [node({ name: 'Tilted', linear: [c, s, -s, c] })] })]));
		expect(doc.roots[0].children[0].style).toMatchObject({ transform: 'rotate(45deg)', 'transform-origin': '0 0' });
	});
});

describe('paint', () => {
	it('converts a default linear gradient to a left-to-right CSS gradient', () => {
		const doc = build(
			result([
				node({
					name: 'Gradient',
					fills: [
						{
							type: 'GRADIENT_LINEAR',
							transform: [
								[1, 0, 0],
								[0, 1, 0],
							],
							stops: [
								{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
								{ position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
							],
							opacity: 1,
						},
					],
				}),
			]),
		);
		expect(doc.roots[0].style.background).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)');
	});

	it('uses outline for uniform strokes so layout is unaffected', () => {
		const doc = build(
			result([
				node({
					name: 'Box',
					strokes: [{ type: 'SOLID', color: black, opacity: 1 }],
					strokeWeights: [2, 2, 2, 2],
					strokeAlign: 'INSIDE',
				}),
			]),
		);
		expect(doc.roots[0].style).toMatchObject({ outline: '2px solid #000000', 'outline-offset': '-2px' });
	});
});

describe('variables', () => {
	it('exports bound variables as custom properties', () => {
		const r = result(
			[
				node({
					name: 'Box',
					fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, colorVar: 'v1' }],
				}),
			],
			{ v1: { name: 'color/surface/base', collection: 'Tokens' } },
		);
		const doc = build(r);
		expect(doc.variables).toEqual([{ name: '--color-surface-base', value: '#ffffff' }]);
		expect(doc.roots[0].style['background-color']).toBe('var(--color-surface-base)');
		expect(build(r, false).roots[0].style['background-color']).toBe('#ffffff');
	});
});

describe('text', () => {
	it('infers heading tags and splits styled runs into spans', () => {
		const doc = build(
			result([
				textNode('H1', [segment('Hello '), segment('world', { fontWeight: 700 })]),
			]),
		);
		const [h] = doc.roots;
		expect(h.tag).toBe('h1');
		expect(h.style['font-weight']).toBe('400');
		expect(h.runs?.[0].className).toBeUndefined();
		expect(h.runs?.[1]).toMatchObject({ className: 'h1-span-1', style: { 'font-weight': '700' } });
		const out = emit(doc, new Map(), 'inline');
		expect(out.markup).toContain('<h1 class="h1">Hello <span class="h1-span-1">world</span></h1>');
		expect(out.css).toContain('.h1-span-1 {\n  font-weight: 700;\n}');
	});

	it('turns a fully linked text layer into an anchor and escapes content', () => {
		const doc = build(result([textNode('Docs', [segment('<Read> & learn', { href: 'https://example.com' })])]));
		const out = emit(doc, new Map(), 'inline');
		expect(out.markup).toContain('<a class="docs" href="https://example.com">&lt;Read&gt; &amp; learn</a>');
	});
});

describe('assets', () => {
	it('inlines, links or abbreviates exported assets depending on mode', () => {
		const r = result([node({ name: 'Logo', type: 'VECTOR', exportAsset: 'node-1' })]);
		r.assets = [{ id: 'node-1', name: 'logo.svg', mime: 'image/svg+xml', ext: 'svg', bytes: new TextEncoder().encode('<svg/>') }];
		const doc = build(r);
		const assets = new Map(r.assets.map((a) => [a.id, a]));
		expect(emit(doc, assets, 'inline').markup).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
		expect(emit(doc, assets, 'files').markup).toContain('src="assets/logo.svg"');
		expect(emit(doc, assets, 'preview').markup).toContain('…(logo.svg, 1 KB)');
	});
});

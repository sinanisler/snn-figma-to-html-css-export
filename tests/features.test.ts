import { describe, expect, it } from 'vitest';
import { buildDocument } from '../src/core/build';
import { checkDesign } from '../src/core/check';
import { assetResolver, cssText, renderMarkup } from '../src/core/emit';
import { generate } from '../src/core/generate';
import type { IRDocument } from '../src/core/ir';
import { nextFiles, starterFiles } from '../src/core/starter';
import type { RawAutoLayout, RawNode, RawTextSegment, ReadResult } from '../src/shared/types';

const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };
let seq = 0;

function node(partial: Partial<RawNode>): RawNode {
	return {
		id: partial.id ?? `n${++seq}`,
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

const text = (name: string, value: string, extra: Partial<RawNode> = {}) =>
	node({
		name,
		type: 'TEXT',
		text: { segments: [segment(value)], alignH: 'LEFT', alignV: 'TOP', autoResize: 'WIDTH_AND_HEIGHT', truncate: false, maxLines: null },
		...extra,
	});

const column = (itemSpacing = 0): RawAutoLayout => ({
	mode: 'VERTICAL',
	inferred: false,
	primaryAlign: 'MIN',
	counterAlign: 'MIN',
	wrap: false,
	alignContentBetween: false,
	itemSpacing,
	counterSpacing: 0,
	padding: [0, 0, 0, 0],
	reverseZ: false,
	strokesIncluded: false,
});

const fixedChild = { absolute: false, sizingH: 'FIXED', sizingV: 'FIXED', grow: 0, alignSelf: 'INHERIT' } as const;

const result = (roots: RawNode[], variables: ReadResult['variables'] = {}): ReadResult => ({
	roots,
	assets: [],
	variables,
	warnings: [],
	nodeCount: 0,
	ms: 0,
});

const build = (r: ReadResult) => buildDocument(r, { decimals: 0, useVariables: true, shareClasses: true });
const css = (doc: IRDocument, systemDark = false) => cssText(doc, assetResolver(new Map(), 'inline'), { systemDark });
const markup = (doc: IRDocument) => renderMarkup(doc, 0, { assets: new Map(), assetMode: 'inline' });

describe('variable modes', () => {
	const r = result([node({ name: 'Box', fills: [{ type: 'SOLID', color: white, opacity: 1, colorVar: 'bg' }] })], {
		bg: {
			name: 'color/bg',
			collection: 'Theme',
			modes: [
				{ name: 'Light', value: white },
				{ name: 'Dark', value: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
			],
		},
	});

	it('writes other modes behind a data-theme attribute', () => {
		const out = css(build(r));
		expect(out).toContain(':root {\n  --color-bg: #ffffff;\n}');
		expect(out).toContain('[data-theme="dark"] {\n  --color-bg: #1a1a1a;\n}');
		expect(out).not.toContain('prefers-color-scheme');
	});

	it('follows the system dark mode when asked', () => {
		expect(css(build(r), true)).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {\n    --color-bg: #1a1a1a;\n  }\n}');
	});
});

describe('state transitions', () => {
	const button = (color: typeof black) =>
		node({ name: 'Button', fills: [{ type: 'SOLID', color, opacity: 1 }], children: [text('Label', 'Go')] });

	it('animates hover changes with a short default', () => {
		const doc = build(result([{ ...button(black), states: [{ state: 'hover', node: button(white) }] }]));
		expect(css(doc)).toContain('transition: background-color 150ms ease-out;');
	});

	it('uses the prototype animation and skips instant ones', () => {
		const smart = build(
			result([{ ...button(black), states: [{ state: 'hover', node: button(white) }], stateTransition: { duration: 0.3, easing: 'EASE_IN_AND_OUT' } }]),
		);
		expect(css(smart)).toContain('transition: background-color 300ms ease-in-out;');
		const instant = build(result([{ ...button(black), states: [{ state: 'hover', node: button(white) }], stateTransition: { duration: 0, easing: 'LINEAR' } }]));
		expect(css(instant)).not.toContain('transition');
	});
});

describe('accessibility', () => {
	it('ties a label to the input next to it', () => {
		const doc = build(
			result([
				node({
					name: 'Field',
					autoLayout: column(4),
					children: [text('Label', 'Email', { child: fixedChild }), node({ name: 'Email input', child: fixedChild, children: [text('Placeholder', 'you@example.com')] })],
				}),
			]),
		);
		const html = markup(doc);
		expect(html).toContain('<label class="label" for="email-input">Email</label>');
		expect(html).toContain('<input class="email-input" type="email" placeholder="you@example.com" id="email-input">');
	});

	it('names icon-only buttons after their layer', () => {
		const doc = build(result([node({ name: 'Close button', children: [node({ name: 'Vector', type: 'VECTOR', exportAsset: 'x' })] })]));
		expect(markup(doc)).toContain('<button class="close-button" type="button" aria-label="Close button">');
	});
});

describe('components', () => {
	const card = (title: string, x: number) =>
		node({
			name: 'Card',
			x,
			component: { id: 'card', name: 'Card' },
			autoLayout: column(8),
			fills: [{ type: 'SOLID', color: white, opacity: 1 }],
			children: [text('Title', title, { child: fixedChild }), text('Body', 'Same text', { child: fixedChild })],
		});
	const page = () => build(result([node({ name: 'Home', children: [card('First', 0), card('Second', 200)] })]));

	it('extracts a React component with props for values that differ', () => {
		const files = generate(page(), { format: 'react', assets: new Map(), assetMode: 'files', googleFonts: false, inlineSvg: false });
		const comp = files.find((f) => f.path === 'src/components/Card.jsx')!;
		expect(comp.content).toContain('export default function Card({ className, title = "First" }) {');
		expect(comp.content).toContain('<div className={className}>');
		expect(comp.content).toContain('<p className="title">{title}</p>');
		expect(comp.content).toMatch(/<p className="[a-z-]+">Same text<\/p>/);
		const home = files.find((f) => f.path === 'src/pages/Home.jsx')!;
		expect(home.content).toContain("import Card from '../components/Card';");
		expect(home.content).toMatch(/<Card className="card[^"]*" title="First" \/>/);
		expect(home.content).toMatch(/<Card className="card[^"]*" title="Second" \/>/);
	});

	it('types props in TypeScript and writes Vue and Svelte components', () => {
		const tsx = generate(page(), { format: 'react', assets: new Map(), assetMode: 'files', googleFonts: false, inlineSvg: false, typescript: true });
		expect(tsx.find((f) => f.path === 'src/components/Card.tsx')!.content).toContain('type CardProps = {\n  className?: string;\n  title?: string;\n};');

		const vue = generate(page(), { format: 'vue', assets: new Map(), assetMode: 'files', googleFonts: false, inlineSvg: false });
		const vueComp = vue.find((f) => f.path === 'src/components/Card.vue')!.content;
		expect(vueComp).toContain('defineProps({\n  title: { type: String, default: "First" },\n});');
		expect(vueComp).toContain('<p class="title">{{ title }}</p>');
		expect(vue.find((f) => f.path === 'src/pages/Home.vue')!.content).toContain("import Card from '../components/Card.vue';");

		const svelte = generate(page(), { format: 'svelte', assets: new Map(), assetMode: 'files', googleFonts: false, inlineSvg: false, typescript: true });
		const svelteComp = svelte.find((f) => f.path === 'src/components/Card.svelte')!.content;
		expect(svelteComp).toContain(`let { class: className = '', title = "First" }: { class?: string; title?: string } = $props();`);
		expect(svelteComp).toContain('<div class={className}>');
	});

	it('can keep everything inline', () => {
		const files = generate(page(), { format: 'react', assets: new Map(), assetMode: 'files', googleFonts: false, inlineSvg: false, components: false });
		expect(files.some((f) => f.path?.includes('components/'))).toBe(false);
	});
});

describe('projects', () => {
	const doc = () =>
		build(result([node({ id: 'home', name: 'Home', topLevel: true, children: [node({ name: 'Pricing link', link: { nodeId: 'pricing' } })] }), node({ id: 'pricing', name: 'Pricing', topLevel: true })]));

	it('writes a TypeScript Vite starter', () => {
		const files = starterFiles(doc(), new Map(), { format: 'react', googleFonts: false, inlineSvg: false, typescript: true });
		expect(Object.keys(files)).toEqual(expect.arrayContaining(['src/main.tsx', 'src/App.tsx', 'src/pages/Home.tsx', 'tsconfig.json', 'vite.config.ts']));
		expect(JSON.parse(files['package.json'] as string).devDependencies).toHaveProperty('typescript');
	});

	it('writes a Next.js app with one route per page', () => {
		const files = nextFiles(doc(), new Map(), { format: 'react-tailwind', googleFonts: false, inlineSvg: false });
		expect(Object.keys(files)).toEqual(
			expect.arrayContaining(['app/layout.jsx', 'app/page.jsx', 'app/pricing/page.jsx', 'views/Home.jsx', 'views/Pricing.jsx', 'app/globals.css', 'postcss.config.mjs', 'next.config.mjs']),
		);
		expect(files['app/pricing/page.jsx']).toContain("import Pricing from '../../views/Pricing';");
		expect(files['views/Home.jsx']).toContain('href="/pricing"');
		expect(files['views/Home.jsx']).not.toContain("import '");
		expect(files['app/layout.jsx']).toContain("import './globals.css';");
		expect(JSON.parse(files['package.json'] as string).dependencies).toHaveProperty('next');
	});
});

describe('design check', () => {
	it('scores Auto Layout use and reports problems', () => {
		const r = result([
			node({
				name: 'Page',
				autoLayout: column(),
				children: [
					node({ name: 'Frame 12', child: fixedChild, children: [text('H3 title', 'Hi'), node({ name: 'Rectangle 2', type: 'RECTANGLE', fills: [{ type: 'IMAGE', assetId: 'img', scaleMode: 'FILL', opacity: 1, hasFilters: false }] })] }),
				],
			}),
		]);
		const report = checkDesign(r, build(r));
		expect(report.score).toBe(50);
		expect(report.issues.map((i) => i.code).sort()).toEqual(['CHECK_GENERIC_NAME', 'CHECK_HEADING_SKIP', 'CHECK_IMAGE_ALT', 'CHECK_NO_AUTO_LAYOUT']);
	});
});

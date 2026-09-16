import { describe, expect, it } from 'vitest';
import { breakpointFor, buildDocument, pageKey, type BuildOptions } from '../src/core/build';
import { assetResolver, cssText, renderMarkup, type RenderOptions } from '../src/core/emit';
import { googleFontsUrl } from '../src/core/fonts';
import { slugify } from '../src/core/format';
import { generate } from '../src/core/generate';
import type { IRDocument } from '../src/core/ir';
import { starterFiles } from '../src/core/starter';
import { toUtilities } from '../src/core/tailwind';
import { tokensToCss, tokensToJson } from '../src/core/tokens';
import type { RawAutoLayout, RawNode, RawTextSegment, ReadResult } from '../src/shared/types';

const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };

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

function result(roots: RawNode[], variables: ReadResult['variables'] = {}): ReadResult {
	return { roots, assets: [], variables, warnings: [], nodeCount: 0, ms: 0 };
}

const build = (r: ReadResult, opts: Partial<BuildOptions> = {}) =>
	buildDocument(r, { decimals: 0, useVariables: true, ...opts });

const roots = (doc: IRDocument) => doc.pages[0].roots;
const markup = (doc: IRDocument, opts: Partial<RenderOptions> = {}) =>
	renderMarkup(doc, 0, { assets: new Map(), assetMode: 'inline', ...opts });
const css = (doc: IRDocument) => cssText(doc, assetResolver(new Map(), 'inline'));

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
					children: [node({ name: 'Card', width: 10 }), node({ name: 'Rectangle 3', type: 'RECTANGLE' })],
				}),
			]),
		);
		const [root] = roots(doc);
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
					autoLayout: { ...column(12), mode: 'HORIZONTAL', primaryAlign: 'CENTER', padding: [8, 16, 8, 16] },
					children: [child],
				}),
			]),
		);
		const [row] = roots(doc);
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
		const [root] = roots(doc);
		expect(root.style.position).toBe('relative');
		expect(root.children[0].style).toMatchObject({ position: 'absolute', left: '10px', top: '21px' });
	});

	it('emits a rotation with a top-left origin for rotated absolute children', () => {
		const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
		const doc = build(result([node({ children: [node({ name: 'Tilted', linear: [c, s, -s, c] })] })]));
		expect(roots(doc)[0].children[0].style).toMatchObject({ transform: 'rotate(45deg)', 'transform-origin': '0 0' });
	});

	it('converts lengths to rem', () => {
		const doc = build(result([node({ name: 'Box', width: 24, height: 13 })]), { units: 'rem' });
		expect(roots(doc)[0].style).toMatchObject({ width: '1.5rem', height: '0.813rem' });
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
		expect(roots(doc)[0].style.background).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)');
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
		expect(roots(doc)[0].style).toMatchObject({ outline: '2px solid #000000', 'outline-offset': '-2px' });
	});
});

describe('variables', () => {
	it('exports bound variables as custom properties', () => {
		const r = result(
			[
				node({
					name: 'Box',
					fills: [{ type: 'SOLID', color: white, opacity: 1, colorVar: 'v1' }],
				}),
			],
			{ v1: { name: 'color/surface/base', collection: 'Tokens' } },
		);
		const doc = build(r);
		expect(doc.variables).toEqual([{ name: '--color-surface-base', value: '#ffffff' }]);
		expect(roots(doc)[0].style['background-color']).toBe('var(--color-surface-base)');
		expect(roots(build(r, { useVariables: false }))[0].style['background-color']).toBe('#ffffff');
	});
});

describe('text', () => {
	it('infers heading tags and splits styled runs into spans', () => {
		const doc = build(result([textNode('H1', [segment('Hello '), segment('world', { fontWeight: 700 })])]));
		const [h] = roots(doc);
		expect(h.tag).toBe('h1');
		expect(h.style['font-weight']).toBe('400');
		expect(h.runs?.[0].className).toBeUndefined();
		expect(h.runs?.[1]).toMatchObject({ className: 'h1-span-1', style: { 'font-weight': '700' } });
		expect(markup(doc)).toContain('<h1 class="h1">Hello <span class="h1-span-1">world</span></h1>');
		expect(css(doc)).toContain('.h1-span-1 {\n  font-weight: 700;\n}');
	});

	it('turns a fully linked text layer into an anchor and escapes content', () => {
		const doc = build(result([textNode('Docs', [segment('<Read> & learn', { href: 'https://example.com' })])]));
		expect(markup(doc)).toContain('<a class="docs" href="https://example.com">&lt;Read&gt; &amp; learn</a>');
	});
});

describe('fonts', () => {
	it('builds a Google Fonts URL with italics and skips system fonts', () => {
		expect(
			googleFontsUrl([
				{ family: 'Open Sans', weights: [400, 700], italicWeights: [400] },
				{ family: 'Arial', weights: [400], italicWeights: [] },
				{ family: 'SF Pro Display', weights: [400], italicWeights: [] },
			]),
		).toBe('https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,700;1,400&display=swap');
		expect(googleFontsUrl([{ family: 'Arial', weights: [400], italicWeights: [] }])).toBeNull();
	});

	it('links the fonts from the HTML document', () => {
		const doc = build(result([textNode('Title', [segment('Hi')])]));
		const [file] = generate(doc, { format: 'html', assets: new Map(), assetMode: 'inline', googleFonts: true, inlineSvg: false });
		expect(file.content).toContain('href="https://fonts.googleapis.com/css2?family=Inter:wght@400&amp;display=swap"');
	});
});

describe('semantics', () => {
	it('builds form controls from named frames', () => {
		const field = node({
			name: 'Email input',
			children: [textNode('Placeholder', [segment('you@example.com', { fills: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, opacity: 1 }] })])],
		});
		const doc = build(result([field]));
		const [input] = roots(doc);
		expect(input.tag).toBe('input');
		expect(input.attrs).toMatchObject({ type: 'email', placeholder: 'you@example.com' });
		expect(input.style['font-size']).toBe('16px');
		expect(markup(doc)).toContain('<input class="email-input" type="email" placeholder="you@example.com" aria-label="you@example.com">');
		expect(css(doc)).toContain('.email-input::placeholder {\n  color: #808080;\n  opacity: 1;\n}');
	});

	it('wraps list children in classless list items', () => {
		const doc = build(
			result([node({ name: 'Nav links', autoLayout: column(), children: [textNode('Home', [segment('Home')], { child: fixedChild })] })]),
		);
		expect(markup(doc)).toContain('<ul class="nav-links">\n  <li>\n    <p class="home">Home</p>\n  </li>\n</ul>');
		expect(css(doc)).toContain('ul > li:not([class])');
	});
});

describe('prototype links', () => {
	it('uses URL actions and links frames to pages', () => {
		const home = node({
			id: 'home',
			name: 'Home',
			topLevel: true,
			children: [
				node({ name: 'Docs', link: { url: 'https://example.com', newTab: true } }),
				node({ name: 'About link', link: { nodeId: 'about' } }),
				node({ name: 'Elsewhere', link: { nodeId: 'missing' } }),
			],
		});
		const about = node({ id: 'about', name: 'About', topLevel: true });
		const doc = build(result([home, about]));
		expect(doc.pages.map((p) => p.slug)).toEqual(['index', 'about']);
		const html = markup(doc, { linkHref: (l) => (l.page !== undefined ? `${doc.pages[l.page].slug}.html` : l.url ?? '#') });
		expect(html).toContain('<a class="docs" href="https://example.com" target="_blank" rel="noopener" aria-label="Docs">');
		expect(html).toContain('<a class="about-link" aria-label="About link" href="about.html">');
		expect(doc.warnings.some((w) => w.code === 'LINK_TARGET_OUTSIDE')).toBe(true);
	});
});

describe('breakpoints', () => {
	it('groups frames by name and snaps breakpoints to device widths', () => {
		expect(pageKey('Home / Mobile')).toBe('Home');
		expect(pageKey('Desktop - Pricing')).toBe('Pricing');
		expect(pageKey('Pricing 2025')).toBe('Pricing 2025');
		expect(breakpointFor(375, 1440)).toBe(767);
		expect(breakpointFor(768, 1440)).toBe(1023);
		expect(breakpointFor(1280, 1440)).toBe(1439);
	});

	it('merges a mobile frame into media query overrides', () => {
		const desktop = node({
			name: 'Home / Desktop',
			width: 1440,
			height: 900,
			topLevel: true,
			autoLayout: column(),
			children: [
				node({ name: 'Hero', width: 1200, height: 400, child: fixedChild }),
				node({ name: 'Sidebar', width: 300, height: 400, child: fixedChild }),
			],
		});
		const mobile = node({
			name: 'Home / Mobile',
			width: 375,
			height: 1600,
			topLevel: true,
			autoLayout: column(),
			children: [
				node({ name: 'Hero', width: 343, height: 400, child: fixedChild }),
				node({ name: 'Menu button', width: 40, height: 40, child: fixedChild }),
			],
		});
		const doc = build(result([mobile, desktop]));
		expect(doc.pages).toHaveLength(1);
		expect(doc.media).toEqual(['(max-width: 767px)']);
		const out = css(doc);
		expect(out).toContain('.home-desktop {\n  width: 100%;');
		expect(out).toContain('@media (max-width: 767px) {\n  .home-desktop {\n    min-height: 1600px;\n  }');
		expect(out).toContain('  .hero {\n    width: 343px;\n  }');
		expect(out).toContain('  .sidebar {\n    display: none;\n  }');
		expect(out).toContain('  .menu-button {\n    display: block;\n  }');
		expect(out).toMatch(/\.menu-button \{\n(.*\n)*  display: none;\n\}/);
	});
});

describe('components', () => {
	it('turns hover variants into :hover rules', () => {
		const button = (color: typeof black) =>
			node({ name: 'Button', fills: [{ type: 'SOLID', color, opacity: 1 }], children: [textNode('Label', [segment('Go')])] });
		const instance = { ...button(black), states: [{ state: 'hover' as const, node: button(white) }] };
		const doc = build(result([instance]));
		expect(css(doc)).toContain('.button:hover {\n  background-color: #ffffff;\n}');
	});

	it('moves properties shared by every instance into one class', () => {
		const instance = (w: number) =>
			node({
				name: 'Card',
				width: w,
				component: { id: 'c1', name: 'Card' },
				radii: [8, 8, 8, 8],
				fills: [{ type: 'SOLID', color: white, opacity: 1 }],
			});
		const doc = build(result([node({ name: 'Grid', children: [instance(100), instance(200)] })]), { shareClasses: true });
		const [a, b] = roots(doc)[0].children;
		expect(doc.sharedClasses).toEqual([{ name: 'card', style: { height: '50px', 'border-radius': '8px', 'background-color': '#ffffff' } }]);
		expect([a.shared, b.shared]).toEqual([['card'], ['card']]);
		expect(markup(doc)).toContain('class="card card-1"');
	});

	it('reuses one class for identical styles', () => {
		const doc = build(result([node({ name: 'Row', children: [node({ name: 'Dot' }), node({ name: 'Dot' })] })]), { shareClasses: true });
		const [a, b] = roots(doc)[0].children;
		expect(a.className).toBe('dot');
		expect(b.className).toBe('dot');
	});
});

describe('formats', () => {
	const svgAsset = {
		id: 'node-1',
		name: 'logo.svg',
		mime: 'image/svg+xml',
		ext: 'svg',
		bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path id="p" stroke-width="2" d="M0 0"/><use href="#p"/></svg>'),
	};
	const assets = new Map([['node-1', svgAsset]]);
	const sample = () =>
		build({
			...result([
				node({
					name: 'Card',
					autoLayout: { ...column(16), padding: [24, 24, 24, 24] },
					fills: [{ type: 'SOLID', color: white, opacity: 1 }],
					children: [
						node({ name: 'Logo', type: 'VECTOR', exportAsset: 'node-1', child: fixedChild }),
						textNode('Title', [segment('Hi {there}')], { child: fixedChild }),
					],
				}),
			]),
			assets: [svgAsset],
		});

	it('maps styles to Tailwind utilities', () => {
		const u = toUtilities({ display: 'flex', 'flex-direction': 'column', gap: '16px', padding: '8px 12px', 'background-color': '#ffffff', width: '375px', background: 'url("x.png") center / cover no-repeat' });
		expect(u.classes).toEqual(['flex', 'flex-col', 'gap-4', 'py-2', 'px-3', 'bg-[#ffffff]', 'w-[375px]']);
		expect(u.inline).toEqual({ background: 'url("x.png") center / cover no-repeat' });
	});

	it('renders Tailwind HTML with the browser build', () => {
		const files = generate(sample(), { format: 'tailwind', assets, assetMode: 'files', googleFonts: false, inlineSvg: false });
		expect(files[0].content).toContain('@tailwindcss/browser@4');
		expect(files[1].content).toContain('<div class="w-[100px] h-[50px] flex flex-col items-start gap-4 p-6 bg-[#ffffff]">');
	});

	it('renders a React component with JSX attributes', () => {
		const files = generate(sample(), { format: 'react', assets, assetMode: 'files', googleFonts: false, inlineSvg: true });
		const jsx = files.find((f) => f.lang === 'jsx')!;
		expect(jsx.path).toBe('src/pages/Card.jsx');
		expect(jsx.content).toContain('export default function Card() {');
		expect(jsx.content).toContain('<div className="card">');
		expect(jsx.content).toContain("Hi {'{'}there{'}'}");
		expect(jsx.content).toContain('<svg className="logo" role="img" aria-label="Logo"');
		expect(jsx.content).toContain('strokeWidth="2"');
		expect(jsx.content).toContain('id="s1-p"');
		expect(jsx.content).toContain('href="#s1-p"');
	});

	it('renders email HTML with inline styles', () => {
		const [file] = generate(sample(), { format: 'email', assets, assetMode: 'files', googleFonts: false, inlineSvg: false });
		expect(file.content).toContain('<div style="width: 100px; height: 50px; display: flex;');
		expect(file.content).not.toContain('class=');
	});

	it('writes a runnable Vite starter', () => {
		const files = starterFiles(sample(), assets, { format: 'react-tailwind', googleFonts: false, inlineSvg: false });
		expect(Object.keys(files).sort()).toEqual(
			['.gitignore', 'README.md', 'index.html', 'package.json', 'public/assets/logo.svg', 'src/App.jsx', 'src/main.jsx', 'src/pages/Card.jsx', 'src/styles.css', 'vite.config.js'].sort(),
		);
		expect(files['src/styles.css']).toContain('@import "tailwindcss";');
		expect(JSON.parse(files['package.json'] as string).devDependencies).toHaveProperty('@tailwindcss/vite');
	});
});

describe('tokens', () => {
	const tokens = {
		collections: [
			{
				name: 'Theme',
				modes: [
					{ id: 'm1', name: 'Light' },
					{ id: 'm2', name: 'Dark' },
				],
				variables: [
					{ id: 'a', name: 'color/bg', type: 'COLOR' as const, values: { m1: white, m2: black } },
					{ id: 'b', name: 'color/surface', type: 'COLOR' as const, values: { m1: { alias: 'a' }, m2: { alias: 'a' } } },
					{ id: 'c', name: 'space/md', type: 'FLOAT' as const, values: { m1: 16, m2: 16 } },
				],
			},
		],
		paintStyles: [],
		textStyles: [],
		effectStyles: [],
	};

	it('writes modes as CSS custom properties', () => {
		const out = tokensToCss(tokens, { units: 'px', decimals: 0 });
		expect(out).toContain(':root {\n  --color-bg: #ffffff;\n  --color-surface: var(--color-bg);\n  --space-md: 16px;\n}');
		expect(out).toContain('[data-theme="dark"] {\n  --color-bg: #000000;');
	});

	it('writes W3C design tokens JSON', () => {
		const json = JSON.parse(tokensToJson(tokens));
		expect(json.Theme.color.surface).toMatchObject({ $type: 'color', $value: '{Theme.color.bg}' });
		expect(json.Theme.color.bg.$extensions.modes.Dark).toBe('#000000');
	});
});

describe('assets', () => {
	it('inlines, links or abbreviates exported assets depending on mode', () => {
		const r = result([node({ name: 'Logo', type: 'VECTOR', exportAsset: 'node-1' })]);
		r.assets = [{ id: 'node-1', name: 'logo.svg', mime: 'image/svg+xml', ext: 'svg', bytes: new TextEncoder().encode('<svg/>') }];
		const doc = build(r);
		const assets = new Map(r.assets.map((a) => [a.id, a]));
		expect(markup(doc, { assets, assetMode: 'inline' })).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
		expect(markup(doc, { assets, assetMode: 'files' })).toContain('src="assets/logo.svg"');
		expect(markup(doc, { assets, assetMode: 'preview' })).toContain('…(logo.svg, 1 KB)');
	});
});

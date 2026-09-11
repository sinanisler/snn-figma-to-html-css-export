# SNN Design to HTML/CSS

A free Figma plugin that exports the selected layers as plain, semantic HTML and CSS. No AI, no network access — everything runs locally inside Figma.

- Auto Layout → flexbox, grid Auto Layout → CSS grid
- Frames without Auto Layout use Figma's own layout inference (`inferredAutoLayout`) when it finds a clean row/column; otherwise children are positioned absolutely
- Fills, gradients, strokes, radii, shadows, blurs, opacity, blend modes
- Rich text: mixed styles become `<span>`s, links become `<a>`, `H1`–`H6` layer or text-style names become headings
- Vectors and icon groups export as SVG; image fills keep their original format (PNG/JPG/GIF/WebP)
- Figma variables become CSS custom properties (`:root { --color-primary: … }`)
- Semantic tags from layer names: `header`, `footer`, `nav`, `main`, `section`, `aside`, `article`, `button`, `link`
- Conversion notes list everything that was approximated; click one to select that layer

## Develop

```bash
npm install
npm run dev        # Plugma dev server with hot reload
npm run build      # production build into dist/
npm test           # converter unit tests
npm run typecheck
```

Load it in the Figma desktop app: **Plugins → Development → Import plugin from manifest…** and pick `dist/manifest.json` (run `npm run dev` or `npm run build` first).

## Using it

1. Select one or more layers (usually a frame).
2. Press **Generate** (or Ctrl/⌘ + Enter).
3. Switch between **HTML file**, **HTML** and **CSS**, then **Copy** or **Download .zip**.

Copying embeds images as base64. When an export has more than 8 images or over 2 MB of assets, the plugin recommends the `.zip` instead, which contains `index.html`, `styles.css` and an `assets/` folder.

Name your layers — class names come from layer names, and generic names like `Rectangle 12` fall back to `box-1`, `text-2`, …

## Layout

```
src/main/     Figma sandbox: reads the selection into a serializable tree, exports assets
src/core/     pure converter: tree → IR (layout, tags, class names, variables) → HTML/CSS
src/ui/       plugin window: CodeMirror viewer, copy, zip download, settings
src/shared/   types shared by both threads
tests/        converter tests (Vitest)
```

Note: Figma only lets users with edit access to a file run plugins; viewers can't launch any plugin.

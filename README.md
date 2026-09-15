# SNN Design to HTML/CSS

A free Figma plugin that exports the selected layers as clean, semantic web code: HTML + CSS, Tailwind, React, Vue, Svelte or email HTML. No AI, no account, no network access — everything runs locally inside Figma.

**Layout & style**

- Auto Layout → flexbox, grid Auto Layout → CSS grid
- Frames without Auto Layout use Figma's own layout inference (`inferredAutoLayout`) when it finds a clean row/column; otherwise children are positioned absolutely
- Fills, gradients, strokes, radii, shadows, blurs, opacity, blend modes
- Rich text: mixed styles become `<span>`s, links become `<a>`, `H1`–`H6` layer or text-style names become headings
- Figma variables become CSS custom properties (`:root { --color-primary: … }`)
- `px` or `rem` units, 0–2 decimals

**Semantics**

- Tags from layer names: `header`, `footer`, `nav`, `main`, `section`, `aside`, `article`, `figure`, `form`, `button`, `link`
- Form controls: frames named `input`, `email field`, `search bar`, `textarea`, `dropdown`… become `<input>` / `<textarea>` / `<select>` with the inner text as placeholder
- Lists: frames named `list`, `links`, `ul`, `ol` become lists; label/caption text layers become `<label>` / `<figcaption>`
- Image `alt` text from layer names

**Interactions & responsive**

- Prototype links: "Open link" → `href`, "Navigate to" a frame → link to that page or anchor
- Component variants named `State=Hover` / `Focus` / `Pressed` → `:hover`, `:focus-visible`, `:active` rules
- Select several top-level frames → a multi-page site (`index.html`, `about.html`, one `styles.css`)
- Frames sharing a name with a breakpoint marker (`Home / Desktop`, `Home / Tablet`, `Home / Mobile`) merge into one page with `@media (max-width: …)` overrides; layers missing at a breakpoint are hidden, layers only there are added

**Cleaner CSS**

- Properties shared by every instance of a component, or every text layer with a text style, move to one class
- Layers with identical styles reuse one class
- Google Fonts `<link>` generated from the fonts used (system and commercial fonts are listed in the notes instead)

**Output**

- Live preview with 1440 / 768 / 375 widths; links between pages work inside the preview
- Copy the current file, or download a `.zip`, a ready-to-run **Vite starter project**, or **design tokens** (`tokens.css` with every variable mode, W3C `tokens.json`)
- Vectors export as SVG (optionally inlined), images keep their original format, rasterized layers at 1x/2x/3x
- **Dev Mode**: the plugin also appears as a code generator in the Inspect panel
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

1. Select one or more layers (usually a frame), or several top-level frames for a site.
2. Pick an output format and press **Generate** (or Ctrl/⌘ + Enter).
3. Switch between **Preview** and the generated files, then **Copy** or **Download**.

Copying embeds images as base64. When an export has more than 8 images or over 2 MB of assets, the plugin recommends the `.zip` instead.

Name your layers — class names come from layer names, and generic names like `Rectangle 12` fall back to `box-1`, `text-2`, …

The preview runs without network access, so Google Fonts only load if the font is installed locally, and Tailwind output is previewed as the equivalent plain CSS.

## Layout

```
src/main/     Figma sandbox: reads the selection (links, variant states) and local tokens, exports assets, Dev Mode codegen
src/core/     pure converter: tree → IR (pages, breakpoints, states, shared classes) → HTML/CSS/Tailwind/JSX/Vue/Svelte/email
src/ui/       plugin window: preview, CodeMirror viewer, copy, zip/starter/tokens download, settings
src/shared/   types shared by both threads
tests/        converter tests (Vitest)
```

Note: Figma only lets users with edit access to a file run plugins; viewers can't launch any plugin. Dev Mode codegen needs a Dev Mode seat.

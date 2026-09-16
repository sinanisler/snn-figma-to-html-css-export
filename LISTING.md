# Figma Community listing

Copy these into the fields of Figma's publish dialog
(Plugins → Development → right-click the plugin → Publish).
None of this is read from `manifest.json`.

- **Icon:** `src/assets/icon-128.png` (128 × 128)
- **Name:** SNN Design to HTML/CSS

## Tagline (short description, max 100 characters)

```
Turn Figma frames into clean HTML, CSS, Tailwind, React, Vue or Svelte. Free, offline, no AI.
```

## Description

```
Turn your Figma designs into clean, semantic, ready-to-use web code in one click.

SNN Design to HTML/CSS converts the layers you select into readable code that a developer would actually write: real flexbox and grid, meaningful HTML tags, shared CSS classes and your design tokens as CSS variables. It's completely free, it needs no account and no internet connection, and it uses no AI. Everything runs locally inside Figma, so your designs never leave your computer.

━━━━━━━━━━━━━━━━━━━━

✦ PICK YOUR OUTPUT

• HTML + CSS
• HTML + Tailwind
• React + CSS or React + Tailwind
• Vue + CSS
• Svelte + CSS
• Email HTML

━━━━━━━━━━━━━━━━━━━━

✦ LAYOUT THAT MATCHES YOUR DESIGN

• Auto Layout becomes flexbox, and grid Auto Layout becomes CSS grid
• Frames without Auto Layout are still turned into rows and columns when Figma can detect them. Everything else is positioned absolutely.
• Fills, gradients, strokes, corner radii, shadows, blurs, opacity and blend modes
• Rich text: mixed styles become spans, links become <a> tags, and H1–H6 layer or text style names become headings
• Figma variables become CSS custom properties (--color-primary…)
• Choose px or rem units and 0–2 decimal places

━━━━━━━━━━━━━━━━━━━━

✦ SEMANTIC HTML FROM YOUR LAYER NAMES

• Layers named header, footer, nav, main, section, aside, article, figure, form, button or link get the matching tag
• Frames named input, email field, search bar, textarea or dropdown become real <input>, <textarea> and <select> elements, and their inner text becomes the placeholder
• Frames named list, links, ul or ol become lists. Label and caption layers become <label> and <figcaption>.
• Image alt text comes from layer names

━━━━━━━━━━━━━━━━━━━━

✦ INTERACTIONS, PAGES & RESPONSIVE

• Prototype links work: "Open link" becomes an href, and "Navigate to" a frame links to that page or anchor
• Component variants named State=Hover, Focus or Pressed become :hover, :focus-visible and :active styles
• Select several top-level frames to export a multi-page website (index.html, about.html…) with one shared stylesheet
• Responsive from your breakpoints: frames named "Home / Desktop", "Home / Tablet" and "Home / Mobile" merge into one page with @media queries. Layers missing at a breakpoint are hidden there, and layers that only exist at one breakpoint are added.

━━━━━━━━━━━━━━━━━━━━

✦ CLEANER CSS

• Styles shared by every instance of a component, or every text layer with the same text style, move into one reusable class
• Layers with identical styles reuse the same class, so nothing is repeated
• A Google Fonts <link> is generated from the fonts you used. System and commercial fonts are listed in the notes instead.

━━━━━━━━━━━━━━━━━━━━

✦ PREVIEW, COPY & DOWNLOAD

• Live preview at desktop (1440), tablet (768) and mobile (375) widths, and links between pages work inside the preview
• Code viewer with syntax highlighting for every generated file
• Copy the current file, or download:
  – a .zip with all files and assets
  – a ready-to-run Vite starter project
  – design tokens: tokens.css with every variable mode, plus a W3C tokens.json
• Vectors export as SVG (optionally inlined). Images keep their original format. Rasterized layers export at 1x, 2x or 3x.
• Conversion notes list everything that had to be approximated. Click a note to select that layer in Figma.

━━━━━━━━━━━━━━━━━━━━

✦ DEV MODE

The plugin also works as a code generator in Dev Mode's Inspect panel, so developers can grab code straight from the design.

━━━━━━━━━━━━━━━━━━━━

✦ HOW TO USE

1. Select a frame, or several top-level frames for a multi-page site
2. Pick an output format and press Generate (or Ctrl/⌘ + Enter)
3. Check the preview, then copy the code or download it

💡 Tip: name your layers. Class names come from layer names, and generic names like "Rectangle 12" fall back to box-1, text-2 and so on.

━━━━━━━━━━━━━━━━━━━━

Free · Offline · No AI · No account · Your designs never leave Figma
```

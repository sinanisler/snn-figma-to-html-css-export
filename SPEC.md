# Technical Spec & Build Plan: snn-design-to-html-css

Companion to [research.md](research.md). That document has the *why*; this document has the *what to actually build*, in enough detail to start coding without re-deciding things mid-stream. Every mapping/threshold below is a sensible default derived from the research — treat numeric thresholds as tunable constants (put them in one config file), not sacred values.

---

## 1. Architecture Recap

Pipeline (per [research.md §2.2](research.md) / §5.1), implemented across the two Figma plugin threads:

```
[sandbox thread: code.ts]                [UI thread: ui iframe]
  1. Read        — walk selection,
                   emit raw JSON tree
                                    ──►   2. Normalize  — raw tree → IR
                                          3. Optimize    — layout mode,
                                                            class names,
                                                            variable refs,
                                                            warnings
                                          4. Generate    — IR → HTML + CSS
                                                            strings (CSS
                                                            generator is
                                                            v1's only
                                                            "Generate"
                                                            module; Tailwind
                                                            can be a second
                                                            one later)
                                          5. Deliver     — CodeMirror view,
                                                            copy / zip
  (exportAsync for images/SVG
   happens in sandbox, bytes sent
   over postMessage as Uint8Array) ──►
```

**Why split this way:** the sandbox thread is the only place with Figma document access (`figma.*`), but has no DOM/clipboard/zip-file APIs. The UI thread has real browser APIs but can't touch the document. Steps 2–5 need string-building, clipboard, and (for the zip path) a zip library — all UI-thread jobs — so only step 1 (and raw byte export) needs to happen in the sandbox. Keep step 1 as a **dumb, complete serializer**: extract everything steps 2-4 might need in one pass, so you don't have to round-trip back to the sandbox mid-generation.

### 1.1 Message protocol (sandbox ⇄ UI)

| Direction | Type | Payload |
|---|---|---|
| main → ui | `SELECTION_CHANGED` | `{ hasSelection: boolean, count: number, names: string[] }` — lets the UI show "N layers selected" without a full read |
| ui → main | `GENERATE` | `{ options: GenerateOptions }` (see §7) |
| main → ui | `PROGRESS` | `{ processed: number, total: number }` — for selections large enough to take visible time |
| main → ui | `RAW_TREE` | `{ tree: RawNode, assets: { nodeId: string, bytes: Uint8Array, format: 'SVG'|'PNG'|'JPG' }[] }` |
| ui → main | `FOCUS_NODE` | `{ nodeId: string }` → sandbox runs `figma.currentPage.selection = [node]; figma.viewport.scrollAndZoomIntoView([node])` — powers "click a warning to jump to the layer" |
| ui → main | `GET_ASSET` | `{ nodeId: string, format }` — lazy-fetch a specific asset only when needed (see §6 threshold logic — you don't want to eagerly export every image before knowing if the user even needs the zip path) |

Keep every payload plain-serializable (§ Figma plugin platform constraints in research.md §3.1) — no class instances, no functions.

---

## 2. Data Model

### 2.1 RawNode (output of step 1 — Read)

One shape for every node type; unused fields are `undefined`, not omitted, so downstream code can rely on consistent shape.

```ts
type RawNode = {
  id: string
  name: string
  type: 'FRAME'|'GROUP'|'COMPONENT'|'COMPONENT_SET'|'INSTANCE'|'TEXT'
      |'RECTANGLE'|'ELLIPSE'|'POLYGON'|'STAR'|'LINE'|'VECTOR'|'BOOLEAN_OPERATION'
  visible: boolean
  x: number; y: number; width: number; height: number   // relative to parent
  rotation: number                                        // degrees
  opacity: number                                         // 0-1
  blendMode: BlendMode
  cornerRadius?: number | 'MIXED'
  rectangleCornerRadii?: [number, number, number, number] // TL, TR, BR, BL
  fills: Paint[]
  strokes: Paint[]
  strokeWeight: number
  strokeTopWeight?: number; strokeRightWeight?: number
  strokeBottomWeight?: number; strokeLeftWeight?: number
  strokeAlign: 'INSIDE'|'OUTSIDE'|'CENTER'
  dashPattern: number[]
  effects: Effect[]
  boundVariables?: Record<string, VariableAlias>          // property -> variable id, as reported by node.boundVariables

  // Auto Layout (present only on FRAME/COMPONENT/COMPONENT_SET/INSTANCE)
  layoutMode?: 'NONE'|'HORIZONTAL'|'VERTICAL'
  primaryAxisAlignItems?: 'MIN'|'CENTER'|'MAX'|'SPACE_BETWEEN'
  counterAxisAlignItems?: 'MIN'|'CENTER'|'MAX'|'BASELINE'
  layoutWrap?: 'NO_WRAP'|'WRAP'
  itemSpacing?: number
  counterAxisSpacing?: number
  paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number
  primaryAxisSizingMode?: 'FIXED'|'AUTO'
  counterAxisSizingMode?: 'FIXED'|'AUTO'

  // Per-child layout (present on any node whose parent has layoutMode != NONE, or layoutPositioning ABSOLUTE)
  layoutPositioning?: 'AUTO'|'ABSOLUTE'
  layoutGrow?: number
  layoutAlign?: 'STRETCH'|'INHERIT'|'MIN'|'CENTER'|'MAX'
  layoutSizingHorizontal?: 'FIXED'|'HUG'|'FILL'
  layoutSizingVertical?: 'FIXED'|'HUG'|'FILL'

  // TEXT only
  characters?: string
  textSegments?: TextSegment[]        // one per distinct style run (see §5)
  textAlignHorizontal?: 'LEFT'|'CENTER'|'RIGHT'|'JUSTIFIED'
  textAutoResize?: 'NONE'|'WIDTH_AND_HEIGHT'|'HEIGHT'|'TRUNCATE'

  // Image/vector leaf hint (computed during Read, not raw Figma data)
  isImageFill: boolean                 // true if any fill is type IMAGE
  isVectorLike: boolean                // true for VECTOR/BOOLEAN_OPERATION/STAR/POLYGON without image fill

  children: RawNode[]
}

type TextSegment = {
  characters: string
  fontFamily: string
  fontWeight: number
  fontStyle: 'normal'|'italic'
  fontSize: number
  lineHeightUnit: 'PIXELS'|'PERCENT'|'AUTO'
  lineHeightValue: number
  letterSpacingUnit: 'PIXELS'|'PERCENT'
  letterSpacingValue: number
  textCase: 'ORIGINAL'|'UPPER'|'LOWER'|'TITLE'
  textDecoration: 'NONE'|'UNDERLINE'|'STRIKETHROUGH'
  fills: Paint[]                       // text color, same Paint shape as node fills
  boundVariables?: Record<string, VariableAlias>
}
```

### 2.2 IR (output of step 2/3 — Normalize + Optimize)

The generator (step 4) should **only** ever consume this shape, never `RawNode` directly — that boundary is what makes a future Tailwind generator a pure addition instead of a rewrite.

```ts
type IRNode = {
  id: string
  className: string                    // resolved by the class-naming algorithm, §4
  tag: string                          // 'div'|'p'|'h1'..'h6'|'span'|'img'|'button'|'a'|'nav'|'header'|'footer'|'main'|'section'
  layout: 'FLEX' | 'ABSOLUTE' | 'NONE'  // NONE = leaf with no children (text/image/vector)
  style: Record<string, string>         // final CSS property:value pairs, already unit-formatted
  attrs?: Record<string, string>        // e.g. { alt: '...', href: '#' }
  textRuns?: { text: string; className?: string; style?: Record<string,string> }[]
  imageRef?: { assetId: string, mimeType: string }  // resolved at Generate time to data: URI or file path
  children: IRNode[]
}

type GeneratedOutput = {
  html: string
  css: string
  warnings: ConversionWarning[]
  assets: { fileName: string, mimeType: string, bytes: Uint8Array }[]  // populated only if zip path is used
}

type ConversionWarning = {
  nodeId: string
  nodeName: string
  code: WarningCode                     // see §8
  message: string
}
```

---

## 3. Node Type → Tag Mapping

| Figma node type | Default tag | Override rule |
|---|---|---|
| FRAME / COMPONENT / COMPONENT_SET / INSTANCE | `div` | Layer-name keyword match (case-insensitive, whole-word) → semantic tag: `header`→`<header>`, `footer`→`<footer>`, `nav`→`<nav>`, `main`→`<main>`, `section`→`<section>`, `button`/`btn`→`<button>`, `link`→`<a>` (with `href="#"` placeholder + warning `PLACEHOLDER_HREF`) |
| TEXT | `p` | If node name or its Figma **text style name** matches `/^h[1-6]$/i` or `heading\s*[1-6]/i` → `h1`-`h6`. If text node is a single run and parent already resolved to `button`/`a` → render as plain text content of parent, no extra wrapper. |
| GROUP | `div` | Never gets Auto Layout (Figma constraint) — always a positioning wrapper, see §5. |
| RECTANGLE, ELLIPSE, POLYGON, STAR | `div` (shape via CSS) or `img` (if `isImageFill`) | If `isImageFill` → `img` with `alt` from layer name (fallback `alt=""` + `ROLE_PRESENTATION` note if name is a default Figma name per §4's rejection list). |
| VECTOR, BOOLEAN_OPERATION | `img` (exported SVG) | Always exported as SVG asset (§6), embedded via `<img src="...">`, not inlined `<svg>` — keeps HTML output readable; inlining is a possible v-next toggle. |
| LINE | `div` with `border-top`/`border-left` per orientation | — |

INSTANCE nodes are **flattened** — traverse their visible children exactly like a frame. No variant/property logic, no component reuse in output (matches the "no AI, no framework smarts" decision). This is a deliberate simplification worth restating: **you are exporting the currently-rendered visual state only.**

---

## 4. Class-Naming Algorithm

```
REJECT_PATTERN = /^(rectangle|ellipse|frame|group|vector|polygon|star|line|component|instance|boolean( operation)?)\s*\d*$/i

function slugify(rawName):
  name = rawName.trim()
  if REJECT_PATTERN.test(name): return null
  slug = name.toLowerCase()
             .replace(/[^a-z0-9]+/g, '-')
             .replace(/^-+|-+$/g, '')
  if slug == '' or /^\d+$/.test(slug): return null
  return slug

function resolveClassName(node, usedNames, counterRef):
  base = slugify(node.name)
  if base == null:
    base = `el-${counterRef.next()}`
  if usedNames.has(base):
    base = `${base}-${counterRef.next()}`
  usedNames.add(base)
  return base
```

- `usedNames` and `counterRef` are scoped to **one export** (reset each Generate run), not persisted — regenerating should be deterministic given the same selection and same layer names.
- Surface a one-line hint in the plugin UI: *"Name your layers for cleaner class names — generic names like 'Rectangle 12' get auto-numbered."* Cheap, and it's the one lever users actually control (per research.md §6.1).

---

## 5. Layout Resolution (Flex vs Absolute)

```
function resolveLayout(node: RawNode): 'FLEX' | 'ABSOLUTE' | 'NONE':
  if node.children.length == 0: return 'NONE'
  if node.type == 'GROUP': return 'ABSOLUTE'          // Groups can never carry Auto Layout
  if node.layoutMode == 'HORIZONTAL' or 'VERTICAL': return 'FLEX'
  return 'ABSOLUTE'                                    // v1 default; §9 below covers the v2 heuristic
```

**FLEX mapping table** (direct, no ambiguity — implement exactly this):

| Figma property | CSS |
|---|---|
| `layoutMode: HORIZONTAL` / `VERTICAL` | `display: flex; flex-direction: row / column` |
| `primaryAxisAlignItems: MIN/CENTER/MAX/SPACE_BETWEEN` | `justify-content: flex-start/center/flex-end/space-between` |
| `counterAxisAlignItems: MIN/CENTER/MAX/BASELINE` | `align-items: flex-start/center/flex-end/baseline` |
| `itemSpacing` (only if `primaryAxisAlignItems != SPACE_BETWEEN`) | `gap: {n}px` |
| `layoutWrap: WRAP` | `flex-wrap: wrap` + `counterAxisSpacing` → `row-gap: {n}px` |
| `paddingTop/Right/Bottom/Left` | `padding: {t}px {r}px {b}px {l}px` |
| `primaryAxisSizingMode: FIXED` | explicit `width`/`height` (whichever is the primary axis) from node dimensions |
| `primaryAxisSizingMode: AUTO` | omit that dimension (content-driven) |
| `counterAxisSizingMode` | same rule, other axis |
| child `layoutSizingHorizontal/Vertical: FIXED` | explicit `width`/`height` px |
| child `layoutSizingHorizontal/Vertical: HUG` | omit (content-driven), or `width: fit-content` if needed to prevent stretch |
| child `layoutSizingHorizontal/Vertical: FILL` on the **main axis** | `flex: 1 0 0%` (also set `min-width:0`/`min-height:0` to avoid flex overflow bugs) |
| child `...FILL` on the **cross axis** | `align-self: stretch` |

**ABSOLUTE mapping (v1 default and v2 fallback target):**

- Parent: `position: relative; width: {w}px; height: {h}px` (or `width/height: 100%` if the parent itself is a FLEX child sized via FILL — check layout context, don't hardcode).
- Each child: `position: absolute; left: {x - parent.x}px; top: {y - parent.y}px; width: {w}px; height: {h}px`.
- `rotation != 0` → add `transform: rotate({deg}deg)`; note CSS rotation origin defaults differ slightly from Figma's — flag `ROTATION_APPROXIMATE` warning when `rotation` is non-zero, don't try to be clever about it in v1.

---

## 6. Fills, Strokes, Effects, Corner Radius, Opacity

### 6.1 Fills → `background`
- Iterate `node.fills` **in reverse** (Figma's array is bottom-to-top; CSS `background`/`background-image` shorthand lists top-to-bottom) so the visual stacking order matches.
- `SOLID` → `background-color: rgba(r*255, g*255, b*255, a * fill.opacity * node.opacity)` (only the *last* solid in stacking order needs `background-color`; earlier ones become `background-image: linear-gradient(rgba(...) 0 0)` layers if you need true multi-fill stacking — for v1, if there's more than one non-image fill, use the **topmost opaque fill** and emit a `MULTIPLE_FILLS_SIMPLIFIED` warning rather than building a multi-layer background stack; revisit in v-next if it turns out to matter often).
- `GRADIENT_LINEAR` → `background: linear-gradient({angle}deg, {stop.color} {stop.position*100}%, ...)`. Angle: derive from `gradientTransform` matrix — `angle = atan2(matrix[1][0], matrix[0][0])` converted to CSS's clockwise-from-top convention (`cssAngleDeg = (90 + degrees(angle)) % 360`, verify empirically against a couple of test gradients rather than trusting this formula blindly — gradient transforms are the single easiest fill type to get subtly wrong).
- `GRADIENT_RADIAL` → `background: radial-gradient({stop.color} {stop.position*100}%, ...)` (v1: ignore radial center/shape skew from the transform matrix, use CSS defaults; flag `GRADIENT_APPROXIMATE`).
- `GRADIENT_ANGULAR` → `background: conic-gradient(...)`; flag `ANGULAR_GRADIENT_LIMITED_SUPPORT`.
- `IMAGE` → sets `isImageFill = true` at Read time; node becomes an `<img>` leaf (§3), not a `background-image` — simpler and gives real `alt` text semantics. `scaleMode: FILL`→`object-fit: cover`, `FIT`→`object-fit: contain`, `CROP`/`TILE`→`object-fit: cover` + `OBJECT_FIT_APPROXIMATE` warning.

### 6.2 Strokes → `border`
- Single uniform stroke, `strokeAlign: CENTER` or unspecified → `border: {strokeWeight}px solid {color}`.
- `strokeAlign: OUTSIDE` → CSS has no native outside border; emit `box-shadow: 0 0 0 {strokeWeight}px {color}` instead (works with border-radius, unlike `outline`) + no warning needed, this is a clean equivalent, not an approximation.
- `strokeAlign: INSIDE` → `border` with `box-sizing: border-box` (default assumption — set `box-sizing: border-box` globally in the generated stylesheet's reset, see §10).
- Per-side weights (`strokeTopWeight`, etc. present) → individual `border-top-width` etc.
- `dashPattern.length > 0` → `border-style: dashed` (does not preserve exact dash/gap lengths) + `DASH_PATTERN_APPROXIMATE` warning.

### 6.3 Effects
- `DROP_SHADOW` → `box-shadow: {offsetX}px {offsetY}px {radius}px {spread}px {color}`
- `INNER_SHADOW` → `box-shadow: inset {offsetX}px {offsetY}px {radius}px {spread}px {color}`
- Multiple shadows → comma-joined in one `box-shadow` declaration (inner and outer can mix freely in CSS).
- `LAYER_BLUR` → `filter: blur({radius/2}px)` (Figma's blur radius ≈ 2x CSS's visual blur — verify against a test file; note as approximate either way with `BLUR_APPROXIMATE`).
- `BACKGROUND_BLUR` → `backdrop-filter: blur({radius}px)` + `BACKDROP_FILTER_SUPPORT` warning (Safari needs `-webkit-backdrop-filter` prefix too — emit both).

### 6.4 Corner radius
- `cornerRadius` (uniform) → `border-radius: {n}px`.
- `rectangleCornerRadii: [TL, TR, BR, BL]` → `border-radius: {TL}px {TR}px {BR}px {BL}px` — this is a **direct** mapping, Figma's array order already matches CSS shorthand order.

### 6.5 Opacity & blend mode
- `node.opacity` → `opacity: {n}` (only emit if `!= 1`).
- `blendMode` → `mix-blend-mode: {css-equivalent}` for all values except `PASS_THROUGH`/`NORMAL` (omit property for those). Direct 1:1 name mapping for `MULTIPLY, SCREEN, OVERLAY, DARKEN, LIGHTEN, COLOR_DODGE, COLOR_BURN, HARD_LIGHT, SOFT_LIGHT, DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY` (these names match CSS `mix-blend-mode` keywords almost exactly, just lowercase-and-hyphenate).

---

## 7. Text Handling

```ts
type GenerateOptions = {
  pxDecimalPlaces: 0 | 1 | 2          // rounding precision, default 0 (whole px)
  inlineAssetsAsBase64: boolean       // default true (clipboard path)
  exportVariablesAsCssVars: boolean   // default true
}
```

Per `TextSegment` (§2.1):

| Figma property | CSS |
|---|---|
| `fontFamily` | `font-family: '{family}', sans-serif` — if the family isn't a known system/web-safe font, add `CUSTOM_FONT_NOT_EMBEDDED` warning (you are not embedding `@font-face`/web-font links in v1 — out of scope, downstream refinement step's job per your "no AI, fast export" philosophy) |
| `fontWeight` | `font-weight: {n}` |
| `fontStyle: italic` | `font-style: italic` |
| `fontSize` | `font-size: {n}px` |
| `lineHeightUnit: PIXELS` | `line-height: {n}px` |
| `lineHeightUnit: PERCENT` | `line-height: {n/100}` (unitless, relative to font-size — matches CSS's normal cascade behavior) |
| `lineHeightUnit: AUTO` | `line-height: normal` |
| `letterSpacingUnit: PIXELS` | `letter-spacing: {n}px` |
| `letterSpacingUnit: PERCENT` | `letter-spacing: {(n/100) * fontSize}px` (convert to px at generation time since CSS letter-spacing percent isn't relative the same way Figma's is) |
| `textCase: UPPER/LOWER/TITLE` | `text-transform: uppercase/lowercase/capitalize` |
| `textDecoration: UNDERLINE/STRIKETHROUGH` | `text-decoration: underline/line-through` |
| fill (text color) | `color: rgba(...)` |

- **Single-run text node** → style goes directly on the tag (`<p class="...">text</p>`), no extra spans.
- **Multi-run text node** → outer tag carries only shared/paragraph-level properties (`text-align`, box model); each run becomes `<span class="run-N" style="...">` — generate a scoped class per unique run style rather than fully inline styles, to keep the CSS/HTML separation clean (matches "clean semantic output" goal better than inline `style=` attributes everywhere).
- `textAutoResize: NONE` → explicit `width`/`height` on the text box.
- `textAutoResize: WIDTH_AND_HEIGHT` → omit both (content sizes it).
- `textAutoResize: HEIGHT` → explicit `width`, omit `height`.
- `textAutoResize: TRUNCATE` → `overflow: hidden; white-space: nowrap; text-overflow: ellipsis` if effectively single-line; if Figma reports a fixed height spanning multiple lines, use `display: -webkit-box; -webkit-line-clamp: {n}; -webkit-box-orient: vertical; overflow: hidden` and add `MULTILINE_TRUNCATE_APPROXIMATE` warning (line count estimated from height/line-height, not exact).

---

## 8. Warnings ("Conversion Notes")

Central list of warning codes to implement from day one (extend as needed, but start every generator function by checking whether it should emit one of these rather than silently guessing):

`ABSOLUTE_FALLBACK`, `ROTATION_APPROXIMATE`, `MULTIPLE_FILLS_SIMPLIFIED`, `GRADIENT_APPROXIMATE`, `ANGULAR_GRADIENT_LIMITED_SUPPORT`, `OBJECT_FIT_APPROXIMATE`, `DASH_PATTERN_APPROXIMATE`, `BLUR_APPROXIMATE`, `BACKDROP_FILTER_SUPPORT`, `CUSTOM_FONT_NOT_EMBEDDED`, `MULTILINE_TRUNCATE_APPROXIMATE`, `PLACEHOLDER_HREF`, `LARGE_ASSET_PAYLOAD` (§9), `VARIABLE_MODE_DEFAULTED` (§10).

UI: a collapsible panel under the code viewer, grouped by code, each entry showing `nodeName` and clickable to send `FOCUS_NODE` (§1.1) — jumps the Figma canvas selection/viewport to that layer. This single feature (copied conceptually from FigmaToCode's "Explain" stage) is what keeps you honest instead of Codia-style overclaiming, per research.md §5.

---

## 9. Asset Export & Delivery

```
DEFAULT_ZIP_RECOMMEND_THRESHOLD_BYTES = 2_000_000   // ~2MB of inlined asset payload
DEFAULT_ZIP_RECOMMEND_THRESHOLD_COUNT = 8            // or more than 8 distinct images
```

- Vector/icon leaves (§3) → `exportAsync({ format: 'SVG' })`.
- Image-fill leaves → `exportAsync({ format: <PNG unless source suggests JPEG-appropriate content>, constraint: { type: 'SCALE', value: 2 } })` — default to 2x export for reasonable retina quality without going overboard; make this a future config knob, not a v1 UI toggle.
- Default delivery: assets inlined as `data:` URIs directly in the copied HTML (`img src="data:image/svg+xml;base64,..."`).
- While generating, sum `bytes.length` across all exported assets and count them. If either threshold is crossed, add a **non-blocking** `LARGE_ASSET_PAYLOAD` warning and switch the primary CTA in the UI from "Copy to Clipboard" to "Download .zip" (keep both buttons visible always — this is a *recommendation*, never a hard gate, per your explicit instruction that copy-to-clipboard should keep working).
- Zip path: separate `assets/` folder, `index.html` referencing `assets/{name}.svg` etc. by relative path, `styles.css` as its own file linked via `<link rel="stylesheet" href="styles.css">` instead of inline `<style>`. Use a lightweight, purely-client-side zip lib in the UI thread (e.g. `fflate` — much smaller than `jszip`, worth checking current bundle size before locking it in, but avoid anything that assumes Node/filesystem APIs, which don't exist in the plugin UI iframe).

---

## 10. Variables → CSS Custom Properties

- During Read (step 1), for every property in `node.boundVariables` (and `textSegment.boundVariables`), resolve via `figma.variables.getVariableByIdAsync(variableId)` to get the variable's **name** and **resolved value for the current mode** of the file.
- Custom property name: `--{slugified-collection-name}-{slugified-variable-name}` (e.g. a variable named `color/primary/500` in collection `Design Tokens` → `--design-tokens-color-primary-500`). Collisions after slugifying → same numeric-suffix strategy as §4.
- Emit `:root { --name: value; }` once per **unique variable actually referenced** in the export (not the whole file's variable collections) — keeps the generated CSS lean and directly tied to what's on screen.
- Use `var(--name)` in place of the literal value wherever a property is bound.
- Multi-mode collections (e.g. light/dark): v1 resolves to whichever mode is **currently active in the Figma file/page being read** and adds a `VARIABLE_MODE_DEFAULTED` warning noting which mode was used — full theming output (`[data-theme="dark"] { --name: ... }` blocks per mode) is a clean v-next addition once the single-mode path is solid, not a v1 blocker.

---

## 11. Output Delivery / UI

- **Code viewer**: CodeMirror 6, read-only, two views — HTML and CSS — either as tabs or a single scrollable document with both (`<style>` block + body markup) mirroring exactly what "Copy to Clipboard" produces. Tabs are cleaner for the zip-file mental model (separate files); a single combined view is closer to the "one paste-able block" clipboard mental model. **Recommendation: default to the combined single-file view** (matches your "fast paste-and-go" priority) with a small toggle to preview the "split files" version that matches what the zip would contain.
- **Buttons**: `Generate` (only enabled on a non-empty selection), `Regenerate` (re-runs with current selection + options, visually distinct so it's clear it's not auto-triggered), `Copy to Clipboard`, `Download .zip` (always visible, highlighted when the threshold in §9 is crossed).
- **Settings** (minimal — resist adding more for v1): px rounding precision, inline-vs-zip default preference, include/exclude variables-as-CSS-vars toggle.

---

## 12. Manifest (starting point)

```json
{
  "name": "SNN Design to HTML/CSS",
  "id": "REPLACE_WITH_FIGMA_ASSIGNED_ID",
  "api": "1.0.0",
  "main": "dist/main.js",
  "ui": "dist/ui.html",
  "editorType": ["figma"],
  "documentAccess": "dynamic-page",
  "networkAccess": { "allowedDomains": ["none"] },
  "permissions": []
}
```

- `documentAccess: "dynamic-page"` opts into Figma's newer, faster plugin loading model (async node access via `getNodeByIdAsync` etc.) — worth using from day one rather than the legacy default, since retrofitting it later means touching every direct-property-access call site.
- `networkAccess: { allowedDomains: ["none"] }` is your privacy/trust differentiator (research.md §2.2, §3.2) — keep it unless a specific future feature genuinely needs a domain.

---

## 13. Build Order / Milestones

Sequenced so you have something real and demoable as early as possible, per your "fast export first" priority:

1. **M0 — Scaffold.** `Plugma` project init, manifest above, minimal UI shell: selection-count readout, disabled `Generate` button, empty CodeMirror instance.
2. **M1 — Flex happy path.** Read + Normalize + Generate for FRAME (Auto Layout only) + TEXT (single-run) + RECTANGLE (solid fill only). Output basic HTML/CSS to the viewer. Copy to Clipboard works end-to-end. **This is your first internal demo.**
3. **M2 — Visual fidelity.** Corner radius, strokes, effects, opacity, blend mode, gradients, multiple-fill simplification (§6).
4. **M3 — Text fidelity.** Multi-run text, line-height/letter-spacing units, text-transform/decoration, `textAutoResize` modes, heading-tag inference (§3, §7).
5. **M4 — Assets.** SVG/image export, `<img>` embedding, Base64-inline default, size/count threshold → zip flow with `fflate` (§9).
6. **M5 — Variables.** Bound-variable resolution → `:root` custom properties + `var()` references (§10).
7. **M6 — Absolute fallback.** Full `position:relative`/`absolute` path for non-Auto-Layout frames and all `GROUP` nodes (§5's ABSOLUTE branch) — this is what makes the plugin usable on *any* file, not just perfectly Auto-Layout-disciplined ones.
8. **M7 — Warnings panel.** Wire up every warning code from §8 as you touch each corresponding feature (don't defer this to the end — it's cheapest to add right where each approximation happens), plus click-to-focus-layer.
9. **M8 — Polish.** Class-naming edge cases, px-rounding config, Regenerate-without-recompute-storm, large-selection progress UI.
10. **v1.1+ — Smart absolute→flex heuristic** (research.md §3.3.1's VIPS-inspired geometry clustering) as an opt-in "Try smart layout" pass before the guaranteed-safe absolute fallback.
11. **v1.x — Tailwind output** as a second Generate module reading the same IR (research.md §5.1) — only once the plain-CSS generator is stable, since it validates the IR is actually framework-agnostic.

---

*This spec is a working baseline, not a contract — expect §6's approximation formulas (gradient angle, blur radius) in particular to need a quick empirical check against a real Figma file once you're generating actual CSS. Everything else here should be safe to build directly against.*

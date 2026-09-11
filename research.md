# Research: Building a "Design to HTML/CSS" Figma Plugin

Compiled 2026-09-11, revised same day after product decisions. Purpose: give you the landscape, the technical constraints, and the community-sourced pain points needed to make deliberate product decisions before writing any code for `snn-design-to-html-css`.

---

## 0. Your Decisions (locked in for v1)

Recorded here so the rest of the document, and the eventual spec, builds on a fixed target instead of re-litigating options.

| Area | Decision | Notes |
|---|---|---|
| Output format | **Native HTML/CSS only** for v1. Tailwind considered as a possible **later, optional** output mode (toggle/tab), not a v1 requirement. | See §5 for how other tools structure this so adding Tailwind later doesn't require a rewrite. |
| AI | **No AI, anywhere, ever in this plugin.** Fast, deterministic, local export only. Imperfect output is expected and acceptable — it's a *starting point*, refinement happens in a separate downstream tool/step, not this plugin's job. | Matches the FigmaToCode philosophy (§2.2) almost exactly. |
| Non-Auto-Layout ("absolute") frames | **Attempt a smarter geometry-based inference first; fall back to 100% absolute positioning (matching Figma's own default model) when inference isn't confident.** Full research on what "smarter" can realistically mean is in §3.3.1 — this is genuinely unsolved territory in the OSS tools reviewed, so treat it as your own R&D, not something to copy from a repo. | This is the single hardest and most differentiating engineering problem in the whole plugin. Budget real time for it. |
| Responsive/breakpoints | **Explicitly out of scope.** Ignore entirely for v1. | Removes an entire category of complexity (§4.3) other tools struggle with. |
| Output UX | **In-plugin code viewer/editor** for readability (recommend **CodeMirror 6**, not Monaco — see §6.1 for why), **Copy to Clipboard**, and explicit **Generate / Regenerate** buttons (no silent auto-regeneration on every canvas edit). | |
| Variables/Tokens | **Yes — exported as CSS custom properties on top of the generated CSS**, wherever a fill/effect/spacing value is bound to a Figma Variable. | See §3.4, unchanged from first pass, now confirmed as in-scope for v1, not a maybe. |
| Entry point | **Classic plugin UI panel only** (not the Dev Mode-only `figma.codegen` integration). | Important nuance: this does **not** guarantee every Figma user can run it — see §6.2, Figma itself restricts *all* plugins (regardless of price) to users with edit access on a file. |
| Access / pricing | **100% free**, no paid tier, intended for everyone. | Combined with the entry-point choice, see §6.2 for the real-world limits on "everyone" that come from Figma's platform, not from your pricing. |
| Semantics | **Clean, semantic HTML/CSS output** as a first-class goal (real tags, sensible class names), not div-soup. | Reinforces the whitespace analysis in §5 (old §5, renumbered below). |

---

## 1. Executive Summary

- The "Figma → code" space is crowded but **unevenly good**. Nobody has solved it well; the dominant sentiment (Hacker News, forums, reviews) is that every tool is either **too shallow** (Figma's native Dev Mode) or **too bloated/opaque** (AI-driven tools like Anima, Codia).
- There are two fundamentally different architectures in the market: **(a) deterministic rule-based compilers** (e.g. FigmaToCode) that map Figma properties to code with no AI, and **(b) AI-inference pipelines** (Anima, Locofy, Builder.io Visual Copilot, Codia, Kombai) that try to infer semantics, components, and frameworks. Rule-based tools are more trustworthy and cheaper to run; AI tools produce more "codebase-aware" output but are inconsistent and provider-dependent.
- The single most-repeated structural criticism (from Hacker News and forum threads) is the **"one-time export" problem**: generated code can't be kept in sync with design changes once a developer adds logic to it. This isn't a bug you can fix with better CSS output — it's a category limitation of the "export" model itself. Worth deciding upfront whether you accept this limitation (be a great *starting-point* generator) or try to mitigate it (idempotent/re-export-friendly output, stable naming, diff-friendly structure).
- A second major shift in the ecosystem: **Figma's Dev Mode MCP Server** now lets AI coding agents (Claude Code, Cursor, Copilot) pull structured design context (node tree, variables, layout, assets) directly, without a traditional plugin UI at all. This is a competing paradigm to a classic Figma plugin and is growing fast — it's worth deciding whether your plugin is a classic UI-driven plugin, an MCP-compatible tool, or both.
- Figma's plugin platform itself imposes real technical constraints (sandboxed dual-thread architecture, message-passing size practicalities, storage limits, manifest-declared network access, and a review process that can take anywhere from a few days to several weeks). These should shape your architecture from day one, not be discovered late.
- The clearest whitespace for a new entrant, based on complaints about existing tools: **clean, deterministic, semantic, locally-processed HTML/CSS** with configurable output (naming, units, class conventions) and honest limitations (no fake "pixel perfect, zero tweaks" claims) — i.e., positioning against both Figma's shallow Dev Mode inspector and the AI tools' unpredictability.

---

## 2. The Competitive Landscape

### 2.1 Commercial / AI-driven tools

| Tool | Model | Output | Notable strengths | Notable complaints |
|---|---|---|---|---|
| **Anima** | Plugin + standalone platform | React, Vue, HTML/CSS, Tailwind, styled-components | Auto-detects components/breakpoints/interactive states; mature responsive breakpoint linking (connect multiple frames per breakpoint) | Steep free→paid price jump ("too steep for freelancers"); flaky Figma-side integration reported in forum; some call it "overly bloated" (HN) |
| **Locofy** | AI pipeline | Next.js, React, HTML/CSS | Widest framework coverage; decent structure | Inconsistent code quality; non-semantic output; **slow/struggles beyond ~5 frames**; token-based pricing gets expensive; output "often needs manual cleanup before production" |
| **Builder.io Visual Copilot** | Multi-stage AI pipeline (proprietary model → Mitosis OSS compiler → fine-tuned LLM refinement) | React, Next.js, Vue, Angular, Svelte, etc. | **Component mapping** — references your actual codebase components (Button, Card) instead of generating generic divs; this is the differentiator nobody else fully matches | Requires the AI/codebase-mapping setup to shine; less useful for plain static HTML/CSS output |
| **Kombai** ("AI design engineer", relaunched mid-2026) | Runs inside the developer's editor, reads existing codebase | Codebase-aware components | Generates code that reuses existing components/tokens; tests output in a real browser | New/unproven; positioning overlaps heavily with Builder.io |
| **Codia AI** | AI | Various | Fast, markets "no manual tweaks needed" | Reviewers note this claim doesn't hold for complex/interactive states; no published evidence backing the "pixel/color/layout perfect" claim; best treated as a disposable-mockup tool |
| **TeleportHQ** | Plugin + platform | HTML, CSS, React, Vue | Real-time browser preview before export | Less discussed in recent community threads; smaller mindshare than the above |
| **html.to.design (divRIOTS)** | Plugin, opposite direction | HTML/CSS website → Figma | Not a design→code tool — it's code→design. Relevant as a "reverse" reference implementation and because the same company (divRIOTS) also ships `code.to.design`, `figma.to.website`, etc. Good study material for DOM/CSS parsing approaches, just mirrored. |
| **Figma Dev Mode (native)** | First-party | CSS/iOS/Android snippets, inspect panel | Ships with every Figma seat with dev access; extensible via `figma.codegen` API (see §3.5) | Frequently called "too little detail" — it's an inspector, not a generator. Your plugin will be judged relative to this baseline; if you don't clearly beat Dev Mode's inspector, there's no reason to install you. |

### 2.2 Open-source projects worth reading (code-level learning)

These are the highest-value reads because you can see actual conversion logic, not marketing copy.

- **[bernaferrari/FigmaToCode](https://github.com/bernaferrari/FigmaToCode)** — By far the most instructive reference. Outputs HTML/CSS, React (JSX), Svelte, styled-components, Tailwind (HTML/React/Twig), Flutter, and SwiftUI from one shared pipeline. Architecture is a clean 5-stage pipeline:
  1. **Read** — extract selected nodes + layout/style metadata
  2. **Normalize** — build an internal tree representation (framework-agnostic)
  3. **Optimize** — resolve Auto Layout, alignment, sizing/positioning relationships
  4. **Generate** — feed the normalized tree to framework-specific backends
  5. **Explain** — return code, previews, assets, and **conversion warnings** (doesn't silently guess — surfaces what it couldn't confidently translate)

  Key decisions worth copying: **zero network permissions** (`allowedDomains: ["none"]` in manifest — fully local, no telemetry, no AI calls — a genuine privacy/trust differentiator), deterministic rule-based generation (no LLM, so output is reproducible and inspectable), and **tunable output** (toggle layer names in output, round spacing/colors to token scale, use color variables vs raw hex, inline vs Base64 images, SVG shape support). It intentionally does **not** attempt semantic inference, accessibility, or app logic — it reports warnings instead of guessing. This "small compiler, not a screenshot service" framing is a good mental model for your own scope.

- **[ayush013/fig-gen](https://github.com/ayush013/fig-gen)** — Simpler, Tailwind-focused, TypeScript + Webpack + PostCSS. Philosophy: prefer flex-based layouts over absolute positioning; explicitly tells designers to avoid Fixed Height/Width in favor of "Fill container"/"Hug contents" for better output. Its own README TODO list is a useful gap-map: better responsiveness, semantic HTML for inputs/buttons/links, mask/clip support, variant handling — i.e., even a well-regarded OSS tool admits these are unsolved.

- **[the-dataface/figma2html](https://github.com/the-dataface/figma2html)** — Narrower scope: exports Figma frames as responsive HTML/CSS. Good for studying a smaller, more focused codebase than FigmaToCode.

- **[gridaco/code](https://github.com/gridaco/code)** (part of the [Grida](https://github.com/gridaco) org, 2.5k+ stars) — A standalone "design to code engine" that converts Figma/Sketch/XD to Flutter/React/Vue. Bigger scope (whole design tool + engine, Rust/Skia/WASM canvas), useful for architecture ideas if you ever want to go beyond a plugin, less useful for a focused MVP.

- **[cirediatpl/FigmaChain](https://github.com/cirediatpl/FigmaChain)** — Early (GPT-3 era) experiment generating HTML/CSS via LLM from Figma input, with a Streamlit chatbot interface. Mostly of historical interest — shows the AI-generation approach's early failure modes (inconsistent, non-deterministic output) that the market has since tried to paper over with bigger pipelines (see Builder.io's multi-stage approach above).

- **[mike2151/html-to-figma](https://github.com/mike2151/html-to-figma)** — Reverse direction (HTML→Figma), open-source version of a Community plugin. Useful for understanding DOM traversal → Figma node mapping, which is the mirror image of your problem and can reveal the same edge cases (fonts, gradients, shadows, images) from the other side.

### 2.3 The MCP paradigm (new competitor category)

Figma ships an official **Dev Mode MCP Server** (GA for reads, beta for write-back) that exposes a selected frame/component as structured data — node tree, variant info, layout constraints, design tokens, asset references — directly to agentic coding tools (Claude Code, Cursor, Copilot, Windsurf). This is architecturally similar to what a plugin does internally, but skips the Figma-hosted plugin UI entirely and lets a general-purpose coding agent do the generation/reasoning. It's free for reads today. This matters for your positioning:
- If your differentiator is "smart/contextual" code generation, MCP + a capable coding agent may already do that better, and will keep improving for free as models improve.
- If your differentiator is a **fast, in-Figma, no-agent-required, deterministic, one-click static HTML/CSS export**, that's a lane MCP doesn't really compete in — a designer without an AI coding subscription still needs something.

---

## 3. Figma Plugin Platform: Technical Foundations

### 3.1 Two-thread sandboxed architecture

Every plugin has two isolated execution contexts, communicating only via `postMessage`:
- **Main/sandbox thread** (QuickJS-based "Realms" sandbox) — runs `code.js`, has full access to the Figma document API (`figma.*`), **no** DOM/browser APIs, no direct network unless declared.
- **UI thread** (an actual sandboxed `<iframe>`) — runs `ui.html`, has browser APIs (DOM, `fetch`, file downloads, clipboard) but **cannot** call the Figma document API directly.
- Communication: `figma.ui.postMessage(msg)` (sandbox→UI) and `parent.postMessage({ pluginMessage: msg }, "*")` (UI→sandbox). Serializable data only (objects, arrays, primitives, `Date`, `Uint8Array` — no functions/prototypes).

**Implication for your architecture:** any HTML/CSS "generation" logic that needs Figma node data must either run in the sandbox thread (safe, but no DOM/clipboard/download APIs) or ship serialized node data over to the UI thread and generate there (gives you real browser APIs for clipboard copy, file download, and if you ever add AI calls, `fetch`). Most design-to-code plugins do the **read + normalize** in the sandbox and the **generate + render + export** in the UI thread — mirrors FigmaToCode's pipeline split.

### 3.2 Manifest & permissions

- `networkAccess.allowedDomains` (or `"none"`) is **mandatory to declare and is publicly shown on your Community page** and reviewed by org admins. If you go fully local/deterministic (no AI, no telemetry), declaring `"none"` is both a technical simplification and a visible trust signal — this is explicitly what FigmaToCode does and calls out in its own docs.
- If you ever add an AI-assisted mode (e.g., semantic tag inference via an LLM call), that requires a domain allowlist, which is disclosed to users at install/review time — expect some users to actively prefer/select tools that don't require this.

### 3.3 Auto Layout → Flexbox mapping (the technical core of your plugin)

Figma's Auto Layout is deliberately Flexbox-shaped. Key property mappings:
- `layoutMode: "HORIZONTAL" | "VERTICAL"` → `flex-direction: row | column`
- `primaryAxisAlignItems` (MIN/CENTER/MAX/SPACE_BETWEEN) → `justify-content` (note: when `SPACE_BETWEEN` is set, `itemSpacing` is ignored by Figma itself — mirror that in your generator)
- `counterAxisAlignItems` → `align-items`
- `itemSpacing` → `gap`
- `counterAxisSpacing` (used when `layoutWrap: "WRAP"`) → `row-gap`/wrap-related gap
- `primaryAxisSizingMode` / `counterAxisSizingMode` ("FIXED" vs "AUTO"/hug) → whether to emit fixed `width/height` vs `width: fit-content`/flex-grow behavior
- Per-child `layoutGrow`, `layoutAlign`, `layoutSizingHorizontal/Vertical` ("FIXED"/"HUG"/"FILL") → `flex-grow`, `align-self`, and fixed vs `100%`/`auto` sizing on the child

**Community-sourced gotcha:** frames **not** using Auto Layout (free-form/absolute positioning) are exactly where generic plugins fall apart — a forum thread ("after converting Figma into code with plugin some of the elements' position went wrong") got no real fix beyond "ask the plugin author," and multiple tools' own docs (fig-gen) explicitly tell designers to avoid fixed positioning and use Auto Layout for decent output.

#### 3.3.1 Deep dive: is a "smarter" absolute→flex inference actually possible? (your explicit ask)

You asked specifically whether it's possible to do better than pure absolute positioning for frames that don't use Auto Layout. Here's what the research actually found, in order of how directly it answers the question:

**Nobody in the OSS space does this today.** I pulled the actual source of `bernaferrari/FigmaToCode` — the most mature, most-studied open-source converter in this whole space — specifically its `packages/backend/src/common/commonPosition.ts`, the file responsible for the absolute-vs-relative decision. Its logic is entirely **local and declarative, not geometric**: `commonIsAbsolutePosition()` just checks whether Figma has already flagged the node as `layoutPositioning === "ABSOLUTE"` or whether the **parent's own** `layoutMode` is `"NONE"`/unset. There is **no clustering, no sibling-relationship analysis, no row/column detection** anywhere in that file or its neighbors (`commonPadding.ts`, `nodeWidthHeight.ts`, etc. only handle padding/sizing math, not grouping). In other words: even the best deterministic OSS converter available today makes the flex-vs-absolute call **per-node, using only flags Figma already set**, and falls straight to absolute positioning the instant Auto Layout isn't already present. This is a genuine, confirmed gap — not something you're missing by not reading enough repos.

**Figma itself has this capability, but doesn't expose it.** The "Suggest Auto Layout" feature (Shift+A on a selection of plain, non-Auto-Layout objects) runs a "best guess" internal algorithm that infers direction, spacing, and alignment from raw geometry — users on the Figma forum confirm this exists and works reasonably well in the UI. However, a Figma forum thread explicitly requesting **plugin API access to this exact feature** ("access to the suggest auto layout feature in the plugin API") confirms it is **not exposed via the Plugin API today**, and there's no published algorithm description — it's proprietary and UI-only. You cannot call it programmatically; you can only read `layoutMode`/`layoutPositioning` after a human has manually applied it.

**So "smarter than absolute" means building your own geometry heuristic from scratch.** This is a real, well-studied class of problem outside Figma's world — it's structurally the same problem as **inferring visual layout structure from raw coordinates**, which the classic **VIPS algorithm** ("VIsion-based Page Segmentation", Microsoft Research, Cai & Yu) solved for web pages by recursively segmenting a page into blocks using visual **separators** (horizontal/vertical gaps with no content crossing them) rather than relying on the underlying markup structure. Applied to your problem, a first practical version could work like this:

1. **Row/column clustering by bounding-box overlap.** For a given non-Auto-Layout frame's direct children, sort by `y` (then `x`). Group children into a "row" when their vertical (`y`, `y+height`) ranges overlap by some threshold; group into a "column" similarly on `x`. This gives you candidate `HORIZONTAL`/`VERTICAL` groupings without any Figma flag telling you so.
2. **Gap-consistency check.** Within a detected row/column, measure the gaps between consecutive siblings. If the gaps are consistent within a small tolerance (e.g. ±1–2px), that's a strong flexbox `gap` signal — emit `display:flex` + `gap`. If gaps vary wildly or elements overlap, that's a strong signal this group is **not** a clean flex candidate.
3. **Alignment check.** Compare each child's leading/trailing edge on the cross-axis (e.g. left edges for a vertical stack) — consistent alignment across children is another positive signal for `align-items: flex-start/center/flex-end`; inconsistent alignment is a negative signal.
4. **Recursive segmentation.** Apply this recursively the way VIPS does — a frame might cleanly split into two or three big row-groups, each of which internally still needs its own row/column analysis, some of which might succeed and some of which might not.
5. **Confidence threshold + graceful fallback.** Only emit `display:flex` when the above checks pass with high confidence (e.g. no overlaps, low gap variance, consistent alignment). The moment confidence is low for a given group — overlapping layers, freeform illustration-style composition, inconsistent spacing — **fall back to `position:absolute` children inside a `position:relative` wrapper at that group's level only** (not the whole frame), which is exactly Figma's own native rendering model, so it's never *wrong*, just less semantic. This gives you a strictly-better-or-equal result compared to "always absolute," while never claiming false precision.

This is genuinely unsolved/undocumented territory among the tools this research could find — which is good news framed correctly: it's real intellectual property you can build, not a missing 10-minute Stack Overflow answer. It's also realistically a **post-v1 feature**, not something to block your first release on, given you've already said imperfect output is fine for now. A reasonable staged plan: **ship v1 with the honest, always-absolute fallback for non-Auto-Layout frames** (fast, correct-if-boring, matches your "fast export, refine elsewhere" philosophy), then invest in the geometry-clustering heuristic above as a v1.1/v2 differentiator once the rest of the pipeline is solid.

### 3.4 Variables/Design Tokens → CSS custom properties

Figma's Variables API can back colors, numbers, strings, and booleans, organized in collections with modes (e.g., light/dark). Several single-purpose Community plugins exist solely to export variables as CSS custom properties (e.g., "Token CSS Exporter", "Figma CSS Variables Converter & Exporter" — some now target OKLCH color space and rem-based sizing, emitting `var(--color-btn-primary)`-style output). If your plugin detects bound variables on fills/effects/spacing, exporting `:root { --token-name: value }` plus `var()` references in the generated CSS (instead of hardcoded literal values) is both technically straightforward and a widely-requested feature — worth scoping into v1 or an early v-next rather than ignoring it, since it's the difference between disposable output and something closer to a real design system handoff.

### 3.5 Text handling

- Single-font text nodes: `figma.loadFontAsync(node.fontName)` before reading.
- Mixed-font text nodes: must call `node.getRangeAllFontNames()` and load each before reading styles per range — mixed runs (bold word inside a sentence, etc.) need per-range `<span>`s in your HTML output or they'll silently collapse to one style.
- Auto-resize modes, line-height units (%, px, auto), letter-spacing units (%, px) all need explicit mapping — these are common sources of "close but not quite" visual mismatch that generic tools get flagged for.

### 3.6 Image/asset export

- `node.exportAsync(settings?)` → `Promise<Uint8Array>`, defaults to PNG @1x if no settings given.
- `ExportSettings` support `format: 'PNG' | 'JPG' | 'SVG' | 'PDF'` and constraint `{ type: 'SCALE'|'WIDTH'|'HEIGHT', value }`.
- **Decision point:** vector layers/icons should generally export as `SVG` (crisp, small, stylable) while photographic fills should export as `PNG`/`JPG` at an appropriate scale — a generic "export everything as PNG" approach (which some low-end plugins do) is a recurring complaint (bloated Base64 payloads, blurry icons). Also decide default behavior for **inline Base64 vs separate asset files** — inline is simpler for a "paste one HTML file" use case but bloats output; separate files are cleaner but require a zip/download flow.

### 3.7 Dev Mode Codegen API (an alternative/complementary integration point)

Beyond a classic plugin UI, Figma has a **Dev Mode-only codegen API**: manifest declares `"editorType": ["dev"]`, `"capabilities": ["codegen"]`, and `"codegenLanguages"`; your plugin registers `figma.codegen.on("generate", callback)`, which fires whenever the Dev Mode user's selection changes, and returns snippets that appear right in Figma's native Inspect panel language dropdown. This is a genuinely different UX from a plugin panel — it makes your output appear as a first-class "language" option next to Figma's built-in CSS/iOS/Android snippets. Worth considering as a second entry point (or even the primary one) if you want the "feels native to Dev Mode" experience rather than a separate popup UI.

### 3.8 Storage & size limits (practical ceilings to design around)

- `setPluginData`: **100KB per entry** (recently actively enforced after being under-enforced for a while — don't assume old docs/blog posts reflect current enforcement).
- `clientStorage`: ~5MB total — fine for user preferences/settings, not for caching full generated projects.
- `postMessage` payloads: no hard Figma-specific cap documented, but general browser guidance (RAIL) treats >100KB messages as risking jank on the main thread — for large selections (hundreds of nodes, big base64 images) chunk or stream data across the sandbox/UI boundary rather than sending one giant object.
- Large/complex Figma files in general can hit **performance walls** well before any of your code runs — several tools' own docs/reviews mention "struggles beyond 5+ frames" (Locofy) — budget for showing progress UI and/or a selection-size warning rather than freezing on big selections.

### 3.9 Tooling/boilerplate choice

- **[create-figma-plugin](https://github.com/yuanqing/create-figma-plugin)** (by yuanqing) — mature, widely used, ships Preact UI components styled to match Figma's own UI, TypeScript + CSS Modules, zero-config bundling. Good default choice for a UI-heavy plugin like yours (you'll want a real settings panel: unit rounding, class-naming convention, asset format, etc.).
- **[Plugma](https://github.com/gavinmcfarland/plugma)** — newer, Vite-based, true hot-module-reload dev server, framework-agnostic (React/Vue/Svelte/etc.), handles GitHub release + Figma Community version syncing in one command. Better DX if you want a modern framework for the settings UI and fast iteration; less batteries-included for Figma-specific UI components than `create-figma-plugin`.
- Both are third-party/community-maintained, not official Figma products — check maintenance activity before committing.

### 3.10 Publishing & review process

- Figma's stated review window is **5–10 business days**, but community forum threads from throughout 2026 report real waits of **3+ weeks to over a month**, with Figma citing submission-volume backlogs and no queue-position visibility. **Plan your release timeline accordingly** — do not assume same-week availability after submission, especially for a first submission or one that declares any network access.
- Anything in `networkAccess.allowedDomains` is shown publicly on your Community listing and reviewed explicitly — another argument for defaulting to `"none"` (local-only) unless you have a concrete reason (e.g., an optional AI enhancement mode) to request network access.

### 3.11 Monetization (if relevant to your plans)

- Figma Community supports paid plugins natively: one-time or subscription, **$2 minimum price**, subscriptions get a default 7-day free trial (configurable), **Figma takes a 15% fee**, payouts ~30 days after purchase.
- Common pattern in this space specifically: **freemium** — free plugin for visibility/adoption, paid tier gates advanced output (e.g., more frameworks, batch export, higher-res assets, tokens/variables export) — this mirrors Anima/Locofy's own tiering and is called out as the generally-recommended model over one-time-purchase for this category.
- Some plugin authors use external payment processors instead of/alongside Figma's native billing for more control over customer data and tax handling — a build-vs-buy decision, not urgent for an MVP. **Not relevant to you** since v1 is 100% free, but noted for completeness in case that ever changes.

### 3.12 Code viewer/editor component (Monaco vs CodeMirror) — resolving your "maybe Monaco" question

You floated Monaco Editor for the in-plugin code viewer. Researched this specifically:

- **Bundle size**: Monaco is roughly **5–10MB** (uncompressed; ~5MB gzipped), and its docs and multiple integration write-ups (Sourcegraph's own "why we migrated off Monaco" post) note it needs **Web Workers** for language services and a non-trivial bundler configuration to work outside a full webpack/VS Code-style setup. **CodeMirror 6** is modular — a basic HTML/CSS-highlighting setup lands around **~50–300KB**, no web workers required, and it's designed to be tree-shaken to just the languages/features you need.
- **Fit with your "no network access" / fully-local philosophy**: Monaco is commonly loaded from a CDN in many integration examples (simplest path), which would either (a) contradict a `networkAccess: "none"` manifest, or (b) require you to vendor and bundle the entire ~5-10MB Monaco distribution locally into your plugin package, inflating install size and Figma review payload for no real benefit here (you don't need Monaco's IntelliSense/autocomplete/multi-file project features — you're rendering **read-only, syntax-highlighted output**, not building an IDE).
- **Precedent found**: a Community plugin, `ilyalesik/figma-code-playground`, does bundle Monaco inside a Figma plugin — proving it's *possible* — but its own repo doesn't document the bundling approach or performance cost, and that plugin's use case (writing/running arbitrary code snippets) genuinely needs an editor with real input/autocomplete, unlike yours (read-only output display).
- **Recommendation**: use **CodeMirror 6** with just the `@codemirror/lang-html` and `@codemirror/lang-css` language packages, in **read-only mode** (`EditorView.editable.of(false)` / `EditorState.readOnly`), with a syntax-highlighting theme. This gets you the "easy to read, monospace, color-coded, scrollable" experience you actually want, keeps the plugin small and fast to load inside Figma's iframe, and stays consistent with your no-network, no-bloat philosophy. Pair it with a simple "Copy to Clipboard" button (`navigator.clipboard.writeText`, available in the UI iframe) and explicit **Generate**/**Regenerate** buttons that re-run the pipeline on demand rather than on every canvas change (avoids perf hits on large selections, matches the "fast, on-demand export" goal).

---

## 4. What Users Actually Complain About (synthesized from forums, HN, reviews, OSS READMEs)

Ranked roughly by how often/strongly each came up across sources:

1. **"One-time export, can't sync back"** (HN, strongest structural critique) — once a developer touches the generated code, there's no path to re-pull design updates without clobbering their edits. No tool in the market has really solved this; a couple of commercial products (Plasmic, mentioned by an employee on HN) claim continuous-sync architectures as their whole pitch.
2. **Non-semantic, "div soup" HTML** — near-universal complaint about free/cheap tools; explicitly called out as a limitation of the popular free "Figma to Code" plugin ("lacks semantic markup support"), and is on fig-gen's own TODO list even for a well-regarded OSS tool.
3. **No responsive/breakpoint support out of the box** — Figma has no native concept of a media query; tools either (a) ignore it entirely (most free plugins), (b) require designers to build parallel frames per breakpoint and manually "connect" them (Anima's approach), or (c) rely on component variants keyed to breakpoint names (Figma Sites' native approach). None of this is automatic from a single frame.
4. **Sub-pixel/non-round output values** ("width computed to be 13.333333333px") — a specific, recurring annoyance; developers want clean, roundable values, not raw computed geometry.
5. **Pricing cliffs** — "free tier is generous, paid tier is a steep jump" is the most common Anima/Locofy complaint; token-based/usage-based pricing for AI tools is called out as unpredictable and expensive at scale.
6. **Performance degradation on non-trivial files** — Locofy specifically called out as struggling past ~5 frames; general Figma-file-size/memory constraints compound this.
7. **Image/asset handling done badly** — everything exported as PNG regardless of content type, oversized Base64 embeds, blurry icons that should've been SVG.
8. **Font mismatches** — missing/unloaded fonts, mixed-style text runs collapsed incorrectly.
9. **Component/variant handling breaks down** — AI tools sometimes invent variant structures that don't match the actual Figma component set (called out specifically re: AI coding agents drifting from design system truth over time).
10. **No accessibility by default** — ARIA/semantic roles are essentially never inserted automatically; treated industry-wide as a manual cleanup pass, not a solved problem — an opportunity if you do even a basic job here (semantic tag inference from layer name/type: "button" layer → `<button>`, "nav" → `<nav>`, image `alt` from layer name).
11. **Frame positioning goes wrong without Auto Layout** — confirmed pain point with no good generic fix other than "use Auto Layout" — worth deciding whether your plugin nudges/validates for this before generating.
12. **Plugin review/approval delays** — this one hits *you*, the plugin author, not your end users — budget weeks, not days, for your first Community submission.

---

## 5. Where the Whitespace Is (and how your decisions map to it)

Based on the competitive research, a differentiated position for `snn-design-to-html-css` combines:

1. **Deterministic, local-only, no-AI core** (like FigmaToCode) — reproducible output, `networkAccess: "none"`, no per-generation cost, no vendor API dependency. ✅ **Matches your decision** in §0 — this is now your architecture, not just an option.
2. **HTML/CSS-only focus, done well**, rather than trying to also cover React/Vue/Flutter/SwiftUI like FigmaToCode does. ✅ **Matches your decision.** Depth over breadth is itself a differentiator — you can afford better semantic-tag inference and cleaner output if you're not maintaining five other backends.
3. **Explicit, visible warnings instead of silent guessing** when a layer isn't Auto Layout, has mixed fonts, or can't be cleanly translated — copy FigmaToCode's "Explain" stage rather than pretending everything converts perfectly. **Recommended addition**, not yet an explicit decision of yours — cheap to add (a small "conversion notes" panel next to the code viewer) and directly defuses the Codia-style "claims perfection, doesn't deliver" credibility complaint.
4. **Basic accessibility and semantics as a first-class setting** — layer-name/type-based tag inference (button/nav/header/footer/img+alt). ✅ **Matches your decision** ("clean semantic HTML/CSS output"). Nobody in the market does this well by default — real whitespace.
5. **Config surface for the things developers actually asked for**: unit rounding/snapping, class-naming convention (BEM vs simple), SVG-for-vectors vs PNG-for-photos, variables→CSS-custom-properties toggle. Still open — see §6.1 below.
6. **Should Tailwind ever become an option, architect for it now, ship it later.** See §5.1.

### 5.1 How other tools structure "plain CSS now, Tailwind maybe later" — direct precedent

You said you're not 100% sure whether to offer Tailwind as an optional additional output. Good news: this exact fork in the road has direct precedent, and it maps cleanly onto the pipeline architecture already recommended in §2.2:

- **FigmaToCode** treats "HTML" and "Tailwind" as **separate generator backends fed by the same normalized tree** — its 5-stage pipeline (Read → Normalize → Optimize → **Generate** → Explain) only branches at the Generate step. Plain-CSS-HTML and Tailwind-HTML are two different "Generate" modules consuming identical upstream data (same layout resolution, same alignment/sizing decisions). Users pick the output format from a tab/dropdown in the UI; nothing about the read/normalize/optimize stages changes.
- **ayush013/fig-gen**, by contrast, is Tailwind-only from the ground up (utility classes baked into its core generation logic), which is exactly why retrofitting plain CSS into a Tailwind-first tool (or vice versa) is awkward — the styling model is threaded through the whole codebase, not isolated to one stage.
- **Practical recommendation for you**: build your v1 pipeline with the same separation FigmaToCode uses — a framework-agnostic **normalized layout/style tree** as the output of "read + optimize," and a **single, swappable "generate CSS classes + HTML tags" module** as the last stage. Ship only the plain-CSS generator for v1 (per your decision), but keep that module boundary clean. If you decide later to add Tailwind, it becomes a **second Generate module** reading the same tree — not a rewrite. This costs you nothing now and preserves the option cleanly, which resolves your "maybe both" uncertainty without forcing a decision today.

---

## 6. Remaining Decisions / Things to Watch

Most of the big product questions from the first research pass are now locked in (§0). What's left:

### 6.1 Still genuinely open
- **Class-naming convention** for generated CSS: simple layer-name-slug classes (`.hero-title`) vs BEM (`.hero__title--large`) vs scoped/hashed classes. Given your semantic/readable-output goal, plain descriptive-slug classes derived from Figma layer names are the simplest match — BEM adds ceremony a static-HTML-export user probably doesn't need, but worth a quick gut-check once you see real output.
- **Unit rounding/snapping** — decide a default (e.g., round to nearest integer px, or snap to a spacing scale like 4/8px) vs. emitting Figma's raw computed values (which produces the widely-mocked `13.333333333px` complaint from §4).
- **Asset export defaults**: SVG for vector/icon layers, PNG/JPG for raster fills, and whether images are inlined as Base64 (simpler single-file copy/paste, matches your "fast export" goal) or exported as separate files (cleaner, but needs a zip/download flow rather than pure clipboard copy). Given you've chosen "copy to clipboard" as a primary flow, **Base64-inline by default, with an optional zip-download for users who want separate files**, is the natural fit.
- **Tooling**: `create-figma-plugin` (batteries-included Preact UI components matching Figma's own look, zero-config bundling) vs `Plugma` (Vite-based, framework-agnostic, faster hot-reload DX). Either works; `create-figma-plugin` is the lower-friction default for a settings-panel-heavy UI like yours, `Plugma` if you'd rather use React/Vue and want a faster dev loop. This is a "just pick one" decision, not a strategic one.

### 6.2 Important platform constraint you should know before writing "let everyone use it" anywhere in your positioning

You said you want the plugin usable by everyone, not gated by seat type, and free — good, that's your call to make on **your** side. But there's a **Figma-platform-level restriction that applies regardless of your plugin's price or your intentions**: confirmed via the Figma forum, **only users with "can edit" access to a file can run *any* plugin at all** — Viewers and comment-only seat holders **cannot run plugins**, including entirely read-only, non-destructive ones like yours, because Figma's permission model doesn't currently distinguish "read-only plugin" from "editing plugin." There's an open, unresolved feature request from the community asking Figma to allow non-modifying plugins for viewers, but it hasn't shipped. **Practical implication**: your plugin will genuinely be free and open to *anyone who can edit a file* (which includes every Starter/free-plan editor — plugins are confirmed free and unrestricted on the free Starter plan itself), but you should phrase your positioning as "free for every Figma editor," not "free for every Figma user," to avoid an inevitable string of confused support questions from Viewer-seat users who can't launch it.

---

## 7. Sources

**Official Figma documentation**
- [Introduction to Plugins & API](https://help.figma.com/hc/en-us/articles/4407275338775-BYFP-Introduction-to-Plugins-API)
- [Plugin API docs](https://developers.figma.com/docs/plugins)
- [Plugin Manifest reference](https://developers.figma.com/docs/plugins/manifest)
- [figma.codegen API](https://developers.figma.com/docs/plugins/api/figma-codegen)
- [Codegen plugins guide](https://developers.figma.com/docs/plugins/codegen-plugins)
- [Codegen Plugins for Automating Design to Code (Figma Blog)](https://www.figma.com/blog/figma-dev-mode-codegen-plugins/)
- [Working with Text](https://developers.figma.com/docs/plugins/working-with-text/)
- [nodes.exportAsync](https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync)
- [figma.ui API](https://developers.figma.com/docs/plugins/api/figma-ui)
- [primaryAxisAlignItems](https://www.figma.com/plugin-docs/api/properties/nodes-primaryaxisalignitems/)
- [layoutMode](https://www.figma.com/plugin-docs/api/properties/nodes-layoutmode/)
- [Plugin and widget review guidelines](https://help.figma.com/hc/en-us/articles/360039958914-Plugin-and-widget-review-guidelines)
- [Publish plugins to the Figma Community](https://help.figma.com/hc/en-us/articles/360042293394-Publish-plugins-to-the-Figma-Community)
- [Introducing our Dev Mode MCP server (Figma Blog)](https://www.figma.com/blog/introducing-figma-mcp-server/)
- [Guide to the Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
- [How to build a plugin system on the web (Figma Blog)](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)

**Open-source projects**
- [bernaferrari/FigmaToCode](https://github.com/bernaferrari/FigmaToCode)
- [ayush013/fig-gen](https://github.com/ayush013/fig-gen)
- [the-dataface/figma2html](https://github.com/the-dataface/figma2html)
- [gridaco/code](https://github.com/gridaco/code) / [gridaco org](https://github.com/gridaco)
- [cirediatpl/FigmaChain](https://github.com/cirediatpl/FigmaChain)
- [mike2151/html-to-figma](https://github.com/mike2151/html-to-figma)
- [yuanqing/create-figma-plugin](https://github.com/yuanqing/create-figma-plugin)
- [gavinmcfarland/plugma](https://github.com/gavinmcfarland/plugma) / [plugma.dev](https://www.plugma.dev/)

**Commercial tools referenced**
- [Anima](https://www.animaapp.com/) — [breakpoints doc](https://www.animaapp.com/blog/design-to-code/breakpoints-with-anima-from-figma-design-to-responsive-website/), [Capterra reviews](https://www.capterra.com/p/240303/Anima/reviews/)
- [Locofy.ai](https://www.locofy.ai/) — [G2 reviews](https://www.g2.com/products/locofy-ai/reviews)
- [Builder.io Visual Copilot](https://www.builder.io/blog/best-figma-to-code-plugin)
- [divRIOTS html.to.design](https://divriots.com/blog/introducing-html-to-design/) / [divriots.com](https://divriots.com/)
- [Codia AI](https://codia.ai/blog/figma-to-code-guide)

**Community sentiment / forum & discussion threads**
- [HN: Ask HN — Why don't you like Figma to code?](https://news.ycombinator.com/item?id=41860927)
- [HN: Ask HN — AI for converting Figma to Code](https://news.ycombinator.com/item?id=40670296)
- [Figma Forum: after converting Figma into code with plugin, elements' position went wrong](https://forum.figma.com/t/after-convering-figma-into-code-with-plugin-some-of-the-elements-position-went-wrong/60563)
- [Figma Forum: developers — what features would you like in a Figma-to-code plugin](https://forum.figma.com/t/developers-what-features-would-you-like-to-see-in-a-figma-to-code-plugin/39883)
- [Figma Forum: plugin review taking 20 days](https://forum.figma.com/ask-the-community-7/plugin-review-taking-20-days-is-this-normal-52367)
- [Figma Forum: setPluginData 100kb limit enforced](https://forum.figma.com/report-a-problem-6/setplugindata-100kb-size-limit-now-being-enforced-38987)
- [Why AI coding agents struggle with Figma (dev.to)](https://dev.to/echoae/why-ai-coding-agents-struggle-with-figma-and-what-actually-worked-3opi)
- [3 Design System Bugs That Survive Every Code Review (Medium)](https://medium.com/design-bootcamp/3-design-system-bugs-that-survive-every-code-review-and-why-ai-makes-them-worse-55272372ee6a)

**Design-token / CSS export references**
- [Export Figma variables to CSS custom properties using Style Dictionary](https://dev.to/alexandersstudi/export-figma-variables-to-css-custom-properties-using-style-dictionary-3pjh)
- [Figma CSS Variables Converter & Exporter (Community plugin)](https://www.figma.com/community/plugin/1580865604483451262/figma-css-variables-converter-exporter)

**Absolute→flex inference / layout heuristics research**
- [bernaferrari/FigmaToCode — `commonPosition.ts` source](https://github.com/bernaferrari/FigmaToCode/blob/main/packages/backend/src/common/commonPosition.ts) (fetched and read directly to confirm no clustering/heuristic logic exists — decision is purely flag-based)
- [Figma Forum: access to the "Suggest Auto Layout" feature in the plugin API](https://forum.figma.com/ask-the-community-7/access-to-the-suggest-auto-layout-feature-in-the-plugin-api-9074) (confirms Shift+A's algorithm is not exposed via API)
- [Figma Forum: random frames defaulting to absolute position when applying auto layout](https://forum.figma.com/ask-the-community-7/random-frames-defaulting-to-absolute-position-when-applying-auto-layout-12144)
- [VIPS: a Vision-based Page Segmentation Algorithm (Microsoft Research, Cai & Yu)](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-2003-79.pdf) — classic algorithm adapted here as the basis for a geometry-based row/column/grouping heuristic
- [jensonwong.com: Behind Figma Auto Layout](https://www.jensonwong.com/blog/behind-autolayout) — confirms Auto Layout is a GUI over CSS flexbox and that non-Auto-Layout content is genuinely absolutely positioned with no relational data
- Figma2Code: Automating Multimodal Design to Code in the Wild (arXiv 2604.13648) — academic paper found to exist and be relevant, but its PDF text extraction failed in this research pass (binary/corrupted stream); worth reading directly from arXiv before finalizing the layout-inference design

**Editor component (Monaco vs CodeMirror) research**
- [Sourcegraph: Migrating from Monaco Editor to CodeMirror](https://sourcegraph.com/blog/migrating-monaco-codemirror)
- [ilyalesik/figma-code-playground](https://github.com/ilyalesik/figma-code-playground) — precedent for bundling Monaco inside a Figma plugin, though undocumented bundling approach
- [Embeddable Monaco Editor](https://lukasbach.com/projects/embeddable-monaco/)

**Access/seat restrictions**
- [Figma Forum: can users with view access only run plugins](https://forum.figma.com/archive-21/can-users-with-view-access-only-run-plugins-35947) — confirms only "can edit" users can run any plugin
- [Figma Forum: Plugin for viewers (feature request)](https://forum.figma.com/suggest-a-feature-11/plugin-for-viewers-11157)
- [Figma Pricing FAQs](https://www.figma.com/pricing-faq/) — confirms plugins are free/unrestricted on the Starter (free) plan for editors

---

*Next step suggested: turn this into a short PRD/spec — the big product decisions (§0) are locked, so the remaining work is the §6.1 detail decisions plus designing the internal normalized-tree data model (§5.1) before writing the Auto Layout → flexbox generator (§3.3) and, later, the absolute-layout heuristic (§3.3.1).*

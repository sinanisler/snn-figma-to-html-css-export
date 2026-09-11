# Research: Building a "Design to HTML/CSS" Figma Plugin

Compiled 2026-09-11. Purpose: give you the landscape, the technical constraints, and the community-sourced pain points needed to make deliberate product decisions before writing any code for `snn-design-to-html-css`.

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

**Community-sourced gotcha:** frames **not** using Auto Layout (free-form/absolute positioning) are exactly where generic plugins fall apart — a forum thread ("after converting Figma into code with plugin some of the elements' position went wrong") got no real fix beyond "ask the plugin author," and multiple tools' own docs (fig-gen) explicitly tell designers to avoid fixed positioning and use Auto Layout for decent output. **Decision point:** decide explicitly how you handle non-Auto-Layout frames — e.g., fall back to `position: absolute` inside a `position: relative` parent (this is honest, at least reproduces the visual, but produces exactly the "brittle/non-responsive" code people complain about) vs. refusing/flagging ungrouped absolute layers as "needs Auto Layout" the way FigmaToCode surfaces warnings instead of guessing.

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
- Some plugin authors use external payment processors instead of/alongside Figma's native billing for more control over customer data and tax handling — a build-vs-buy decision, not urgent for an MVP.

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

## 5. Where the Whitespace Is

Based on the above, a differentiated position for `snn-design-to-html-css` could combine:

1. **Deterministic, local-only, no-AI core** (like FigmaToCode) — reproducible output, `networkAccess: "none"`, no per-generation cost, no vendor API dependency, and it's a genuine trust/privacy pitch against the AI-pipeline tools.
2. **HTML/CSS-only focus, done well**, rather than trying to also cover React/Vue/Flutter/SwiftUI like FigmaToCode does — depth over breadth is itself a differentiator; you can afford better semantic-tag inference, cleaner class naming, and real accessibility defaults if you're not also maintaining five other backends.
3. **Explicit, visible warnings instead of silent guessing** when a layer isn't Auto Layout, has mixed fonts, or can't be cleanly translated — copy FigmaToCode's "Explain" stage rather than pretending everything converts perfectly (avoids Codia-style credibility complaints).
4. **Round-trip-aware output habits** even if you don't solve full sync: stable, human-readable class names derived from Figma layer names (not `div_1_2_3`), consistent structure ordering, and a "re-export merges predictably" mental model — mitigates (without fully solving) complaint #1.
5. **Basic accessibility and semantics as a first-class setting**, not an afterthought — layer-name/type-based tag inference (button/nav/header/footer/img+alt), since literally nobody in the market does this well by default.
6. **Config surface for the things developers actually asked for**: unit rounding/snapping, class-naming convention (BEM vs simple), inline-style vs external stylesheet, SVG-for-vectors vs PNG-for-photos, variables→CSS-custom-properties toggle.
7. **Decide your breakpoint story explicitly** rather than ignoring it: even a simple "detect N frames named `Mobile`/`Tablet`/`Desktop` in the same section and emit `@media` queries" would beat most free tools and doesn't require Anima's full manual-linking UI.

---

## 6. Open Decisions for You to Make (before coding starts)

- **Scope**: HTML/CSS only (per your stated goal) — confirm you're deliberately *not* chasing React/Vue/Tailwind output like FigmaToCode does, to keep quality high and scope sane for v1.
- **AI or not**: fully deterministic rule-based (simpler, local, trustworthy, but semantic inference will be shallow) vs. optional AI-assisted mode for things like tag/alt-text inference (adds network access disclosure + cost + inconsistency risk).
- **Non-Auto-Layout fallback**: absolute-position fallback vs. hard warning/refusal.
- **Output delivery**: copy-to-clipboard single file, downloadable zip with separate CSS/assets, or both.
- **Responsive story**: none in v1, or basic multi-frame/media-query detection.
- **Variables/tokens**: ignore in v1, or export bound variables as CSS custom properties.
- **Entry point**: classic plugin UI panel, Dev Mode codegen integration (`figma.codegen`), or both.
- **Tooling**: `create-figma-plugin` (batteries-included, Preact) vs `Plugma` (Vite, framework-agnostic, faster DX loop).
- **Monetization**: free-only for adoption/portfolio purposes, or freemium from day one (gate e.g. zipped multi-file export, variables export, or batch/multi-frame export behind a paid tier).
- **Positioning statement**: pick one lane and say it out loud — e.g. "the deterministic, local-only, semantic HTML/CSS exporter for designers who don't want AI guesswork or React baggage."

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

---

*Next step suggested: once you've made the decisions in §6, we can turn this into a short PRD/spec and start scaffolding the plugin (recommend `create-figma-plugin` unless you have a strong reason to prefer Plugma's Vite-based DX).*

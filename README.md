# Figma to HTML, Tailwind, React, Vue and Svelte

Figma plugin that turns a selected frame into code: HTML + CSS, HTML + Tailwind, React (CSS / Tailwind), Vue (CSS / Tailwind), Svelte and Email HTML. It includes a live preview with device widths, a zip or Vite / Next.js starter download, design tokens export and Dev Mode codegen.

## Responsive output

- **Auto Layout → flex / grid.** Frames that use Auto Layout export as real flexbox / CSS grid (Hug → auto size, Fill → `flex: 1 1 0`, Wrap → `flex-wrap: wrap`), so the page fits every screen.
- **No Auto Layout → fixed.** Layers placed by hand keep their exact size and position (`position: absolute`). Without AI the plugin cannot guess a responsive layout, so it reproduces the design faithfully instead.
- **Breakpoints:** name frames `Home / Desktop` and `Home / Mobile` to merge them into one page with media queries.
- The Notes panel shows the design's **Auto Layout score** and lists the layers without it.

## Development

```bash
npm install
npm run dev        # plugma dev build, load manifest from dist/ in Figma
npm run build      # production build in dist/
npm run typecheck
npm test           # vitest
node scripts/figma-check.mjs   # compile dist/main.js with QuickJS (Figma's sandbox engine)
```

Layout: `src/main` (Figma sandbox: reads nodes, tokens, storage), `src/ui` (iframe UI, preview, export), `src/core` (pure conversion: build IR → emit markup/CSS → formats), `src/shared/types.ts` (message and data types). `cover/` holds the Community listing images (`*.html` rendered to 1920×1080 PNG with headless Chrome).

---

## AI rebuild: removed for Figma review, planned to return

### Status (2026-09)

Figma Community review **rejected** the plugin with this note: *"plugin can't be approved with a user-supplied OpenRouter API key (BYOK); please switch to a publisher-managed AI integration, keep the OpenRouter image-transfer disclosure, and resubmit."*

To get approved fast, the whole AI feature was removed. The last commit **with** AI is `45cbba2` (BYOK OpenRouter). The one before it, `85f199b`, had a first attempt at a publisher-managed route ("SNN account with browser pairing"). Restore files with `git show 45cbba2:<path>`.

What was removed:

| File | Role |
|---|---|
| `src/core/ai.ts` | Pure logic: section planning, prompts, response parsing, text-coverage check, page assembly, HTML→JSX, asset/link rewriting, `aiFiles()` output for every format except email |
| `src/ui/ai-run.ts` | Runs sections through a worker pool (`parallel` 1–4), streams progress, AbortController cancel |
| `src/ui/openrouter.ts` | `streamChat` (SSE, `usage: {include: true}` for cost), `checkKey`, `listModels` |
| `tests/openrouter.test.ts`, AI block in `tests/features.test.ts` | Tests |
| `ui.ts` / `styles.css` | AI Generate button, Standard/AI source toggle, AI settings panel, run panel (per-section status, Retry/Redo, Cancel, Regenerate all), empty state, AI notes |
| `main.ts` / `types.ts` | `SAVE_AI` / `ai` clientStorage, `SCREENSHOT` → `IMAGE` message (JPG export of a node for the vision model) |
| `manifest.json` | `https://openrouter.ai` in `networkAccess.allowedDomains` and its reasoning text |

`main.ts` now runs `figma.clientStorage.deleteAsync('ai')` on launch so API keys saved by old versions are wiped. Keep this line.

### How it worked (keep this design)

1. **Standard export first.** `buildDocument()` builds the IR as usual. AI never starts from raw Figma nodes; it starts from the plugin's own literal HTML + CSS for each section.
2. **Plan** (`planPages`). A frame at least 900 px tall with two or more blocks is a page, split into top-level sections. A section larger than `SECTION_LIMIT` (24 000 chars of HTML + CSS) is split into its children. Wrappers keep their background but drop their placement/size so sections flow. Results are keyed by Figma layer id, so they survive re-generate until the selection or styling changes.
3. **Prompt** (`sectionMessages`). The system prompt depends on the styling (CSS or Tailwind) plus the user's custom instructions. Each call carries the section's literal HTML/CSS, a JPG screenshot of the section (≤1024 px) and one of the whole page (512 px, shared by sections), so a vision model understands the layout. Bump `PROMPT_VERSION` when the prompt changes.
4. **Run** 1–4 sections in parallel. Stream the answer and show chars, reasoning chars, time and cost per section.
5. **Parse** (`parseSectionResponse`): pull the ```html and ```css blocks and strip anything a page must not contain. **Check** with `textCoverage`: under 80 % of the design's words kept shows the `AI_TEXT_CHANGED` note. A failed section falls back to the standard output (`AI_SECTION_FAILED`).
6. **Assemble** (`assemblePages` + `aiFiles`): stitch sections back into pages, rewrite `assets/…` paths per asset mode and page links per routing (files / hash / path), and convert to JSX for React. Downloads get a `-ai` suffix.
7. **UX rules:** never show the standard export labelled as AI (show an empty state instead); keep a stash per styling so switching CSS ↔ Tailwind restores the earlier rebuild; the email format has no AI.

### What Figma requires to bring it back

- **Publisher-managed AI only.** No user-supplied API key, no key field in the UI. The plugin calls **our own backend** (e.g. `api.sinanisler.com`), and that backend holds the OpenRouter key and calls the model.
- **Keep the disclosure** in the UI, the listing and the manifest `networkAccess.reasoning`: *section HTML/CSS and screenshots of the selected layers are sent to our server and to OpenRouter / the model provider.* Show it before the first run.
- `allowedDomains` gets our backend domain only, not `openrouter.ai`.

### Plan: publisher-managed backend

- **Backend** (serverless function or WordPress REST endpoint): `POST /v1/ai/section` takes `{ messages, styling, promptVersion }` and streams SSE back in the same shape `streamChat` parses today, so `ai-run.ts` barely changes. It adds the OpenRouter key server-side, pins the **model allow-list** (the client sends a model alias, not a free model id), and caps `max_tokens`.
- **Auth and abuse control:** sign in with the SNN account (browser pairing flow, see `85f199b`: the plugin opens a URL with `figma.openExternal`, then polls for a token) or use `figma.currentUser.id` + a signed per-install token. Rate limit per user and per day; enforce a credit/quota system server-side and return remaining credit so the run panel can show it instead of `$` cost.
- **Keep the prompt server-side** (optional) so it can change without a plugin release; send `PROMPT_VERSION` for cache keys.
- **Cache** by `hashText(section html+css + styling + promptVersion)` on the server to cut costs on re-runs.
- **Privacy:** don't store screenshots; log only token counts and cost. Document retention in the listing.
- **Restore steps:** `git show 45cbba2:src/core/ai.ts > src/core/ai.ts` (and `ai-run.ts`, the tests); replace `openrouter.ts` with `backend.ts` (same `streamChat` signature, no `apiKey`, auth token instead); in `ui.ts`, bring back the AI button, source toggle, run panel and notes, and replace the key/model fields with account status plus remaining credit; re-add `SCREENSHOT`/`IMAGE` messages; update manifest domains + reasoning, the covers (`cover/slide5.html`) and the listing name.

### Future AI feature ideas

- Semantic cleanup of standard output even with Auto Layout (tag names, BEM class names, `<button>`/`<nav>`/`<header>`).
- Accessibility pass: alt text from screenshots, heading order, labels.
- Responsive breakpoints generated for a single desktop frame (mobile CSS for each section).
- Component extraction: detect repeated sections and emit shared React/Vue/Svelte components with props.
- Per-section "Redo with instructions" chat.

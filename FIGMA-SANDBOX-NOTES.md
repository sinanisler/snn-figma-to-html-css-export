# Figma sandbox notes — what broke, and the rules that keep it working

Written after a rollback on 2026-09-16. Read this before touching anything under `src/main/`.

## The one rule

**`src/main/` must never import `src/core/`.**

The plugin has two threads, and they are not equal:

| | `src/main/` (sandbox) | `src/ui/` (iframe) |
|---|---|---|
| Runs in | Figma's own JS VM (a QuickJS fork) | Chromium, a normal browser |
| Parses | Much less than the docs claim | Everything modern |
| Should contain | Reading the selection, exporting assets, `figma.*` calls | The converter, the UI, zips, downloads |
| Size to aim for | ~13–17 KB | Anything (it's ~580 KB today) |

The converter (`src/core/`) is plain TypeScript with no Figma dependency. It runs perfectly in the iframe. Keep it there.

## What happened

A batch of features (Tailwind/React/Vue/Svelte/email output, preview, breakpoints, variant states, shared classes, multi-page sites, design tokens, starter projects, **Dev Mode codegen**) was added. All of it worked in tests, typecheck and the production build.

In Figma the plugin then failed at load with:

```
SyntaxError: expecting '('
    at PLUGIN_3_SOURCE:1:581
```

Only one of those features touched the sandbox: **Dev Mode codegen**. `figma.codegen.on('generate')` has to convert nodes to code, so `src/main/main.ts` imported `buildDocument` and `generate` — and that pulled the entire converter into the sandbox bundle.

### Evidence

| | Working (`b9331a8`) | After the features |
|---|---|---|
| `dist/main.js` | 13 KB | 58 KB (394 KB via `plugma dev`) |
| Minimum ES level | ES2015 | ES2016, then ES2017 |
| Constructs new to the sandbox | — | object shorthand `{a, b}` ×117, computed keys `{[k]: v}` ×6, destructured params ×8 |

Every one of those constructs arrived with `src/core/`. A [documented report](https://www.sam.today/blog/bumbling-the-figma-api) describes Figma's VM failing on exactly this kind of syntax (`x = { y, ...z }`), even though [Figma's own docs](https://developers.figma.com/docs/plugins/how-plugins-run) claim "ES2020 and beyond". Trust the VM, not the docs.

### Dead ends (don't repeat these)

- **Raising the build target.** Setting `target: 'es2017'` made it *worse*: it stopped esbuild lowering `async`/`await` and `**`, pushing the bundle further from the shape that worked.
- **Lowering the syntax away.** esbuild refuses: *"Transforming destructuring to the configured target environment is not supported yet"*, same for object literal extensions. Only Babel could do it, at the cost of a second toolchain.
- **Reproducing it locally.** The bundle compiled cleanly under two QuickJS builds (`quickjs-emscripten` and `quickjs-ng`) and parsed as valid ES2015. Figma's VM is a private fork; **no local engine is a reliable oracle for it.**
- **Blaming the build mode.** `npm run dev` and `npm run build` produce very different bundles (394 KB vs 58 KB) and both failed.

## Checklist before shipping anything that touches `src/main/`

1. `npm run build`, then check the size: `wc -c < dist/main.js`. Expect ~13–20 KB. **If it jumped to hundreds of KB, you imported the converter — stop.**
2. Check nothing but `figma.*` work landed there: `grep -rn "core/" src/main/`. It must return nothing.
3. Compare the syntax against the last version known to run in Figma. Build that commit into a second folder and diff the AST constructs; anything in the "NEW-ONLY" list is a risk:

   ```bash
   git worktree add /tmp/goodbuild <last-good-commit>
   # build both, then compare the two dist/main.js files
   ```

4. Load it in Figma and open the console **before** you commit. Tests, typecheck and a green build say nothing about whether the VM will parse the bundle.

## If you want Dev Mode codegen later

Do not import the converter into the sandbox. Instead:

- `figma.showUI(__html__, { visible: false })` keeps the iframe alive.
- The `generate` callback reads the node, `postMessage`s the raw tree to the iframe, and waits for the iframe to send back the generated code.
- The converter stays in the iframe, where modern JavaScript is fine.

The callback has a 3-second budget, so the round trip must be quick. Treat this as an experiment: build it, load it in Figma, and check the console before building anything else on top.

## Where the parked work is

Branch **`feature/multi-format-export`**, commit `b64767b`. Everything is there and passing (29 tests, typecheck, build): Tailwind/React/Vue/Svelte/email output, live preview, breakpoints, hover states from variants, shared classes, multi-page sites, prototype links, design tokens, Vite starter projects, semantic form controls and lists, Google Fonts links, rem units, inline SVG.

Almost none of it needs the sandbox. To bring features back, port them **one at a time**, UI-side only, and load each one in Figma before moving on:

1. Start with the pure-converter ones (output formats, shared classes, semantic tags, fonts, units) — these touch `src/core/` and `src/ui/` only and carry no sandbox risk.
2. Features needing new data from Figma (prototype links, component variant states, local variables for tokens) each add a small, boring read to `src/main/read.ts`. Keep the additions plain: no destructured parameters, no fancy syntax, no new imports.
3. Re-check `wc -c < dist/main.js` after every one.

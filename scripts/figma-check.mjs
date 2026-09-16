#!/usr/bin/env node
/**
 * Preflight check: compiles the built plugin with QuickJS — the JS engine
 * family Figma uses in its plugin sandbox ("expecting '...'" errors in the
 * Figma console come from that engine).
 *
 * Guards against esbuild output that Figma's VM cannot compile. Known trap:
 * with `target: es6`, `for (const x of await f())` inside an async function is
 * lowered to `for (const x of yield f())` in the generated state machine,
 * which QuickJS rejects. Hoist the awaited iterable into a local before the
 * loop to avoid it.
 *
 * Usage:
 *   node scripts/figma-check.mjs                 # checks dist/main.js
 *   node scripts/figma-check.mjs path/to/main.js
 *   node scripts/figma-check.mjs --bisect        # locate the failing statement
 */
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const bisect = args.includes('--bisect');
const file = args.find((a) => !a.startsWith('--')) ?? 'dist/main.js';

if (!existsSync(file)) {
	console.error(`figma-check: file not found: ${file}`);
	process.exit(2);
}
const code = readFileSync(file, 'utf8');

const { getQuickJS } = await import('quickjs-emscripten');
const QuickJS = await getQuickJS();

/** @returns {string | null} error message, or null when it compiles. */
function compileError(source) {
	const vm = QuickJS.newContext();
	const result = vm.evalCode(source, 'main.js', { compileOnly: true });
	if (!result.error) return null;
	const dumped = vm.dump(result.error);
	return dumped && dumped.message ? dumped.message : JSON.stringify(dumped);
}

const message = compileError(code);
if (!message) {
	console.log(`figma-check: OK — ${file} compiles in QuickJS (${code.length} bytes)`);
	process.exit(0);
}

console.error(`figma-check: FAIL — Figma's JS engine cannot compile ${file}`);
console.error(`  QuickJS error: ${message}`);

if (bisect) {
	const acorn = await import('acorn');
	let statements = null;
	try {
		const ast = acorn.parse(code, { ecmaVersion: 'latest' });
		const last = ast.body[ast.body.length - 1];
		const callee = last && last.expression && last.expression.callee;
		if (callee && callee.type === 'FunctionExpression') statements = callee.body.body;
	} catch (e) {
		console.error(`  (could not parse for bisection: ${e.message})`);
	}

	if (statements && statements.length) {
		let lo = 0;
		let hi = statements.length;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			const prefix = code.slice(0, statements[mid - 1].end) + '})();';
			if (compileError(prefix)) hi = mid;
			else lo = mid;
		}
		const culprit = statements[hi - 1];
		console.error(`  First failing statement (bytes ${culprit.start}..${culprit.end}):`);
		console.error('  ' + code.slice(culprit.start, Math.min(culprit.end, culprit.start + 600)).replace(/\n/g, '\n  '));
	} else {
		console.error('  (bisection unavailable for this file shape)');
	}
}

console.error('  Fix the source pattern above (see script header) and rebuild: npm run build');
process.exit(1);

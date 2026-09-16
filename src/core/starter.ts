import type { Format, RawAsset } from '../shared/types';
import { fontLinkTags, googleFontsUrl } from './fonts';
import { componentName, extFor, formatParts, generate, htmlDocument, pathsFor, type OutFile } from './generate';
import type { IRDocument } from './ir';

export type StarterOptions = {
	format: Format;
	googleFonts: boolean;
	inlineSvg: boolean;
	components?: boolean;
	typescript?: boolean;
	systemDark?: boolean;
	/** Use these files (e.g. AI output) instead of generating them from the document. */
	files?: OutFile[];
};

const VERSIONS = {
	vite: '^7.1.0',
	react: '^19.1.0',
	'react-dom': '^19.1.0',
	'@vitejs/plugin-react': '^5.0.0',
	vue: '^3.5.0',
	'@vitejs/plugin-vue': '^6.0.0',
	svelte: '^5.38.0',
	'@sveltejs/vite-plugin-svelte': '^6.1.0',
	tailwindcss: '^4.1.0',
	'@tailwindcss/vite': '^4.1.0',
	'@tailwindcss/postcss': '^4.1.0',
	next: '^15.5.0',
	typescript: '^5.9.0',
	'@types/react': '^19.1.0',
	'@types/react-dom': '^19.1.0',
	'@types/node': '^22.0.0',
	'vue-tsc': '^3.0.0',
};

const pick = (...names: (keyof typeof VERSIONS)[]) => Object.fromEntries(names.map((n) => [n, VERSIONS[n]]));

function packageJson(name: string, deps: Record<string, string>, devDeps: Record<string, string>, scripts?: Record<string, string>): string {
	return (
		JSON.stringify(
			{
				name,
				private: true,
				version: '0.0.0',
				type: 'module',
				scripts: scripts ?? { dev: 'vite', build: 'vite build', preview: 'vite preview' },
				dependencies: Object.keys(deps).length ? deps : undefined,
				devDependencies: devDeps,
			},
			null,
			2,
		) + '\n'
	);
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function projectName(doc: IRDocument): string {
	return doc.pages[0]?.slug === 'index' ? pkgName(doc.title) : pkgName(doc.pages[0]?.name ?? 'site');
}

function readme(doc: IRDocument, dev = 'npm run dev', out = 'dist/'): string {
	return `# ${doc.title}\n\nExported from Figma with SNN Design to HTML/CSS.\n\n\`\`\`bash\nnpm install\n${dev}\n\`\`\`\n\n\`npm run build\` writes a production build to \`${out}\`.\n`;
}

/** Every file of a ready-to-run Vite project for the chosen format. */
export function starterFiles(doc: IRDocument, assets: Map<string, RawAsset>, opts: StarterOptions): Record<string, string | Uint8Array> {
	const { framework, styling } = formatParts(opts.format);
	const tailwind = styling === 'tailwind';
	const ts = opts.typescript === true && framework !== 'html' && framework !== 'email';
	const name = projectName(doc);
	const out: Record<string, string | Uint8Array> = {};
	const files = opts.files ?? generate(doc, { ...opts, assets, assetMode: 'files', tailwindCdn: false, layout: 'vite' });
	const twPlugin = tailwind ? ["import tailwindcss from '@tailwindcss/vite';"] : [];
	const twUse = tailwind ? ['tailwindcss()'] : [];
	const twDeps = tailwind ? pick('tailwindcss', '@tailwindcss/vite') : {};
	const config = ts ? 'vite.config.ts' : 'vite.config.js';

	if (framework === 'html' || framework === 'email') {
		for (const f of files) if (f.path) out[f.path] = f.content;
		for (const a of assets.values()) out[`assets/${a.name}`] = a.bytes;
		const inputs = doc.pages.map((p) => `      ${JSON.stringify(p.slug)}: resolve(import.meta.dirname, '${p.slug}.html'),`);
		out['vite.config.js'] = [
			"import { resolve } from 'node:path';",
			"import { defineConfig } from 'vite';",
			...twPlugin,
			'',
			'export default defineConfig({',
			`  plugins: [${twUse.join(', ')}],`,
			'  build: {',
			'    rollupOptions: {',
			'      input: {',
			...inputs,
			'      },',
			'    },',
			'  },',
			'});',
			'',
		].join('\n');
		out['package.json'] = packageJson(name, {}, { ...pick('vite'), ...twDeps });
	} else {
		for (const f of files) if (f.path) out[f.path] = f.content;
		for (const a of assets.values()) out[`public/assets/${a.name}`] = a.bytes;
		const pages = doc.pages.map((p, i) => ({ slug: p.slug === 'index' ? '' : p.slug, name: componentName(doc, i) }));
		const ext = extFor(framework, ts);
		const imports = pages.map((p) => `import ${p.name} from './pages/${p.name}.${ext}';`).join('\n');
		const routes = `{ ${pages.map((p) => `${JSON.stringify(p.slug)}: ${p.name}`).join(', ')} }`;
		const mount = framework === 'react' ? 'root' : 'app';
		const fontHead = fontLinkTags(opts.googleFonts ? googleFontsUrl(doc.fonts) : null);
		const entry = framework === 'react' ? `src/main.${ts ? 'tsx' : 'jsx'}` : `src/main.${ts ? 'ts' : 'js'}`;
		out['index.html'] = htmlDocument(doc.title, [fontHead], `<div id="${mount}"></div>\n<script type="module" src="/${entry}"></script>`);
		const tsDeps = ts ? pick('typescript') : {};

		if (framework === 'react') {
			const app = ts ? 'App.tsx' : 'App.jsx';
			out[entry] = `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './${app}';\n\ncreateRoot(document.getElementById('root')${ts ? '!' : ''}).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`;
			const routeType = ts ? ': Record<string, ComponentType>' : '';
			const typeImport = ts ? "import type { ComponentType } from 'react';\n" : '';
			out[`src/${app}`] = `import { useEffect, useState } from 'react';\n${typeImport}${imports}\n\nconst routes${routeType} = ${routes};\nconst current = () => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);\n\nexport default function App() {\n  const [route, setRoute] = useState(current() ?? '');\n  useEffect(() => {\n    const onHash = () => {\n      const next = current();\n      if (next !== null) setRoute(next);\n    };\n    addEventListener('hashchange', onHash);\n    return () => removeEventListener('hashchange', onHash);\n  }, []);\n  const Page = routes[route] ?? ${pages[0].name};\n  return <Page />;\n}\n`;
			out[config] = ["import { defineConfig } from 'vite';", "import react from '@vitejs/plugin-react';", ...twPlugin, '', `export default defineConfig({\n  plugins: [${['react()', ...twUse].join(', ')}],\n});`, ''].join('\n');
			out['package.json'] = packageJson(name, pick('react', 'react-dom'), {
				...pick('vite', '@vitejs/plugin-react'),
				...twDeps,
				...tsDeps,
				...(ts ? pick('@types/react', '@types/react-dom') : {}),
			});
			if (ts) {
				out['tsconfig.json'] = json({
					compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, types: ['vite/client'] },
					include: ['src'],
				});
			}
		} else if (framework === 'vue') {
			out[entry] = `import { createApp } from 'vue';\nimport './styles.css';\nimport App from './App.vue';\n\ncreateApp(App).mount('#app');\n`;
			const routeType = ts ? ': Record<string, Component>' : '';
			const typeImport = ts ? "import type { Component } from 'vue';\n" : '';
			out['src/App.vue'] = `<script setup${ts ? ' lang="ts"' : ''}>\nimport { onBeforeUnmount, ref, computed } from 'vue';\n${typeImport}${imports}\n\nconst routes${routeType} = ${routes};\nconst current = () => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);\nconst route = ref(current() ?? '');\nconst onHash = () => {\n  const next = current();\n  if (next !== null) route.value = next;\n};\naddEventListener('hashchange', onHash);\nonBeforeUnmount(() => removeEventListener('hashchange', onHash));\nconst Page = computed(() => routes[route.value] ?? ${pages[0].name});\n</script>\n\n<template>\n  <component :is="Page" />\n</template>\n`;
			out[config] = ["import { defineConfig } from 'vite';", "import vue from '@vitejs/plugin-vue';", ...twPlugin, '', `export default defineConfig({\n  plugins: [${['vue()', ...twUse].join(', ')}],\n});`, ''].join('\n');
			out['package.json'] = packageJson(name, pick('vue'), { ...pick('vite', '@vitejs/plugin-vue'), ...twDeps, ...tsDeps, ...(ts ? pick('vue-tsc') : {}) });
			if (ts) {
				out['src/env.d.ts'] = `/// <reference types="vite/client" />\n\ndeclare module '*.vue' {\n  import type { DefineComponent } from 'vue';\n  const component: DefineComponent;\n  export default component;\n}\n`;
				out['tsconfig.json'] = json({
					compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true },
					include: ['src'],
				});
			}
		} else {
			out[entry] = `import { mount } from 'svelte';\nimport './styles.css';\nimport App from './App.svelte';\n\nmount(App, { target: document.getElementById('app')${ts ? '!' : ''} });\n`;
			const routeType = ts ? ': Record<string, Component>' : '';
			const typeImport = ts ? "import type { Component } from 'svelte';\n" : '';
			out['src/App.svelte'] = `<script${ts ? ' lang="ts"' : ''}>\n  ${(typeImport + imports).split('\n').join('\n  ')}\n\n  const routes${routeType} = ${routes};\n  const current = () => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);\n  let route = $state(current() ?? '');\n  $effect(() => {\n    const onHash = () => {\n      const next = current();\n      if (next !== null) route = next;\n    };\n    addEventListener('hashchange', onHash);\n    return () => removeEventListener('hashchange', onHash);\n  });\n  const Page = $derived(routes[route] ?? ${pages[0].name});\n</script>\n\n<Page />\n`;
			out[config] = ["import { defineConfig } from 'vite';", "import { svelte } from '@sveltejs/vite-plugin-svelte';", ...twPlugin, '', `export default defineConfig({\n  plugins: [${['svelte()', ...twUse].join(', ')}],\n});`, ''].join('\n');
			out['package.json'] = packageJson(name, {}, { ...pick('vite', 'svelte', '@sveltejs/vite-plugin-svelte'), ...twDeps, ...tsDeps });
			if (ts) {
				out['tsconfig.json'] = json({
					compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, verbatimModuleSyntax: true, types: ['vite/client', 'svelte'] },
					include: ['src'],
				});
			}
		}
	}

	out['README.md'] = readme(doc);
	out['.gitignore'] = 'node_modules\ndist\n';
	return out;
}

/** A Next.js App Router project; React formats only. Each page becomes a route. */
export function nextFiles(doc: IRDocument, assets: Map<string, RawAsset>, opts: StarterOptions): Record<string, string | Uint8Array> {
	const { framework, styling } = formatParts(opts.format);
	if (framework !== 'react') throw new Error('Next.js projects need a React format.');
	const tailwind = styling === 'tailwind';
	const ts = opts.typescript === true;
	const x = ts ? 'tsx' : 'jsx';
	const paths = pathsFor('next');
	const out: Record<string, string | Uint8Array> = {};
	const files = opts.files ?? generate(doc, { ...opts, assets, assetMode: 'files', tailwindCdn: false, layout: 'next' });
	for (const f of files) if (f.path) out[f.path] = f.content;
	for (const a of assets.values()) out[`public/assets/${a.name}`] = a.bytes;

	const typeImports = ts ? "import type { Metadata } from 'next';\nimport type { ReactNode } from 'react';\n" : '';
	out[`app/layout.${x}`] = `${typeImports}import './globals.css';\n\nexport const metadata${ts ? ': Metadata' : ''} = {\n  title: ${JSON.stringify(doc.title)},\n};\n\nexport default function RootLayout({ children }${ts ? ': { children: ReactNode }' : ''}) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`;

	doc.pages.forEach((p, i) => {
		const name = componentName(doc, i);
		const dir = p.slug === 'index' ? 'app/' : `app/${p.slug}/`;
		const depth = dir.split('/').filter(Boolean).length;
		const from = `${'../'.repeat(depth)}${paths.pages}${name}`;
		out[`${dir}page.${x}`] = `import ${name} from '${from}';\n\nexport const metadata = { title: ${JSON.stringify(p.title)} };\n\nexport default function Page() {\n  return <${name} />;\n}\n`;
	});

	out['next.config.mjs'] = `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`;
	if (tailwind) out['postcss.config.mjs'] = `export default {\n  plugins: {\n    '@tailwindcss/postcss': {},\n  },\n};\n`;
	if (ts) {
		out['tsconfig.json'] = json({
			compilerOptions: {
				target: 'ES2022',
				lib: ['dom', 'dom.iterable', 'esnext'],
				allowJs: true,
				skipLibCheck: true,
				strict: true,
				noEmit: true,
				esModuleInterop: true,
				module: 'esnext',
				moduleResolution: 'bundler',
				resolveJsonModule: true,
				isolatedModules: true,
				jsx: 'preserve',
				incremental: true,
				plugins: [{ name: 'next' }],
			},
			include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
			exclude: ['node_modules'],
		});
	}
	const devDeps = {
		...(tailwind ? pick('tailwindcss', '@tailwindcss/postcss') : {}),
		...(ts ? pick('typescript', '@types/react', '@types/react-dom', '@types/node') : {}),
	};
	out['package.json'] = packageJson(projectName(doc), pick('next', 'react', 'react-dom'), devDeps, { dev: 'next dev', build: 'next build', start: 'next start' });
	out['README.md'] = readme(doc, 'npm run dev', '.next/');
	out['.gitignore'] = 'node_modules\n.next\nout\nnext-env.d.ts\n';
	return out;
}

function pkgName(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'figma-export'
	);
}

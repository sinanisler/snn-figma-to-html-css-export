import type { Format, RawAsset } from '../shared/types';
import { fontLinkTags, googleFontsUrl } from './fonts';
import { componentName, formatParts, generate, htmlDocument } from './generate';
import type { IRDocument } from './ir';

export type StarterOptions = { format: Format; googleFonts: boolean; inlineSvg: boolean };

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
};

const pick = (...names: (keyof typeof VERSIONS)[]) => Object.fromEntries(names.map((n) => [n, VERSIONS[n]]));

function packageJson(name: string, deps: Record<string, string>, devDeps: Record<string, string>): string {
	return (
		JSON.stringify(
			{
				name,
				private: true,
				version: '0.0.0',
				type: 'module',
				scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
				dependencies: Object.keys(deps).length ? deps : undefined,
				devDependencies: devDeps,
			},
			null,
			2,
		) + '\n'
	);
}

/** Every file of a ready-to-run Vite project for the chosen format. */
export function starterFiles(doc: IRDocument, assets: Map<string, RawAsset>, opts: StarterOptions): Record<string, string | Uint8Array> {
	const { framework, styling } = formatParts(opts.format);
	const tailwind = styling === 'tailwind';
	const name = doc.pages[0]?.slug === 'index' ? pkgName(doc.title) : pkgName(doc.pages[0]?.name ?? 'site');
	const out: Record<string, string | Uint8Array> = {};
	const files = generate(doc, { ...opts, assets, assetMode: 'files', tailwindCdn: false });
	const twPlugin = tailwind ? ["import tailwindcss from '@tailwindcss/vite';"] : [];
	const twUse = tailwind ? ['tailwindcss()'] : [];
	const twDeps = tailwind ? pick('tailwindcss', '@tailwindcss/vite') : {};

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
		const ext = framework === 'react' ? 'jsx' : framework;
		const imports = pages.map((p) => `import ${p.name} from './pages/${p.name}.${ext}';`).join('\n');
		const routes = `{ ${pages.map((p) => `${JSON.stringify(p.slug)}: ${p.name}`).join(', ')} }`;
		const mount = framework === 'react' ? 'root' : 'app';
		const fontHead = fontLinkTags(opts.googleFonts ? googleFontsUrl(doc.fonts) : null);
		const entry = framework === 'react' ? 'src/main.jsx' : 'src/main.js';
		out['index.html'] = htmlDocument(doc.title, [fontHead], `<div id="${mount}"></div>\n<script type="module" src="/${entry}"></script>`);

		if (framework === 'react') {
			out['src/main.jsx'] = `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`;
			out['src/App.jsx'] = `import { useEffect, useState } from 'react';\n${imports}\n\nconst routes = ${routes};\nconst current = () => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);\n\nexport default function App() {\n  const [route, setRoute] = useState(current() ?? '');\n  useEffect(() => {\n    const onHash = () => {\n      const next = current();\n      if (next !== null) setRoute(next);\n    };\n    addEventListener('hashchange', onHash);\n    return () => removeEventListener('hashchange', onHash);\n  }, []);\n  const Page = routes[route] ?? ${pages[0].name};\n  return <Page />;\n}\n`;
			out['vite.config.js'] = ["import { defineConfig } from 'vite';", "import react from '@vitejs/plugin-react';", ...twPlugin, '', `export default defineConfig({\n  plugins: [${['react()', ...twUse].join(', ')}],\n});`, ''].join('\n');
			out['package.json'] = packageJson(name, pick('react', 'react-dom'), { ...pick('vite', '@vitejs/plugin-react'), ...twDeps });
		} else if (framework === 'vue') {
			out['src/main.js'] = `import { createApp } from 'vue';\nimport './styles.css';\nimport App from './App.vue';\n\ncreateApp(App).mount('#app');\n`;
			out['src/App.vue'] = `<script setup>\nimport { onBeforeUnmount, ref, computed } from 'vue';\n${imports}\n\nconst routes = ${routes};\nconst current = () => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);\nconst route = ref(current() ?? '');\nconst onHash = () => {\n  const next = current();\n  if (next !== null) route.value = next;\n};\naddEventListener('hashchange', onHash);\nonBeforeUnmount(() => removeEventListener('hashchange', onHash));\nconst Page = computed(() => routes[route.value] ?? ${pages[0].name});\n</script>\n\n<template>\n  <component :is="Page" />\n</template>\n`;
			out['vite.config.js'] = ["import { defineConfig } from 'vite';", "import vue from '@vitejs/plugin-vue';", ...twPlugin, '', `export default defineConfig({\n  plugins: [${['vue()', ...twUse].join(', ')}],\n});`, ''].join('\n');
			out['package.json'] = packageJson(name, pick('vue'), { ...pick('vite', '@vitejs/plugin-vue'), ...twDeps });
		} else {
			out['src/main.js'] = `import { mount } from 'svelte';\nimport './styles.css';\nimport App from './App.svelte';\n\nmount(App, { target: document.getElementById('app') });\n`;
			out['src/App.svelte'] = `<script>\n  ${imports.split('\n').join('\n  ')}\n\n  const routes = ${routes};\n  const current = () => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);\n  let route = $state(current() ?? '');\n  $effect(() => {\n    const onHash = () => {\n      const next = current();\n      if (next !== null) route = next;\n    };\n    addEventListener('hashchange', onHash);\n    return () => removeEventListener('hashchange', onHash);\n  });\n  const Page = $derived(routes[route] ?? ${pages[0].name});\n</script>\n\n<Page />\n`;
			out['vite.config.js'] = ["import { defineConfig } from 'vite';", "import { svelte } from '@sveltejs/vite-plugin-svelte';", ...twPlugin, '', `export default defineConfig({\n  plugins: [${['svelte()', ...twUse].join(', ')}],\n});`, ''].join('\n');
			out['package.json'] = packageJson(name, {}, { ...pick('vite', 'svelte', '@sveltejs/vite-plugin-svelte'), ...twDeps });
		}
	}

	out['README.md'] = `# ${doc.title}\n\nExported from Figma with SNN Design to HTML/CSS.\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n\`npm run build\` writes a static site to \`dist/\`.\n`;
	out['.gitignore'] = 'node_modules\ndist\n';
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

import { buildDocument } from '../core/build';
import { codegenSections, generate } from '../core/generate';
import { DEFAULT_SETTINGS, type Format, type MainToUi, type Settings, type UiToMain } from '../shared/types';
import { readSelection } from './read';
import { readTokens } from './tokens';

const MIN_W = 420, MAX_W = 1600, MIN_H = 360, MAX_H = 1200;

async function loadSettings(): Promise<Settings> {
	const saved = (await figma.clientStorage.getAsync('settings')) as Partial<Settings> | undefined;
	return { ...DEFAULT_SETTINGS, ...saved };
}

/** Dev Mode: show code for the inspected layer in the Inspect panel. */
function registerCodegen() {
	figma.codegen.on('generate', async ({ node, language }) => {
		const settings = await loadSettings();
		const result = await readSelection([node], () => {}, { rasterScale: settings.rasterScale, assetBytes: false });
		const doc = buildDocument(result, {
			decimals: settings.decimals,
			useVariables: settings.useVariables,
			units: settings.units,
			shareClasses: settings.shareClasses,
		});
		const files = generate(doc, {
			format: language as Format,
			assets: new Map(result.assets.map((a) => [a.id, a])),
			assetMode: 'files',
			googleFonts: false,
			inlineSvg: false,
			components: settings.components,
			typescript: settings.typescript,
			systemDark: settings.systemDarkMode,
		});
		return codegenSections(files);
	});
}

export default async function () {
	if (figma.mode === 'codegen') {
		registerCodegen();
		return;
	}

	const savedSize = (await figma.clientStorage.getAsync('size')) as { w: number; h: number } | undefined;
	const size = savedSize ?? { w: 760, h: 640 };
	const settings = await loadSettings();

	figma.showUI(__html__, { width: size.w, height: size.h, themeColors: true, title: 'SNN Design to HTML/CSS' });

	const post = (msg: MainToUi) => figma.ui.postMessage(msg);
	const sendSelection = () => {
		const sel = figma.currentPage.selection;
		post({ type: 'SELECTION', ids: sel.map((n) => n.id), names: sel.slice(0, 5).map((n) => n.name) });
	};

	post({ type: 'INIT', settings, size });
	// Drop the OpenRouter key and AI settings saved by versions that had the AI rebuild.
	void figma.clientStorage.deleteAsync('ai');
	sendSelection();
	figma.on('selectionchange', sendSelection);
	figma.on('currentpagechange', sendSelection);

	let busy = false;
	figma.ui.onmessage = async (msg: UiToMain) => {
		switch (msg.type) {
			case 'GENERATE': {
				if (busy) return;
				const selection = figma.currentPage.selection;
				if (selection.length === 0) {
					post({ type: 'ERROR', message: 'Select at least one layer to export.' });
					return;
				}
				busy = true;
				try {
					const result = await readSelection(selection, (done, total) => post({ type: 'PROGRESS', done, total }), msg.options);
					post({ type: 'RESULT', result });
				} catch (err) {
					post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
				} finally {
					busy = false;
				}
				return;
			}
			case 'TOKENS': {
				try {
					post({ type: 'TOKENS', tokens: await readTokens() });
				} catch (err) {
					post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
				}
				return;
			}
			case 'FOCUS': {
				const node = await figma.getNodeByIdAsync(msg.nodeId);
				if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
					figma.currentPage.selection = [node as SceneNode];
					figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
				}
				return;
			}
			case 'RESIZE': {
				const w = Math.round(Math.min(MAX_W, Math.max(MIN_W, msg.w)));
				const h = Math.round(Math.min(MAX_H, Math.max(MIN_H, msg.h)));
				figma.ui.resize(w, h);
				await figma.clientStorage.setAsync('size', { w, h });
				return;
			}
			case 'SAVE_SETTINGS':
				await figma.clientStorage.setAsync('settings', msg.settings);
				return;
			case 'OPEN_URL':
				if (/^https:\/\//.test(msg.url)) figma.openExternal(msg.url);
				return;
			case 'NOTIFY':
				figma.notify(msg.message);
				return;
		}
	};
}

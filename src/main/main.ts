import { DEFAULT_SETTINGS, type MainToUi, type Settings, type UiToMain } from '../shared/types';
import { readSelection } from './read';

const MIN_W = 420, MAX_W = 1600, MIN_H = 360, MAX_H = 1200;

export default async function () {
	const savedSize = (await figma.clientStorage.getAsync('size')) as { w: number; h: number } | undefined;
	const savedSettings = (await figma.clientStorage.getAsync('settings')) as Partial<Settings> | undefined;
	const size = savedSize ?? { w: 760, h: 640 };
	const settings: Settings = { ...DEFAULT_SETTINGS, ...savedSettings };

	figma.showUI(__html__, { width: size.w, height: size.h, themeColors: true, title: 'SNN Design to HTML/CSS' });

	const post = (msg: MainToUi) => figma.ui.postMessage(msg);
	const sendSelection = () => {
		const sel = figma.currentPage.selection;
		post({ type: 'SELECTION', ids: sel.map((n) => n.id), names: sel.slice(0, 5).map((n) => n.name) });
	};

	post({ type: 'INIT', settings, size });
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
					const result = await readSelection(selection, (done, total) => post({ type: 'PROGRESS', done, total }));
					post({ type: 'RESULT', result });
				} catch (err) {
					post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
				} finally {
					busy = false;
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
			case 'NOTIFY':
				figma.notify(msg.message);
				return;
		}
	};
}

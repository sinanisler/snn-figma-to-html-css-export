import './styles.css';
import { buildDocument } from '../core/build';
import { emit, type AssetMode } from '../core/emit';
import type { IRDocument, IRWarning } from '../core/ir';
import { describeWarning } from '../core/warnings';
import { DEFAULT_SETTINGS, type MainToUi, type RawAsset, type ReadResult, type Settings, type UiToMain } from '../shared/types';
import { copyText, downloadZip } from './export';
import { createViewer } from './viewer';

const ZIP_RECOMMEND_BYTES = 2_000_000;
const ZIP_RECOMMEND_COUNT = 8;

type Tab = 'full' | 'markup' | 'css';

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="shell">
	<header class="bar">
		<div class="selection" id="selection">Select a layer to export</div>
		<button class="btn primary" id="generate" disabled title="Ctrl/⌘ + Enter">Generate</button>
	</header>
	<div class="bar sub">
		<div class="tabs" role="tablist">
			<button class="tab active" data-tab="full" role="tab">HTML file</button>
			<button class="tab" data-tab="markup" role="tab">HTML</button>
			<button class="tab" data-tab="css" role="tab">CSS</button>
		</div>
		<div class="actions">
			<button class="btn" id="copy" disabled>Copy</button>
			<button class="btn" id="zip" disabled>Download .zip</button>
			<button class="icon-btn" id="settings-toggle" title="Settings" aria-label="Settings" aria-expanded="false">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>
			</button>
		</div>
	</div>
	<div class="settings" id="settings" hidden>
		<label>Decimal places
			<select id="opt-decimals"><option value="0">0 (whole px)</option><option value="1">1</option><option value="2">2</option></select>
		</label>
		<label class="check"><input type="checkbox" id="opt-vars"> Figma variables → CSS custom properties</label>
		<label class="check"><input type="checkbox" id="opt-inline"> Embed images when copying</label>
		<label class="check"><input type="checkbox" id="opt-wrap"> Wrap long lines</label>
	</div>
	<div class="banner" id="banner" hidden></div>
	<main class="editor-wrap">
		<div class="editor" id="editor"></div>
		<div class="empty" id="empty">
			<p><strong>Select a frame, then press Generate.</strong></p>
			<p>Auto Layout becomes flexbox/grid, everything else is positioned absolutely.<br>Name your layers for cleaner class names.</p>
		</div>
	</main>
	<section class="notes" id="notes" hidden>
		<button class="notes-head" id="notes-toggle" aria-expanded="false"><span id="notes-title"></span><span class="chev">▾</span></button>
		<div class="notes-body" id="notes-body" hidden></div>
	</section>
	<footer class="status" id="status">Ready</footer>
	<div class="resize" id="resize" title="Drag to resize"></div>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
	selection: $('selection'),
	generate: $<HTMLButtonElement>('generate'),
	copy: $<HTMLButtonElement>('copy'),
	zip: $<HTMLButtonElement>('zip'),
	settingsToggle: $<HTMLButtonElement>('settings-toggle'),
	settings: $('settings'),
	decimals: $<HTMLSelectElement>('opt-decimals'),
	vars: $<HTMLInputElement>('opt-vars'),
	inline: $<HTMLInputElement>('opt-inline'),
	wrap: $<HTMLInputElement>('opt-wrap'),
	banner: $('banner'),
	empty: $('empty'),
	notes: $('notes'),
	notesToggle: $<HTMLButtonElement>('notes-toggle'),
	notesTitle: $('notes-title'),
	notesBody: $('notes-body'),
	status: $('status'),
	resize: $('resize'),
};
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];
const viewer = createViewer($('editor'));

let settings: Settings = { ...DEFAULT_SETTINGS };
let result: ReadResult | null = null;
let assets = new Map<string, RawAsset>();
let doc: IRDocument | null = null;
let tab: Tab = 'full';
let selectionIds: string[] = [];
let generatedIds: string[] = [];
let focusedId: string | null = null;
let busy = false;

const send = (msg: UiToMain) => parent.postMessage({ pluginMessage: msg }, '*');

const formatBytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const assetBytes = () => [...assets.values()].reduce((sum, a) => sum + a.bytes.length, 0);

function output(mode: AssetMode) {
	return emit(doc!, assets, mode);
}

function renderViewer() {
	if (!doc) return;
	const out = output('preview');
	viewer.show(tab === 'css' ? out.css : tab === 'markup' ? out.markup : out.full, tab === 'css' ? 'css' : 'html');
}

function renderNotes(warnings: IRWarning[]) {
	if (warnings.length === 0) {
		els.notes.hidden = true;
		return;
	}
	els.notes.hidden = false;
	els.notesTitle.textContent = `Conversion notes (${warnings.length})`;
	const groups = new Map<string, IRWarning[]>();
	for (const w of warnings) groups.set(w.code, [...(groups.get(w.code) ?? []), w]);
	els.notesBody.replaceChildren(
		...[...groups.entries()].map(([code, items]) => {
			const group = document.createElement('div');
			group.className = 'note-group';
			const title = document.createElement('div');
			title.className = 'note-title';
			title.textContent = `${describeWarning(code)} (${items.length})`;
			group.appendChild(title);
			for (const w of items.slice(0, 50)) {
				const item = document.createElement('button');
				item.className = 'note-item';
				item.textContent = w.detail ? `${w.nodeName} — ${w.detail}` : w.nodeName;
				item.title = 'Select this layer in Figma';
				item.addEventListener('click', () => {
					focusedId = w.nodeId;
					send({ type: 'FOCUS', nodeId: w.nodeId });
				});
				group.appendChild(item);
			}
			if (items.length > 50) {
				const more = document.createElement('div');
				more.className = 'note-more';
				more.textContent = `…and ${items.length - 50} more`;
				group.appendChild(more);
			}
			return group;
		}),
	);
}

function renderAll() {
	if (!result) return;
	doc = buildDocument(result, { decimals: settings.decimals, useVariables: settings.useVariables });
	renderViewer();
	renderNotes(doc.warnings);
	els.empty.hidden = true;
	els.copy.disabled = false;
	els.zip.disabled = false;

	const bytes = assetBytes();
	const heavy = bytes > ZIP_RECOMMEND_BYTES || assets.size > ZIP_RECOMMEND_COUNT;
	els.zip.classList.toggle('primary', heavy);
	els.banner.hidden = !heavy;
	if (heavy) {
		els.banner.textContent = `This export includes ${assets.size} images (${formatBytes(bytes)}). Download the .zip for separate asset files — copying embeds them all as base64.`;
	}
	els.status.textContent = `${result.nodeCount} layers · ${assets.size} assets (${formatBytes(bytes)}) · read in ${result.ms} ms`;
}

let selectionNames: string[] = [];

function updateSelection(ids: string[], names: string[]) {
	selectionIds = ids;
	selectionNames = names;
	els.generate.disabled = busy || ids.length === 0;
	if (ids.length === 0) els.selection.textContent = 'Select a layer to export';
	else {
		const label = names.join(', ') + (ids.length > names.length ? ` +${ids.length - names.length}` : '');
		els.selection.textContent = `${ids.length} selected: ${label}`;
	}
	const changed = generatedIds.length > 0 && ids.join() !== generatedIds.join() && !(ids.length === 1 && ids[0] === focusedId);
	els.selection.classList.toggle('stale', changed);
	if (changed) els.selection.title = 'Selection changed since the last export — press Regenerate';
	else els.selection.removeAttribute('title');
}

function generate() {
	if (busy || selectionIds.length === 0) return;
	busy = true;
	els.generate.disabled = true;
	els.status.textContent = 'Reading layers…';
	send({ type: 'GENERATE' });
}

function applySettingsToForm() {
	els.decimals.value = String(settings.decimals);
	els.vars.checked = settings.useVariables;
	els.inline.checked = settings.inlineImages;
}

function saveSettings(rerender: boolean) {
	send({ type: 'SAVE_SETTINGS', settings });
	if (rerender) renderAll();
}

window.onmessage = (event: MessageEvent) => {
	const msg = event.data?.pluginMessage as MainToUi | undefined;
	if (!msg) return;
	switch (msg.type) {
		case 'INIT':
			settings = { ...DEFAULT_SETTINGS, ...msg.settings };
			applySettingsToForm();
			return;
		case 'SELECTION':
			updateSelection(msg.ids, msg.names);
			return;
		case 'PROGRESS':
			els.status.textContent = `Reading layers… ${msg.done} / ${msg.total}`;
			return;
		case 'RESULT':
			busy = false;
			result = msg.result;
			assets = new Map(msg.result.assets.map((a) => [a.id, a]));
			generatedIds = [...selectionIds];
			focusedId = null;
			els.generate.textContent = 'Regenerate';
			updateSelection(selectionIds, selectionNames);
			renderAll();
			return;
		case 'ERROR':
			busy = false;
			els.generate.disabled = selectionIds.length === 0;
			els.status.textContent = msg.message;
			return;
	}
};

els.generate.addEventListener('click', generate);
document.addEventListener('keydown', (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
		e.preventDefault();
		generate();
	}
});

tabs.forEach((button) =>
	button.addEventListener('click', () => {
		tab = button.dataset.tab as Tab;
		tabs.forEach((b) => b.classList.toggle('active', b === button));
		renderViewer();
	}),
);

els.copy.addEventListener('click', () => {
	if (!doc) return;
	const out = output(settings.inlineImages ? 'inline' : 'files');
	const text = tab === 'css' ? out.css : tab === 'markup' ? out.markup : out.full;
	const ok = copyText(text);
	send({
		type: 'NOTIFY',
		message: ok
			? `Copied ${tab === 'css' ? 'CSS' : 'HTML'} (${formatBytes(text.length)})`
			: 'Copy failed — select the code and press Ctrl/⌘ + C',
	});
});

els.zip.addEventListener('click', () => {
	if (!doc || !result) return;
	const out = output('files');
	const base =
		(result.roots[0]?.name ?? 'export')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'export';
	downloadZip(`${base}.zip`, { html: out.full, css: out.css, assets: [...assets.values()] });
	send({ type: 'NOTIFY', message: `Downloaded ${base}.zip` });
});

els.settingsToggle.addEventListener('click', () => {
	els.settings.hidden = !els.settings.hidden;
	els.settingsToggle.setAttribute('aria-expanded', String(!els.settings.hidden));
});
els.decimals.addEventListener('change', () => {
	settings = { ...settings, decimals: Number(els.decimals.value) as Settings['decimals'] };
	saveSettings(true);
});
els.vars.addEventListener('change', () => {
	settings = { ...settings, useVariables: els.vars.checked };
	saveSettings(true);
});
els.inline.addEventListener('change', () => {
	settings = { ...settings, inlineImages: els.inline.checked };
	saveSettings(false);
});
els.wrap.addEventListener('change', () => viewer.setWrap(els.wrap.checked));

els.notesToggle.addEventListener('click', () => {
	els.notesBody.hidden = !els.notesBody.hidden;
	els.notesToggle.setAttribute('aria-expanded', String(!els.notesBody.hidden));
	els.notes.classList.toggle('open', !els.notesBody.hidden);
});

els.resize.addEventListener('pointerdown', (e) => {
	const startX = e.clientX;
	const startY = e.clientY;
	const startW = window.innerWidth;
	const startH = window.innerHeight;
	let frame = 0;
	els.resize.setPointerCapture(e.pointerId);
	const move = (ev: PointerEvent) => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() =>
			send({ type: 'RESIZE', w: startW + ev.clientX - startX, h: startH + ev.clientY - startY }),
		);
	};
	const up = () => {
		els.resize.removeEventListener('pointermove', move);
		els.resize.removeEventListener('pointerup', up);
	};
	els.resize.addEventListener('pointermove', move);
	els.resize.addEventListener('pointerup', up);
});

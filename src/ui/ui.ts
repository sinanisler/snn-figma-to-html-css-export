import './styles.css';
import { buildDocument } from '../core/build';
import type { AssetMode } from '../core/emit';
import { cssSlug } from '../core/format';
import { formatParts, FORMAT_LABELS, generate, previewDocument, type OutFile } from '../core/generate';
import type { IRDocument, IRWarning } from '../core/ir';
import { starterFiles } from '../core/starter';
import { tokensToCss, tokensToJson } from '../core/tokens';
import { describeWarning } from '../core/warnings';
import {
	DEFAULT_SETTINGS,
	type Format,
	type MainToUi,
	type RawAsset,
	type ReadResult,
	type Settings,
	type TokensResult,
	type UiToMain,
} from '../shared/types';
import { copyText, downloadZip } from './export';
import { createViewer } from './viewer';

const ZIP_RECOMMEND_BYTES = 2_000_000;
const ZIP_RECOMMEND_COUNT = 8;
const PREVIEW = 'Preview';
const DEVICES = [
	{ label: 'Fit', width: 0 },
	{ label: '1440', width: 1440 },
	{ label: '768', width: 768 },
	{ label: '375', width: 375 },
];

const formatOptions = (Object.keys(FORMAT_LABELS) as Format[])
	.map((f) => `<option value="${f}">${FORMAT_LABELS[f]}</option>`)
	.join('');

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="shell">
	<header class="bar">
		<div class="selection" id="selection">Select a layer to export</div>
		<select class="format" id="format" title="Output format" aria-label="Output format">${formatOptions}</select>
		<button class="btn primary" id="generate" disabled title="Ctrl/⌘ + Enter">Generate</button>
	</header>
	<div class="bar sub">
		<div class="tabs" id="tabs" role="tablist"></div>
		<div class="actions">
			<select class="page" id="page" title="Page" aria-label="Page" hidden></select>
			<div class="devices" id="devices" hidden>${DEVICES.map((d) => `<button data-width="${d.width}" title="${d.width ? `${d.width}px wide` : 'Fit the panel'}">${d.label}</button>`).join('')}</div>
			<button class="btn" id="copy" disabled>Copy</button>
			<div class="menu-wrap">
				<button class="btn" id="download" aria-haspopup="true" aria-expanded="false">Download ▾</button>
				<div class="menu" id="menu" hidden>
					<button data-dl="zip" disabled>Files (.zip)<small>Pages, stylesheet and assets</small></button>
					<button data-dl="starter" disabled>Starter project<small>Vite project — npm install &amp;&amp; npm run dev</small></button>
					<button data-dl="tokens">Design tokens<small>All local variables and styles (.css + .json)</small></button>
				</div>
			</div>
			<button class="icon-btn" id="settings-toggle" title="Settings" aria-label="Settings" aria-expanded="false">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>
			</button>
		</div>
	</div>
	<div class="settings" id="settings" hidden>
		<label>Units
			<select id="opt-units"><option value="px">px</option><option value="rem">rem</option></select>
		</label>
		<label>Decimals
			<select id="opt-decimals"><option value="0">0</option><option value="1">1</option><option value="2">2</option></select>
		</label>
		<label title="Resolution of layers exported as PNG (masks, unsupported layers). Applies on the next Generate.">Raster
			<select id="opt-scale"><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select>
		</label>
		<label class="check"><input type="checkbox" id="opt-vars"> Variables → CSS custom properties</label>
		<label class="check" title="Components and text styles share one class; identical styles reuse a class"><input type="checkbox" id="opt-share"> Shared classes</label>
		<label class="check"><input type="checkbox" id="opt-fonts"> Google Fonts link</label>
		<label class="check"><input type="checkbox" id="opt-svg"> Inline SVG</label>
		<label class="check"><input type="checkbox" id="opt-inline"> Embed images when copying</label>
		<label class="check"><input type="checkbox" id="opt-wrap"> Wrap lines</label>
	</div>
	<div class="banner" id="banner" hidden></div>
	<main class="editor-wrap">
		<div class="editor" id="editor"></div>
		<div class="preview" id="preview" hidden><iframe id="preview-frame" title="Preview" sandbox="allow-scripts"></iframe></div>
		<div class="empty" id="empty">
			<p><strong>Select a frame, then press Generate.</strong></p>
			<p>Select several top-level frames for a multi-page site.<br>Name them “Home / Desktop”, “Home / Mobile” to merge breakpoints.</p>
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
	format: $<HTMLSelectElement>('format'),
	generate: $<HTMLButtonElement>('generate'),
	tabs: $('tabs'),
	page: $<HTMLSelectElement>('page'),
	devices: $('devices'),
	copy: $<HTMLButtonElement>('copy'),
	download: $<HTMLButtonElement>('download'),
	menu: $('menu'),
	settingsToggle: $<HTMLButtonElement>('settings-toggle'),
	settings: $('settings'),
	units: $<HTMLSelectElement>('opt-units'),
	decimals: $<HTMLSelectElement>('opt-decimals'),
	scale: $<HTMLSelectElement>('opt-scale'),
	vars: $<HTMLInputElement>('opt-vars'),
	share: $<HTMLInputElement>('opt-share'),
	fonts: $<HTMLInputElement>('opt-fonts'),
	svg: $<HTMLInputElement>('opt-svg'),
	inline: $<HTMLInputElement>('opt-inline'),
	wrap: $<HTMLInputElement>('opt-wrap'),
	banner: $('banner'),
	editor: $('editor'),
	preview: $('preview'),
	frame: $<HTMLIFrameElement>('preview-frame'),
	empty: $('empty'),
	notes: $('notes'),
	notesToggle: $<HTMLButtonElement>('notes-toggle'),
	notesTitle: $('notes-title'),
	notesBody: $('notes-body'),
	status: $('status'),
	resize: $('resize'),
};
const viewer = createViewer(els.editor);

let settings: Settings = { ...DEFAULT_SETTINGS };
let result: ReadResult | null = null;
let assets = new Map<string, RawAsset>();
let doc: IRDocument | null = null;
let files: OutFile[] = [];
let tab = '';
let page = 0;
let deviceWidth = 0;
let previewKey = '';
let selectionIds: string[] = [];
let selectionNames: string[] = [];
let generatedIds: string[] = [];
let focusedId: string | null = null;
let busy = false;

const send = (msg: UiToMain) => parent.postMessage({ pluginMessage: msg }, '*');
const notify = (message: string) => send({ type: 'NOTIFY', message });

const formatBytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const assetBytes = () => [...assets.values()].reduce((sum, a) => sum + a.bytes.length, 0);

const baseName = () => cssSlug(result?.roots[0]?.name ?? 'export', 'export');

function output(mode: AssetMode): OutFile[] {
	return generate(doc!, {
		format: settings.format,
		assets,
		assetMode: mode,
		googleFonts: settings.googleFonts,
		inlineSvg: settings.inlineSvg,
	});
}

const pageFiles = (list: OutFile[]) => list.filter((f) => f.page === page || f.page === null);

function renderTabs() {
	const labels = [PREVIEW, ...pageFiles(files).map((f) => f.label)];
	if (!labels.includes(tab)) tab = labels[1] ?? PREVIEW;
	els.tabs.replaceChildren(
		...labels.map((label) => {
			const b = document.createElement('button');
			b.className = `tab${label === tab ? ' active' : ''}`;
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', String(label === tab));
			b.textContent = label;
			b.addEventListener('click', () => {
				tab = label;
				renderTabs();
				renderView();
			});
			return b;
		}),
	);
}

function renderPages() {
	if (!doc) return;
	els.page.hidden = doc.pages.length < 2;
	els.page.replaceChildren(
		...doc.pages.map((p, i) => {
			const o = document.createElement('option');
			o.value = String(i);
			o.textContent = p.slug === 'index' ? `${p.name} (index)` : p.name;
			return o;
		}),
	);
	els.page.value = String(page);
}

function renderDevices() {
	for (const b of els.devices.querySelectorAll<HTMLButtonElement>('button'))
		b.classList.toggle('active', Number(b.dataset.width) === deviceWidth);
	els.frame.style.width = deviceWidth ? `${deviceWidth}px` : '100%';
}

function renderView() {
	if (!doc) return;
	const isPreview = tab === PREVIEW;
	els.preview.hidden = !isPreview;
	els.editor.hidden = isPreview;
	els.devices.hidden = !isPreview;
	if (isPreview) {
		const key = `${page}|${settings.inlineSvg}|${files.length}|${doc.title}|${JSON.stringify(settings)}`;
		if (key !== previewKey) {
			previewKey = key;
			els.frame.srcdoc = previewDocument(doc, page, assets, settings.inlineSvg);
		}
		renderDevices();
		return;
	}
	const file = pageFiles(files).find((f) => f.label === tab);
	if (file) viewer.show(file.content, file.lang);
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

function setMenuState() {
	for (const b of els.menu.querySelectorAll<HTMLButtonElement>('button[data-dl]')) {
		if (b.dataset.dl === 'tokens') continue;
		b.disabled = !doc || (b.dataset.dl === 'starter' && settings.format === 'email');
	}
}

function renderAll() {
	if (!result) return;
	doc = buildDocument(result, {
		decimals: settings.decimals,
		useVariables: settings.useVariables,
		units: settings.units,
		shareClasses: settings.shareClasses,
	});
	page = Math.min(page, doc.pages.length - 1);
	files = output('preview');
	renderPages();
	renderTabs();
	renderView();
	renderNotes(doc.warnings);
	setMenuState();
	els.empty.hidden = true;
	els.copy.disabled = false;

	const bytes = assetBytes();
	const heavy = settings.inlineImages && (bytes > ZIP_RECOMMEND_BYTES || assets.size > ZIP_RECOMMEND_COUNT);
	els.download.classList.toggle('primary', heavy);
	els.banner.hidden = !heavy;
	if (heavy) {
		els.banner.textContent = `This export includes ${assets.size} images (${formatBytes(bytes)}). Download the .zip for separate asset files — copying embeds them all as base64.`;
	}
	const pages = doc.pages.length > 1 ? ` · ${doc.pages.length} pages` : '';
	const breakpoints = doc.media.length ? ` · ${doc.media.length} breakpoints` : '';
	els.status.textContent = `${result.nodeCount} layers${pages}${breakpoints} · ${assets.size} assets (${formatBytes(bytes)}) · read in ${result.ms} ms`;
}

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

function generateNow() {
	if (busy || selectionIds.length === 0) return;
	busy = true;
	els.generate.disabled = true;
	els.status.textContent = 'Reading layers…';
	send({ type: 'GENERATE', options: { rasterScale: settings.rasterScale, assetBytes: true } });
}

function applySettingsToForm() {
	els.format.value = settings.format;
	els.units.value = settings.units;
	els.decimals.value = String(settings.decimals);
	els.scale.value = String(settings.rasterScale);
	els.vars.checked = settings.useVariables;
	els.share.checked = settings.shareClasses;
	els.fonts.checked = settings.googleFonts;
	els.svg.checked = settings.inlineSvg;
	els.inline.checked = settings.inlineImages;
}

function update(patch: Partial<Settings>, rerender = true) {
	settings = { ...settings, ...patch };
	send({ type: 'SAVE_SETTINGS', settings });
	if (rerender) renderAll();
	setMenuState();
}

function downloadTokens(tokens: TokensResult) {
	const count =
		tokens.collections.reduce((n, c) => n + c.variables.length, 0) +
		tokens.paintStyles.length +
		tokens.textStyles.length +
		tokens.effectStyles.length;
	if (count === 0) {
		notify('This file has no local variables or styles');
		return;
	}
	downloadZip('design-tokens.zip', {
		'tokens.css': tokensToCss(tokens, { units: settings.units, decimals: settings.decimals }),
		'tokens.json': tokensToJson(tokens),
	});
	notify(`Downloaded design-tokens.zip (${count} tokens)`);
}

window.addEventListener('message', (event: MessageEvent) => {
	const nav = event.data?.previewNav as string | undefined;
	if (nav && doc) {
		const slug = nav.replace(/^\.?\//, '').split(/[#?]/)[0].replace(/\.html$/, '') || 'index';
		const index = doc.pages.findIndex((p) => p.slug === slug);
		if (index >= 0) {
			page = index;
			renderAll();
		} else if (/^https?:/.test(nav)) notify(`Link: ${nav}`);
		return;
	}
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
			previewKey = '';
			page = 0;
			els.generate.textContent = 'Regenerate';
			updateSelection(selectionIds, selectionNames);
			renderAll();
			return;
		case 'TOKENS':
			downloadTokens(msg.tokens);
			return;
		case 'ERROR':
			busy = false;
			els.generate.disabled = selectionIds.length === 0;
			els.status.textContent = msg.message;
			return;
	}
});

els.generate.addEventListener('click', generateNow);
document.addEventListener('keydown', (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
		e.preventDefault();
		generateNow();
	}
	if (e.key === 'Escape') closeMenu();
});

els.format.addEventListener('change', () => update({ format: els.format.value as Format }));
els.page.addEventListener('change', () => {
	page = Number(els.page.value);
	renderTabs();
	renderView();
});
els.devices.addEventListener('click', (e) => {
	const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-width]');
	if (!b) return;
	deviceWidth = Number(b.dataset.width);
	renderDevices();
});

els.copy.addEventListener('click', () => {
	if (!doc) return;
	const list = pageFiles(output(settings.inlineImages ? 'inline' : 'files'));
	const file = list.find((f) => f.label === tab) ?? list[0];
	if (!file) return;
	const ok = copyText(file.content);
	notify(ok ? `Copied ${file.label} (${formatBytes(file.content.length)})` : 'Copy failed — select the code and press Ctrl/⌘ + C');
});

function closeMenu() {
	els.menu.hidden = true;
	els.download.setAttribute('aria-expanded', 'false');
}

els.download.addEventListener('click', (e) => {
	e.stopPropagation();
	els.menu.hidden = !els.menu.hidden;
	els.download.setAttribute('aria-expanded', String(!els.menu.hidden));
});
document.addEventListener('click', (e) => {
	if (!els.menu.hidden && !els.menu.contains(e.target as Node)) closeMenu();
});

els.menu.addEventListener('click', (e) => {
	const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-dl]');
	if (!b || b.disabled) return;
	closeMenu();
	const kind = b.dataset.dl;
	if (kind === 'tokens') {
		els.status.textContent = 'Reading variables and styles…';
		send({ type: 'TOKENS' });
		return;
	}
	if (!doc || !result) return;
	if (kind === 'zip') {
		const entries: Record<string, string | Uint8Array> = {};
		for (const f of output('files')) if (f.path) entries[f.path] = f.content;
		const dir = formatParts(settings.format).framework === 'html' || settings.format === 'email' ? 'assets' : 'public/assets';
		for (const a of assets.values()) entries[`${dir}/${a.name}`] = a.bytes;
		downloadZip(`${baseName()}.zip`, entries);
		notify(`Downloaded ${baseName()}.zip`);
	} else if (kind === 'starter') {
		const entries = starterFiles(doc, assets, { format: settings.format, googleFonts: settings.googleFonts, inlineSvg: settings.inlineSvg });
		downloadZip(`${baseName()}-starter.zip`, entries);
		notify(`Downloaded ${baseName()}-starter.zip — run npm install && npm run dev`);
	}
});

els.settingsToggle.addEventListener('click', () => {
	els.settings.hidden = !els.settings.hidden;
	els.settingsToggle.setAttribute('aria-expanded', String(!els.settings.hidden));
});
els.units.addEventListener('change', () => update({ units: els.units.value as Settings['units'] }));
els.decimals.addEventListener('change', () => update({ decimals: Number(els.decimals.value) as Settings['decimals'] }));
els.scale.addEventListener('change', () => {
	update({ rasterScale: Number(els.scale.value) as Settings['rasterScale'] }, false);
	if (result) els.status.textContent = 'Raster scale applies on the next Generate';
});
els.vars.addEventListener('change', () => update({ useVariables: els.vars.checked }));
els.share.addEventListener('change', () => update({ shareClasses: els.share.checked }));
els.fonts.addEventListener('change', () => update({ googleFonts: els.fonts.checked }));
els.svg.addEventListener('change', () => update({ inlineSvg: els.svg.checked }));
els.inline.addEventListener('change', () => update({ inlineImages: els.inline.checked }));
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

import './styles.css';
import { aiFiles, assemblePages, planPages, type PagePlan, type SectionResult } from '../core/ai';
import { buildDocument } from '../core/build';
import { checkDesign, type DesignCheck } from '../core/check';
import { toBase64, type AssetMode, type Styling } from '../core/emit';
import { cssSlug } from '../core/format';
import {
	formatParts,
	FORMAT_LABELS,
	generate,
	previewDocument,
	withPreviewScript,
	type Layout,
	type OutFile,
} from '../core/generate';
import type { IRDocument, IRWarning } from '../core/ir';
import { nextFiles, starterFiles } from '../core/starter';
import { tokensToCss, tokensToJson } from '../core/tokens';
import { describeWarning } from '../core/warnings';
import {
	DEFAULT_AI_SETTINGS,
	DEFAULT_SETTINGS,
	type AiSettings,
	type Format,
	type MainToUi,
	type RawAsset,
	type ReadResult,
	type Settings,
	type TokensResult,
	type UiToMain,
} from '../shared/types';
import { initialState, runSections, type SectionState } from './ai-run';
import { copyText, downloadZip } from './export';
import { checkKey, listModels } from './openrouter';
import { createViewer } from './viewer';

const ZIP_RECOMMEND_BYTES = 2_000_000;
const ZIP_RECOMMEND_COUNT = 8;
const COVERAGE_WARNING = 0.8;
const SCREENSHOT_WIDTH = 1024;
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

const SPARKLE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.3 3.6L13 6.5 9.3 7.9 8 11.5 6.7 7.9 3 6.5l3.7-1.4zM12.5 10.5l.6 1.5 1.4.5-1.4.6-.6 1.4-.5-1.4-1.5-.6 1.5-.5z"/></svg>';

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="shell">
	<header class="bar">
		<div class="selection" id="selection">Select a layer to export</div>
		<select class="format" id="format" title="Output format" aria-label="Output format">${formatOptions}</select>
		<button class="btn primary" id="generate" disabled title="Ctrl/⌘ + Enter">Generate</button>
		<button class="btn ai" id="ai-generate" disabled title="Rebuild the page section by section with an AI model (OpenRouter)">${SPARKLE}<span>AI</span></button>
	</header>
	<div class="bar sub">
		<div class="tabs" id="tabs" role="tablist"></div>
		<div class="actions">
			<div class="seg" id="source" hidden role="group" aria-label="Output source">
				<button data-src="standard" title="Direct conversion of the design">Standard</button>
				<button data-src="ai" title="AI rebuild, section by section">AI</button>
			</div>
			<select class="page" id="page" title="Page" aria-label="Page" hidden></select>
			<select class="theme" id="theme" title="Variable mode shown in the preview" aria-label="Theme" hidden></select>
			<div class="devices" id="devices" hidden>${DEVICES.map((d) => `<button data-width="${d.width}" title="${d.width ? `${d.width}px wide` : 'Fit the panel'}">${d.label}</button>`).join('')}</div>
			<button class="btn" id="copy" disabled>Copy</button>
			<div class="menu-wrap">
				<button class="btn" id="download" aria-haspopup="true" aria-expanded="false">Download ▾</button>
				<div class="menu" id="menu" hidden>
					<button data-dl="zip" disabled>Files (.zip)<small>Pages, stylesheet and assets</small></button>
					<button data-dl="starter" disabled>Vite project<small>npm install &amp;&amp; npm run dev</small></button>
					<button data-dl="next" disabled>Next.js project<small>React formats — npm install &amp;&amp; npm run dev</small></button>
					<button data-dl="tokens">Design tokens<small>All local variables and styles (.css + .json)</small></button>
				</div>
			</div>
			<button class="icon-btn" id="ai-toggle" title="AI settings" aria-label="AI settings" aria-expanded="false">${SPARKLE}</button>
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
		<label class="check" title="A variable mode named “Dark” applies when the visitor's system is in dark mode"><input type="checkbox" id="opt-dark"> Dark mode follows system</label>
		<label class="check" title="Components and text styles share one class; identical styles reuse a class"><input type="checkbox" id="opt-share"> Shared classes</label>
		<label class="check" title="React, Vue and Svelte: Figma components become component files with props"><input type="checkbox" id="opt-components"> Components</label>
		<label class="check" title="React, Vue and Svelte"><input type="checkbox" id="opt-ts"> TypeScript</label>
		<label class="check"><input type="checkbox" id="opt-fonts"> Google Fonts link</label>
		<label class="check"><input type="checkbox" id="opt-svg"> Inline SVG</label>
		<label class="check"><input type="checkbox" id="opt-inline"> Embed images when copying</label>
		<label class="check"><input type="checkbox" id="opt-wrap"> Wrap lines</label>
	</div>
	<div class="ai-panel" id="ai-panel" hidden>
		<p class="ai-intro"><strong>Why AI?</strong> Figma is a free canvas: every layer that isn't inside Auto Layout sits at an absolute position. The standard export reproduces the design faithfully, so it keeps those fixed sizes and positions. For cleaner, responsive code, an AI model can rebuild the page <em>section by section</em> — small pieces it can get right, instead of one huge page it can't.</p>
		<div class="ai-grid">
			<label class="wide">OpenRouter API key
				<span class="row">
					<input type="password" id="ai-key" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false">
					<button class="btn" id="ai-key-show" type="button">Show</button>
					<button class="btn" id="ai-key-check" type="button">Check</button>
				</span>
				<small id="ai-key-status"><a href="#" data-url="https://openrouter.ai/keys">Get a key</a> · Saved only in this Figma app on this computer.</small>
			</label>
			<label class="wide">Model
				<input id="ai-model" list="ai-models" spellcheck="false" autocomplete="off">
				<datalist id="ai-models"></datalist>
				<small>Any OpenRouter model id. Default: ~deepseek/deepseek-pro-latest · <a href="#" data-url="https://openrouter.ai/models">Browse models</a></small>
			</label>
			<label>Reasoning
				<select id="ai-reasoning">
					<option value="default">Model default</option>
					<option value="off">Off</option>
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
				</select>
			</label>
			<label>Sections at once
				<select id="ai-parallel"><option>1</option><option>2</option><option>3</option><option>4</option></select>
			</label>
			<label class="check" title="Adds a screenshot of each section to the prompt. Only for models that accept images."><input type="checkbox" id="ai-shots"> Send screenshots (vision models)</label>
			<label class="wide">Extra instructions
				<textarea id="ai-instructions" rows="2" placeholder="e.g. Use a 1200px max-width container. Use BEM class names."></textarea>
			</label>
		</div>
		<p class="ai-privacy">Optional. Your key is sent only to openrouter.ai. Each section's generated HTML and CSS (and screenshots, if enabled) go to OpenRouter and the model provider you pick; usage is billed to your OpenRouter account.</p>
	</div>
	<div class="banner" id="banner" hidden></div>
	<main class="editor-wrap">
		<div class="editor" id="editor"></div>
		<div class="preview" id="preview" hidden><iframe id="preview-frame" title="Preview" sandbox="allow-scripts"></iframe></div>
		<div class="empty" id="empty">
			<p><strong>Select a frame, then press Generate.</strong></p>
			<p>Select several top-level frames for a multi-page site.<br>Name them “Home / Desktop”, “Home / Mobile” to merge breakpoints.</p>
			<p class="hint">No Auto Layout in your design? Layers will be positioned absolutely — use <strong>AI</strong> to rebuild it as responsive code.</p>
		</div>
	</main>
	<section class="ai-run" id="ai-run" hidden>
		<div class="ai-run-head">
			<button class="notes-head" id="ai-run-toggle" aria-expanded="true"><span id="ai-run-title">AI</span><span class="chev">▾</span></button>
			<button class="btn small" id="ai-cancel" hidden>Cancel</button>
			<button class="btn small" id="ai-regen">Regenerate all</button>
		</div>
		<div class="ai-run-body" id="ai-run-body"></div>
	</section>
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
	aiGenerate: $<HTMLButtonElement>('ai-generate'),
	tabs: $('tabs'),
	source: $('source'),
	page: $<HTMLSelectElement>('page'),
	theme: $<HTMLSelectElement>('theme'),
	devices: $('devices'),
	copy: $<HTMLButtonElement>('copy'),
	download: $<HTMLButtonElement>('download'),
	menu: $('menu'),
	aiToggle: $<HTMLButtonElement>('ai-toggle'),
	settingsToggle: $<HTMLButtonElement>('settings-toggle'),
	settings: $('settings'),
	units: $<HTMLSelectElement>('opt-units'),
	decimals: $<HTMLSelectElement>('opt-decimals'),
	scale: $<HTMLSelectElement>('opt-scale'),
	vars: $<HTMLInputElement>('opt-vars'),
	dark: $<HTMLInputElement>('opt-dark'),
	share: $<HTMLInputElement>('opt-share'),
	components: $<HTMLInputElement>('opt-components'),
	ts: $<HTMLInputElement>('opt-ts'),
	fonts: $<HTMLInputElement>('opt-fonts'),
	svg: $<HTMLInputElement>('opt-svg'),
	inline: $<HTMLInputElement>('opt-inline'),
	wrap: $<HTMLInputElement>('opt-wrap'),
	aiPanel: $('ai-panel'),
	aiKey: $<HTMLInputElement>('ai-key'),
	aiKeyShow: $<HTMLButtonElement>('ai-key-show'),
	aiKeyCheck: $<HTMLButtonElement>('ai-key-check'),
	aiKeyStatus: $('ai-key-status'),
	aiModel: $<HTMLInputElement>('ai-model'),
	aiModels: $('ai-models'),
	aiReasoning: $<HTMLSelectElement>('ai-reasoning'),
	aiParallel: $<HTMLSelectElement>('ai-parallel'),
	aiShots: $<HTMLInputElement>('ai-shots'),
	aiInstructions: $<HTMLTextAreaElement>('ai-instructions'),
	banner: $('banner'),
	editor: $('editor'),
	preview: $('preview'),
	frame: $<HTMLIFrameElement>('preview-frame'),
	empty: $('empty'),
	aiRun: $('ai-run'),
	aiRunToggle: $<HTMLButtonElement>('ai-run-toggle'),
	aiRunTitle: $('ai-run-title'),
	aiRunBody: $('ai-run-body'),
	aiCancel: $<HTMLButtonElement>('ai-cancel'),
	aiRegen: $<HTMLButtonElement>('ai-regen'),
	notes: $('notes'),
	notesToggle: $<HTMLButtonElement>('notes-toggle'),
	notesTitle: $('notes-title'),
	notesBody: $('notes-body'),
	status: $('status'),
	resize: $('resize'),
};
const viewer = createViewer(els.editor);

let settings: Settings = { ...DEFAULT_SETTINGS };
let ai: AiSettings = { ...DEFAULT_AI_SETTINGS };
let result: ReadResult | null = null;
let assets = new Map<string, RawAsset>();
let doc: IRDocument | null = null;
let check: DesignCheck | null = null;
let files: OutFile[] = [];
let tab = '';
let page = 0;
let deviceWidth = 0;
let theme = '';
let previewKey = '';
let selectionIds: string[] = [];
let selectionNames: string[] = [];
let generatedIds: string[] = [];
let focusedId: string | null = null;
let busy = false;

// AI state: results survive rebuilds (keys are Figma layer ids) until the selection or styling changes.
let source: 'standard' | 'ai' = 'standard';
let aiPlans: PagePlan[] | null = null;
let aiResults = new Map<string, SectionResult>();
let aiStates = new Map<string, SectionState>();
let aiStyling: Styling | null = null;
let aiController: AbortController | null = null;
let aiVersion = 0;
let aiAfterGenerate = false;

const send = (msg: UiToMain) => parent.postMessage({ pluginMessage: msg }, '*');
const notify = (message: string) => send({ type: 'NOTIFY', message });

const formatBytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const formatCount = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

const assetBytes = () => [...assets.values()].reduce((sum, a) => sum + a.bytes.length, 0);

const baseName = () => cssSlug(result?.roots[0]?.name ?? 'export', 'export');

const useAi = () => source === 'ai' && aiPlans !== null && settings.format !== 'email';

function output(mode: AssetMode, layout: Layout = 'vite'): OutFile[] {
	const opts = {
		format: settings.format,
		assets,
		assetMode: mode,
		googleFonts: settings.googleFonts,
		inlineSvg: settings.inlineSvg,
		components: settings.components,
		typescript: settings.typescript,
		systemDark: settings.systemDarkMode,
		layout,
	};
	if (useAi()) return aiFiles(doc!, assemblePages({ doc: doc!, plans: aiPlans!, results: aiResults, assets, styling: aiStyling ?? 'css' }), opts);
	return generate(doc!, opts);
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

/** Variable modes that differ from the design's own values, as data-attribute choices for the preview. */
function themeChoices(): { attr: string; mode: string; label: string }[] {
	if (!doc) return [];
	const moded = doc.variables.filter((v) => v.modes?.length);
	const collections = new Set(moded.map((v) => v.collection ?? ''));
	const seen = new Map<string, { attr: string; mode: string; label: string }>();
	for (const v of moded) {
		const attr = collections.size > 1 ? `data-${cssSlug(v.collection ?? '', 'theme')}` : 'data-theme';
		for (const m of v.modes!) {
			const key = `${attr}|${cssSlug(m.mode, 'mode')}`;
			if (!seen.has(key)) seen.set(key, { attr, mode: cssSlug(m.mode, 'mode'), label: collections.size > 1 ? `${v.collection}: ${m.mode}` : m.mode });
		}
	}
	return [...seen.values()];
}

function renderThemes() {
	const choices = themeChoices();
	els.theme.replaceChildren(
		new Option('Design', ''),
		...choices.map((c) => new Option(c.label, `${c.attr}|${c.mode}`)),
	);
	if (![...els.theme.options].some((o) => o.value === theme)) theme = '';
	els.theme.value = theme;
	els.theme.dataset.available = String(choices.length > 0);
}

function applyTheme() {
	const [attr, mode] = theme ? theme.split('|') : ['data-theme', ''];
	els.frame.contentWindow?.postMessage({ theme: mode, attr }, '*');
}

function renderDevices() {
	for (const b of els.devices.querySelectorAll<HTMLButtonElement>('button'))
		b.classList.toggle('active', Number(b.dataset.width) === deviceWidth);
	els.frame.style.width = deviceWidth ? `${deviceWidth}px` : '100%';
}

function previewHtml(): string {
	if (!doc) return '';
	if (useAi()) {
		const aiDoc = aiFiles(doc, assemblePages({ doc, plans: aiPlans!, results: aiResults, assets, styling: aiStyling ?? 'css' }), {
			format: aiStyling === 'tailwind' ? 'tailwind' : 'html',
			assets,
			assetMode: 'inline',
			googleFonts: true,
			inlineSvg: settings.inlineSvg,
			systemDark: settings.systemDarkMode,
		});
		return withPreviewScript(aiDoc.find((f) => f.page === page && f.document)?.content ?? '');
	}
	return previewDocument(doc, page, assets, settings.inlineSvg, settings.systemDarkMode);
}

function renderView() {
	if (!doc) return;
	const isPreview = tab === PREVIEW;
	els.preview.hidden = !isPreview;
	els.editor.hidden = isPreview;
	els.devices.hidden = !isPreview;
	els.theme.hidden = !isPreview || els.theme.dataset.available !== 'true';
	if (isPreview) {
		const key = `${page}|${source}|${aiVersion}|${files.length}|${doc.title}|${JSON.stringify(settings)}`;
		if (key !== previewKey) {
			previewKey = key;
			els.frame.srcdoc = previewHtml();
		}
		renderDevices();
		return;
	}
	const file = pageFiles(files).find((f) => f.label === tab);
	if (file) viewer.show(file.content, file.lang);
}

function aiWarnings(): IRWarning[] {
	if (source !== 'ai') return [];
	const out: IRWarning[] = [];
	for (const s of aiStates.values()) {
		const nodeId = s.layerIds[0] ?? '';
		if (s.status === 'failed') out.push({ nodeId, nodeName: s.label, code: 'AI_SECTION_FAILED', detail: s.error });
		else if (s.status === 'done' && s.coverage !== undefined && s.coverage < COVERAGE_WARNING)
			out.push({ nodeId, nodeName: s.label, code: 'AI_TEXT_CHANGED', detail: `${Math.round(s.coverage * 100)}% of words kept` });
	}
	return out;
}

function noteGroup(code: string, items: IRWarning[]): HTMLElement {
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
			if (!w.nodeId) return;
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
}

function groupsOf(warnings: IRWarning[]): HTMLElement[] {
	const groups = new Map<string, IRWarning[]>();
	for (const w of warnings) groups.set(w.code, [...(groups.get(w.code) ?? []), w]);
	return [...groups.entries()].map(([code, items]) => noteGroup(code, items));
}

function heading(text: string): HTMLElement {
	const h = document.createElement('div');
	h.className = 'note-heading';
	h.textContent = text;
	return h;
}

function renderNotes() {
	if (!doc) return;
	const conversion = doc.warnings;
	const design = check?.issues ?? [];
	const aiNotes = aiWarnings();
	const total = conversion.length + design.length + aiNotes.length;
	if (total === 0) {
		els.notes.hidden = true;
		return;
	}
	els.notes.hidden = false;
	const score = check && check.containers ? ` · Auto Layout ${check.score}%` : '';
	els.notesTitle.textContent = `Notes (${total})${score}`;
	const children: HTMLElement[] = [];
	if (aiNotes.length) children.push(heading('AI'), ...groupsOf(aiNotes));
	if (conversion.length) children.push(heading('Conversion'), ...groupsOf(conversion));
	if (design.length) children.push(heading(`Design check — ${check!.score}% of layers with children use Auto Layout`), ...groupsOf(design));
	els.notesBody.replaceChildren(...children);
}

function setMenuState() {
	const { framework } = formatParts(settings.format);
	for (const b of els.menu.querySelectorAll<HTMLButtonElement>('button[data-dl]')) {
		const kind = b.dataset.dl;
		if (kind === 'tokens') continue;
		b.disabled = !doc || (kind === 'starter' && settings.format === 'email') || (kind === 'next' && framework !== 'react');
	}
	els.aiGenerate.disabled = busy || aiController !== null || selectionIds.length === 0 || settings.format === 'email';
	els.aiGenerate.title =
		settings.format === 'email'
			? 'AI rebuild is not available for email HTML'
			: 'Rebuild the page section by section with an AI model (OpenRouter)';
}

function renderSource() {
	const available = aiPlans !== null && settings.format !== 'email';
	els.source.hidden = !available;
	if (!available && source === 'ai') source = 'standard';
	for (const b of els.source.querySelectorAll<HTMLButtonElement>('button'))
		b.classList.toggle('active', b.dataset.src === source);
}

/** Re-renders output only (after an AI section lands). */
function renderOutput() {
	if (!doc) return;
	files = output('preview');
	renderSource();
	renderTabs();
	renderView();
	renderNotes();
}

function renderAll() {
	if (!result) return;
	doc = buildDocument(result, {
		decimals: settings.decimals,
		useVariables: settings.useVariables,
		units: settings.units,
		shareClasses: settings.shareClasses,
	});
	check = checkDesign(result, doc);
	if (aiPlans) aiPlans = planPages(doc, { assets });
	page = Math.min(page, doc.pages.length - 1);
	files = output('preview');
	renderPages();
	renderThemes();
	renderSource();
	renderTabs();
	renderView();
	renderNotes();
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
	renderStatus();
}

function renderStatus() {
	if (!doc || !result) return;
	if (aiController) return renderAiRun();
	const pages = doc.pages.length > 1 ? ` · ${doc.pages.length} pages` : '';
	const breakpoints = doc.media.length ? ` · ${doc.media.length} breakpoints` : '';
	els.status.textContent = `${result.nodeCount} layers${pages}${breakpoints} · ${assets.size} assets (${formatBytes(assetBytes())}) · read in ${result.ms} ms`;
}

function updateSelection(ids: string[], names: string[]) {
	selectionIds = ids;
	selectionNames = names;
	els.generate.disabled = busy || ids.length === 0;
	setMenuState();
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
	setMenuState();
	els.status.textContent = 'Reading layers…';
	send({ type: 'GENERATE', options: { rasterScale: settings.rasterScale, assetBytes: true } });
}

function applySettingsToForm() {
	els.format.value = settings.format;
	els.units.value = settings.units;
	els.decimals.value = String(settings.decimals);
	els.scale.value = String(settings.rasterScale);
	els.vars.checked = settings.useVariables;
	els.dark.checked = settings.systemDarkMode;
	els.share.checked = settings.shareClasses;
	els.components.checked = settings.components;
	els.ts.checked = settings.typescript;
	els.fonts.checked = settings.googleFonts;
	els.svg.checked = settings.inlineSvg;
	els.inline.checked = settings.inlineImages;
}

function applyAiToForm() {
	els.aiKey.value = ai.apiKey;
	els.aiModel.value = ai.model;
	els.aiReasoning.value = ai.reasoning;
	els.aiParallel.value = String(ai.parallel);
	els.aiShots.checked = ai.screenshots;
	els.aiInstructions.value = ai.instructions;
}

function update(patch: Partial<Settings>, rerender = true) {
	settings = { ...settings, ...patch };
	send({ type: 'SAVE_SETTINGS', settings });
	if (rerender) renderAll();
	setMenuState();
}

function updateAi(patch: Partial<AiSettings>) {
	ai = { ...ai, ...patch };
	send({ type: 'SAVE_AI', ai });
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

// ---------- AI ----------

const screenshotRequests = new Map<number, (bytes: Uint8Array | null) => void>();
let screenshotSeq = 0;

function screenshot(layerId: string): Promise<string | null> {
	const requestId = ++screenshotSeq;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			screenshotRequests.delete(requestId);
			resolve(null);
		}, 15_000);
		screenshotRequests.set(requestId, (bytes) => {
			clearTimeout(timer);
			resolve(bytes && bytes.length ? `data:image/jpeg;base64,${toBase64(bytes)}` : null);
		});
		send({ type: 'SCREENSHOT', requestId, nodeId: layerId, maxWidth: SCREENSHOT_WIDTH });
	});
}

function openAiPanel(focusKey = false) {
	els.aiPanel.hidden = false;
	els.aiToggle.setAttribute('aria-expanded', 'true');
	if (focusKey) els.aiKey.focus();
}

let runFrame = 0;
function scheduleRunRender() {
	cancelAnimationFrame(runFrame);
	runFrame = requestAnimationFrame(renderAiRun);
}

function renderAiRun() {
	const states = [...aiStates.values()];
	els.aiRun.hidden = states.length === 0;
	if (!states.length) return;
	const done = states.filter((s) => s.status === 'done').length;
	const failed = states.filter((s) => s.status === 'failed').length;
	const running = aiController !== null;
	const cost = states.reduce((sum, s) => sum + (s.cost ?? 0), 0);
	const costText = cost > 0 ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}` : '';
	const title = `AI ${running ? 'rebuilding' : 'rebuild'} · ${done}/${states.length} sections${failed ? ` · ${failed} failed` : ''}${costText}`;
	els.aiRunTitle.textContent = title;
	els.aiCancel.hidden = !running;
	els.aiRegen.disabled = running;
	if (running) els.status.textContent = `${title} · ${ai.model}`;

	els.aiRunBody.replaceChildren(
		...states.map((s) => {
			const row = document.createElement('div');
			row.className = `ai-row ${s.status}`;
			const dot = document.createElement('span');
			dot.className = 'dot';
			dot.title = s.status;
			const label = document.createElement('button');
			label.className = 'ai-label';
			label.textContent = aiPlans && aiPlans.length > 1 ? `${aiPlans[s.page]?.name} · ${s.label}` : s.label;
			label.title = 'Select this layer in Figma';
			label.addEventListener('click', () => {
				if (s.layerIds[0]) {
					focusedId = s.layerIds[0];
					send({ type: 'FOCUS', nodeId: s.layerIds[0] });
				}
			});
			const meta = document.createElement('span');
			meta.className = 'ai-meta';
			const secs = s.ms ? ` · ${Math.round(s.ms / 1000)}s` : '';
			if (s.status === 'running') meta.textContent = s.chars || s.reasoning ? `${s.reasoning && !s.chars ? 'thinking ' + formatCount(s.reasoning) : formatCount(s.chars)} chars${secs}` : `waiting${secs}`;
			else if (s.status === 'done') meta.textContent = `done${secs}${s.coverage !== undefined && s.coverage < COVERAGE_WARNING ? ' · check text' : ''}`;
			else if (s.status === 'failed') {
				meta.textContent = s.error ?? 'failed';
				meta.title = s.error ?? '';
			} else meta.textContent = s.status;
			row.append(dot, label, meta);
			if (!running && (s.status === 'failed' || s.status === 'done' || s.status === 'cancelled')) {
				const retry = document.createElement('button');
				retry.className = 'btn small';
				retry.textContent = s.status === 'done' ? 'Redo' : 'Retry';
				retry.addEventListener('click', () => startAi([s.key]));
				row.appendChild(retry);
			}
			return row;
		}),
	);
}

/** Rebuilds missing sections (or `keys`, or everything when `all`). */
async function startAi(keys?: string[], all = false) {
	if (settings.format === 'email' || aiController) return;
	if (!ai.apiKey.trim()) {
		openAiPanel(true);
		els.status.textContent = 'Add your OpenRouter API key to use AI generation';
		return;
	}
	if (!ai.model.trim()) {
		openAiPanel();
		els.aiModel.focus();
		return;
	}
	if (!doc || !result) {
		aiAfterGenerate = true;
		generateNow();
		return;
	}
	const styling = formatParts(settings.format).styling;
	if (aiStyling && aiStyling !== styling) {
		aiResults = new Map();
		aiStates = new Map();
	}
	aiStyling = styling;
	aiPlans = planPages(doc, { assets });
	const sections = aiPlans.flatMap((p) => p.sections);
	if (!sections.length) {
		notify('Nothing to rebuild — the selection has no layers with children');
		aiPlans = null;
		return;
	}
	if (all) {
		aiResults = new Map();
		aiStates = new Map();
	}
	for (const s of sections) if (!aiStates.has(s.key)) aiStates.set(s.key, { ...initialState(s), status: aiResults.has(s.key) ? 'done' : 'queued' });
	for (const key of [...aiStates.keys()]) if (!sections.some((s) => s.key === key)) aiStates.delete(key);

	const todo = sections.filter((s) => (keys ? keys.includes(s.key) : !aiResults.has(s.key)));
	source = 'ai';
	if (!todo.length) {
		renderOutput();
		renderAiRun();
		notify('All sections are already rebuilt — use Redo on a section or Regenerate all');
		return;
	}
	for (const s of todo) aiResults.delete(s.key);

	const controller = new AbortController();
	aiController = controller;
	setMenuState();
	renderOutput();
	renderAiRun();
	const started = Date.now();
	try {
		await runSections({
			doc,
			plans: aiPlans,
			sections: todo,
			ai,
			styling,
			signal: controller.signal,
			results: aiResults,
			states: aiStates,
			screenshot,
			onUpdate: (state) => {
				scheduleRunRender();
				if (state.status === 'done' || state.status === 'failed') {
					aiVersion++;
					renderOutput();
				}
			},
		});
	} finally {
		aiController = null;
		aiVersion++;
		setMenuState();
		renderOutput();
		renderAiRun();
	}
	const states = todo.map((s) => aiStates.get(s.key)!);
	const failed = states.filter((s) => s.status === 'failed');
	const cancelled = controller.signal.aborted;
	const secs = Math.round((Date.now() - started) / 1000);
	if (cancelled) els.status.textContent = 'AI rebuild cancelled — finished sections are kept';
	else if (failed.length === states.length) {
		els.status.textContent = `AI rebuild failed: ${failed[0]?.error ?? 'unknown error'}`;
		notify(`AI rebuild failed: ${failed[0]?.error ?? 'unknown error'}`);
	} else {
		els.status.textContent = `AI rebuilt ${states.length - failed.length} of ${states.length} sections in ${secs}s${failed.length ? ' — failed sections use the standard output' : ''}`;
		notify(`AI rebuild finished (${states.length - failed.length}/${states.length} sections)`);
	}
}

// ---------- messages ----------

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
			ai = { ...DEFAULT_AI_SETTINGS, ...msg.ai };
			applySettingsToForm();
			applyAiToForm();
			setMenuState();
			return;
		case 'SELECTION':
			updateSelection(msg.ids, msg.names);
			return;
		case 'PROGRESS':
			els.status.textContent = `Reading layers… ${msg.done} / ${msg.total}`;
			return;
		case 'RESULT': {
			busy = false;
			const sameSelection = generatedIds.join() === selectionIds.join();
			result = msg.result;
			assets = new Map(msg.result.assets.map((a) => [a.id, a]));
			generatedIds = [...selectionIds];
			focusedId = null;
			previewKey = '';
			page = 0;
			if (!sameSelection) {
				aiPlans = null;
				aiResults = new Map();
				aiStates = new Map();
				source = 'standard';
				els.aiRun.hidden = true;
			}
			els.generate.textContent = 'Regenerate';
			updateSelection(selectionIds, selectionNames);
			renderAll();
			if (aiAfterGenerate) {
				aiAfterGenerate = false;
				void startAi();
			}
			return;
		}
		case 'TOKENS':
			downloadTokens(msg.tokens);
			return;
		case 'IMAGE':
			screenshotRequests.get(msg.requestId)?.(msg.bytes);
			screenshotRequests.delete(msg.requestId);
			return;
		case 'ERROR':
			busy = false;
			aiAfterGenerate = false;
			els.generate.disabled = selectionIds.length === 0;
			setMenuState();
			els.status.textContent = msg.message;
			return;
	}
});

els.generate.addEventListener('click', generateNow);
els.aiGenerate.addEventListener('click', () => void startAi());
document.addEventListener('keydown', (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
		e.preventDefault();
		generateNow();
	}
	if (e.key === 'Escape') closeMenu();
});

els.format.addEventListener('change', () => {
	const before = formatParts(settings.format).styling;
	update({ format: els.format.value as Format });
	if (aiStyling && before !== formatParts(settings.format).styling && aiResults.size) {
		els.status.textContent = 'Styling changed (CSS ↔ Tailwind) — press AI to rebuild the sections for it';
		aiPlans = null;
		aiResults = new Map();
		aiStates = new Map();
		source = 'standard';
		renderOutput();
		renderAiRun();
	}
});
els.source.addEventListener('click', (e) => {
	const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-src]');
	if (!b) return;
	source = b.dataset.src === 'ai' ? 'ai' : 'standard';
	renderOutput();
});
els.page.addEventListener('change', () => {
	page = Number(els.page.value);
	renderTabs();
	renderView();
});
els.theme.addEventListener('change', () => {
	theme = els.theme.value;
	applyTheme();
});
els.frame.addEventListener('load', () => {
	if (theme) applyTheme();
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
	const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-url]');
	if (link) {
		e.preventDefault();
		send({ type: 'OPEN_URL', url: link.dataset.url! });
	}
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
	const suffix = useAi() ? '-ai' : '';
	const starterOpts = {
		format: settings.format,
		googleFonts: settings.googleFonts,
		inlineSvg: settings.inlineSvg,
		components: settings.components,
		typescript: settings.typescript,
		systemDark: settings.systemDarkMode,
	};
	if (kind === 'zip') {
		const entries: Record<string, string | Uint8Array> = {};
		for (const f of output('files')) if (f.path) entries[f.path] = f.content;
		const dir = formatParts(settings.format).framework === 'html' || settings.format === 'email' ? 'assets' : 'public/assets';
		for (const a of assets.values()) entries[`${dir}/${a.name}`] = a.bytes;
		downloadZip(`${baseName()}${suffix}.zip`, entries);
		notify(`Downloaded ${baseName()}${suffix}.zip`);
	} else if (kind === 'starter') {
		const entries = starterFiles(doc, assets, { ...starterOpts, files: useAi() ? output('files') : undefined });
		downloadZip(`${baseName()}${suffix}-vite.zip`, entries);
		notify(`Downloaded ${baseName()}${suffix}-vite.zip — run npm install && npm run dev`);
	} else if (kind === 'next') {
		const entries = nextFiles(doc, assets, { ...starterOpts, files: useAi() ? output('files', 'next') : undefined });
		downloadZip(`${baseName()}${suffix}-next.zip`, entries);
		notify(`Downloaded ${baseName()}${suffix}-next.zip — run npm install && npm run dev`);
	}
});

function togglePanel(panel: HTMLElement, button: HTMLButtonElement, other: [HTMLElement, HTMLButtonElement]) {
	panel.hidden = !panel.hidden;
	button.setAttribute('aria-expanded', String(!panel.hidden));
	if (!panel.hidden) {
		other[0].hidden = true;
		other[1].setAttribute('aria-expanded', 'false');
	}
}

els.settingsToggle.addEventListener('click', () => togglePanel(els.settings, els.settingsToggle, [els.aiPanel, els.aiToggle]));
els.aiToggle.addEventListener('click', () => togglePanel(els.aiPanel, els.aiToggle, [els.settings, els.settingsToggle]));
els.units.addEventListener('change', () => update({ units: els.units.value as Settings['units'] }));
els.decimals.addEventListener('change', () => update({ decimals: Number(els.decimals.value) as Settings['decimals'] }));
els.scale.addEventListener('change', () => {
	update({ rasterScale: Number(els.scale.value) as Settings['rasterScale'] }, false);
	if (result) els.status.textContent = 'Raster scale applies on the next Generate';
});
els.vars.addEventListener('change', () => update({ useVariables: els.vars.checked }));
els.dark.addEventListener('change', () => update({ systemDarkMode: els.dark.checked }));
els.share.addEventListener('change', () => update({ shareClasses: els.share.checked }));
els.components.addEventListener('change', () => update({ components: els.components.checked }));
els.ts.addEventListener('change', () => update({ typescript: els.ts.checked }));
els.fonts.addEventListener('change', () => update({ googleFonts: els.fonts.checked }));
els.svg.addEventListener('change', () => update({ inlineSvg: els.svg.checked }));
els.inline.addEventListener('change', () => update({ inlineImages: els.inline.checked }));
els.wrap.addEventListener('change', () => viewer.setWrap(els.wrap.checked));

els.aiKey.addEventListener('change', () => updateAi({ apiKey: els.aiKey.value.trim() }));
els.aiKeyShow.addEventListener('click', () => {
	const show = els.aiKey.type === 'password';
	els.aiKey.type = show ? 'text' : 'password';
	els.aiKeyShow.textContent = show ? 'Hide' : 'Show';
});
els.aiKeyCheck.addEventListener('click', async () => {
	updateAi({ apiKey: els.aiKey.value.trim() });
	if (!ai.apiKey) {
		els.aiKeyStatus.textContent = 'Paste a key first.';
		return;
	}
	els.aiKeyStatus.textContent = 'Checking…';
	try {
		const info = await checkKey(ai.apiKey);
		const left = info.limitRemaining !== null ? ` · $${info.limitRemaining.toFixed(2)} left on this key` : '';
		els.aiKeyStatus.textContent = `✓ Key works (${info.label})${left}`;
	} catch (err) {
		els.aiKeyStatus.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
	}
});
els.aiModel.addEventListener('change', () => updateAi({ model: els.aiModel.value.trim() || DEFAULT_AI_SETTINGS.model }));
els.aiModel.addEventListener(
	'focus',
	() => {
		listModels()
			.then((models) => {
				els.aiModels.replaceChildren(
					new Option(DEFAULT_AI_SETTINGS.model, DEFAULT_AI_SETTINGS.model),
					...models.map((m) => new Option(`${m.name}${m.vision ? ' · images' : ''}`, m.id)),
				);
			})
			.catch(() => {});
	},
	{ once: true },
);
els.aiReasoning.addEventListener('change', () => updateAi({ reasoning: els.aiReasoning.value as AiSettings['reasoning'] }));
els.aiParallel.addEventListener('change', () => updateAi({ parallel: Number(els.aiParallel.value) as AiSettings['parallel'] }));
els.aiShots.addEventListener('change', () => updateAi({ screenshots: els.aiShots.checked }));
els.aiInstructions.addEventListener('change', () => updateAi({ instructions: els.aiInstructions.value }));

els.aiCancel.addEventListener('click', () => aiController?.abort());
els.aiRegen.addEventListener('click', () => void startAi(undefined, true));
els.aiRunToggle.addEventListener('click', () => {
	els.aiRunBody.hidden = !els.aiRunBody.hidden;
	els.aiRunToggle.setAttribute('aria-expanded', String(!els.aiRunBody.hidden));
	els.aiRun.classList.toggle('collapsed', els.aiRunBody.hidden);
});

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

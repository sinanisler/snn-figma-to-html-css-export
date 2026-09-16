import { parseSectionResponse, sectionMessages, textCoverage, type PagePlan, type SectionPlan, type SectionResult } from '../core/ai';
import type { Styling } from '../core/emit';
import type { IRDocument } from '../core/ir';
import type { AiSettings } from '../shared/types';
import { streamChat } from './openrouter';

const PAGE_SCREENSHOT_WIDTH = 512;

export type SectionStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type SectionState = {
	key: string;
	label: string;
	page: number;
	layerIds: string[];
	status: SectionStatus;
	/** Characters received so far (answer + reasoning). */
	chars: number;
	reasoning: number;
	startedAt: number;
	ms: number;
	error?: string;
	cost?: number | null;
	/** Share of the design's words found in the answer. */
	coverage?: number;
};

export type RunOptions = {
	doc: IRDocument;
	plans: PagePlan[];
	sections: SectionPlan[];
	ai: AiSettings;
	styling: Styling;
	signal: AbortSignal;
	results: Map<string, SectionResult>;
	states: Map<string, SectionState>;
	onUpdate: (state: SectionState) => void;
	/** JPG data URL of a layer, or null. */
	screenshot: (layerId: string, maxWidth?: number) => Promise<string | null>;
};

export function initialState(s: SectionPlan): SectionState {
	return { key: s.key, label: s.label, page: s.page, layerIds: s.layerIds, status: 'queued', chars: 0, reasoning: 0, startedAt: 0, ms: 0 };
}

/** Generates sections a few at a time; each finished section lands in `results` right away. */
export async function runSections(opts: RunOptions): Promise<void> {
	const queue = [...opts.sections];
	for (const s of queue) {
		const state = initialState(s);
		opts.states.set(s.key, state);
		opts.onUpdate(state);
	}

	// One small overview shot per page, shared by its sections.
	const pageShots = new Map<number, Promise<string | null>>();
	const pageShot = (page: number) => {
		const id = opts.doc.pages[page]?.roots[0]?.id;
		if (!id) return Promise.resolve(null);
		if (!pageShots.has(page)) pageShots.set(page, opts.screenshot(id, PAGE_SCREENSHOT_WIDTH));
		return pageShots.get(page)!;
	};

	const one = async (section: SectionPlan) => {
		const state = opts.states.get(section.key)!;
		if (opts.signal.aborted) {
			state.status = 'cancelled';
			opts.onUpdate(state);
			return;
		}
		state.status = 'running';
		state.startedAt = Date.now();
		opts.onUpdate(state);
		try {
			const plan = opts.plans[section.page];
			const screenshot = opts.ai.screenshots && section.layerIds.length === 1 ? await opts.screenshot(section.layerIds[0]) : null;
			const pageScreenshot = opts.ai.screenshots && plan.sections.length > 1 ? await pageShot(section.page) : null;
			const messages = sectionMessages(section, { doc: opts.doc, plan, styling: opts.styling, instructions: opts.ai.instructions, screenshot, pageScreenshot });
			const answer = await streamChat({
				apiKey: opts.ai.apiKey,
				model: opts.ai.model,
				messages,
				reasoning: opts.ai.reasoning,
				signal: opts.signal,
				onProgress: (p) => {
					state.chars = p.content;
					state.reasoning = p.reasoning;
					state.ms = Date.now() - state.startedAt;
					opts.onUpdate(state);
				},
			});
			const parsed = parseSectionResponse(answer.content);
			opts.results.set(section.key, parsed);
			state.status = 'done';
			state.cost = answer.cost;
			state.coverage = textCoverage(section, parsed.html);
			state.error = undefined;
		} catch (err) {
			const aborted = opts.signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
			state.status = aborted ? 'cancelled' : 'failed';
			state.error = aborted ? undefined : err instanceof Error ? err.message : String(err);
		}
		state.ms = Date.now() - state.startedAt;
		opts.onUpdate(state);
	};

	const workers = Array.from({ length: Math.max(1, Math.min(opts.ai.parallel, queue.length)) }, async () => {
		for (let next = queue.shift(); next; next = queue.shift()) await one(next);
	});
	await Promise.all(workers);
}

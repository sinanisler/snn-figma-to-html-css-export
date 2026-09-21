import type { ChatMessage } from '../core/ai';
import type { ReasoningEffort } from '../shared/types';

const API = 'https://openrouter.ai/api/v1';
const HEADERS = {
	'HTTP-Referer': 'https://www.figma.com/community',
	'X-Title': 'SNN Design to HTML/CSS',
};

export type StreamProgress = { content: number; reasoning: number };
export type ChatResult = { content: string; cost: number | null; tokens: number | null; model: string | null };

export class OpenRouterError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function errorFrom(res: Response): Promise<OpenRouterError> {
	let message = `${res.status} ${res.statusText}`;
	try {
		const body = await res.json();
		if (body?.error?.message) message = body.error.message;
	} catch {
		// not JSON
	}
	if (res.status === 401) message = `Invalid API key (${message})`;
	if (res.status === 402) message = `Not enough OpenRouter credits (${message})`;
	if (res.status === 429) message = `Rate limited — try fewer sections at once (${message})`;
	return new OpenRouterError(message, res.status);
}

/** One streamed chat completion. Resolves with the whole answer. */
export async function streamChat(opts: {
	apiKey: string;
	model: string;
	messages: ChatMessage[];
	reasoning: ReasoningEffort;
	signal: AbortSignal;
	onProgress?: (p: StreamProgress) => void;
}): Promise<ChatResult> {
	const body: Record<string, unknown> = {
		model: opts.model,
		messages: opts.messages,
		stream: true,
		temperature: 0.2,
		usage: { include: true },
	};
	if (opts.reasoning === 'off') body.reasoning = { enabled: false };
	else if (opts.reasoning !== 'default') body.reasoning = { effort: opts.reasoning };

	const res = await fetch(`${API}/chat/completions`, {
		method: 'POST',
		headers: { ...HEADERS, Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok || !res.body) throw await errorFrom(res);

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let content = '';
	let reasoning = 0;
	let cost: number | null = null;
	let tokens: number | null = null;
	let model: string | null = null;
	let finish: string | null = null;

	const handle = (line: string) => {
		if (!line.startsWith('data:')) return; // ": OPENROUTER PROCESSING" keep-alives
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') return;
		let chunk: any;
		try {
			chunk = JSON.parse(data);
		} catch {
			return;
		}
		if (chunk.error) throw new OpenRouterError(chunk.error.message ?? 'Generation failed', chunk.error.code ?? 500);
		if (chunk.model) model = chunk.model;
		const choice = chunk.choices?.[0];
		if (choice?.delta?.content) content += choice.delta.content;
		if (choice?.delta?.reasoning) reasoning += choice.delta.reasoning.length;
		if (choice?.finish_reason) finish = choice.finish_reason;
		if (chunk.usage) {
			if (typeof chunk.usage.cost === 'number') cost = chunk.usage.cost;
			if (typeof chunk.usage.total_tokens === 'number') tokens = chunk.usage.total_tokens;
		}
		opts.onProgress?.({ content: content.length, reasoning });
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			handle(buffer.slice(0, nl).trim());
			buffer = buffer.slice(nl + 1);
		}
	}
	handle(buffer.trim());
	if (finish === 'length') throw new OpenRouterError('The answer was cut off (max tokens reached) — the section is too large for this model.', 413);
	if (!content.trim()) throw new OpenRouterError('The model returned an empty answer.', 502);
	return { content, cost, tokens, model };
}

export type KeyInfo = { label: string; limitRemaining: number | null; usage: number | null };

export async function checkKey(apiKey: string): Promise<KeyInfo> {
	const res = await fetch(`${API}/key`, { headers: { ...HEADERS, Authorization: `Bearer ${apiKey}` } });
	if (!res.ok) throw await errorFrom(res);
	const { data } = await res.json();
	return { label: data?.label ?? 'API key', limitRemaining: data?.limit_remaining ?? null, usage: data?.usage ?? null };
}

export type ModelInfo = { id: string; name: string; vision: boolean };

let modelCache: Promise<ModelInfo[]> | null = null;

export function listModels(): Promise<ModelInfo[]> {
	modelCache ??= fetch(`${API}/models`, { headers: HEADERS })
		.then(async (res) => {
			if (!res.ok) throw await errorFrom(res);
			const { data } = await res.json();
			return (data as any[]).map((m) => ({
				id: m.id as string,
				name: (m.name as string) ?? m.id,
				vision: Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.includes('image'),
			}));
		})
		.catch((err) => {
			modelCache = null;
			throw err;
		});
	return modelCache;
}

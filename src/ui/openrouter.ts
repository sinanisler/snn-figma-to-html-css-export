import type { ChatMessage } from '../core/ai';
import type { ReasoningEffort } from '../shared/types';

/** SNN account service: holds the user's provider key and forwards AI requests to OpenRouter. */
export const SERVICE = 'https://snn.is/snn-figma';
const API = `${SERVICE}/api.php`;
const endpoint = (action: string) => `${API}?action=${action}`;

export type StreamProgress = { content: number; reasoning: number };
export type ChatResult = { content: string; cost: number | null; tokens: number | null; model: string | null };

export class OpenRouterError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** Service error code, e.g. not_connected, no_key, bad_key, quota. */
		readonly code = '',
	) {
		super(message);
	}
}

async function errorFrom(res: Response): Promise<OpenRouterError> {
	let message = `${res.status} ${res.statusText}`;
	let code = '';
	try {
		const body = await res.json();
		if (body?.error?.message) message = body.error.message;
		if (typeof body?.error?.code === 'string') code = body.error.code;
	} catch {
		// not JSON
	}
	if (res.status === 401) message = 'Not connected — open AI settings and click Connect account';
	else if (res.status === 402 && !code) message = `Not enough OpenRouter credits (${message})`;
	else if (res.status === 429 && !code) message = `Rate limited — try fewer sections at once (${message})`;
	return new OpenRouterError(message, res.status, code);
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** One streamed chat completion. Resolves with the whole answer. */
export async function streamChat(opts: {
	token: string;
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

	const res = await fetch(endpoint('chat'), {
		method: 'POST',
		headers: { ...auth(opts.token), 'Content-Type': 'application/json' },
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

export type Account = {
	email: string;
	plan: { name: string; daily_limit: number; monthly_limit: number; managed: boolean };
	usage: { today: number; month: number };
	providers: { id: string; name: string; ready: boolean }[];
	dashboard: string;
};

export async function accountInfo(token: string): Promise<Account> {
	const res = await fetch(endpoint('me'), { headers: auth(token) });
	if (!res.ok) throw await errorFrom(res);
	return res.json();
}

export async function disconnect(token: string): Promise<void> {
	await fetch(endpoint('disconnect'), { method: 'POST', headers: auth(token) }).catch(() => {});
}

export type Pairing = { code: string; secret: string; url: string; expires_in: number };

/** Starts a sign-in: the user approves `url` in the browser while the plugin polls with `waitForPairing`. */
export async function startPairing(): Promise<Pairing> {
	const res = await fetch(endpoint('pair_start'), { method: 'POST' });
	if (!res.ok) throw await errorFrom(res);
	return res.json();
}

/** Resolves with the plugin token once the user approves, or null when the code expires or `signal` aborts. */
export async function waitForPairing(p: Pairing, signal: AbortSignal, intervalMs = 2500): Promise<string | null> {
	const deadline = Date.now() + p.expires_in * 1000;
	while (!signal.aborted && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, intervalMs));
		if (signal.aborted) break;
		try {
			const res = await fetch(endpoint('pair_poll'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: p.code, secret: p.secret }),
				signal,
			});
			if (!res.ok) continue;
			const data = await res.json();
			if (data.status === 'ok' && data.token) return data.token as string;
			if (data.status === 'expired') return null;
		} catch {
			// network blip or abort — keep polling until the deadline
		}
	}
	return null;
}

export type ModelInfo = { id: string; name: string; vision: boolean };

let modelCache: Promise<ModelInfo[]> | null = null;

export function listModels(): Promise<ModelInfo[]> {
	modelCache ??= fetch(endpoint('models'))
		.then(async (res) => {
			if (!res.ok) throw await errorFrom(res);
			const { data } = await res.json();
			return data as ModelInfo[];
		})
		.catch((err) => {
			modelCache = null;
			throw err;
		});
	return modelCache;
}

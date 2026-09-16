import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from '../src/ui/openrouter';

function sse(parts: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const p of parts) controller.enqueue(encoder.encode(p));
			controller.close();
		},
	});
	return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

const call = (signal = new AbortController().signal, onProgress = vi.fn()) =>
	streamChat({
		apiKey: 'sk-or-test',
		model: '~deepseek/deepseek-pro-latest',
		messages: [{ role: 'user', content: 'hi' }],
		reasoning: 'low',
		signal,
		onProgress,
	});

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter streaming', () => {
	it('assembles content across split chunks and reads usage', async () => {
		const first = chunk({ model: 'deepseek/deepseek-pro', choices: [{ delta: { reasoning: 'think' } }] });
		const second = chunk({ choices: [{ delta: { content: '```html\n<p>Hi</p>' } }] });
		const fetchMock = vi.fn(async () =>
			sse([
				': OPENROUTER PROCESSING\n\n',
				first,
				second.slice(0, 20),
				second.slice(20),
				chunk({ choices: [{ delta: { content: '\n```' }, finish_reason: 'stop' }] }),
				chunk({ choices: [], usage: { total_tokens: 42, cost: 0.0012 } }),
				'data: [DONE]\n\n',
			]),
		);
		vi.stubGlobal('fetch', fetchMock);
		const progress = vi.fn();
		const res = await call(undefined, progress);
		expect(res).toEqual({ content: '```html\n<p>Hi</p>\n```', cost: 0.0012, tokens: 42, model: 'deepseek/deepseek-pro' });
		expect(progress).toHaveBeenCalled();

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({ model: '~deepseek/deepseek-pro-latest', stream: true, reasoning: { effort: 'low' } });
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
	});

	it('reports HTTP and mid-stream errors', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), { status: 401 })));
		await expect(call()).rejects.toThrow('Invalid API key (No auth credentials found)');

		vi.stubGlobal('fetch', vi.fn(async () => sse([chunk({ error: { code: 502, message: 'Provider returned error' } })])));
		await expect(call()).rejects.toThrow('Provider returned error');

		vi.stubGlobal('fetch', vi.fn(async () => sse([chunk({ choices: [{ delta: { content: '<p>cut' }, finish_reason: 'length' }] })])));
		await expect(call()).rejects.toThrow('cut off');
	});
});

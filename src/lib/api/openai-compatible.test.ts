import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchChatCompletion,
  OpenAICompatibleClient,
  parseExtraBody,
  REQUEST_TIMEOUT_MS,
  type CompletionTransport,
} from './openai-compatible';

// Mock fetch
global.fetch = vi.fn();

// noUncheckedIndexedAccess makes mock.calls[0] possibly undefined; this narrows it.
function firstCall<T extends unknown[]>(calls: T[]): T {
  const c = calls[0];
  if (!c) throw new Error('expected a call');
  return c;
}

describe('OpenAICompatibleClient', () => {
  let client: OpenAICompatibleClient;
  const apiKey = process.env.OPENAI_API_KEY || 'test-openai-key';
  const baseUrl = 'https://api.openai.com/v1';
  const model = 'gpt-4';

  beforeEach(() => {
    vi.clearAllMocks();
    client = new OpenAICompatibleClient({
      apiKey,
      baseUrl,
      model,
    });
  });

  describe('translate', () => {
    it('should translate text successfully', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: 'Bonjour',
            },
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      const result = await client.translate('Hello', 'fr');

      expect(result).toBe('Bonjour');
      expect(fetch).toHaveBeenCalledWith(
        `${baseUrl}/chat/completions`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should include correct model in request', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'こんにちは' } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      await client.translate('Hello', 'ja');

      const callArgs = firstCall(vi.mocked(fetch).mock.calls);
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.model).toBe(model);
    });

    it('should include system prompt with target language', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'Hola' } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      await client.translate('Hello', 'es');

      const callArgs = firstCall(vi.mocked(fetch).mock.calls);
      const body = JSON.parse(callArgs[1]?.body as string);

      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toContain('Spanish');
      expect(body.messages[1].role).toBe('user');
      expect(body.messages[1].content).toBe('Hello');
    });

    it('should use low temperature for consistent translations', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'Guten Tag' } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      await client.translate('Hello', 'de');

      const callArgs = firstCall(vi.mocked(fetch).mock.calls);
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.temperature).toBe(0.3);
    });

    it('should throw error on API failure', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({
          error: {
            message: 'Invalid API key',
          },
        }),
      } as Response);

      const error = await client.translate('Hello', 'fr').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('OpenAI API Error');
      expect(message).toContain('401');
      expect(message).toContain('Invalid API key');
    });

    it('should include nested error details from the response body', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({
          error: { message: 'Provider returned error', metadata: { raw: 'upstream detail' } },
        }),
      } as Response);

      await expect(client.translate('Hello', 'fr')).rejects.toThrow('upstream detail');
    });

    it('should trim a non-JSON error body', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => '  Bad gateway  ',
      } as Response);

      await expect(client.translate('Hello', 'fr')).rejects.toThrow('Bad gateway');
    });

    it.each([
      ['reasoning_content', { content: '', reasoning_content: 'thinking...' }, undefined],
      ['reasoning', { content: null, reasoning: 'x' }, undefined],
      ['finish_reason length', { content: '' }, 'length'],
    ])('should report exhausted output budget (%s)', async (_label, message, finishReason) => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ choices: [{ finish_reason: finishReason, message }] }),
      } as Response);

      await expect(client.translate('Hello', 'fr')).rejects.toThrow('returned no translation');
    });

    it.each([{ choices: [] }, {}])('should report empty translation for %j', async (payload) => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => payload,
      } as Response);

      await expect(client.translate('Hello', 'fr')).rejects.toThrow(
        'OpenAI API returned empty translation'
      );
    });

    it('should throw error when translation is empty', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: '',
            },
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      await expect(client.translate('Hello', 'fr')).rejects.toThrow(
        'OpenAI API returned empty translation'
      );
    });

    it('should trim whitespace from translated text', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: '  Bonjour  \n',
            },
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      const result = await client.translate('Hello', 'fr');
      expect(result).toBe('Bonjour');
    });

    it('should handle Chinese language variants', async () => {
      const mockResponse = {
        choices: [{ message: { content: '你好' } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      await client.translate('Hello', 'zh-CN');

      const callArgs = firstCall(vi.mocked(fetch).mock.calls);
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.messages[0].content).toContain('Simplified Chinese');
    });

    it('should work with custom base URL', async () => {
      const customClient = new OpenAICompatibleClient({
        apiKey: 'custom-key',
        baseUrl: 'https://custom-api.example.com/v1',
        model: 'claude-3-5-sonnet-20241022',
      });

      const mockResponse = {
        choices: [{ message: { content: 'Translated' } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => mockResponse,
      } as Response);

      await customClient.translate('Test', 'ja');

      expect(fetch).toHaveBeenCalledWith(
        'https://custom-api.example.com/v1/chat/completions',
        expect.any(Object)
      );
    });

    it.each([
      'https://openrouter.ai/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions/',
      'https://openrouter.ai/api/v1/',
    ])('should normalize base URL %s', async (inputUrl) => {
      const customClient = new OpenAICompatibleClient({
        apiKey: 'custom-key',
        baseUrl: inputUrl,
        model: 'some-model',
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: 'Translated' } }] }),
      } as Response);

      await customClient.translate('Test', 'ja');

      expect(fetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.any(Object)
      );
    });
  });

  describe('translateBatch', () => {
    const tagged = (...texts: Array<string | null>): string =>
      JSON.stringify(texts.flatMap((text, id) => (text === null ? [] : [{ id, text }])));

    function mockContents(...contents: string[]): void {
      for (const content of contents) {
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ choices: [{ message: { content } }] }),
        } as Response);
      }
    }

    it('should translate multiple texts in a single request', async () => {
      mockContents(tagged('Bonjour', 'Au revoir', 'Merci'));

      const result = await client.translateBatch(['Hello', 'Goodbye', 'Thanks'], 'fr');

      expect(result).toEqual(['Bonjour', 'Au revoir', 'Merci']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should map out-of-order items by id', async () => {
      mockContents(JSON.stringify([
        { id: 2, text: 'Merci' },
        { id: 0, text: 'Bonjour' },
        { id: 1, text: 'Au revoir' },
      ]));

      const result = await client.translateBatch(['Hello', 'Goodbye', 'Thanks'], 'fr');

      expect(result).toEqual(['Bonjour', 'Au revoir', 'Merci']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should return empty array for empty input', async () => {
      const result = await client.translateBatch([], 'fr');
      expect(result).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should send the texts as a JSON array with ids', async () => {
      mockContents(tagged('Hola', 'Adiós'));

      await client.translateBatch(['Hello', 'Goodbye'], 'es');

      const callArgs = firstCall(vi.mocked(fetch).mock.calls);
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(JSON.parse(body.messages[1].content)).toEqual([
        { id: 0, text: 'Hello' },
        { id: 1, text: 'Goodbye' },
      ]);
      expect(body.messages[0].content).toContain('Spanish');
      expect(body.max_tokens).toBe(4000);
    });

    it('retains successful IDs without paying for missing items again', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      mockContents(tagged('Bonjour', null, 'Merci'));
      expect(await client.translateBatch(['Hello', 'Goodbye', 'Thanks'], 'fr'))
        .toEqual(['Bonjour', '', 'Merci']);
      expect(fetch).toHaveBeenCalledTimes(1);
      debug.mockRestore();
    });

    it('sends more than five short units in one request with shared message context', async () => {
      const texts = Array.from({ length: 24 }, (_, i) => 'Sentence ' + i + '.');
      const translated = texts.map((_, i) => '번역 ' + i);
      mockContents(tagged(...translated));
      expect(await client.translateBatch(texts, 'ko', undefined, texts.map(() => 'message-1'))).toEqual(translated);
      expect(fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(firstCall(vi.mocked(fetch).mock.calls)[1]?.body as string);
      expect(JSON.parse(body.messages[1].content)).toEqual(texts.map((text, id) => ({ id, group: 0, text })));
      expect(body.messages[0].content).toContain('read them together');
    });

    it('should ignore duplicate, out-of-range, and non-string items', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      mockContents(
        JSON.stringify([
          { id: 0, text: 'Bonjour' },
          { id: 0, text: 'Duplicate' },
          { id: 2, text: 'Out of range' },
          { id: -1, text: 'Negative' },
          { id: 1.5, text: 'Fractional' },
          { id: '1', text: 'String id' },
          { id: 1, text: 42 },
          null,
        ]),
      );

      const result = await client.translateBatch(['Hello', 'Goodbye'], 'fr');

      expect(result).toEqual(['Bonjour', '']);
      expect(fetch).toHaveBeenCalledTimes(1);
      debug.mockRestore();
    });

    it('should parse content wrapped in code fences', async () => {
      mockContents('```json\n' + tagged('Bonjour', 'Au revoir') + '\n```');

      const result = await client.translateBatch(['Hello', 'Goodbye'], 'fr');

      expect(result).toEqual(['Bonjour', 'Au revoir']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should parse content with a leading think block', async () => {
      mockContents('<think>ids [0] and [1], easy</think>\n' + tagged('Bonjour', 'Au revoir'));

      const result = await client.translateBatch(['Hello', 'Goodbye'], 'fr');

      expect(result).toEqual(['Bonjour', 'Au revoir']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('retains complete objects in a truncated response without retrying', async () => {
      mockContents('[{"id":0,"text":"Bonjour"},{"id":1,"text":"Au');
      expect(await client.translateBatch(['Hello', 'Goodbye'], 'fr')).toEqual(['Bonjour', '']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not fan out another request when alignment is unparseable', async () => {
      mockContents('Only one translation');
      expect(await client.translateBatch(['Hello', 'Goodbye'], 'fr')).toEqual(['', '']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not start later AI chunks after cancellation', async () => {
      const controller = new AbortController();
      const text = 'A'.repeat(2400);
      vi.mocked(fetch).mockImplementationOnce(async () => {
        controller.abort();
        return { ok: true, headers: new Headers(), json: async () => ({ choices: [{ message: { content: tagged('번역') } }] }) } as Response;
      });
      await expect(client.translateBatch([text, text], 'ko', undefined, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('splits long inputs at complete units and preserves order', async () => {
      const text = 'A'.repeat(2400);
      mockContents(tagged('첫째'), tagged('둘째'), tagged('셋째'));
      expect(await client.translateBatch([text, text, text], 'ko')).toEqual(['첫째', '둘째', '셋째']);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('should propagate an HTTP error without falling back', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: async () => 'boom',
      } as Response);

      await expect(client.translateBatch(['Hello', 'Goodbye'], 'fr')).rejects.toThrow('OpenAI API Error');
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseExtraBody', () => {
    it.each([undefined, '', '  '])('treats %j as no extra body', (input) => {
      expect(parseExtraBody(input)).toEqual({ ok: true, value: null });
    });

    it('parses a JSON object', () => {
      expect(parseExtraBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    });

    it.each(['{', '[1]', '1', '"x"', 'null'])('rejects %j', (input) => {
      expect(parseExtraBody(input).ok).toBe(false);
    });
  });

  describe('extra request body', () => {
    function clientWithExtra(extraBody: string): OpenAICompatibleClient {
      return new OpenAICompatibleClient({ apiKey, baseUrl, model, extraBody });
    }

    function mockContent(content: string): void {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content } }] }),
      } as Response);
    }

    function requestBody(): Record<string, unknown> {
      const callArgs = firstCall(vi.mocked(fetch).mock.calls);
      return JSON.parse(callArgs[1]?.body as string);
    }

    it('merges extra fields and lets them override temperature', async () => {
      mockContent('Bonjour');

      await clientWithExtra('{"reasoning_effort":"low","temperature":0.7}').translate('Hello', 'fr');

      const body = requestBody();
      expect(body.reasoning_effort).toBe('low');
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1000);
    });

    it('does not let extra fields override model or messages', async () => {
      mockContent('Bonjour');

      await clientWithExtra('{"model":"x","messages":[]}').translate('Hello', 'fr');

      const body = requestBody();
      expect(body.model).toBe(model);
      expect(body.messages).toHaveLength(2);
    });

    it('removes fields set to null', async () => {
      mockContent('Bonjour');

      await clientWithExtra('{"max_tokens":null,"temperature":null}').translate('Hello', 'fr');

      const body = requestBody();
      expect('max_tokens' in body).toBe(false);
      expect('temperature' in body).toBe(false);
      expect(body.model).toBe(model);
      expect(body.messages).toBeDefined();
    });

    it('applies the extra body to translateBatch via the shared path', async () => {
      mockContent(JSON.stringify([{ id: 0, text: 'Bonjour' }, { id: 1, text: 'Au revoir' }]));

      const result = await clientWithExtra('{"max_tokens":null}').translateBatch(['Hello', 'Goodbye'], 'fr');

      expect(result).toEqual(['Bonjour', 'Au revoir']);
      expect('max_tokens' in requestBody()).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('rejects before fetching when the stored text is invalid', async () => {
      await expect(clientWithExtra('{').translate('Hello', 'fr')).rejects.toThrow(
        'Invalid extra request body'
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('request timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function signalOf(init: RequestInit | undefined): AbortSignal {
      if (!init?.signal) throw new Error('expected fetch to receive a signal');
      return init.signal;
    }

    const rejectOnAbort = (signal: AbortSignal) =>
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))));

    it('aborts when headers never arrive', async () => {
      vi.mocked(fetch).mockImplementation((_url, init) => rejectOnAbort(signalOf(init)));

      const promise = client.translate('Hello', 'fr');
      const assertion = expect(promise).rejects.toThrow('LLM did not respond within 120 s');
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await assertion;
    });

    it('aborts when the body read stalls', async () => {
      vi.mocked(fetch).mockImplementation(async (_url, init) => {
        const signal = signalOf(init);
        const json = (): Promise<unknown> => rejectOnAbort(signal);
        return { ok: true, headers: new Headers(), json } as Response;
      });

      const promise = client.translate('Hello', 'fr');
      const assertion = expect(promise).rejects.toThrow('LLM did not respond within 120 s');
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await assertion;
    });

    it('does not fall back to individual requests on timeout', async () => {
      vi.mocked(fetch).mockImplementation((_url, init) => rejectOnAbort(signalOf(init)));

      const promise = client.translateBatch(['Hello', 'Goodbye'], 'fr');
      const assertion = expect(promise).rejects.toThrow('LLM did not respond within 120 s');
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('passes an abort signal and clears the timer after success', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: 'Bonjour' } }] }),
      } as Response);

      await expect(client.translate('Hello', 'fr')).resolves.toBe('Bonjour');

      const callArgs = firstCall(vi.mocked(fetch).mock.calls);
      expect(callArgs[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;

describe('fetchChatCompletion', () => {
  const request = { url: 'http://127.0.0.1:9931/v1/chat/completions', apiKey: 'k', body: { model: 'm' } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('joins streamed deltas, including frames split across reads', async () => {
    const frames = [chunk({ content: 'Bon' }), chunk({ content: 'jour' }, 'stop'), 'data: [DONE]\n\n'];
    const joined = frames.join('');
    vi.mocked(fetch).mockResolvedValue(sseResponse([joined.slice(0, 20), joined.slice(20)]));

    await expect(fetchChatCompletion(request)).resolves.toEqual({
      content: 'Bonjour',
      reasoning: '',
      finishReason: 'stop',
    });
  });

  it('collects reasoning from both field names and ignores keep-alive lines', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse([
      ': keep-alive\n\n',
      chunk({ reasoning_content: 'think ' }),
      chunk({ reasoning: 'more' }, 'length'),
    ]));

    await expect(fetchChatCompletion(request)).resolves.toEqual({
      content: '',
      reasoning: 'think more',
      finishReason: 'length',
    });
  });

  it('sends the Authorization header only when an API key is set', async () => {
    vi.mocked(fetch).mockResolvedValue(sseResponse([chunk({ content: 'x' }), 'data: [DONE]\n\n']));
    await fetchChatCompletion(request);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toEqual({
      'Authorization': 'Bearer k',
      'Content-Type': 'application/json',
    });

    vi.mocked(fetch).mockResolvedValue(sseResponse([chunk({ content: 'x' }), 'data: [DONE]\n\n']));
    await fetchChatCompletion({ ...request, apiKey: '' });
    const headers = vi.mocked(fetch).mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('aborts when the caller signal aborts', async () => {
    const caller = new AbortController();
    vi.mocked(fetch).mockImplementation((_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));

    const promise = fetchChatCompletion(request, caller.signal);
    caller.abort();
    await expect(promise).rejects.toThrow('Aborted');
  });
});

describe('OpenAICompatibleClient transport', () => {
  it('sends a streaming request through the injected transport', async () => {
    const transport = vi.fn<CompletionTransport>().mockResolvedValue({
      content: ' Bonjour ',
      reasoning: '',
      finishReason: 'stop',
    });
    const client = new OpenAICompatibleClient(
      { apiKey: 'k', baseUrl: 'http://127.0.0.1:9931/v1/', model: 'm' },
      transport,
    );

    await expect(client.translate('Hello', 'fr')).resolves.toBe('Bonjour');
    const request = transport.mock.calls[0]?.[0];
    expect(request?.url).toBe('http://127.0.0.1:9931/v1/chat/completions');
    expect(request?.body).toMatchObject({ model: 'm', stream: true });
  });
});

describe('PLaMo 3 Translate models', () => {
  const okResult = { content: 'こんにちは', reasoning: '', finishReason: 'stop' };

  function plamoClient(model: string, extraBody?: string) {
    const transport = vi.fn<CompletionTransport>().mockResolvedValue(okResult);
    const client = new OpenAICompatibleClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9931/v1', model, extraBody }, transport);
    return { client, transport };
  }

  const bodyOf = (transport: ReturnType<typeof plamoClient>['transport'], call = 0) => transport.mock.calls[call]?.[0].body;

  it.each(['pfnet/plamo-3-translate-0.8b', 'pfnet/plamo-3-translate-0.8b-GGUF', 'plamo-3-translate', 'PFNET/PLaMo-3-Translate-0.8b'])(
    'sends only the text with the target language as a template kwarg for %s',
    async (model) => {
      const { client, transport } = plamoClient(model);

      await expect(client.translate('Hello', 'ja')).resolves.toBe('こんにちは');
      expect(bodyOf(transport)).toMatchObject({
        messages: [{ role: 'user', content: 'Hello' }],
        chat_template_kwargs: { target_lang: 'ja' },
        temperature: 0,
        stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
      });
    },
  );

  it.each(['gpt-4', 'plamo-2-translate', 'pfnet/plamo-3-translator'])('keeps the generic prompt for %s', async (model) => {
    const { client, transport } = plamoClient(model);

    await client.translate('Hello', 'ja');
    expect(bodyOf(transport)?.messages).toHaveLength(2);
    expect(bodyOf(transport)).not.toHaveProperty('chat_template_kwargs');
  });

  it.each([
    ['zh-CN', 'zh-hans'],
    ['zh-TW', 'zh-hant'],
    ['EN', 'en'],
    ['pt-BR', 'pt'],
  ])('maps %s to the template code %s', async (code, expected) => {
    const { client, transport } = plamoClient('plamo-3-translate');

    await client.translate('Hello', code);
    expect(bodyOf(transport)?.chat_template_kwargs).toEqual({ target_lang: expected });
  });

  it('keeps template kwargs from the extra body but always sets target_lang', async () => {
    const { client, transport } = plamoClient(
      'plamo-3-translate',
      '{"chat_template_kwargs": {"form": "polite", "target_lang": "en"}, "temperature": 0.2}',
    );

    await client.translate('Hello', 'ja');
    expect(bodyOf(transport)).toMatchObject({
      chat_template_kwargs: { form: 'polite', target_lang: 'ja' },
      temperature: 0.2,
    });
  });

  it('translates a batch with one request per text', async () => {
    const { client, transport } = plamoClient('plamo-3-translate');
    transport.mockImplementation(async (request) => ({
      ...okResult,
      content: `ja:${(request.body.messages as { content: string }[])[0]?.content}`,
    }));

    await expect(client.translateBatch(['a', 'b', 'c'], 'ja')).resolves.toEqual(['ja:a', 'ja:b', 'ja:c']);
    expect(transport).toHaveBeenCalledTimes(3);
  });
});

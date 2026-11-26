import { planBatchRanges } from './batch-plan';
import { buildTranslationSystemPrompt, type TranslationPurpose } from './translation-prompts';

interface OpenAIConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  extraBody?: string;
  purpose?: TranslationPurpose;
  draftPrompt?: string;
  draftPromptEnabled?: boolean;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ReasoningFields {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: ReasoningFields;
    delta?: ReasoningFields;
  }>;
}

export interface CompletionRequest {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  finishReason: string | null;
}

/** Performs one chat-completions HTTP request. Injected so the content script can run it in the background. */
export type CompletionTransport = (request: CompletionRequest) => Promise<CompletionResult>;

// Reasoning models can think for a long time before the answer completes, so
// the limit is generous.
export const REQUEST_TIMEOUT_MS = 120_000;

const REASONING_EXHAUSTED_MESSAGE =
  'OpenAI API returned no translation: the model likely used its whole output budget on reasoning. ' +
  'Raise max_tokens or reduce reasoning via the extra request body setting, ' +
  'e.g. {"max_tokens": 8000} or {"reasoning_effort": "low"}.';

// Keep the whole body: gateways nest the real cause (e.g. under metadata)
// where error.message alone hides it. Indent JSON so it stays readable.
function formatErrorBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.trim();
  }
}

export type ExtraBodyResult =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string };

/** Empty/whitespace/undefined text means "no extra body". */
export function parseExtraBody(text: string | undefined): ExtraBodyResult {
  if (text === undefined || text.trim() === '') {
    return { ok: true, value: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Must be a JSON object, e.g. {"key": "value"}' };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Salvage complete top-level objects from a truncated JSON array.
 * Stop at the first damaged boundary; never infer a missing ID or text.
 */
function recoverIndexedPrefix(source: string, start: number, count: number): unknown[] {
  const items: unknown[] = [];
  let cursor = start + 1;
  while (cursor < source.length && items.length < count) {
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++;
    if (source[cursor] !== '{') break;
    const begin = cursor;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let complete = false;
    for (; cursor < source.length; cursor++) {
      const char = source[cursor]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) { cursor++; complete = true; break; }
      }
    }
    if (!complete) break;
    try {
      items.push(JSON.parse(source.slice(begin, cursor)));
    } catch { break; }
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++;
    if (source[cursor] !== ',') break;
    cursor++;
  }
  return items;
}

/**
 * Extract indexed translations without guessing alignment. Complete entries
 * from a truncated response can be retained without another paid request.
 */
export function parseIndexedTranslations(content: string, count: number): Map<number, string> {
  const result = new Map<number, string>();
  const cleaned = content.replace(/^\s*<think>[\s\S]*?<\/think>/, '');
  const start = cleaned.indexOf('[');
  if (start === -1) return result;
  const end = cleaned.lastIndexOf(']');
  let items: unknown;
  try {
    items = end > start ? JSON.parse(cleaned.slice(start, end + 1)) : recoverIndexedPrefix(cleaned, start, count);
  } catch {
    items = recoverIndexedPrefix(cleaned, start, count);
  }
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, text } = item as { id?: unknown; text?: unknown };
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= count) continue;
    if (typeof text !== 'string' || result.has(id)) continue;
    const trimmed = text.trim();
    if (trimmed) result.set(id, trimmed);
  }
  return result;
}

/**
 * Send one streamed chat-completions request and collect the whole answer.
 * Streaming makes the response headers arrive immediately, which keeps an
 * extension service worker from being stopped while a reasoning model thinks
 * (Chrome stops it when a fetch response takes over 30 s to arrive).
 */
export async function fetchChatCompletion(
  request: CompletionRequest,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: {
        // Local servers need no key, and some reject an empty Bearer token.
        ...(request.apiKey !== '' && { 'Authorization': `Bearer ${request.apiKey}` }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const status = [response.status, response.statusText].filter(Boolean).join(' ');
      const detail = formatErrorBody(errorBody) || response.statusText || 'Unknown error';
      throw new Error(`OpenAI API Error${status ? ` (${status})` : ''}: ${detail}`);
    }

    // Some servers ignore "stream": true and answer with a single JSON body.
    const isEventStream = response.headers.get('content-type')?.includes('text/event-stream');
    if (!isEventStream || !response.body) {
      const choice = ((await response.json()) as ChatCompletionResponse)?.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        reasoning: choice?.message?.reasoning_content || choice?.message?.reasoning || '',
        finishReason: choice?.finish_reason ?? null,
      };
    }

    const result: CompletionResult = { content: '', reasoning: '', finishReason: null };
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      // SSE frames are newline-delimited; each "data:" line holds one JSON chunk.
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return result;
        let choice;
        try {
          choice = (JSON.parse(payload) as ChatCompletionResponse)?.choices?.[0];
        } catch {
          continue;
        }
        const delta = choice?.delta;
        // GLM/DeepSeek stream `reasoning_content`; OpenRouter and others use `reasoning`.
        result.reasoning += delta?.reasoning_content || delta?.reasoning || '';
        result.content += delta?.content ?? '';
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
      }
    }
    return result;
  } catch (error) {
    // Detect our own timer rather than error.name: the abort reason can vary
    // by runtime and by mock.
    if (timedOut) {
      throw new Error(`LLM did not respond within ${REQUEST_TIMEOUT_MS / 1000} s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// PLaMo 3 Translate only translates: it renders no system prompt (its GGUF
// chat template drops system messages, and older templates translate them as
// text) and takes the target language from chat_template_kwargs.
const PLAMO_TRANSLATE_MODEL = /^(pfnet\/)?plamo-3-translate(-|$)/i;
const PLAMO_STOP_TOKENS = ['<|plamo:tag|>', '<|plamo:bos|>'];

/** The PLaMo chat template accepts only lowercase codes with an optional 4-letter script subtag. */
function toPlamoLanguageCode(langCode: string): string {
  const lower = langCode.toLowerCase();
  if (lower === 'zh-cn') return 'zh-hans';
  if (lower === 'zh-tw') return 'zh-hant';
  return lower.split('-')[0] ?? lower;
}

interface PlamoOptions {
  targetLang: string;
}

export class OpenAICompatibleClient {
  private config: OpenAIConfig;
  private transport: CompletionTransport;
  private isPlamoTranslate: boolean;

  constructor(config: OpenAIConfig, transport: CompletionTransport = fetchChatCompletion) {
    this.transport = transport;
    // Users often paste the full endpoint URL; strip it so we don't request .../chat/completions/chat/completions
    const baseUrl = config.baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '');
    this.config = { ...config, baseUrl };
    this.isPlamoTranslate = PLAMO_TRANSLATE_MODEL.test(config.model.trim());
  }

  /**
   * Translate text using OpenAI-compatible API with automatic language detection
   * The LLM will automatically detect the source language
   */
  async translate(text: string, targetLang: string, _sourceLang?: string): Promise<string> {
    // Note: sourceLang is ignored as LLM can auto-detect the language
    if (this.isPlamoTranslate) {
      return this.requestCompletion([{ role: 'user', content: text }], 1000, { targetLang });
    }

    const targetLanguageName = this.getLanguageName(targetLang);

    const systemPrompt = buildTranslationSystemPrompt(
      targetLanguageName, this.config.purpose ?? 'incoming', 'single', this.config.draftPrompt, this.config.draftPromptEnabled,
    );

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: text,
      },
    ];

    return this.requestCompletion(messages, this.config.purpose === 'draft' ? 3000 : 1000);
  }

  /**
   * Translate multiple texts in a single API request
   * More efficient for batch processing
   */
  async translateBatch(
    texts: string[], targetLang: string, _sourceLang?: string,
    groupIds?: readonly string[],
  ): Promise<string[]> {
    if (!texts.length) return [];

    // This specialized model does not implement indexed JSON translation.
    if (this.isPlamoTranslate) {
      const results: string[] = [];
      for (const text of texts) results.push(await this.translate(text, targetLang));
      return results;
    }

    const extra = parseExtraBody(this.config.extraBody);
    if (!extra.ok) throw new Error(`Invalid extra request body in settings: ${extra.error}`);
    const configuredBudget = extra.value?.max_completion_tokens ?? extra.value?.max_tokens;
    const budget = typeof configuredBudget === 'number' && Number.isFinite(configuredBudget) && configuredBudget > 0
      ? configuredBudget : 4000;

    // Match Phrase Desk's length-based planning rather than a fixed count of
    // five texts. JSON overhead is included in the estimate; a hard unit cap
    // bounds response alignment work. The user's output budget is unchanged.
    const charBudget = Math.max(320, Math.min(16000, Math.floor(budget * 1.15)));
    const grouped = groupIds?.length === texts.length;
    const numericGroups = new Map<string, number>();
    const items = texts.map((text, id) => {
      if (!grouped) return { id, text };
      const key = groupIds![id]!;
      let group = numericGroups.get(key);
      if (group === undefined) {
        group = numericGroups.size;
        numericGroups.set(key, group);
      }
      return { id, group, text };
    });
    const ranges = planBatchRanges(items.map(item => JSON.stringify(item).length + 1),
      charBudget - 2, 64, grouped ? groupIds : undefined);
    const systemPrompt = buildTranslationSystemPrompt(
      this.getLanguageName(targetLang), this.config.purpose ?? 'incoming',
      grouped ? 'aligned-batch' : 'batch', this.config.draftPrompt, this.config.draftPromptEnabled,
    );
    const results = texts.map(() => '');
    for (const range of ranges) {
      const chunk = items.slice(range.start, range.end).map((item, id) => ({ ...item, id }));
      let content: string;
      try {
        content = await this.requestCompletion([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(chunk) },
        ], 4000);
      } catch (error) {
        // Do not pay again for previously completed chunks, or continue
        // issuing requests after a transport failure.
        if (range.start === 0) throw error;
        console.error('[OpenAI] Later translation chunk failed; retaining completed results:', error);
        break;
      }
      const parsed = parseIndexedTranslations(content, chunk.length);
      for (const [id, translation] of parsed) results[range.start + id] = translation;
      if (parsed.size !== chunk.length) {
        // Missing IDs are left empty, not guessed or retried individually.
        // Callers retain the source and cache only usable results.
        console.debug('[OpenAI] Incomplete aligned response:', parsed.size, '/', chunk.length);
      }
    }
    return results;
  }

  /**
   * Send one chat-completions request and return the trimmed, non-empty content
   */
  private async requestCompletion(
    messages: ChatMessage[],
    maxTokens: number,
    plamo?: PlamoOptions,
  ): Promise<string> {
    // Parsed per request so an invalid stored value surfaces as a translate error
    // instead of making the factory throw.
    const extra = parseExtraBody(this.config.extraBody);
    if (!extra.ok) {
      throw new Error(`Invalid extra request body in settings: ${extra.error}`);
    }

    const body: Record<string, unknown> = {
      // Lower temperature for more consistent translations; the PLaMo model card uses greedy decoding.
      temperature: plamo ? 0 : 0.3,
      max_tokens: maxTokens,
      ...(plamo && { stop: PLAMO_STOP_TOKENS }),
      ...extra.value, // may override temperature/max_tokens or add fields
      model: this.config.model, // core fields always win
      messages,
    };
    if (plamo) {
      // Keep other template options (context, glossary, form) from the extra body.
      const kwargs = extra.value?.chat_template_kwargs;
      body.chat_template_kwargs = {
        ...(typeof kwargs === 'object' && kwargs !== null && !Array.isArray(kwargs) ? kwargs : {}),
        target_lang: toPlamoLanguageCode(plamo.targetLang),
      };
    }
    // A null in the extra body means "omit this field": some endpoints reject
    // max_tokens or temperature. JSON.stringify would otherwise send null.
    for (const [key, value] of Object.entries(body)) {
      if (value === null) delete body[key];
    }

    const result = await this.transport({
      url: `${this.config.baseUrl}/chat/completions`,
      apiKey: this.config.apiKey,
      body: { ...body, stream: true },
    });
    const content = result.content.trim();

    if (!content) {
      if (result.reasoning.trim() || result.finishReason === 'length') {
        throw new Error(REASONING_EXHAUSTED_MESSAGE);
      }
      throw new Error('OpenAI API returned empty translation');
    }

    return content;
  }

  /**
   * Convert language code to full language name for better LLM understanding
   */
  private getLanguageName(langCode: string): string {
    const languageMap: Record<string, string> = {
      'en': 'English',
      'ja': 'Japanese',
      'ko': 'Korean',
      'zh': 'Chinese',
      'zh-cn': 'Simplified Chinese',
      'zh-tw': 'Traditional Chinese',
      'es': 'Spanish',
      'fr': 'French',
      'de': 'German',
      'pt': 'Portuguese',
      'ru': 'Russian',
      'it': 'Italian',
      'nl': 'Dutch',
      'pl': 'Polish',
      'ar': 'Arabic',
      'hi': 'Hindi',
      'th': 'Thai',
      'vi': 'Vietnamese',
      'id': 'Indonesian',
      'tr': 'Turkish',
      'sv': 'Swedish',
      'da': 'Danish',
      'fi': 'Finnish',
      'no': 'Norwegian',
    };

    return languageMap[langCode.toLowerCase()] || langCode.toUpperCase();
  }
}

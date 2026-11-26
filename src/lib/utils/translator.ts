import { planBatchRanges } from '@/lib/api/batch-plan';
import { createStorage } from '@/lib/cache/factory';
import { createTranslationClient } from '@/lib/api/factory';
import type { TranslationCacheEntry } from '@/types/cache';
import { getSettings } from './settings';

export async function translateMessage(
  messageId: string,
  text: string,
  targetLang: string
): Promise<string> {
  const storage = await createStorage();

  // Check cache
  const cached = await storage.get(messageId);
  const hit = cached?.translations[targetLang];
  if (hit) {
    console.log(`[Translator] Cache hit for message ${messageId}`);
    return hit;
  }

  // Get settings and create client
  const settings = await getSettings();
  const client = createTranslationClient(settings);

  // Call API
  const translation = await client.translate(text, targetLang);

  // chrome-builtin returns the original text when it cannot translate (unsupported
  // pair, missing language pack, etc). Caching that would pin the message as
  // untranslated even after the pack becomes available.
  if (settings.translationProvider === 'chrome-builtin' && translation === text) {
    return translation;
  }

  // Save to cache
  const entry: TranslationCacheEntry = {
    translations: {
      ...(cached?.translations || {}),
      [targetLang]: translation,
    },
    timestamp: Date.now(),
  };
  await storage.set(messageId, entry);

  console.log(`[Translator] Translated and cached message ${messageId}`);
  return translation;
}

/**
 * Translate multiple messages in a single batch request
 * More efficient than translating individually
 */
export async function translateMessageBatch(
  messages: Array<{ id: string; content: string; groupId?: string }>,
  targetLang: string
): Promise<Map<string, string>> {
  const storage = await createStorage();
  const settings = await getSettings();
  const results = new Map<string, string>();

  // Separate cached and uncached messages
  const uncachedMessages: typeof messages = [];
  const uncachedTexts: string[] = [];

  for (const message of messages) {
    const cached = await storage.get(message.id);
    const hit = cached?.translations[targetLang];
    if (hit) {
      results.set(message.id, hit);
      console.log(`[Translator] Cache hit for message ${message.id}`);
    } else {
      uncachedMessages.push(message);
      uncachedTexts.push(message.content);
    }
  }

  // If all messages are cached, return immediately
  if (uncachedMessages.length === 0) {
    return results;
  }

  // Call batch translation API
  const client = createTranslationClient(settings);
  let translations: string[];

  try {
    if (settings.translationProvider === 'openai' && uncachedMessages.some(message => message.groupId !== undefined)) {
      translations = await client.translateBatch(uncachedTexts, targetLang, undefined,
        uncachedMessages.map(message => message.groupId ?? message.id));
    } else if (settings.translationProvider === 'google' || settings.translationProvider === 'deepl') {
      // Respect the services' request size and item limits, while keeping
      // ordinary short messages in one request.
      const encoder = new TextEncoder();
      const ranges = planBatchRanges(uncachedTexts.map(text => encoder.encode(JSON.stringify(text)).length + 1),
        90 * 1024, settings.translationProvider === 'deepl' ? 50 : 128);
      translations = [];
      for (const range of ranges) {
        const part = await client.translateBatch(uncachedTexts.slice(range.start, range.end), targetLang);
        if (part.length !== range.end - range.start) throw new Error('Translation batch result count mismatch');
        translations.push(...part);
      }
    } else {
      translations = await client.translateBatch(uncachedTexts, targetLang);
    }
  } catch (error) {
    console.error('[Translator] Batch translation failed:', error);
    throw error;
  }

  if (translations.length !== uncachedMessages.length) {
    throw new Error('[Translator] translateBatch returned a mismatched number of results');
  }

  // Save translations to cache and results
  for (let i = 0; i < uncachedMessages.length; i++) {
    const message = uncachedMessages[i];
    const translation = translations[i];
    if (message === undefined || !translation?.trim()) continue;

    results.set(message.id, translation);

    // See the comment in translateMessage: skip caching a chrome-builtin no-op.
    if (settings.translationProvider === 'chrome-builtin' && translation === message.content) {
      continue;
    }

    // Update cache
    const cached = await storage.get(message.id);
    const entry: TranslationCacheEntry = {
      translations: {
        ...(cached?.translations || {}),
        [targetLang]: translation,
      },
      timestamp: Date.now(),
    };
    await storage.set(message.id, entry);
  }

  console.log(`[Translator] Batch translated and cached ${uncachedMessages.length} messages`);
  return results;
}

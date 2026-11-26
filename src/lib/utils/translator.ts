import { planBatchRanges } from '@/lib/api/batch-plan';
import { createStorage } from '@/lib/cache/factory';
import type { ITranslationStorage } from '@/lib/cache/types';
import { createTranslationClient } from '@/lib/api/factory';
import type { TranslationCacheEntry } from '@/types/cache';
import { getSettings } from './settings';
import { validateTranslation } from './translation-validation';

export async function translateMessage(
  messageId: string,
  text: string,
  targetLang: string
): Promise<string> {
  const storage = await createStorage();

  // Check cache
  const cached = await storage.get(messageId);
  const hit = cached?.source === text ? validateTranslation(text, cached.translations[targetLang], targetLang) : null;
  if (hit) {
    console.log(`[Translator] Cache hit for message ${messageId}`);
    return hit;
  }

  // Get settings and create client
  const settings = await getSettings();
  const client = createTranslationClient(settings);

  // Call API
  const translation = validateTranslation(text, await client.translate(text, targetLang), targetLang);
  if (translation === null) return text;

  // chrome-builtin returns the original text when it cannot translate (unsupported
  // pair, missing language pack, etc). Caching that would pin the message as
  // untranslated even after the pack becomes available.
  if (settings.translationProvider === 'chrome-builtin' && translation === text) {
    return translation;
  }

  // Save to cache
  const latest = await storage.get(messageId);
  const entry: TranslationCacheEntry = {
    source: text,
    translations: {
      ...(latest?.source === text ? latest.translations : {}),
      [targetLang]: translation,
    },
    timestamp: Date.now(),
  };
  await storage.set(messageId, entry);

  console.log(`[Translator] Translated and cached message ${messageId}`);
  return translation;
}

async function readCachedEntries(storage: ITranslationStorage, ids: string[]): Promise<Map<string, TranslationCacheEntry>> {
  if (storage.getMany) return storage.getMany(ids);
  const entries = new Map<string, TranslationCacheEntry>();
  for (const id of ids) {
    const entry = await storage.get(id);
    if (entry) entries.set(id, entry);
  }
  return entries;
}

/**
 * Translate visible units together, reading and writing their cache entries in bulk.
 */
export async function translateMessageBatch(
  messages: Array<{ id: string; content: string; groupId?: string }>,
  targetLang: string
): Promise<Map<string, string>> {
  const storage = await createStorage();
  const settings = await getSettings();
  const results = new Map<string, string>();

  const cachedEntries = await readCachedEntries(storage, messages.map(message => message.id));
  const uncachedMessages: typeof messages = [];
  const uncachedTexts: string[] = [];

  for (const message of messages) {
    const cached = cachedEntries.get(message.id);
    const hit = cached?.source === message.content
      ? validateTranslation(message.content, cached.translations[targetLang], targetLang) : null;
    if (hit) results.set(message.id, hit);
    else {
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

  const cacheable = new Map<string, { source: string; translation: string }>();
  for (let i = 0; i < uncachedMessages.length; i++) {
    const message = uncachedMessages[i];
    if (message === undefined) continue;
    const translation = validateTranslation(message.content, translations[i], targetLang);
    if (translation === null) continue;
    results.set(message.id, translation);
    if (settings.translationProvider === 'chrome-builtin' && translation === message.content) continue;
    cacheable.set(message.id, { source: message.content, translation });
  }

  if (cacheable.size) {
    // Read fresh entries before merging: another completed request may have
    // saved a different target language during the API call.
    const latest = await readCachedEntries(storage, [...cacheable.keys()]);
    const entries = new Map<string, TranslationCacheEntry>();
    const timestamp = Date.now();
    for (const [id, { source, translation }] of cacheable) {
      const prior = latest.get(id);
      entries.set(id, {
        source,
        translations: { ...(prior?.source === source ? prior.translations : {}), [targetLang]: translation },
        timestamp,
      });
    }
    if (storage.setMany) await storage.setMany(entries);
    else for (const [id, entry] of entries) await storage.set(id, entry);
  }
  console.log(`[Translator] Batch cache: ${results.size} usable, ${cacheable.size} saved`);
  return results;
}

export interface TranslationCacheEntry {
  // Legacy entries without an exact source cannot be trusted after an edit.
  source?: string;
  translations: {
    [targetLanguage: string]: string; // e.g., { "ja": "こんにちは", "de": "Guten Tag" }
  };
  timestamp: number; // Unix timestamp (milliseconds)
}

export interface CacheSettings {
  ttlDays: number; // Default: 7 days
}

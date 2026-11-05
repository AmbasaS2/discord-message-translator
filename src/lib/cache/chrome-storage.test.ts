import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChromeStorageCache } from './chrome-storage';
import type { TranslationCacheEntry } from '@/types/cache';
import { mockedAsync } from '../../../vitest.setup';

// Serves chrome.storage.local.get by requested key, because cache entries and
// the cacheTTLDays setting now live in the same storage area.
const mockLocalStorage = (data: Record<string, unknown>) =>
  mockedAsync(chrome.storage.local.get).mockImplementation(async (keys?: unknown) => {
    if (keys == null) return data;
    return Object.fromEntries(
      (keys as string[]).filter((key) => key in data).map((key) => [key, data[key]]),
    );
  });

describe('ChromeStorageCache', () => {
  let cache: ChromeStorageCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new ChromeStorageCache();
  });

  describe('get', () => {
    it('should return cached entry if exists and not expired', async () => {
      const messageId = 'test-message-1';
      const entry: TranslationCacheEntry = {
        translations: { en: 'Hello' },
        timestamp: Date.now(),
      };

      mockLocalStorage({
        [`cache_${messageId}`]: entry,
        cacheTTLDays: 7,
      });

      const result = await cache.get(messageId);

      expect(result).toEqual(entry);
      expect(chrome.storage.local.get).toHaveBeenCalledWith([`cache_${messageId}`]);
      expect(chrome.storage.local.get).toHaveBeenCalledWith(['cacheTTLDays']);
    });

    it('should return null if entry does not exist', async () => {
      const messageId = 'non-existent';

      mockLocalStorage({});

      const result = await cache.get(messageId);

      expect(result).toBeNull();
    });

    it('should delete and return null if entry is expired', async () => {
      const messageId = 'test-message-expired';
      const expiredEntry: TranslationCacheEntry = {
        translations: { en: 'Old translation' },
        timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      };

      mockLocalStorage({
        [`cache_${messageId}`]: expiredEntry,
        cacheTTLDays: 7,
      });
      mockedAsync(chrome.storage.local.remove).mockResolvedValue(undefined);

      const result = await cache.get(messageId);

      expect(result).toBeNull();
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([`cache_${messageId}`]);
    });

    it('should use the stored cacheTTLDays from local storage', async () => {
      const messageId = 'test-message-short-ttl';
      const entry: TranslationCacheEntry = {
        translations: { en: 'Two days old' },
        timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
      };

      // Within the 7-day default, so it only expires if the stored 1-day TTL is read.
      mockLocalStorage({
        [`cache_${messageId}`]: entry,
        cacheTTLDays: 1,
      });
      mockedAsync(chrome.storage.local.remove).mockResolvedValue(undefined);

      const result = await cache.get(messageId);

      expect(result).toBeNull();
      expect(chrome.storage.local.remove).toHaveBeenCalledWith([`cache_${messageId}`]);
    });
  });

  describe('set', () => {
    it('should save entry to storage', async () => {
      const messageId = 'test-message-2';
      const entry: TranslationCacheEntry = {
        translations: { ja: 'こんにちは' },
        timestamp: Date.now(),
      };

      mockedAsync(chrome.storage.local.getBytesInUse).mockResolvedValue(1000);
      mockedAsync(chrome.storage.local.set).mockResolvedValue(undefined);

      await cache.set(messageId, entry);

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [`cache_${messageId}`]: entry,
      });
    });
  });

  describe('delete', () => {
    it('should remove entry from storage', async () => {
      const messageId = 'test-message-3';

      mockedAsync(chrome.storage.local.remove).mockResolvedValue(undefined);

      await cache.delete(messageId);

      expect(chrome.storage.local.remove).toHaveBeenCalledWith([`cache_${messageId}`]);
    });
  });

  describe('clear', () => {
    it('should remove all cache entries', async () => {
      const allData = {
        cache_message1: { translations: {}, timestamp: Date.now() },
        cache_message2: { translations: {}, timestamp: Date.now() },
        otherKey: 'value',
      };

      mockedAsync(chrome.storage.local.get).mockResolvedValue(allData);
      mockedAsync(chrome.storage.local.remove).mockResolvedValue(undefined);

      await cache.clear();

      expect(chrome.storage.local.remove).toHaveBeenCalledWith([
        'cache_message1',
        'cache_message2',
      ]);
    });
  });

  describe('getAllEntries', () => {
    it('should return all cache entries as a Map', async () => {
      const entry1: TranslationCacheEntry = {
        translations: { en: 'Hello' },
        timestamp: Date.now(),
      };
      const entry2: TranslationCacheEntry = {
        translations: { ja: 'こんにちは' },
        timestamp: Date.now(),
      };

      mockedAsync(chrome.storage.local.get).mockResolvedValue({
        cache_message1: entry1,
        cache_message2: entry2,
        otherKey: 'value',
      });

      const result = await cache.getAllEntries();

      expect(result.size).toBe(2);
      expect(result.get('message1')).toEqual(entry1);
      expect(result.get('message2')).toEqual(entry2);
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired entries', async () => {
      const now = Date.now();
      const validEntry: TranslationCacheEntry = {
        translations: { en: 'Valid' },
        timestamp: now,
      };
      const expiredEntry: TranslationCacheEntry = {
        translations: { en: 'Expired' },
        timestamp: now - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      };

      mockLocalStorage({
        cache_valid: validEntry,
        cache_expired: expiredEntry,
        cacheTTLDays: 7,
      });
      mockedAsync(chrome.storage.local.remove).mockResolvedValue(undefined);

      await cache.cleanupExpired();

      expect(chrome.storage.local.remove).toHaveBeenCalledWith(['cache_expired']);
    });
  });

  describe('getStats', () => {
    it('should return stats for empty cache', async () => {
      mockLocalStorage({ cacheTTLDays: 7 });
      mockedAsync(chrome.storage.local.getBytesInUse).mockResolvedValue(0);

      const stats = await cache.getStats();

      expect(stats.entryCount).toBe(0);
      expect(stats.bytesInUse).toBe(0);
      expect(stats.maxBytes).toBe(10 * 1024 * 1024); // 10MB
      expect(stats.usagePercent).toBe(0);
      expect(stats.expiredCount).toBe(0);
    });

    it('should return stats with cached entries', async () => {
      const now = Date.now();
      const entry1: TranslationCacheEntry = {
        translations: { en: 'Hello', ja: 'こんにちは' },
        timestamp: now,
      };
      const entry2: TranslationCacheEntry = {
        translations: { en: 'World' },
        timestamp: now,
      };

      mockLocalStorage({
        cache_message1: entry1,
        cache_message2: entry2,
        cacheTTLDays: 7,
      });

      mockedAsync(chrome.storage.local.getBytesInUse).mockResolvedValue(5 * 1024 * 1024); // 5MB

      const stats = await cache.getStats();

      expect(stats.entryCount).toBe(2);
      expect(stats.bytesInUse).toBe(5 * 1024 * 1024);
      expect(stats.maxBytes).toBe(10 * 1024 * 1024);
      expect(stats.usagePercent).toBe(50);
      expect(stats.expiredCount).toBe(0);
    });

    it('should count expired entries correctly', async () => {
      const now = Date.now();
      const validEntry: TranslationCacheEntry = {
        translations: { en: 'Valid' },
        timestamp: now,
      };
      const expiredEntry1: TranslationCacheEntry = {
        translations: { en: 'Expired 1' },
        timestamp: now - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      };
      const expiredEntry2: TranslationCacheEntry = {
        translations: { en: 'Expired 2' },
        timestamp: now - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      };

      mockLocalStorage({
        cache_valid: validEntry,
        cache_expired1: expiredEntry1,
        cache_expired2: expiredEntry2,
        cacheTTLDays: 7,
      });

      mockedAsync(chrome.storage.local.getBytesInUse).mockResolvedValue(2 * 1024 * 1024); // 2MB

      const stats = await cache.getStats();

      expect(stats.entryCount).toBe(3);
      expect(stats.expiredCount).toBe(2);
      expect(stats.usagePercent).toBe(20);
    });

    it('should calculate usage percent correctly for high usage', async () => {
      const now = Date.now();
      const entry: TranslationCacheEntry = {
        translations: { en: 'Test' },
        timestamp: now,
      };

      mockLocalStorage({
        cache_message1: entry,
        cacheTTLDays: 7,
      });

      mockedAsync(chrome.storage.local.getBytesInUse).mockResolvedValue(9 * 1024 * 1024); // 9MB (90%)

      const stats = await cache.getStats();

      expect(stats.entryCount).toBe(1);
      expect(stats.usagePercent).toBe(90);
    });
  });
});

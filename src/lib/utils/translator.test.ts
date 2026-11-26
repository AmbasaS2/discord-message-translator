import { describe, it, expect, beforeEach, vi } from 'vitest';
import { translateMessage, translateMessageBatch } from './translator';

// Mock dependencies
vi.mock('@/lib/cache/factory', () => ({
  createStorage: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
  })),
}));

vi.mock('./settings', () => ({
  getSettings: vi.fn(),
}));

vi.mock('@/lib/api/google-translate', () => ({
  GoogleTranslateClient: vi.fn().mockImplementation(function () {
    return { translate: vi.fn() };
  }),
}));

vi.mock('@/lib/api/deepl', () => ({
  DeepLClient: vi.fn().mockImplementation(function () {
    return { translate: vi.fn() };
  }),
}));

vi.mock('@/lib/api/openai-compatible', () => ({
  OpenAICompatibleClient: vi.fn().mockImplementation(function () {
    return { translate: vi.fn() };
  }),
}));

// factory.ts caches a single ChromeBuiltinTranslator instance, so the mock
// instance methods are hoisted and shared across every `new` call.
const chromeBuiltinMocks = vi.hoisted(() => ({
  translate: vi.fn(),
  translateBatch: vi.fn(),
}));

vi.mock('@/lib/api/chrome-builtin', () => {
  const ChromeBuiltinTranslator = vi.fn().mockImplementation(function () {
    return { translate: chromeBuiltinMocks.translate, translateBatch: chromeBuiltinMocks.translateBatch };
  });
  (ChromeBuiltinTranslator as unknown as { isAvailable: () => boolean }).isAvailable = () => true;
  return { ChromeBuiltinTranslator };
});

import { createStorage } from '@/lib/cache/factory';
import { getSettings } from './settings';
import { GoogleTranslateClient } from '@/lib/api/google-translate';
import { DeepLClient } from '@/lib/api/deepl';
import { OpenAICompatibleClient } from '@/lib/api/openai-compatible';

describe('Translator Utilities', () => {
  let mockStorage: any;
  let mockTranslate: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorage = {
      get: vi.fn(),
      set: vi.fn(),
    };

    mockTranslate = vi.fn();

    vi.mocked(createStorage).mockResolvedValue(mockStorage);
    vi.mocked(GoogleTranslateClient).mockImplementation(function () {
      return { translate: mockTranslate } as any;
    });
    chromeBuiltinMocks.translate.mockReset();
  });

  it('bulk reads and saves successful grouped units without caching a missing AI result', async () => {
    const existing = { source: 'First.', translations: { ko: '첫째' }, timestamp: Date.now() };
    mockStorage.getMany = vi.fn().mockResolvedValueOnce(new Map([['a', existing]])).mockResolvedValueOnce(new Map());
    mockStorage.setMany = vi.fn().mockResolvedValue(undefined);
    const batch = vi.fn().mockResolvedValue(['둘째', '']);
    vi.mocked(OpenAICompatibleClient).mockImplementation(function () {
      return { translateBatch: batch } as any;
    });
    vi.mocked(getSettings).mockResolvedValue({
      translationProvider: 'openai',
      apiKeys: {},
      openaiPresets: [{ id: 'p1', name: 'test', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'key' }],
      activeOpenaiPresetId: 'p1',
    } as any);

    const result = await translateMessageBatch([
      { id: 'a', content: 'First.', groupId: 'm1' },
      { id: 'b', content: 'Second.', groupId: 'm1' },
      { id: 'c', content: 'Third.', groupId: 'm1' },
    ], 'ko');

    expect(result).toEqual(new Map([['a', '첫째'], ['b', '둘째']]));
    expect(batch).toHaveBeenCalledWith(['Second.', 'Third.'], 'ko', undefined, ['m1', 'm1']);
    expect(mockStorage.getMany).toHaveBeenCalledTimes(2);
    expect(mockStorage.getMany).toHaveBeenLastCalledWith(['b']);
    expect(mockStorage.get).not.toHaveBeenCalled();
    expect(mockStorage.setMany).toHaveBeenCalledTimes(1);
    const saved = mockStorage.setMany.mock.calls[0][0] as Map<string, any>;
    expect([...saved.keys()]).toEqual(['b']);
    expect(saved.get('b').translations.ko).toBe('둘째');
  });

  describe('translateMessage', () => {
    it('should return cached translation if available', async () => {
      const messageId = 'msg-123';
      const cachedEntry = {
        source: 'Hello',
        translations: {
          ja: 'こんにちは',
        },
        timestamp: Date.now(),
      };

      mockStorage.get.mockResolvedValue(cachedEntry);
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'google',
        apiKeys: { google: 'test-key' },
      } as any);

      const result = await translateMessage(messageId, 'Hello', 'ja');

      expect(result).toBe('こんにちは');
      expect(mockTranslate).not.toHaveBeenCalled();
    });

    it.each([undefined, 'Old text.'])('does not reuse an unverified or edited source (%s)', async source => {
      mockStorage.get.mockResolvedValue({ source, translations: { ko: '이전 번역' }, timestamp: Date.now() });
      mockTranslate.mockResolvedValue('새 문장.');
      vi.mocked(getSettings).mockResolvedValue({ translationProvider: 'google', apiKeys: { google: 'key' } } as any);
      expect(await translateMessage('same-id', 'New text.', 'ko')).toBe('새 문장.');
      expect(mockTranslate).toHaveBeenCalledWith('New text.', 'ko');
      expect(mockStorage.set).toHaveBeenCalledWith('same-id', expect.objectContaining({
        source: 'New text.', translations: { ko: '새 문장.' },
      }));
    });

    it('does not persist a broken placeholder result', async () => {
      mockStorage.get.mockResolvedValue(null);
      mockTranslate.mockResolvedValue('링크를 읽어.');
      vi.mocked(getSettings).mockResolvedValue({ translationProvider: 'google', apiKeys: { google: 'key' } } as any);
      expect(await translateMessage('link', 'Read §P0§.', 'ko')).toBe('Read §P0§.');
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it('should call Google API and cache result when no cache exists', async () => {
      const messageId = 'msg-456';
      const translation = 'Bonjour';

      mockStorage.get.mockResolvedValue(null);
      mockTranslate.mockResolvedValue(translation);
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'google',
        apiKeys: { google: 'test-key' },
      } as any);

      const result = await translateMessage(messageId, 'Hello', 'fr');

      expect(result).toBe(translation);
      expect(mockTranslate).toHaveBeenCalledWith('Hello', 'fr');
      expect(mockStorage.set).toHaveBeenCalledWith(
        messageId,
        expect.objectContaining({
          translations: {
            fr: translation,
          },
        })
      );
    });

    it('should call DeepL API when provider is deepl', async () => {
      const messageId = 'msg-deepl';
      const translation = 'Hallo';

      mockStorage.get.mockResolvedValue(null);
      const mockDeepLTranslate = vi.fn().mockResolvedValue(translation);
      vi.mocked(DeepLClient).mockImplementation(function () {
        return { translate: mockDeepLTranslate } as any;
      });

      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'deepl',
        apiKeys: { deepl: 'test-deepl-key' },
      } as any);

      const result = await translateMessage(messageId, 'Hello', 'de');

      expect(result).toBe(translation);
      expect(mockDeepLTranslate).toHaveBeenCalledWith('Hello', 'de');
    });

    it('should call OpenAI API when provider is openai', async () => {
      const messageId = 'msg-openai';
      const translation = 'こんにちは';

      mockStorage.get.mockResolvedValue(null);
      const mockOpenAITranslate = vi.fn().mockResolvedValue(translation);
      vi.mocked(OpenAICompatibleClient).mockImplementation(function () {
        return { translate: mockOpenAITranslate } as any;
      });

      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'openai',
        apiKeys: {},
        openaiPresets: [
          { id: 'p1', name: 'gpt-4', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4', apiKey: 'test-openai-key' },
        ],
        activeOpenaiPresetId: 'p1',
      } as any);

      const result = await translateMessage(messageId, 'Hello', 'ja');

      expect(result).toBe(translation);
      expect(mockOpenAITranslate).toHaveBeenCalledWith('Hello', 'ja');
    });

    it('should throw error if Google API key is not configured', async () => {
      mockStorage.get.mockResolvedValue(null);
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'google',
        apiKeys: {},
      } as any);

      await expect(translateMessage('msg-789', 'Hello', 'ja')).rejects.toThrow(
        'Google Translate API key is not configured'
      );
    });

    it('should throw error if DeepL API key is not configured', async () => {
      mockStorage.get.mockResolvedValue(null);
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'deepl',
        apiKeys: {},
      } as any);

      await expect(translateMessage('msg-deepl', 'Hello', 'ja')).rejects.toThrow(
        'DeepL API key is not configured'
      );
    });

    it('should throw error if OpenAI API is not configured', async () => {
      mockStorage.get.mockResolvedValue(null);
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'openai',
        apiKeys: {},
        openaiPresets: [],
        activeOpenaiPresetId: null,
      } as any);

      await expect(translateMessage('msg-openai', 'Hello', 'ja')).rejects.toThrow(
        'OpenAI API is not configured'
      );
    });

    it('should throw error if OpenAI model is not configured', async () => {
      mockStorage.get.mockResolvedValue(null);
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'openai',
        apiKeys: {},
        openaiPresets: [
          { id: 'p1', name: 'x', baseUrl: 'https://api.example.com/v1', model: '', apiKey: 'test-key' },
        ],
        activeOpenaiPresetId: 'p1',
      } as any);

      await expect(translateMessage('msg-openai-model', 'Hello', 'ja')).rejects.toThrow(
        'OpenAI model is not configured'
      );
    });

    it('should merge new translation with existing cache', async () => {
      const messageId = 'msg-999';
      const existingCache = {
        source: 'Hello',
        translations: {
          ja: 'こんにちは',
        },
        timestamp: Date.now() - 1000,
      };

      mockStorage.get.mockResolvedValue(existingCache);
      mockTranslate.mockResolvedValue('Hola');
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'google',
        apiKeys: { google: 'test-key' },
      } as any);

      await translateMessage(messageId, 'Hello', 'es');

      expect(mockStorage.set).toHaveBeenCalledWith(
        messageId,
        expect.objectContaining({
          translations: {
            ja: 'こんにちは',
            es: 'Hola',
          },
        })
      );
    });

    it('does not cache a chrome-builtin result that equals the original text', async () => {
      mockStorage.get.mockResolvedValue(null);
      chromeBuiltinMocks.translate.mockResolvedValue('Hello');
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'chrome-builtin',
      } as any);

      const result = await translateMessage('msg-chrome-builtin', 'Hello', 'ja');

      expect(result).toBe('Hello');
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it('caches a google result that equals the original text', async () => {
      mockStorage.get.mockResolvedValue(null);
      mockTranslate.mockResolvedValue('Hello');
      vi.mocked(getSettings).mockResolvedValue({
        translationProvider: 'google',
        apiKeys: { google: 'test-key' },
      } as any);

      const result = await translateMessage('msg-google-noop', 'Hello', 'ja');

      expect(result).toBe('Hello');
      expect(mockStorage.set).toHaveBeenCalled();
    });
  });
});

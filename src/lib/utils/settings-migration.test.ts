import { describe, it, expect, beforeEach, vi } from 'vitest';
import { convertLegacySettings, initializeSettings } from './settings-migration';
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '@/types/settings';
import { mockedAsync } from '../../../vitest.setup';

describe('convertLegacySettings', () => {
  it('converts the single OpenAI configuration into the active preset', () => {
    const result = convertLegacySettings({
      translationProvider: 'openai',
      apiKeys: { google: 'g', openai: 'k' },
      openaiConfig: { baseUrl: 'http://h/v1', model: 'm', extraBody: '{"a":1}' },
      targetLanguage: 'fr',
    });

    const presets = result.openaiPresets as Array<Record<string, unknown>>;
    expect(presets).toHaveLength(1);
    expect(presets[0]).toEqual({
      id: expect.any(String),
      name: 'm',
      baseUrl: 'http://h/v1',
      model: 'm',
      apiKey: 'k',
      extraBody: '{"a":1}',
    });
    expect(result.activeOpenaiPresetId).toBe(presets[0]!.id);
    expect(result.apiKeys).toEqual({ google: 'g' });
    expect(result.translationProvider).toBe('openai');
    expect(result.targetLanguage).toBe('fr');
    expect('openaiConfig' in result).toBe(false);
  });

  it('uses the default base URL and name when only a key exists', () => {
    const result = convertLegacySettings({ apiKeys: { openai: 'k' } });

    const presets = result.openaiPresets as Array<Record<string, unknown>>;
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: '',
      apiKey: 'k',
    });
  });

  it('creates no preset when neither key nor config exists', () => {
    const result = convertLegacySettings({ apiKeys: { google: 'g' } });

    expect(result.openaiPresets).toEqual([]);
    expect(result.activeOpenaiPresetId).toBeNull();
    expect(result.apiKeys).toEqual({ google: 'g' });
  });

  it('omits an empty extraBody', () => {
    const result = convertLegacySettings({
      openaiConfig: { baseUrl: 'http://h/v1', model: 'm', extraBody: '  ' },
    });

    const presets = result.openaiPresets as Array<Record<string, unknown>>;
    expect(presets[0]!).not.toHaveProperty('extraBody');
  });
});

describe('initializeSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates sync data to local storage, then clears sync', async () => {
    const legacy = {
      translationProvider: 'openai',
      apiKeys: { openai: 'k' },
      openaiConfig: { baseUrl: 'http://h/v1', model: 'm' },
    };
    mockedAsync(chrome.storage.sync.get).mockResolvedValue(legacy);
    mockedAsync(chrome.storage.local.get).mockResolvedValue({});
    mockedAsync(chrome.storage.local.set).mockResolvedValue(undefined);
    mockedAsync(chrome.storage.sync.clear).mockResolvedValue(undefined);

    await initializeSettings();

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    const written = mockedAsync(chrome.storage.local.set).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(written.translationProvider).toBe('openai');
    expect(written.apiKeys).toEqual({});
    expect(written.openaiPresets).toHaveLength(1);
    expect(chrome.storage.sync.clear).toHaveBeenCalledTimes(1);

    const setOrder = mockedAsync(chrome.storage.local.set).mock.invocationCallOrder[0]!;
    const clearOrder = mockedAsync(chrome.storage.sync.clear).mock.invocationCallOrder[0]!;
    expect(setOrder).toBeLessThan(clearOrder);
  });

  it('skips the local write when settings already exist but still clears sync', async () => {
    mockedAsync(chrome.storage.sync.get).mockResolvedValue({ targetLanguage: 'fr' });
    mockedAsync(chrome.storage.local.get).mockResolvedValue({ targetLanguage: 'de' });
    mockedAsync(chrome.storage.sync.clear).mockResolvedValue(undefined);

    await initializeSettings();

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.clear).toHaveBeenCalledTimes(1);
  });

  it('writes defaults when both areas are empty and does not clear sync', async () => {
    mockedAsync(chrome.storage.sync.get).mockResolvedValue({});
    mockedAsync(chrome.storage.local.get).mockResolvedValue({});
    mockedAsync(chrome.storage.local.set).mockResolvedValue(undefined);

    await initializeSettings();

    expect(chrome.storage.local.set).toHaveBeenCalledWith(DEFAULT_SETTINGS);
    expect(chrome.storage.sync.clear).not.toHaveBeenCalled();
  });

  it('reads local storage with the settings keys, never null', async () => {
    mockedAsync(chrome.storage.sync.get).mockResolvedValue({});
    mockedAsync(chrome.storage.local.get).mockResolvedValue({ targetLanguage: 'de' });

    await initializeSettings();

    expect(chrome.storage.local.get).toHaveBeenCalledWith(SETTINGS_KEYS);
    expect(chrome.storage.local.get).not.toHaveBeenCalledWith(null);
  });
});

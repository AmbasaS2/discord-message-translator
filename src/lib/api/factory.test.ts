import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenAIPreset, Settings } from '@/types/settings';
import { DEFAULT_SETTINGS } from '@/types/settings';

vi.mock('./openai-compatible', () => ({
  OpenAICompatibleClient: vi.fn(),
}));

vi.mock('./openai-background', () => ({
  requestCompletionViaBackground: vi.fn(),
}));

import { createTranslationClient } from './factory';
import { OpenAICompatibleClient } from './openai-compatible';
import { requestCompletionViaBackground } from './openai-background';

const preset = (overrides: Partial<OpenAIPreset> = {}): OpenAIPreset => ({
  id: 'p1',
  name: 'Local',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'm1',
  apiKey: 'k1',
  ...overrides,
});

const openaiSettings = (
  presets: OpenAIPreset[],
  activeOpenaiPresetId: string | null,
): Settings => ({
  ...DEFAULT_SETTINGS,
  translationProvider: 'openai',
  openaiPresets: presets,
  activeOpenaiPresetId,
});

describe('createTranslationClient (openai)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds the client from the active preset with the background transport', () => {
    const second = preset({ id: 'p2', baseUrl: 'https://example.com/v1', model: 'm2', apiKey: 'k2', extraBody: '{"a":1}' });
    createTranslationClient(openaiSettings([preset(), second], 'p2'));

    expect(OpenAICompatibleClient).toHaveBeenCalledWith(
      { apiKey: 'k2', baseUrl: 'https://example.com/v1', model: 'm2', extraBody: '{"a":1}' },
      requestCompletionViaBackground,
    );
  });

  it('passes the saved draft style and its independent toggle without changing incoming options', () => {
    const settings = { ...openaiSettings([preset()], 'p1'), draftTranslationPrompt: 'Keep casual phrasing.', draftPromptEnabled: false };
    createTranslationClient(settings, 'draft');
    expect(OpenAICompatibleClient).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'draft', draftPrompt: 'Keep casual phrasing.', draftPromptEnabled: false }),
      requestCompletionViaBackground,
    );
  });

  it('uses the first preset when the active id is stale', () => {
    createTranslationClient(openaiSettings([preset(), preset({ id: 'p2', model: 'm2' })], 'gone'));

    expect(OpenAICompatibleClient).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'm1', apiKey: 'k1' }),
      requestCompletionViaBackground,
    );
  });

  it('accepts an empty API key', () => {
    expect(() => createTranslationClient(openaiSettings([preset({ apiKey: '' })], 'p1'))).not.toThrow();
    expect(OpenAICompatibleClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '' }),
      requestCompletionViaBackground,
    );
  });

  it('throws when there are no presets', () => {
    expect(() => createTranslationClient(openaiSettings([], null))).toThrow('OpenAI API is not configured');
  });

  it('throws when the active preset has no base URL', () => {
    expect(() => createTranslationClient(openaiSettings([preset({ baseUrl: ' ' })], 'p1'))).toThrow(
      'OpenAI API is not configured',
    );
  });

  it('throws when the active preset has no model', () => {
    expect(() => createTranslationClient(openaiSettings([preset({ model: '' })], 'p1'))).toThrow(
      'OpenAI model is not configured',
    );
  });
});

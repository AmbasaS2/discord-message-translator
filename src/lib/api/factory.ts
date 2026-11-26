import type { Settings } from '@/types/settings';
import { getActiveOpenaiPreset } from '@/lib/utils/openai-presets';
import { GoogleTranslateClient } from './google-translate';
import { DeepLClient } from './deepl';
import { OpenAICompatibleClient } from './openai-compatible';
import { requestCompletionViaBackground } from './openai-background';
import { ChromeBuiltinTranslator } from './chrome-builtin';
import type { TranslationPurpose } from './translation-prompts';

export interface TranslationClient {
  translate(text: string, targetLang: string, sourceLang?: string): Promise<string>;
  translateBatch(texts: string[], targetLang: string, sourceLang?: string, groupIds?: readonly string[]): Promise<string[]>;
}

// Singleton instance for Chrome Built-in Translator (to reuse translator cache)
let chromeBuiltinInstance: ChromeBuiltinTranslator | null = null;

function getChromeBuiltinTranslator(): ChromeBuiltinTranslator {
  if (!chromeBuiltinInstance) {
    chromeBuiltinInstance = new ChromeBuiltinTranslator();
  }
  return chromeBuiltinInstance;
}

export function createTranslationClient(settings: Settings, purpose: TranslationPurpose = 'incoming'): TranslationClient {
  switch (settings.translationProvider) {
    case 'google':
      if (!settings.apiKeys.google) {
        throw new Error('Google Translate API key is not configured');
      }
      return new GoogleTranslateClient(settings.apiKeys.google);

    case 'deepl':
      if (!settings.apiKeys.deepl) {
        throw new Error('DeepL API key is not configured');
      }
      return new DeepLClient(settings.apiKeys.deepl, true);

    case 'openai': {
      const preset = getActiveOpenaiPreset(settings);
      if (!preset || !preset.baseUrl.trim()) {
        throw new Error('OpenAI API is not configured');
      }
      if (!preset.model.trim()) {
        throw new Error('OpenAI model is not configured');
      }
      return new OpenAICompatibleClient({
        apiKey: preset.apiKey,
        baseUrl: preset.baseUrl,
        model: preset.model,
        extraBody: preset.extraBody,
        ...(purpose === 'draft' ? { purpose, draftPrompt: settings.draftTranslationPrompt, draftPromptEnabled: settings.draftPromptEnabled } : {}),
      }, requestCompletionViaBackground);
    }

    case 'chrome-builtin':
      if (!ChromeBuiltinTranslator.isAvailable()) {
        throw new Error('Chrome Built-in Translator API is not available. Please use Chrome 138+ or select a different provider.');
      }
      return getChromeBuiltinTranslator();

    default:
      throw new Error(`Unsupported translation provider: ${settings.translationProvider}`);
  }
}

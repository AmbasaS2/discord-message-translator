export interface OpenAIPreset {
  id: string; // crypto.randomUUID()
  name: string; // shown in the preset list
  baseUrl: string; // e.g., https://api.openai.com/v1; the client appends /chat/completions
  model: string; // model name as expected by the endpoint
  apiKey: string; // '' = send no Authorization header
  // Raw JSON object text merged into each chat-completions request body; omitted when empty.
  extraBody?: string;
}

export interface Settings {
  // Translation API settings
  translationProvider: 'google' | 'deepl' | 'openai' | 'chrome-builtin';
  apiKeys: {
    google?: string;
    deepl?: string;
    openai?: string; // Legacy single OpenAI-compatible key; replaced by openaiPresets
  };
  openaiPresets: OpenAIPreset[];
  activeOpenaiPresetId: string | null;
  // Legacy single OpenAI-compatible config; replaced by openaiPresets
  openaiConfig?: {
    baseUrl: string; // e.g., https://api.openai.com/v1
    model: string;   // model name as expected by the endpoint
    // Raw JSON object text merged into each chat-completions request body.
    extraBody?: string;
  };

  // Translation settings
  targetLanguage: string; // e.g., "ja", "en", "de"
  translationMode: 'replace' | 'append'; // Replace original or append translation
  autoTranslate: boolean; // Auto-translate on/off

  // Cache settings
  cacheTTLDays: number; // Default: 7

  // UI settings
  showOriginalOnHover: boolean; // Show original on hover

  // Language detection settings
  skipTargetLanguage: boolean; // Skip translation if message is already in target language
}

export const DEFAULT_SETTINGS: Settings = {
  translationProvider: 'google',
  apiKeys: {},
  openaiPresets: [],
  activeOpenaiPresetId: null,
  targetLanguage: 'ja',
  translationMode: 'replace',
  autoTranslate: true,
  cacheTTLDays: 7,
  showOriginalOnHover: false,
  skipTargetLanguage: false,
};

// Every Settings field is required and present in DEFAULT_SETTINGS, so its
// keys are exactly the keys settings code may read from chrome.storage.local
// (which also holds cache_* entries, so it must never be read with get(null)).
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

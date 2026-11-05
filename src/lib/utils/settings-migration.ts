import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '@/types/settings';

/**
 * Shape written to chrome.storage.sync by versions before presets. Kept as its
 * own type so removing the legacy fields from Settings does not affect it.
 */
interface LegacySyncSettings {
  apiKeys?: { google?: string; deepl?: string; openai?: string };
  openaiConfig?: { baseUrl?: string; model?: string; extraBody?: string };
  [key: string]: unknown;
}

/** Pure: legacy sync object -> object to write to local storage. */
export function convertLegacySettings(legacy: LegacySyncSettings): Record<string, unknown> {
  const { apiKeys, openaiConfig, ...rest } = legacy;
  const converted: Record<string, unknown> = { ...rest };

  if (apiKeys) {
    const { openai: _openai, ...otherKeys } = apiKeys;
    converted.apiKeys = otherKeys;
  }

  if (apiKeys?.openai || openaiConfig) {
    const extraBody = openaiConfig?.extraBody?.trim();
    const preset = {
      id: crypto.randomUUID(),
      name: openaiConfig?.model?.trim() || 'OpenAI',
      // Default the old options page used when no base URL was entered.
      baseUrl: openaiConfig?.baseUrl || 'https://api.openai.com/v1',
      model: openaiConfig?.model ?? '',
      apiKey: apiKeys?.openai ?? '',
      ...(extraBody ? { extraBody } : {}),
    };
    converted.openaiPresets = [preset];
    converted.activeOpenaiPresetId = preset.id;
  } else {
    converted.openaiPresets = [];
    converted.activeOpenaiPresetId = null;
  }

  return converted;
}

/** Called from runtime.onInstalled (install and every update). Idempotent. */
export async function initializeSettings(): Promise<void> {
  const synced = await chrome.storage.sync.get(null);
  // Explicit key list: local storage also holds cache_* entries (up to 10 MB).
  const local = await chrome.storage.local.get(SETTINGS_KEYS);
  const hasSynced = Object.keys(synced).length > 0;

  // Detect settings by their keys, not by "local is empty", because cache
  // entries may already live in local storage.
  if (Object.keys(local).length === 0) {
    await chrome.storage.local.set(hasSynced ? convertLegacySettings(synced) : { ...DEFAULT_SETTINGS });
  }

  // Runs after the local write so a failed write leaves the sync data for the
  // next attempt. Clearing keeps API keys out of the Google account.
  if (hasSynced) {
    await chrome.storage.sync.clear();
  }
}

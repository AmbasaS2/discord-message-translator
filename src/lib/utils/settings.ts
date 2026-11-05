import { DEFAULT_SETTINGS, SETTINGS_KEYS, type Settings } from '@/types/settings';

export async function getSettings(): Promise<Settings> {
  // Explicit key list: local storage also holds cache_* entries, which a
  // get(null) would read as well.
  const result = await chrome.storage.local.get(SETTINGS_KEYS);
  return {
    ...DEFAULT_SETTINGS,
    ...result,
  } as Settings;
}

export async function updateSettings(updates: Partial<Settings>): Promise<void> {
  // Deep merge for nested objects to prevent overwriting sibling keys
  // chrome.storage.local.set() only does shallow merge at top level
  const current = await getSettings();

  const merged: Partial<Settings> = {
    ...updates,
  };

  // Deep merge apiKeys object
  if (updates.apiKeys) {
    merged.apiKeys = {
      ...current.apiKeys,
      ...updates.apiKeys,
    };
  }

  // Deep merge openaiConfig object
  if (updates.openaiConfig) {
    merged.openaiConfig = {
      ...current.openaiConfig,
      ...updates.openaiConfig,
    };
  }

  await chrome.storage.local.set(merged);
}

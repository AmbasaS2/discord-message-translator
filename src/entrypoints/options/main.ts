import type { AvailabilityStatus } from '@/lib/api/chrome-builtin';
import { getSettings, updateSettings } from '@/lib/utils/settings';
import { getActiveOpenaiPreset } from '@/lib/utils/openai-presets';
import { populateAiConnections, updateAiProviderLabel, chooseExplicitDraftConnection } from '@/lib/ui/ai-connections';
import { DEFAULT_DRAFT_TRANSLATION_PROMPT } from '@/lib/api/translation-prompts';
import type { Settings } from '@/types/settings';
import { createStorage } from '@/lib/cache/factory';
import { populateLanguageSelect, setupPasswordToggle } from '@/lib/utils/dom-helpers';
import { applyI18n, t } from '@/lib/utils/i18n';
import { showToast } from '@/lib/ui/toast';
import { createAutoSaver } from '@/lib/ui/auto-save';
import { renderCacheStats } from '@/lib/ui/cache-stats';
import { getTranslatorApiStatus, getLanguageDetectorStatus } from '@/lib/ui/api-availability';
import { setupOpenaiPresetEditor } from './openai-preset-editor';
import './styles.css';

// DOM elements
const autoTranslateToggle = document.getElementById('autoTranslate') as HTMLInputElement;
const targetLanguageSelect = document.getElementById('targetLanguage') as HTMLSelectElement;
const translationModeSelect = document.getElementById('translationMode') as HTMLSelectElement;
const translationProviderSelect = document.getElementById('translationProvider') as HTMLSelectElement;
const chromeBuiltinHint = document.getElementById('chromeBuiltinHint') as HTMLLabelElement;
const skipTargetLanguageToggle = document.getElementById('skipTargetLanguage') as HTMLInputElement;
const languageDetectorHint = document.getElementById('languageDetectorHint') as HTMLLabelElement;
const translatorApiStatusBadge = document.getElementById('translatorApiStatus') as HTMLSpanElement;
const languageDetectorApiStatusBadge = document.getElementById('languageDetectorApiStatus') as HTMLSpanElement;
const googleApiKeyInput = document.getElementById('googleApiKey') as HTMLInputElement;
const toggleGoogleApiKeyVisibility = document.getElementById('toggleGoogleApiKeyVisibility') as HTMLButtonElement;
const deeplApiKeyInput = document.getElementById('deeplApiKey') as HTMLInputElement;
const toggleDeeplApiKeyVisibility = document.getElementById('toggleDeeplApiKeyVisibility') as HTMLButtonElement;
const chromeBuiltinSection = document.getElementById('chromeBuiltinSection') as HTMLDivElement;
const incomingPreset = document.getElementById('incomingOpenaiPresetId') as HTMLSelectElement;
const incomingField = document.getElementById('incomingConnectionField') as HTMLElement;
const draftEnabled = document.getElementById('draftEnabled') as HTMLInputElement;
const draftTarget = document.getElementById('draftTargetLanguage') as HTMLSelectElement;
const draftProvider = document.getElementById('draftProvider') as HTMLSelectElement;
const draftPreset = document.getElementById('draftOpenaiPresetId') as HTMLSelectElement;
const draftField = document.getElementById('draftConnectionField') as HTMLElement;
const promptEnabled = document.getElementById('draftPromptEnabled') as HTMLInputElement;
const promptInput = document.getElementById('draftTranslationPrompt') as HTMLTextAreaElement;
const savePromptButton = document.getElementById('saveDraftPrompt') as HTMLButtonElement;
const resetPromptButton = document.getElementById('resetDraftPrompt') as HTMLButtonElement;
let current: Settings | null = null;
const cacheTTLDaysInput = document.getElementById('cacheTTLDays') as HTMLInputElement;
const cacheTTLValue = document.getElementById('cacheTTLValue') as HTMLSpanElement;
const cacheUsageProgress = document.getElementById('cacheUsageProgress') as HTMLProgressElement;
const cacheUsageText = document.getElementById('cacheUsageText') as HTMLSpanElement;
const cacheBytesUsed = document.getElementById('cacheBytesUsed') as HTMLSpanElement;
const cacheEntryCount = document.getElementById('cacheEntryCount') as HTMLSpanElement;
const cacheExpiredCount = document.getElementById('cacheExpiredCount') as HTMLSpanElement;
const refreshCacheStatsButton = document.getElementById('refreshCacheStats') as HTMLButtonElement;
const clearCacheButton = document.getElementById('clearCache') as HTMLButtonElement;

const autoSave = createAutoSaver((error) => {
  console.error('[Options] Failed to save settings:', error);
  showToast(t('status_saveFailed'), 'error');
});

// Apply i18n to static elements
applyI18n();

// Connection management remains available regardless of either engine.
function updateApiSectionVisibility(provider: string) {
  chromeBuiltinSection.classList.toggle('hidden', provider !== 'chrome-builtin');
  incomingField.hidden = provider !== 'openai';
  draftField.hidden = draftProvider.value !== 'openai';
  if (!current) return;
  const fallback = getActiveOpenaiPreset(current);
  updateAiProviderLabel(translationProviderSelect, current.openaiPresets, incomingPreset.value, fallback);
  updateAiProviderLabel(draftProvider, current.openaiPresets, draftPreset.value, fallback);
}

function refreshConnections(settings: Settings): void {
  current = { ...settings };
  populateAiConnections(incomingPreset, settings, 'incoming');
  populateAiConnections(draftPreset, settings, 'draft');
  updateApiSectionVisibility(translationProviderSelect.value);
}

function saveEngineChange(updates: Partial<Settings>): void {
  if (current) current = { ...current, ...updates };
  void updateSettings(updates).catch(() => showToast(t('status_saveFailed'), 'error'));
}

// Maps a LanguageDetector availability status to its localized label.
function languageDetectorStatusLabel(status: AvailabilityStatus): string {
  switch (status) {
    case 'available':
      return t('options_statusAvailable');
    case 'downloadable':
      return t('options_statusDownloadable');
    case 'downloading':
      return t('options_statusDownloading');
    default:
      return t('options_statusUnavailable');
  }
}

// Check Chrome Built-in Translator API availability
async function checkChromeBuiltinAvailability(): Promise<void> {
  const chromeBuiltinOption = translationProviderSelect.querySelector(
    'option[value="chrome-builtin"]'
  ) as HTMLOptionElement;

  const { supported } = await getTranslatorApiStatus();
  translatorApiStatusBadge.textContent = supported
    ? t('options_statusAvailable')
    : t('options_statusUnavailable');
  translatorApiStatusBadge.className = `badge badge-sm ${supported ? 'badge-success' : 'badge-ghost'}`;

  if (supported) {
    chromeBuiltinOption.disabled = false;
    chromeBuiltinOption.textContent = t('options_chromeBuiltinFree');
    chromeBuiltinHint.style.display = 'none';
  } else {
    chromeBuiltinOption.disabled = true;
    chromeBuiltinOption.textContent = t('options_chromeBuiltinUnavailable');
    chromeBuiltinHint.style.display = 'block';
  }
}

// Check Chrome Language Detector API availability
async function checkLanguageDetectorAvailability(): Promise<void> {
  const status = await getLanguageDetectorStatus();
  languageDetectorApiStatusBadge.textContent = languageDetectorStatusLabel(status);
  languageDetectorApiStatusBadge.className = `badge badge-sm ${status === 'available' ? 'badge-success' : 'badge-ghost'}`;

  if (status !== 'unavailable') {
    skipTargetLanguageToggle.disabled = false;
    languageDetectorHint.style.display = 'none';
    return;
  }

  skipTargetLanguageToggle.disabled = true;
  languageDetectorHint.style.display = 'block';
}

// Load settings and reflect in UI
async function loadSettings() {
  populateLanguageSelect(targetLanguageSelect);
  populateLanguageSelect(draftTarget);
  const settings = await getSettings();
  current = settings;

  await checkChromeBuiltinAvailability();
  await checkLanguageDetectorAvailability();

  // API availability can change without the user's saved preference changing.
  translationProviderSelect.value = settings.translationProvider;

  autoTranslateToggle.checked = settings.autoTranslate;
  targetLanguageSelect.value = settings.targetLanguage;
  translationModeSelect.value = settings.translationMode;
  googleApiKeyInput.value = settings.apiKeys.google || '';
  deeplApiKeyInput.value = settings.apiKeys.deepl || '';
  draftEnabled.checked = settings.draftEnabled;
  draftTarget.value = settings.draftTargetLanguage;
  draftProvider.value = settings.draftProvider;
  promptEnabled.checked = settings.draftPromptEnabled;
  promptInput.value = settings.draftTranslationPrompt.trim() || DEFAULT_DRAFT_TRANSLATION_PROMPT;
  refreshConnections(settings);
  setupOpenaiPresetEditor(settings, refreshConnections);
  cacheTTLDaysInput.value = settings.cacheTTLDays.toString();
  updateCacheTTLDisplay(settings.cacheTTLDays);

  skipTargetLanguageToggle.checked = settings.skipTargetLanguage;

  // Show correct API section
  updateApiSectionVisibility(translationProviderSelect.value);
}

// Update cache TTL display
function updateCacheTTLDisplay(days: number) {
  const key = days === 1 ? 'options_cacheTTLDay' : 'options_cacheTTLDays';
  cacheTTLValue.textContent = t(key, [days.toString()]);
}

// Load cache statistics
async function loadCacheStats() {
  try {
    await renderCacheStats({
      progress: cacheUsageProgress,
      usageText: cacheUsageText,
      bytesUsed: cacheBytesUsed,
      entryCount: cacheEntryCount,
      expiredCount: cacheExpiredCount,
    });
  } catch (error) {
    console.error('[Options] Failed to load cache stats:', error);
    cacheUsageText.textContent = 'Error';
  }
}

// --- Event Listeners ---

// Auto Translate toggle
autoTranslateToggle.addEventListener('change', () => {
  autoSave({ autoTranslate: autoTranslateToggle.checked });
  showToast(
    autoTranslateToggle.checked
      ? t('status_autoTranslateEnabled')
      : t('status_autoTranslateDisabled')
  );
});

// Target Language change
targetLanguageSelect.addEventListener('change', () => {
  autoSave({ targetLanguage: targetLanguageSelect.value });
});

// Translation Mode change
translationModeSelect.addEventListener('change', () => {
  autoSave({ translationMode: translationModeSelect.value as 'replace' | 'append' });
});

// Skip Target Language toggle
skipTargetLanguageToggle.addEventListener('change', () => {
  autoSave({ skipTargetLanguage: skipTargetLanguageToggle.checked });
});

// Translation Provider change
translationProviderSelect.addEventListener('change', () => {
  const provider = translationProviderSelect.value;
  saveEngineChange({ translationProvider: provider as Settings['translationProvider'] });
  updateApiSectionVisibility(provider);
});
incomingPreset.addEventListener('change', () => {
  saveEngineChange({ activeOpenaiPresetId: incomingPreset.value || null });
  updateApiSectionVisibility(translationProviderSelect.value);
});
draftEnabled.addEventListener('change', () => saveEngineChange({ draftEnabled: draftEnabled.checked }));
draftTarget.addEventListener('change', () => saveEngineChange({ draftTargetLanguage: draftTarget.value }));
draftProvider.addEventListener('change', () => {
  const provider = draftProvider.value as Settings['draftProvider'];
  const updates: Partial<Settings> = { draftProvider: provider };
  if (provider === 'openai' && current && current.draftProvider !== 'openai') {
    const id = chooseExplicitDraftConnection(current);
    updates.draftOpenaiPresetId = id;
    draftPreset.value = id ?? '';
  }
  saveEngineChange(updates);
  updateApiSectionVisibility(translationProviderSelect.value);
});
draftPreset.addEventListener('change', () => {
  saveEngineChange({ draftOpenaiPresetId: draftPreset.value || null });
  updateApiSectionVisibility(translationProviderSelect.value);
});
promptEnabled.addEventListener('change', () => saveEngineChange({ draftPromptEnabled: promptEnabled.checked }));
async function storeDraftPrompt(value: string): Promise<void> {
  try {
    await updateSettings({ draftTranslationPrompt: value === DEFAULT_DRAFT_TRANSLATION_PROMPT ? '' : value });
    if (!value) promptInput.value = DEFAULT_DRAFT_TRANSLATION_PROMPT;
    showToast(t('status_saved'));
  } catch { showToast(t('status_saveFailed'), 'error'); }
}
savePromptButton.addEventListener('click', () => { void storeDraftPrompt(promptInput.value.trim()); });
resetPromptButton.addEventListener('click', () => {
  promptInput.value = DEFAULT_DRAFT_TRANSLATION_PROMPT;
  void storeDraftPrompt('');
});

// Google API Key input
googleApiKeyInput.addEventListener('input', () => {
  const apiKey = googleApiKeyInput.value.trim();
  autoSave({ apiKeys: { google: apiKey || undefined } });
});

// DeepL API Key input
deeplApiKeyInput.addEventListener('input', () => {
  const apiKey = deeplApiKeyInput.value.trim();
  autoSave({ apiKeys: { deepl: apiKey || undefined } });
});

// Toggle API Key visibility
setupPasswordToggle(toggleGoogleApiKeyVisibility, googleApiKeyInput);
setupPasswordToggle(toggleDeeplApiKeyVisibility, deeplApiKeyInput);

// Cache TTL input
cacheTTLDaysInput.addEventListener('input', () => {
  const days = parseInt(cacheTTLDaysInput.value) || 7;
  updateCacheTTLDisplay(days);
  autoSave({ cacheTTLDays: days });
});

// Refresh cache stats
refreshCacheStatsButton.addEventListener('click', async () => {
  try {
    refreshCacheStatsButton.disabled = true;
    refreshCacheStatsButton.classList.add('loading');
    await loadCacheStats();
    showToast(t('status_cacheRefreshed'), 'success');
  } catch (error) {
    console.error('[Options] Failed to refresh cache stats:', error);
    showToast(t('status_cacheRefreshFailed'), 'error');
  } finally {
    refreshCacheStatsButton.disabled = false;
    refreshCacheStatsButton.classList.remove('loading');
  }
});

// Clear cache
clearCacheButton.addEventListener('click', async () => {
  if (!confirm(t('confirm_clearCache'))) {
    return;
  }

  try {
    clearCacheButton.disabled = true;
    clearCacheButton.classList.add('loading');
    const storage = await createStorage();
    await storage.clear();
    await loadCacheStats();
    showToast(t('status_cacheCleared'), 'success');
  } catch (error) {
    console.error('[Options] Failed to clear cache:', error);
    showToast(t('status_cacheClearFailed'), 'error');
  } finally {
    clearCacheButton.disabled = false;
    clearCacheButton.classList.remove('loading');
  }
});

// Load cache stats up front since there is no cache tab to gate it behind.
loadCacheStats();

// Initialize
loadSettings();

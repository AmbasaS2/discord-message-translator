import { getSettings } from '@/lib/utils/settings';
import { populateLanguageSelect } from '@/lib/utils/dom-helpers';
import { applyI18n, t } from '@/lib/utils/i18n';
import { showToast } from '@/lib/ui/toast';
import { createAutoSaver } from '@/lib/ui/auto-save';
import './styles.css';

// DOM elements
const autoTranslateToggle = document.getElementById('autoTranslate') as HTMLInputElement;
const targetLanguageSelect = document.getElementById('targetLanguage') as HTMLSelectElement;
const translationModeSelect = document.getElementById('translationMode') as HTMLSelectElement;
const openOptionsButton = document.getElementById('openOptions') as HTMLButtonElement;
const draftEnabled = document.getElementById('draftEnabled') as HTMLInputElement;
const draftTarget = document.getElementById('draftTargetLanguage') as HTMLSelectElement;
const draftProvider = document.getElementById('draftProvider') as HTMLSelectElement;
const draftPreset = document.getElementById('draftOpenaiPresetId') as HTMLSelectElement;
const surfaceKeys = ['translateNavigation', 'translateForum', 'translateSearch'] as const;

const autoSave = createAutoSaver((error) => {
  console.error('[Popup] Failed to save settings:', error);
  showToast(t('status_saveFailed'), 'error');
});

// Apply i18n to static elements
applyI18n();

// Load settings and reflect in UI
async function loadSettings() {
  populateLanguageSelect(targetLanguageSelect);
  populateLanguageSelect(draftTarget);
  const settings = await getSettings();

  autoTranslateToggle.checked = settings.autoTranslate;
  targetLanguageSelect.value = settings.targetLanguage;
  translationModeSelect.value = settings.translationMode;
  draftEnabled.checked = settings.draftEnabled;
  draftTarget.value = settings.draftTargetLanguage;
  draftProvider.value = settings.draftProvider;
  draftPreset.replaceChildren(new Option(t('basa_currentPreset'), ''));
  settings.openaiPresets.forEach((preset) => draftPreset.add(new Option(preset.name, preset.id)));
  draftPreset.value = settings.draftOpenaiPresetId ?? '';
  draftPreset.disabled = draftProvider.value !== 'openai';
  for (const key of surfaceKeys) {
    (document.getElementById(key) as HTMLInputElement).checked = settings[key];
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

draftEnabled.addEventListener('change', () => autoSave({ draftEnabled: draftEnabled.checked }));
draftTarget.addEventListener('change', () => autoSave({ draftTargetLanguage: draftTarget.value }));
draftProvider.addEventListener('change', () => {
  draftPreset.disabled = draftProvider.value !== 'openai';
  autoSave({ draftProvider: draftProvider.value as 'inherit' | 'chrome-builtin' | 'google' | 'deepl' | 'openai' });
});
draftPreset.addEventListener('change', () => autoSave({ draftOpenaiPresetId: draftPreset.value || null }));
for (const key of surfaceKeys) {
  const input = document.getElementById(key) as HTMLInputElement;
  input.addEventListener('change', () => autoSave({ [key]: input.checked }));
}

// Open Options
openOptionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Initialize
loadSettings();

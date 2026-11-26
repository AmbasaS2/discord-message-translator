
import { getSettings } from '@/lib/utils/settings';
import { getActiveOpenaiPreset } from '@/lib/utils/openai-presets';
import { populateAiConnections, updateAiProviderLabel } from '@/lib/ui/ai-connections';
import { populateLanguageSelect } from '@/lib/utils/dom-helpers';
import { applyI18n, t } from '@/lib/utils/i18n';
import { showToast } from '@/lib/ui/toast';
import type { Settings } from '@/types/settings';
import './styles.css';

const autoTranslateToggle = document.getElementById('autoTranslate') as HTMLInputElement;
const targetLanguageSelect = document.getElementById('targetLanguage') as HTMLSelectElement;
const translationModeSelect = document.getElementById('translationMode') as HTMLSelectElement;
const openOptionsButton = document.getElementById('openOptions') as HTMLButtonElement;
const incomingProvider = document.getElementById('incomingProvider') as HTMLSelectElement;
const incomingPreset = document.getElementById('incomingOpenaiPresetId') as HTMLSelectElement;
const incomingField = document.getElementById('incomingConnectionField') as HTMLElement;
const draftEnabled = document.getElementById('draftEnabled') as HTMLInputElement;
const draftTarget = document.getElementById('draftTargetLanguage') as HTMLSelectElement;
const draftProvider = document.getElementById('draftProvider') as HTMLSelectElement;
const draftPreset = document.getElementById('draftOpenaiPresetId') as HTMLSelectElement;
const draftField = document.getElementById('draftConnectionField') as HTMLElement;
const surfaceKeys = ['translateNavigation', 'translateForum', 'translateSearch'] as const;
let current: Settings | null = null;

// These are discrete controls, so persist immediately before the popup can close.
function save(updates: Partial<Settings>): void {
  if (current) current = { ...current, ...updates };
  void chrome.storage.local.set(updates).catch((error) => {
    console.error('[Popup] Failed to save settings:', error);
    showToast(t('status_saveFailed'), 'error');
  });
}

function updateConnectionVisibility(): void {
  if (!current) return;
  incomingField.hidden = incomingProvider.value !== 'openai';
  draftField.hidden = draftProvider.value !== 'openai';
  const fallback = getActiveOpenaiPreset(current);
  updateAiProviderLabel(incomingProvider, current.openaiPresets, incomingPreset.value, fallback);
  updateAiProviderLabel(draftProvider, current.openaiPresets, draftPreset.value, fallback);
}

applyI18n();

async function loadSettings() {
  populateLanguageSelect(targetLanguageSelect);
  populateLanguageSelect(draftTarget);
  const settings = await getSettings();
  current = settings;
  autoTranslateToggle.checked = settings.autoTranslate;
  targetLanguageSelect.value = settings.targetLanguage;
  translationModeSelect.value = settings.translationMode;
  incomingProvider.value = settings.translationProvider;
  draftEnabled.checked = settings.draftEnabled;
  draftTarget.value = settings.draftTargetLanguage;
  draftProvider.value = settings.draftProvider;
  populateAiConnections(incomingPreset, settings, 'incoming');
  populateAiConnections(draftPreset, settings, 'draft');
  updateConnectionVisibility();
  for (const key of surfaceKeys) {
    (document.getElementById(key) as HTMLInputElement).checked = settings[key];
  }
}

autoTranslateToggle.addEventListener('change', () => {
  save({ autoTranslate: autoTranslateToggle.checked });
  showToast(autoTranslateToggle.checked ? t('status_autoTranslateEnabled') : t('status_autoTranslateDisabled'));
});
targetLanguageSelect.addEventListener('change', () => save({ targetLanguage: targetLanguageSelect.value }));
translationModeSelect.addEventListener('change', () => save({ translationMode: translationModeSelect.value as Settings['translationMode'] }));
incomingProvider.addEventListener('change', () => {
  save({ translationProvider: incomingProvider.value as Settings['translationProvider'] });
  updateConnectionVisibility();
});
incomingPreset.addEventListener('change', () => {
  save({ activeOpenaiPresetId: incomingPreset.value || null });
  updateConnectionVisibility();
});
draftEnabled.addEventListener('change', () => save({ draftEnabled: draftEnabled.checked }));
draftTarget.addEventListener('change', () => save({ draftTargetLanguage: draftTarget.value }));
draftProvider.addEventListener('change', () => {
  save({ draftProvider: draftProvider.value as Settings['draftProvider'] });
  updateConnectionVisibility();
});
draftPreset.addEventListener('change', () => {
  save({ draftOpenaiPresetId: draftPreset.value || null });
  updateConnectionVisibility();
});
for (const key of surfaceKeys) {
  const input = document.getElementById(key) as HTMLInputElement;
  input.addEventListener('change', () => save({ [key]: input.checked }));
}
openOptionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
void loadSettings();

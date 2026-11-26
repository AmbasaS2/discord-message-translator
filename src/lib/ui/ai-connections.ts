
import type { OpenAIPreset, Settings } from '@/types/settings';
import { API_SERVICES, inferApiService, type ApiService } from '@/lib/utils/api-services';
import { getActiveOpenaiPreset } from '@/lib/utils/openai-presets';
import { t } from '@/lib/utils/i18n';

export function serviceLabel(service: ApiService): string {
  if (service === 'custom') return t('basa_serviceCustom');
  if (service === 'nano-gpt-subscription') return t('basa_serviceNanoSubscription');
  return API_SERVICES[service].label;
}

function createOption(label: string, value: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.textContent = label;
  option.value = value;
  return option;
}

export function populateAiConnections(
  select: HTMLSelectElement,
  settings: Settings,
  direction: 'incoming' | 'draft',
): void {
  const requested = direction === 'draft' ? settings.draftOpenaiPresetId : settings.activeOpenaiPresetId;
  const chosen = direction === 'draft'
    ? requested ?? ''
    : getActiveOpenaiPreset(settings)?.id ?? '';
  select.replaceChildren();
  if (direction === 'draft' || settings.openaiPresets.length === 0) {
    const option = createOption(
      direction === 'draft' && settings.openaiPresets.length ? t('basa_currentPreset') : t('basa_noConnections'),
      '',
    );
    if (direction === 'incoming' || !settings.openaiPresets.length) option.disabled = true;
    select.appendChild(option);
  }
  for (const service of Object.keys(API_SERVICES) as ApiService[]) {
    const presets = settings.openaiPresets.filter((preset) => inferApiService(preset.baseUrl) === service);
    if (!presets.length) continue;
    const group = document.createElement('optgroup');
    group.label = serviceLabel(service);
    for (const preset of presets) {
      group.appendChild(createOption(`${preset.name} · ${preset.model}`, preset.id));
    }
    select.appendChild(group);
  }
  if (chosen && !settings.openaiPresets.some((preset) => preset.id === chosen)) {
    const missing = createOption(t('basa_missingConnection'), chosen);
    missing.disabled = true;
    select.appendChild(missing);
  }
  select.value = chosen;
}

export function chooseExplicitDraftConnection(settings: Settings): string | null {
  const chosen = settings.openaiPresets.find((preset) => preset.id === settings.draftOpenaiPresetId);
  return chosen?.id ?? getActiveOpenaiPreset(settings)?.id ?? null;
}

export function updateAiProviderLabel(
  provider: HTMLSelectElement,
  presets: OpenAIPreset[],
  selected: string,
  fallback?: OpenAIPreset | null,
): void {
  const option = provider.querySelector<HTMLOptionElement>('option[value="openai"]');
  if (!option) return;
  option.disabled = presets.length === 0;
  const preset = presets.find((item) => item.id === selected) ?? (selected ? null : fallback);
  option.textContent = preset
    ? `${serviceLabel(inferApiService(preset.baseUrl))} · AI API`
    : presets.length ? t('basa_providerAI') : t('basa_addConnectionFirst');
}

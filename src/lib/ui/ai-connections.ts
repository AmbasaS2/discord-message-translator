
import type { OpenAIPreset, Settings } from '@/types/settings';
import { API_SERVICES, inferApiService, type ApiService } from '@/lib/utils/api-services';
import { getActiveOpenaiPreset } from '@/lib/utils/openai-presets';
import { t } from '@/lib/utils/i18n';

export function serviceLabel(service: ApiService): string {
  if (service === 'custom') return t('basa_serviceCustom');
  if (service === 'nano-gpt-subscription') return t('basa_serviceNanoSubscription');
  return API_SERVICES[service].label;
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
    const option = new Option(
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
      group.appendChild(new Option(`${preset.name} · ${preset.model}`, preset.id));
    }
    select.appendChild(group);
  }
  if (chosen && !settings.openaiPresets.some((preset) => preset.id === chosen)) {
    const missing = new Option(t('basa_missingConnection'), chosen);
    missing.disabled = true;
    select.appendChild(missing);
  }
  select.value = chosen;
}

export function updateAiProviderLabel(
  provider: HTMLSelectElement,
  presets: OpenAIPreset[],
  selected: string,
  fallback?: OpenAIPreset | null,
): void {
  const option = provider.querySelector<HTMLOptionElement>('option[value="openai"]');
  if (!option) return;
  const preset = presets.find((item) => item.id === selected) ?? (selected ? null : fallback);
  option.textContent = preset
    ? `${serviceLabel(inferApiService(preset.baseUrl))} · AI API`
    : t('basa_providerAI');
}

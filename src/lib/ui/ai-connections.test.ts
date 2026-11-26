
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type OpenAIPreset } from '@/types/settings';
import { chooseExplicitDraftConnection, populateAiConnections, updateAiProviderLabel } from './ai-connections';

vi.mock('@/lib/utils/i18n', () => ({ t: (key: string) => key }));

const preset = (id: string, baseUrl: string): OpenAIPreset => ({ id, baseUrl, apiKey: 'test', model: 'model-' + id, name: id });
const nano = preset('nano', 'https://api.nano-gpt.com/api/v1');
const other = preset('other', 'https://api.openai.com/v1');

describe('independent AI connection choices', () => {
  it('renders a distinct choice for each direction and groups models by service', () => {
    const settings = { ...DEFAULT_SETTINGS, openaiPresets: [nano, other], activeOpenaiPresetId: 'other', draftOpenaiPresetId: 'nano' };
    const incoming = document.createElement('select');
    const draft = document.createElement('select');
    populateAiConnections(incoming, settings, 'incoming');
    populateAiConnections(draft, settings, 'draft');
    expect(incoming.value).toBe('other');
    expect(draft.value).toBe('nano');
    expect(draft.querySelector('optgroup[label="NanoGPT"] option')?.textContent).toContain('model-nano');
    expect(chooseExplicitDraftConnection(settings)).toBe('nano');
  });

  it('chooses a concrete connection when first enabling the AI draft engine', () => {
    const settings = { ...DEFAULT_SETTINGS, openaiPresets: [nano, other], activeOpenaiPresetId: 'nano' };
    expect(chooseExplicitDraftConnection(settings)).toBe('nano');
    expect(chooseExplicitDraftConnection(DEFAULT_SETTINGS)).toBeNull();
  });

  it('keeps a removed draft connection visible rather than silently picking another model', () => {
    const select = document.createElement('select');
    populateAiConnections(select, { ...DEFAULT_SETTINGS, openaiPresets: [other], draftOpenaiPresetId: 'missing' }, 'draft');
    expect(select.value).toBe('missing');
    expect(select.querySelector<HTMLOptionElement>('option[value="missing"]')?.disabled).toBe(true);
  });

  it('disables unconfigured AI and names the configured service', () => {
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.textContent = 'AI API';
    option.value = 'openai';
    select.append(option);
    updateAiProviderLabel(select, [], '');
    expect(option.disabled).toBe(true);
    updateAiProviderLabel(select, [nano], 'nano');
    expect(option.disabled).toBe(false);
    expect(option.textContent).toBe('NanoGPT · AI API');
  });
});

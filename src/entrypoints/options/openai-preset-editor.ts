import { OpenAICompatibleClient, parseExtraBody } from '@/lib/api/openai-compatible';
import { requestCompletionViaBackground } from '@/lib/api/openai-background';
import {
  endpointOriginPattern,
  getActiveOpenaiPreset,
  removeOpenaiPreset,
  upsertOpenaiPreset,
  type PresetState,
} from '@/lib/utils/openai-presets';
import { getSettings, updateSettings } from '@/lib/utils/settings';
import { setupPasswordToggle } from '@/lib/utils/dom-helpers';
import { applyI18n, t } from '@/lib/utils/i18n';
import type { OpenAIPreset, Settings } from '@/types/settings';

const addButton = document.getElementById('addOpenaiPreset') as HTMLButtonElement;
const listElement = document.getElementById('openaiPresetList') as HTMLUListElement;
const emptyElement = document.getElementById('openaiPresetEmpty') as HTMLParagraphElement;
const itemTemplate = document.getElementById('openaiPresetItemTemplate') as HTMLTemplateElement;
const form = document.getElementById('openaiPresetForm') as HTMLFormElement;
const nameInput = document.getElementById('presetName') as HTMLInputElement;
const baseUrlInput = document.getElementById('presetBaseUrl') as HTMLInputElement;
const modelInput = document.getElementById('presetModel') as HTMLInputElement;
const apiKeyInput = document.getElementById('presetApiKey') as HTMLInputElement;
const toggleApiKeyVisibility = document.getElementById('togglePresetApiKeyVisibility') as HTMLButtonElement;
const extraBodyInput = document.getElementById('presetExtraBody') as HTMLTextAreaElement;
const extraBodyError = document.getElementById('presetExtraBodyError') as HTMLParagraphElement;
const testResult = document.getElementById('presetTestResult') as HTMLParagraphElement;
const testButton = document.getElementById('testOpenaiPreset') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelOpenaiPreset') as HTMLButtonElement;
const saveButton = document.getElementById('saveOpenaiPreset') as HTMLButtonElement;

let state: PresetState = { openaiPresets: [], activeOpenaiPresetId: null };
// Id of the preset in the form; null while the form is closed.
let editingId: string | null = null;

function readForm(id: string): OpenAIPreset {
  const extraBody = extraBodyInput.value.trim();
  return {
    id,
    name: nameInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
    model: modelInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    ...(extraBody ? { extraBody } : {}),
  };
}

// Without a host permission the background fetch only succeeds if the endpoint
// answers CORS for the extension origin, which local servers often don't.
// Must be called before any await in a click/submit handler (user gesture).
// Resolves true when no request is possible (a URL that does not parse, or a
// pattern Chrome rejects such as "localhost:8080"), so the caller goes on and
// the real request reports the problem.
async function requestEndpointAccess(baseUrl: string): Promise<boolean> {
  const pattern = endpointOriginPattern(baseUrl);
  if (pattern === null) return true;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return true;
  }
}

function showTestResult(message: string, kind: 'success' | 'error' | 'info' | null): void {
  testResult.textContent = message;
  testResult.classList.toggle('hidden', kind === null);
  testResult.classList.toggle('text-success', kind === 'success');
  testResult.classList.toggle('text-error', kind === 'error');
}

function render(): void {
  const editing = editingId !== null;
  form.classList.toggle('hidden', !editing);
  addButton.classList.toggle('hidden', editing);
  listElement.classList.toggle('hidden', editing);
  emptyElement.classList.toggle('hidden', editing || state.openaiPresets.length > 0);

  const activeId = getActiveOpenaiPreset(state)?.id;
  listElement.replaceChildren();
  for (const preset of state.openaiPresets) {
    const li = (itemTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLLIElement;
    // Templates are skipped by the page-level applyI18n call.
    applyI18n(li);

    const radio = li.querySelector('input[type="radio"]') as HTMLInputElement;
    radio.checked = preset.id === activeId;
    radio.setAttribute('aria-label', preset.name);
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      state = { ...state, activeOpenaiPresetId: preset.id };
      await updateSettings({ activeOpenaiPresetId: preset.id });
    });

    (li.querySelector('[data-role="name"]') as HTMLElement).textContent = preset.name;
    (li.querySelector('[data-role="meta"]') as HTMLElement).textContent = `${preset.model} · ${preset.baseUrl}`;

    li.querySelector('[data-role="edit"]')!.addEventListener('click', () => openForm(preset));
    li.querySelector('[data-role="delete"]')!.addEventListener('click', async () => {
      if (!confirm(t('confirm_deletePreset', [preset.name]))) return;
      const next = removeOpenaiPreset(await getSettings(), preset.id);
      await updateSettings(next);
      state = next;
      render();
    });

    listElement.appendChild(li);
  }
}

function validate(): void {
  const parsed = parseExtraBody(extraBodyInput.value.trim());
  extraBodyError.textContent = parsed.ok ? '' : t('options_extraBodyInvalid', [parsed.error]);
  extraBodyError.classList.toggle('hidden', parsed.ok);
  extraBodyInput.classList.toggle('textarea-error', !parsed.ok);

  const valid =
    parsed.ok &&
    nameInput.value.trim() !== '' &&
    baseUrlInput.value.trim() !== '' &&
    modelInput.value.trim() !== '';
  saveButton.disabled = !valid;
  testButton.disabled = !valid;
}

function openForm(preset?: OpenAIPreset): void {
  editingId = preset?.id ?? crypto.randomUUID();
  nameInput.value = preset?.name ?? '';
  baseUrlInput.value = preset?.baseUrl ?? '';
  modelInput.value = preset?.model ?? '';
  apiKeyInput.value = preset?.apiKey ?? '';
  apiKeyInput.type = 'password';
  extraBodyInput.value = preset?.extraBody ?? '';
  showTestResult('', null);
  validate();
  render();
}

function closeForm(): void {
  editingId = null;
  render();
}

export function setupOpenaiPresetEditor(settings: Settings): void {
  state = {
    openaiPresets: settings.openaiPresets,
    activeOpenaiPresetId: settings.activeOpenaiPresetId,
  };
  render();
}

addButton.addEventListener('click', () => openForm());
cancelButton.addEventListener('click', closeForm);
setupPasswordToggle(toggleApiKeyVisibility, apiKeyInput);

for (const input of [nameInput, baseUrlInput, modelInput, apiKeyInput, extraBodyInput]) {
  input.addEventListener('input', validate);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (editingId === null) return;
  const preset = readForm(editingId);
  // Saved whether or not access is granted; Test reports a missing permission.
  await requestEndpointAccess(preset.baseUrl);
  // Read fresh settings so a second options tab's list is not overwritten.
  const next = upsertOpenaiPreset(await getSettings(), preset);
  await updateSettings(next);
  state = next;
  closeForm();
});

testButton.addEventListener('click', async () => {
  const preset = readForm(editingId ?? '');
  if (!(await requestEndpointAccess(preset.baseUrl))) {
    showTestResult(t('options_testPermissionDenied'), 'error');
    return;
  }

  testButton.disabled = true;
  showTestResult(t('options_testing'), 'info');
  // A result that arrives after Cancel or after another preset was opened
  // belongs to a closed working copy.
  const testedId = editingId;
  try {
    const client = new OpenAICompatibleClient(
      { apiKey: preset.apiKey, baseUrl: preset.baseUrl, model: preset.model, extraBody: preset.extraBody },
      requestCompletionViaBackground,
    );
    const result = await client.translate('Hello, world.', (await getSettings()).targetLanguage);
    if (editingId === testedId) showTestResult(t('options_testOk', [result.slice(0, 60)]), 'success');
  } catch (error) {
    if (editingId === testedId) showTestResult(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    validate();
  }
});

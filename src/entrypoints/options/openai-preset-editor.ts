import { OpenAICompatibleClient, parseExtraBody } from '@/lib/api/openai-compatible';
import { requestCompletionViaBackground } from '@/lib/api/openai-background';
import {
  endpointOriginPattern,
  removeOpenaiPreset,
  upsertOpenaiPreset,
  type PresetState,
} from '@/lib/utils/openai-presets';
import { getSettings, updateSettings } from '@/lib/utils/settings';
import { API_SERVICES, inferApiService, fetchModelIds, normalizeModelBaseUrl, type ApiService } from '@/lib/utils/api-services';
import { serviceLabel } from '@/lib/ui/ai-connections';
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
const advancedSettings = document.getElementById('presetAdvancedSettings') as HTMLDetailsElement;
const extraBodyInput = document.getElementById('presetExtraBody') as HTMLTextAreaElement;
const extraBodyError = document.getElementById('presetExtraBodyError') as HTMLParagraphElement;
const testResult = document.getElementById('presetTestResult') as HTMLParagraphElement;
const testButton = document.getElementById('testOpenaiPreset') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelOpenaiPreset') as HTMLButtonElement;
const saveButton = document.getElementById('saveOpenaiPreset') as HTMLButtonElement;
const serviceSelect = document.getElementById('presetService') as HTMLSelectElement;
const keyLink = document.getElementById('presetKeyLink') as HTMLAnchorElement;
const billingHint = document.getElementById('nanoBillingHint') as HTMLElement;
const modelsButton = document.getElementById('loadPresetModels') as HTMLButtonElement;
const modelList = document.getElementById('presetModelList') as HTMLDataListElement;
const modelsStatus = document.getElementById('presetModelsStatus') as HTMLElement;
let modelRequest: AbortController | null = null;
let keyOrigin: string | null = null;
let connectionsChanged: ((settings: Settings) => void) | undefined;

let state: PresetState = { openaiPresets: [], activeOpenaiPresetId: null };
// Id of the preset in the form; null while the form is closed.
let editingId: string | null = null;

function readForm(id: string): OpenAIPreset {
  const extraBody = extraBodyInput.value.trim();
  return {
    id,
    name: nameInput.value.trim(),
    baseUrl: normalizeModelBaseUrl(baseUrlInput.value),
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

  listElement.replaceChildren();
  for (const preset of state.openaiPresets) {
    const li = (itemTemplate.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLLIElement;
    // Templates are skipped by the page-level applyI18n call.
    applyI18n(li);

    (li.querySelector('[data-role="name"]') as HTMLElement).textContent = preset.name;
    (li.querySelector('[data-role="meta"]') as HTMLElement).textContent = `${serviceLabel(inferApiService(preset.baseUrl))} · ${preset.model} · ${preset.baseUrl}`;

    li.querySelector('[data-role="edit"]')!.addEventListener('click', () => openForm(preset));
    li.querySelector('[data-role="delete"]')!.addEventListener('click', async () => {
      if (!confirm(t('confirm_deletePreset', [preset.name]))) return;
      const next = removeOpenaiPreset(await getSettings(), preset.id);
      await updateSettings(next);
      state = next;
      render();
      connectionsChanged?.(await getSettings());
    });

    listElement.appendChild(li);
  }
}

function validate(): void {
  const parsed = parseExtraBody(extraBodyInput.value.trim());
  extraBodyError.textContent = parsed.ok ? '' : t('options_extraBodyInvalid', [parsed.error]);
  extraBodyError.classList.toggle('hidden', parsed.ok);
  extraBodyInput.classList.toggle('textarea-error', !parsed.ok);
  if (!parsed.ok) advancedSettings.open = true;

  let validUrl = false;
  try { normalizeModelBaseUrl(baseUrlInput.value); validUrl = true; } catch { /* still editing */ }
  modelsButton.disabled = !validUrl || modelRequest !== null;
  const valid =
    parsed.ok && validUrl &&
    nameInput.value.trim() !== '' &&
    baseUrlInput.value.trim() !== '' &&
    modelInput.value.trim() !== '';
  saveButton.disabled = !valid;
  testButton.disabled = !valid;
}

function clearModelList(): void {
  modelRequest?.abort();
  modelRequest = null;
  modelList.replaceChildren();
  modelsStatus.textContent = '';
}

function apiOrigin(baseUrl: string): string | null {
  try { return new URL(normalizeModelBaseUrl(baseUrl)).origin; } catch { return null; }
}

function clearKeyIfOriginChanged(): void {
  const origin = apiOrigin(baseUrlInput.value);
  if (apiKeyInput.value && origin !== keyOrigin) {
    apiKeyInput.value = '';
    clearModelList();
    modelsStatus.textContent = t('basa_keyOriginChanged');
  }
  keyOrigin = origin;
}

function showServiceLink(): void {
  const service = inferApiService(baseUrlInput.value);
  const metadata = API_SERVICES[service];
  keyLink.hidden = !metadata.keyUrl;
  if (metadata.keyUrl) keyLink.href = metadata.keyUrl;
  else keyLink.removeAttribute('href');
  billingHint.classList.toggle('hidden', service !== 'nano-gpt' && service !== 'nano-gpt-subscription');
}

function openForm(preset?: OpenAIPreset): void {
  clearModelList();
  editingId = preset?.id ?? crypto.randomUUID();
  const service = preset ? inferApiService(preset.baseUrl) : 'nano-gpt';
  serviceSelect.value = service;
  nameInput.value = preset?.name ?? serviceLabel(service);
  baseUrlInput.value = preset?.baseUrl ?? API_SERVICES[service].baseUrl;
  modelInput.value = preset?.model ?? '';
  apiKeyInput.value = preset?.apiKey ?? '';
  keyOrigin = apiOrigin(baseUrlInput.value);
  apiKeyInput.type = 'password';
  extraBodyInput.value = preset?.extraBody ?? '';
  advancedSettings.open = Boolean(extraBodyInput.value.trim());
  showTestResult('', null);
  showServiceLink();
  validate();
  render();
}

function closeForm(): void {
  clearModelList();
  editingId = null;
  render();
}

export function setupOpenaiPresetEditor(settings: Settings, onChange?: (settings: Settings) => void): void {
  connectionsChanged = onChange;
  state = {
    openaiPresets: settings.openaiPresets,
    activeOpenaiPresetId: settings.activeOpenaiPresetId,
  };
  render();
}

addButton.addEventListener('click', () => openForm());
cancelButton.addEventListener('click', closeForm);
setupPasswordToggle(toggleApiKeyVisibility, apiKeyInput);

for (const input of [nameInput, modelInput, extraBodyInput]) input.addEventListener('input', validate);
apiKeyInput.addEventListener('input', () => {
  keyOrigin = apiOrigin(baseUrlInput.value);
  clearModelList();
  validate();
});
baseUrlInput.addEventListener('input', () => {
  clearModelList();
  serviceSelect.value = inferApiService(baseUrlInput.value);
  showServiceLink();
  validate();
});
baseUrlInput.addEventListener('change', () => {
  clearKeyIfOriginChanged();
  validate();
});
serviceSelect.addEventListener('change', () => {
  const service = serviceSelect.value as ApiService;
  const previous = inferApiService(baseUrlInput.value);
  const next = API_SERVICES[service];
  if (!nameInput.value.trim() || nameInput.value === serviceLabel(previous)) nameInput.value = serviceLabel(service);
  baseUrlInput.value = next.baseUrl;
  modelInput.value = '';
  clearModelList();
  clearKeyIfOriginChanged();
  showServiceLink();
  validate();
});

modelsButton.addEventListener('click', async () => {
  if (editingId === null || modelRequest) return;
  clearKeyIfOriginChanged();
  const id = editingId;
  const baseUrl = baseUrlInput.value.trim();
  const apiKey = apiKeyInput.value;
  if (!(await requestEndpointAccess(baseUrl))) {
    modelsStatus.textContent = t('options_testPermissionDenied');
    return;
  }
  if (editingId !== id || baseUrlInput.value.trim() !== baseUrl || apiKeyInput.value !== apiKey || modelRequest) return;
  const controller = new AbortController();
  modelRequest = controller;
  modelsStatus.textContent = t('options_loading');
  validate();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const ids = await fetchModelIds(baseUrl, apiKey, controller.signal);
    if (editingId !== id || modelRequest !== controller) return;
    const fragment = document.createDocumentFragment();
    for (const model of ids) fragment.appendChild(new Option(model, model));
    modelList.replaceChildren(fragment);
    modelsStatus.textContent = t('basa_modelsLoaded', [String(ids.length)]);
    modelInput.focus();
  } catch (error) {
    if (editingId === id && modelRequest === controller) {
      modelsStatus.textContent = `${t('basa_modelsFailed')} ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    clearTimeout(timer);
    if (modelRequest === controller) {
      modelRequest = null;
      validate();
    }
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (editingId === null) return;
  clearKeyIfOriginChanged();
  validate();
  if (saveButton.disabled) return;
  const preset = readForm(editingId);
  // Saved whether or not access is granted; Test reports a missing permission.
  await requestEndpointAccess(preset.baseUrl);
  // Read fresh settings so a second options tab's list is not overwritten.
  const next = upsertOpenaiPreset(await getSettings(), preset);
  await updateSettings(next);
  state = next;
  closeForm();
  connectionsChanged?.(await getSettings());
});

testButton.addEventListener('click', async () => {
  if (editingId === null) return;
  clearKeyIfOriginChanged();
  validate();
  if (testButton.disabled) return;
  const preset = readForm(editingId);
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


export const API_SERVICES = {
  'nano-gpt': { label: 'NanoGPT', baseUrl: 'https://api.nano-gpt.com/api/v1', keyUrl: 'https://nano-gpt.com/api' },
  'nano-gpt-subscription': { label: 'NanoGPT (Subscription API)', baseUrl: 'https://api.nano-gpt.com/api/subscription/v1', keyUrl: 'https://nano-gpt.com/api' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  custom: { label: 'Custom API', baseUrl: '', keyUrl: '' },
} as const;

export type ApiService = keyof typeof API_SERVICES;

export function inferApiService(baseUrl: string): ApiService {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'https:') return 'custom';
    if (['nano-gpt.com', 'api.nano-gpt.com'].includes(url.hostname)) {
      return url.pathname.startsWith('/api/subscription/v1') ? 'nano-gpt-subscription' : 'nano-gpt';
    }
    if (url.hostname === 'api.openai.com') return 'openai';
    if (url.hostname === 'openrouter.ai') return 'openrouter';
  } catch { /* A partially entered custom URL has no known provider yet. */ }
  return 'custom';
}

export function normalizeModelBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid API base URL');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseModelIds(payload: unknown): string[] {
  const data = Array.isArray(payload) ? payload :
    payload && typeof payload === 'object'
      ? ((payload as { data?: unknown; models?: unknown }).data ?? (payload as { models?: unknown }).models)
      : null;
  if (!Array.isArray(data)) throw new Error('The API did not return a model list');
  const ids = new Set<string>();
  for (const item of data) {
    const id = typeof item === 'string' ? item :
      item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && id.trim() && id.length <= 512) ids.add(id.trim());
  }
  if (!ids.size) throw new Error('The API returned no usable model IDs');
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const url = normalizeModelBaseUrl(baseUrl);
  const response = await fetch(`${url}/models`, {
    method: 'GET',
    headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`Model list request failed (HTTP ${response.status})`);
  return parseModelIds(await response.json());
}

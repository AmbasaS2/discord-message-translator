
import { describe, expect, it, vi } from 'vitest';
import { API_SERVICES, inferApiService, normalizeModelBaseUrl, parseModelIds, fetchModelIds } from './api-services';

describe('API service connections', () => {
  it('recognizes NanoGPT standard and subscription URLs without adding a new transport', () => {
    expect(inferApiService(API_SERVICES['nano-gpt'].baseUrl)).toBe('nano-gpt');
    expect(inferApiService(API_SERVICES['nano-gpt-subscription'].baseUrl)).toBe('nano-gpt-subscription');
    expect(inferApiService('https://nano-gpt.com/api/v1')).toBe('nano-gpt');
    expect(inferApiService('https://api.nano-gpt.com.evil.example/v1')).toBe('custom');
    expect(inferApiService('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(inferApiService('http://localhost:1234/v1')).toBe('custom');
  });

  it('accepts standard model list formats and removes duplicate IDs', () => {
    expect(parseModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, { id: 12 }] })).toEqual(['a', 'b']);
    expect(parseModelIds({ models: ['model-a'] })).toEqual(['model-a']);
    expect(() => parseModelIds({ data: [] })).toThrow();
  });

  it('normalizes only HTTP(S) API endpoints', () => {
    expect(normalizeModelBaseUrl('https://api.nano-gpt.com/api/v1/chat/completions/')).toBe('https://api.nano-gpt.com/api/v1');
    expect(() => normalizeModelBaseUrl('file:///tmp/models')).toThrow();
    expect(() => normalizeModelBaseUrl('https://user:password@example.com/v1')).toThrow();
  });

  it('loads the chosen endpoint only when explicitly requested', async () => {
    const mockedFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model' }] })));
    vi.stubGlobal('fetch', mockedFetch);
    try {
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(await fetchModelIds(API_SERVICES['nano-gpt'].baseUrl, 'key')).toEqual(['model']);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockedFetch).toHaveBeenCalledWith('https://api.nano-gpt.com/api/v1/models', expect.objectContaining({
        headers: { Authorization: 'Bearer key' }, credentials: 'omit', redirect: 'error',
      }));
    } finally { vi.unstubAllGlobals(); }
  });
});

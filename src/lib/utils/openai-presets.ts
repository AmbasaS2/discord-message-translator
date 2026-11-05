import type { OpenAIPreset, Settings } from '@/types/settings';

export type PresetState = Pick<Settings, 'openaiPresets' | 'activeOpenaiPresetId'>;

/** Active preset; a missing or stale id falls back to the first preset. */
export function getActiveOpenaiPreset(state: PresetState): OpenAIPreset | null {
  return (
    state.openaiPresets.find((p) => p.id === state.activeOpenaiPresetId) ??
    state.openaiPresets[0] ??
    null
  );
}

/** Replace by id or append. The first preset saved while none is active becomes active. */
export function upsertOpenaiPreset(state: PresetState, preset: OpenAIPreset): PresetState {
  const exists = state.openaiPresets.some((p) => p.id === preset.id);
  const openaiPresets = exists
    ? state.openaiPresets.map((p) => (p.id === preset.id ? preset : p))
    : [...state.openaiPresets, preset];
  return {
    openaiPresets,
    activeOpenaiPresetId: state.activeOpenaiPresetId ?? preset.id,
  };
}

/** Remove by id. If it was active, the first remaining preset (or null) becomes active. */
export function removeOpenaiPreset(state: PresetState, id: string): PresetState {
  const openaiPresets = state.openaiPresets.filter((p) => p.id !== id);
  const activeOpenaiPresetId =
    state.activeOpenaiPresetId === id
      ? (openaiPresets[0]?.id ?? null)
      : state.activeOpenaiPresetId;
  return { openaiPresets, activeOpenaiPresetId };
}

/**
 * Host-permission match pattern for a base URL: `${protocol}//${hostname}/*`,
 * or null when the URL does not parse. Match patterns without a port match
 * every port, so a local server keeps working when its port changes.
 */
export function endpointOriginPattern(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

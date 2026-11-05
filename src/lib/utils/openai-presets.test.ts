import { describe, expect, it } from 'vitest';
import type { OpenAIPreset } from '@/types/settings';
import {
  endpointOriginPattern,
  getActiveOpenaiPreset,
  removeOpenaiPreset,
  upsertOpenaiPreset,
} from './openai-presets';

const preset = (id: string, name = id): OpenAIPreset => ({
  id,
  name,
  baseUrl: 'http://localhost:8080/v1',
  model: 'm',
  apiKey: '',
});

describe('getActiveOpenaiPreset', () => {
  it('returns the preset matching the active id', () => {
    const state = { openaiPresets: [preset('a'), preset('b')], activeOpenaiPresetId: 'b' };
    expect(getActiveOpenaiPreset(state)?.id).toBe('b');
  });

  it('falls back to the first preset for a stale id', () => {
    const state = { openaiPresets: [preset('a'), preset('b')], activeOpenaiPresetId: 'gone' };
    expect(getActiveOpenaiPreset(state)?.id).toBe('a');
  });

  it('falls back to the first preset when the id is null', () => {
    const state = { openaiPresets: [preset('a')], activeOpenaiPresetId: null };
    expect(getActiveOpenaiPreset(state)?.id).toBe('a');
  });

  it('returns null for an empty list', () => {
    expect(getActiveOpenaiPreset({ openaiPresets: [], activeOpenaiPresetId: null })).toBeNull();
  });
});

describe('upsertOpenaiPreset', () => {
  it('replaces by id and keeps order', () => {
    const state = {
      openaiPresets: Object.freeze([preset('a'), preset('b'), preset('c')]) as OpenAIPreset[],
      activeOpenaiPresetId: 'a',
    };
    const next = upsertOpenaiPreset(state, preset('b', 'renamed'));
    expect(next.openaiPresets.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(next.openaiPresets[1]?.name).toBe('renamed');
  });

  it('appends a new preset', () => {
    const state = { openaiPresets: [preset('a')], activeOpenaiPresetId: 'a' };
    const next = upsertOpenaiPreset(state, preset('b'));
    expect(next.openaiPresets.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('makes the first saved preset active when none is active', () => {
    const next = upsertOpenaiPreset(
      { openaiPresets: [], activeOpenaiPresetId: null },
      preset('a'),
    );
    expect(next.activeOpenaiPresetId).toBe('a');
  });

  it('does not change an existing active id', () => {
    const state = { openaiPresets: [preset('a')], activeOpenaiPresetId: 'a' };
    expect(upsertOpenaiPreset(state, preset('b')).activeOpenaiPresetId).toBe('a');
  });

  it('does not mutate its input', () => {
    const presets = Object.freeze([preset('a')]) as OpenAIPreset[];
    const state = Object.freeze({ openaiPresets: presets, activeOpenaiPresetId: null });
    const next = upsertOpenaiPreset(state, preset('b'));
    expect(presets).toHaveLength(1);
    expect(next.openaiPresets).not.toBe(presets);
  });
});

describe('removeOpenaiPreset', () => {
  it('selects the first remaining preset when the active one is removed', () => {
    const state = {
      openaiPresets: [preset('a'), preset('b'), preset('c')],
      activeOpenaiPresetId: 'b',
    };
    const next = removeOpenaiPreset(state, 'b');
    expect(next.openaiPresets.map((p) => p.id)).toEqual(['a', 'c']);
    expect(next.activeOpenaiPresetId).toBe('a');
  });

  it('keeps the active id when another preset is removed', () => {
    const state = { openaiPresets: [preset('a'), preset('b')], activeOpenaiPresetId: 'b' };
    expect(removeOpenaiPreset(state, 'a').activeOpenaiPresetId).toBe('b');
  });

  it('sets active to null when the last preset is removed', () => {
    const state = { openaiPresets: [preset('a')], activeOpenaiPresetId: 'a' };
    const next = removeOpenaiPreset(state, 'a');
    expect(next.openaiPresets).toEqual([]);
    expect(next.activeOpenaiPresetId).toBeNull();
  });

  it('does not mutate its input', () => {
    const presets = Object.freeze([preset('a'), preset('b')]) as OpenAIPreset[];
    const state = Object.freeze({ openaiPresets: presets, activeOpenaiPresetId: 'a' });
    const next = removeOpenaiPreset(state, 'a');
    expect(presets).toHaveLength(2);
    expect(next.openaiPresets).not.toBe(presets);
  });
});

describe('endpointOriginPattern', () => {
  it('drops the port and path', () => {
    expect(endpointOriginPattern('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1/*');
  });

  it('keeps the https scheme', () => {
    expect(endpointOriginPattern('https://api.openai.com/v1')).toBe('https://api.openai.com/*');
  });

  it('returns null for an invalid URL', () => {
    expect(endpointOriginPattern('not a url')).toBeNull();
  });
});


import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/types/settings';
import { getSettings } from '@/lib/utils/settings';
import { DraftTranslator, hasDraftText } from './draft-translator';

vi.mock('@/lib/utils/settings', () => ({ getSettings: vi.fn() }));
vi.mock('@/lib/utils/i18n', () => ({ t: (key: string) => key }));

function mountComposer(): { editor: HTMLElement; buttons: HTMLElement; composer: HTMLElement } {
  const composer = document.createElement('div');
  composer.className = 'channelTextArea_fixture';
  composer.innerHTML = '<div data-slate-editor="true" contenteditable="true" role="textbox"><span data-slate-placeholder>Write a message</span></div><div class="buttons_fixture"></div>';
  document.body.append(composer);
  return { composer, editor: composer.firstElementChild as HTMLElement, buttons: composer.lastElementChild as HTMLElement };
}

describe('draft composer UI', () => {
  let draft: DraftTranslator;
  beforeEach(() => {
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, draftEnabled: true });
    draft = new DraftTranslator();
  });
  afterEach(() => {
    draft.stop();
    document.body.replaceChildren();
  });

  it('hides the globe on empty input including placeholders and zero width spaces', () => {
    const { editor } = mountComposer();
    expect(hasDraftText(editor)).toBe(false);
    editor.textContent = ' \u200b\uFEFF ';
    expect(hasDraftText(editor)).toBe(false);
    editor.textContent = '안녕하세요';
    expect(hasDraftText(editor)).toBe(true);
  });

  it('uses a single native-row control group and toggles visibility on editor input', async () => {
    const { editor, buttons, composer } = mountComposer();
    draft.start();
    await draft.configure();
    editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const panel = buttons.querySelector<HTMLElement>('.basa-draft-tools')!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
    expect(editor.querySelector('.basa-draft-tools')).toBeNull();
    editor.textContent = '안녕하세요';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.hidden).toBe(false);
    const globe = panel.querySelector<HTMLButtonElement>('[aria-label="basa_translateDraft"]')!;
    expect(globe.hidden).toBe(false);
    expect(globe.querySelector('svg path')).not.toBeNull();
    editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(composer.querySelectorAll('.basa-draft-tools')).toHaveLength(1);
    editor.textContent = '';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.hidden).toBe(true);
  });

  it('removes old editor controls when moving to another composer or disabling', async () => {
    const first = mountComposer();
    const second = mountComposer();
    draft.start();
    await draft.configure();
    first.editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    second.editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(first.composer.querySelector('.basa-draft-tools')).toBeNull();
    expect(second.composer.querySelector('.basa-draft-tools')).not.toBeNull();
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, draftEnabled: false });
    await draft.configure();
    expect(second.composer.querySelector('.basa-draft-tools')).toBeNull();
  });
});

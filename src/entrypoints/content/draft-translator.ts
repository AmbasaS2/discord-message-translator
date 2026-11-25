import { createTranslationClient } from '@/lib/api/factory';
import { getSettings } from '@/lib/utils/settings';
import { t } from '@/lib/utils/i18n';

const EDITOR_SELECTOR = '[data-slate-editor="true"][contenteditable="true"][role="textbox"]';
const COMPOSER_SELECTOR = '[class*="channelTextArea"]';

export function readDraft(editor: HTMLElement): string {
  if (editor.querySelector('[data-slate-placeholder]') && !editor.querySelector('[data-slate-string]')) return '';
  return (editor.innerText ?? editor.textContent ?? '').replace(/[\u200b\uFEFF]/g, '').trim();
}

export function isRichDraft(editor: HTMLElement): boolean {
  return Boolean(editor.querySelector('[contenteditable="false"]:not([data-slate-placeholder]), [data-slate-void="true"], a[href], img'));
}

// Text replacement goes through the browser's editing pipeline, not direct Slate DOM mutation.
function replaceDraft(editor: HTMLElement, value: string): boolean {
  if (!editor.isConnected) return false;
  editor.focus();
  if (document.activeElement !== editor && !editor.contains(document.activeElement)) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  const inserted = document.execCommand('insertText', false, value);
  return inserted && readDraft(editor) === value.trim();
}

function makeButton(key: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = t(key);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  return button;
}

export class DraftTranslator {
  private enabled = false;
  private editor: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private generation = 0;
  private busy = false;

  start(): void {
    document.addEventListener('focusin', this.onFocus);
    void this.configure();
  }

  async configure(): Promise<void> {
    const settings = await getSettings();
    this.enabled = settings.draftEnabled;
    if (!this.enabled) this.detach();
    else if (document.activeElement instanceof HTMLElement) this.attach(document.activeElement);
  }

  private onFocus = (event: FocusEvent): void => {
    if (this.enabled && event.target instanceof HTMLElement) this.attach(event.target);
  };

  private detach(): void {
    this.generation++;
    this.panel?.remove();
    this.panel = null;
    this.editor = null;
    this.busy = false;
  }

  private attach(target: HTMLElement): void {
    const editor = target.closest<HTMLElement>(EDITOR_SELECTOR);
    const composer = editor?.closest<HTMLElement>(COMPOSER_SELECTOR);
    if (!editor || !composer || !editor.isConnected) return;
    if (this.editor === editor && this.panel?.isConnected) return;
    this.detach();
    this.editor = editor;
    const panel = document.createElement('div');
    panel.className = 'basa-draft-tools';
    const translate = makeButton('basa_translateDraft');
    const restore = makeButton('basa_restoreDraft');
    const copy = makeButton('basa_copyDraft');
    const status = document.createElement('span');
    status.className = 'basa-draft-status';
    status.setAttribute('aria-live', 'polite');
    const preview = document.createElement('textarea');
    preview.className = 'basa-draft-preview';
    preview.readOnly = true;
    preview.rows = 2;
    preview.hidden = true;
    restore.hidden = true;
    copy.hidden = true;
    panel.append(translate, restore, copy, status, preview);
    this.panel = panel;
    // Mount next to, never inside, Discord's editable Slate node.
    composer.appendChild(panel);

    let original = '';
    let result = '';
    let applied = false;

    translate.addEventListener('click', async () => {
      if (this.busy || this.editor !== editor || !editor.isConnected) return;
      const snapshot = readDraft(editor);
      if (!snapshot) { status.textContent = t('basa_noDraft'); return; }
      this.busy = true;
      translate.disabled = true;
      restore.hidden = true;
      copy.hidden = true;
      preview.hidden = true;
      status.textContent = t('basa_translating');
      const generation = this.generation;
      const isCurrent = () => generation === this.generation && this.editor === editor && editor.isConnected;
      try {
        const settings = await getSettings();
        if (!settings.draftEnabled || !isCurrent()) return;
        const provider = settings.draftProvider === 'inherit' ? settings.translationProvider : settings.draftProvider;
        const client = createTranslationClient({
          ...settings,
          translationProvider: provider,
          activeOpenaiPresetId: settings.draftOpenaiPresetId && settings.draftProvider === 'openai'
            ? settings.draftOpenaiPresetId : settings.activeOpenaiPresetId,
        });
        const source = provider === 'chrome-builtin' && /[가-힣]/.test(snapshot) ? 'ko' : undefined;
        const translated = await client.translate(snapshot, settings.draftTargetLanguage, source);
        if (!isCurrent()) return;
        if (!translated.trim() || translated.trim() === snapshot) {
          status.textContent = t('basa_draftUnchanged');
          return;
        }
        original = snapshot;
        result = translated;
        preview.value = result;
        copy.hidden = false;
        // Rich Slate nodes and edits made during the request must remain intact.
        const unchanged = readDraft(editor) === snapshot;
        applied = unchanged && !isRichDraft(editor) && replaceDraft(editor, result);
        restore.hidden = !applied;
        preview.hidden = applied;
        status.textContent = t(applied ? 'basa_draftReady' : 'basa_draftPreview');
      } catch {
        if (isCurrent()) status.textContent = t('basa_draftError');
      } finally {
        if (generation === this.generation) {
          this.busy = false;
          translate.disabled = false;
        }
      }
    });

    restore.addEventListener('click', () => {
      if (!applied || this.editor !== editor || readDraft(editor) !== result.trim() || isRichDraft(editor)) {
        status.textContent = t('basa_restoreBlocked');
        return;
      }
      if (replaceDraft(editor, original)) {
        applied = false;
        restore.hidden = true;
        status.textContent = t('basa_restored');
      } else {
        status.textContent = t('basa_restoreBlocked');
      }
    });

    copy.addEventListener('click', async () => {
      if (!result) return;
      try {
        await navigator.clipboard.writeText(result);
        status.textContent = t('basa_copied');
      } catch {
        preview.hidden = false;
        preview.focus();
        preview.select();
        status.textContent = t('basa_copyFailed');
      }
    });
  }
}

import { createTranslationClient } from '@/lib/api/factory';
import { validateTranslation } from '@/lib/utils/translation-validation';
import { getSettings } from '@/lib/utils/settings';
import { t } from '@/lib/utils/i18n';
import { createDraftIcon, type DraftIcon } from './basa-icons';

const EDITOR_SELECTOR = '[data-slate-editor="true"][contenteditable="true"][role="textbox"]';
const COMPOSER_SELECTOR = '[class*="channelTextArea"]';
const BUTTONS_SELECTOR = '[class^="buttons_"], [class*=" buttons_"], [class~="buttons"]';

export function hasDraftText(editor: HTMLElement): boolean {
  if (editor.querySelector('[data-slate-placeholder]') && !editor.querySelector('[data-slate-string]')) return false;
  return Boolean((editor.textContent ?? '').replace(/[\u200b\uFEFF]/g, '').trim());
}

export function readDraft(editor: HTMLElement): string {
  if (editor.querySelector('[data-slate-placeholder]') && !editor.querySelector('[data-slate-string]')) return '';
  return (editor.innerText ?? editor.textContent ?? '').replace(/[\u200b\uFEFF]/g, '').trim();
}

export function isRichDraft(editor: HTMLElement): boolean {
  return Boolean(editor.querySelector('[contenteditable="false"]:not([data-slate-placeholder]), [data-slate-void="true"], a[href], img'));
}

// Let Slate commit the edit so its model and rendered text stay in sync.
async function replaceDraft(editor: HTMLElement, value: string): Promise<boolean> {
  if (!editor.isConnected) return false;
  editor.focus();
  if (document.activeElement !== editor && !editor.contains(document.activeElement)) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const leaves = editor.querySelectorAll('[data-slate-string], [data-slate-zero-width]');
  const first = leaves[0]?.firstChild;
  const last = leaves[leaves.length - 1]?.lastChild;
  if (!(first instanceof Text) || !(last instanceof Text)) return false;
  const original = readDraft(editor);
  selection.setBaseAndExtent(first, 0, last, last.length);
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  if (!editor.isConnected || document.activeElement !== editor || readDraft(editor) !== original ||
      selection.anchorNode !== first || selection.anchorOffset !== 0 ||
      selection.focusNode !== last || selection.focusOffset !== last.length) return false;
  editor.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertReplacementText',
    data: value,
    targetRanges: [new StaticRange({
      startContainer: first,
      startOffset: 0,
      endContainer: last,
      endOffset: last.length,
    })],
  }));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  return editor.isConnected && readDraft(editor) === value.trim();
}

function makeButton(key: string, icon: DraftIcon): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'basa-draft-icon';
  button.title = t(key);
  button.setAttribute('aria-label', t(key));
  button.appendChild(createDraftIcon(icon));
  button.addEventListener('mousedown', (event) => event.preventDefault());
  return button;
}

export class DraftTranslator {
  private enabled = false;
  private editor: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private feedback: HTMLElement | null = null;
  private removeInputListener: (() => void) | null = null;
  private configureRevision = 0;
  private generation = 0;
  private busy = false;
  private requestController: AbortController | null = null;

  start(): void {
    document.addEventListener('focusin', this.onFocus);
    void this.configure();
  }

  stop(): void {
    this.configureRevision++;
    this.enabled = false;
    document.removeEventListener('focusin', this.onFocus);
    this.detach();
  }

  async configure(): Promise<void> {
    const revision = ++this.configureRevision;
    const settings = await getSettings();
    if (revision !== this.configureRevision) return;
    this.enabled = settings.draftEnabled;
    if (!this.enabled) this.detach();
    else if (document.activeElement instanceof HTMLElement) this.attach(document.activeElement);
  }

  private onFocus = (event: FocusEvent): void => {
    if (this.enabled && event.target instanceof HTMLElement) this.attach(event.target);
  };

  private detach(): void {
    this.generation++;
    this.requestController?.abort();
    this.requestController = null;
    this.removeInputListener?.();
    this.removeInputListener = null;
    this.panel?.remove();
    this.feedback?.remove();
    this.panel = null;
    this.feedback = null;
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
    const translate = makeButton('basa_translateDraft', 'globe');
    const restore = makeButton('basa_restoreDraft', 'restore');
    const copy = makeButton('basa_copyDraft', 'copy');
    const feedback = document.createElement('div');
    feedback.className = 'basa-draft-feedback basa-draft-feedback--quiet';
    const status = document.createElement('span');
    status.className = 'basa-draft-status';
    status.setAttribute('aria-live', 'polite');
    const preview = document.createElement('textarea');
    preview.className = 'basa-draft-preview';
    preview.readOnly = true;
    preview.rows = 2;
    preview.hidden = true;
    panel.append(translate, restore, copy);
    feedback.append(status, preview);
    this.panel = panel;
    this.feedback = feedback;
    // Use the existing accessory row; fall back to one compact row outside Slate.
    const buttons = composer.querySelector<HTMLElement>(BUTTONS_SELECTOR);
    if (buttons && !editor.contains(buttons)) buttons.prepend(panel);
    else {
      panel.classList.add('basa-draft-tools--fallback');
      composer.appendChild(panel);
    }
    composer.appendChild(feedback);

    let original = '';
    let result = '';
    let applied = false;
    let writing = false;
    let inputFrame: number | undefined;
    let pasteTimer: number | undefined;

    const setHidden = (element: HTMLElement, hidden: boolean) => {
      if (element.hidden !== hidden) element.hidden = hidden;
    };
    const updateVisibility = () => {
      const hasText = hasDraftText(editor);
      setHidden(translate, !hasText || applied);
      setHidden(restore, !hasText || !applied);
      setHidden(copy, !result || (!applied && Boolean(preview.hidden)));
      setHidden(panel, Boolean(translate.hidden && restore.hidden && copy.hidden));
    };
    const setStatus = (key: string, visible = false) => {
      const message = key ? t(key) : '';
      if (status.textContent !== message) status.textContent = message;
      feedback.classList.toggle('basa-draft-feedback--quiet', !visible && Boolean(preview.hidden));
      status.classList.toggle('basa-draft-status--quiet', !visible);
    };
    const writeDraft = async (value: string) => {
      writing = true;
      try { return await replaceDraft(editor, value); }
      finally { writing = false; }
    };
    const onInput = () => {
      if (writing || this.editor !== editor || inputFrame !== undefined) return;
      // Slate may handle beforeinput itself and never emit a native input event.
      inputFrame = window.requestAnimationFrame(() => {
        inputFrame = undefined;
        if (!editor.isConnected || this.editor !== editor) return;
        // Changes invalidate a completed result, but never interrupt an active request.
        if (!this.busy && (result || applied || status.textContent || !preview.hidden)) {
          original = '';
          result = '';
          applied = false;
          preview.hidden = true;
          setStatus('');
        }
        updateVisibility();
      });
    };
    editor.addEventListener('beforeinput', onInput, true);
    const onPaste = (event: ClipboardEvent) => {
      if (!(event.target instanceof Node) || !editor.contains(event.target)) return;
      // Discord can consume the paste and commit text after its clipboard handler finishes.
      window.clearTimeout(pasteTimer);
      pasteTimer = window.setTimeout(onInput, 60);
    };
    window.addEventListener('paste', onPaste, true);
    this.removeInputListener = () => {
      editor.removeEventListener('beforeinput', onInput, true);
      window.removeEventListener('paste', onPaste, true);
      window.clearTimeout(pasteTimer);
      if (inputFrame !== undefined) window.cancelAnimationFrame(inputFrame);
    };
    updateVisibility();

    translate.addEventListener('click', async () => {
      if (this.busy || this.editor !== editor || !editor.isConnected) return;
      const snapshot = readDraft(editor);
      if (!snapshot) { updateVisibility(); return; }
      this.busy = true;
      translate.disabled = true;
      translate.setAttribute('aria-busy', 'true');
      original = '';
      result = '';
      applied = false;
      preview.hidden = true;
      setStatus('basa_translating');
      updateVisibility();
      const generation = this.generation;
      const controller = new AbortController();
      this.requestController = controller;
      const isCurrent = () => !controller.signal.aborted && generation === this.generation && this.editor === editor && editor.isConnected;
      try {
        const settings = await getSettings();
        if (!settings.draftEnabled || !isCurrent()) return;
        const provider = settings.draftProvider === 'inherit' ? settings.translationProvider : settings.draftProvider;
        if (settings.draftProvider === 'openai' && settings.draftOpenaiPresetId &&
            !settings.openaiPresets.some((preset) => preset.id === settings.draftOpenaiPresetId)) {
          throw new Error('The selected draft AI connection no longer exists');
        }
        const client = createTranslationClient({
          ...settings,
          translationProvider: provider,
          activeOpenaiPresetId: settings.draftOpenaiPresetId && settings.draftProvider === 'openai'
            ? settings.draftOpenaiPresetId : settings.activeOpenaiPresetId,
        }, 'draft');
        const source = provider === 'chrome-builtin' && /[가-힣]/.test(snapshot) ? 'ko' : undefined;
        const raw = await client.translate(snapshot, settings.draftTargetLanguage, source, controller.signal);
        if (!isCurrent()) return;
        const translated = validateTranslation(snapshot, raw, settings.draftTargetLanguage);
        if (translated === null) {
          setStatus('basa_draftError', true);
          return;
        }
        if (translated === snapshot) {
          setStatus('basa_draftUnchanged', true);
          return;
        }
        original = snapshot;
        result = translated;
        preview.value = result;
        // Rich Slate nodes and edits made during the request must remain intact.
        const unchanged = readDraft(editor) === snapshot;
        applied = unchanged && !isRichDraft(editor) && await writeDraft(result);
        if (!isCurrent()) return;
        preview.hidden = applied;
        setStatus(applied ? 'basa_draftReady' : 'basa_draftPreview', !applied);
        updateVisibility();
      } catch {
        if (isCurrent()) setStatus('basa_draftError', true);
      } finally {
        if (this.requestController === controller) this.requestController = null;
        if (generation === this.generation) {
          this.busy = false;
          translate.disabled = false;
          translate.removeAttribute('aria-busy');
          updateVisibility();
        }
      }
    });

    restore.addEventListener('click', async () => {
      if (writing || !applied || this.editor !== editor || readDraft(editor) !== result.trim() || isRichDraft(editor)) {
        setStatus('basa_restoreBlocked', true);
        return;
      }
      const restored = await writeDraft(original);
      if (this.editor !== editor || !editor.isConnected) return;
      if (restored) {
        applied = false;
        original = '';
        result = '';
        preview.hidden = true;
        setStatus('basa_restored');
        updateVisibility();
      } else {
        setStatus('basa_restoreBlocked', true);
      }
    });

    copy.addEventListener('click', async () => {
      if (!result) return;
      try {
        await navigator.clipboard.writeText(result);
        setStatus('basa_copied', !preview.hidden);
      } catch {
        preview.hidden = false;
        preview.focus();
        preview.select();
        setStatus('basa_copyFailed', true);
        updateVisibility();
      }
    });
  }
}

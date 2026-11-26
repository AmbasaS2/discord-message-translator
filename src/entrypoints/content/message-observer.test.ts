import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/types/settings';
import { getSettings } from '@/lib/utils/settings';
import { translateMessage, translateMessageBatch } from '@/lib/utils/translator';
import { MessageTranslationObserver } from './message-observer';

vi.mock('@/lib/utils/settings', () => ({ getSettings: vi.fn() }));
vi.mock('@/lib/utils/translator', () => ({
  translateMessage: vi.fn(),
  translateMessageBatch: vi.fn(),
}));

const translated = '.discord-translator-translation';
const observe = vi.fn();
const unobserve = vi.fn();
let onIntersection: (entries: IntersectionObserverEntry[]) => void;
let onMutation: (entries: MutationRecord[]) => void;
let observer: MessageTranslationObserver;

function message(id: number, content: string): HTMLElement {
  const node = document.createElement('li');
  node.id = `chat-messages-1-${id}`;
  node.innerHTML = `<div id="message-content-${id}">${content}</div>`;
  return node;
}

async function show(...nodes: HTMLElement[]): Promise<void> {
  onIntersection(nodes.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry));
  await vi.advanceTimersByTimeAsync(120);
}

describe('MessageTranslationObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', class {
      observe = observe;
      unobserve = unobserve;
      disconnect = vi.fn();
      constructor(callback: typeof onIntersection) { onIntersection = callback; }
    });
    vi.stubGlobal('MutationObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: typeof onMutation) { onMutation = callback; }
    });
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, translationMode: 'append' });
    observer = new MessageTranslationObserver();
  });

  afterEach(() => {
    observer.stop();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('leaves a no-op result untouched and can translate it on a later intersection', async () => {
    const node = message(101, 'The original stays visible.');
    document.body.append(node);
    vi.mocked(translateMessage)
      .mockResolvedValueOnce('The original stays visible.')
      .mockResolvedValueOnce('원문은 계속 보입니다.');
    observer.start();

    await show(node);
    expect(node.querySelector(translated)).toBeNull();
    expect(node.textContent).toBe('The original stays visible.');

    await show(node);
    expect(node.querySelector(translated)?.textContent).toBe('원문은 계속 보입니다.');
    expect(unobserve).toHaveBeenCalledWith(node);
  });

  it('uses the existing mutation observer to update an edited message without reacting to its own output', async () => {
    const node = message(101, 'Before edit.');
    const content = node.querySelector<HTMLElement>('[id^="message-content-"]')!;
    const source = content.firstChild as Text;
    document.body.append(node);
    vi.mocked(translateMessage).mockResolvedValueOnce('수정 전.').mockResolvedValueOnce('수정 후.');
    observer.start();
    await show(node);
    const ownView = content.querySelector(translated)!;
    onMutation([{ type: 'childList', target: content, addedNodes: [ownView], removedNodes: [] } as unknown as MutationRecord]);
    await vi.advanceTimersByTimeAsync(120);
    expect(translateMessage).toHaveBeenCalledTimes(1);
    expect(content.querySelector(translated)).toBe(ownView);

    source.data = 'After edit.';
    onMutation([{ type: 'characterData', target: source, addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
    expect(content.querySelector(translated)).toBeNull();
    expect(content.textContent).toBe('After edit.');
    await show(node);
    expect(content.querySelector(translated)?.textContent).toBe('수정 후.');
    expect(translateMessage).toHaveBeenCalledTimes(2);
  });

  it('discards an in-flight response for edited source and sends the new source on re-entry', async () => {
    const node = message(101, 'Before edit.');
    const content = node.querySelector<HTMLElement>('[id^="message-content-"]')!;
    document.body.append(node);
    let resolveOld!: (value: string) => void;
    vi.mocked(translateMessage)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce('수정 후.');
    observer.start();
    await show(node);
    const signal = vi.mocked(translateMessage).mock.calls[0]![3]!;
    const original = content.firstChild as Text;
    original.data = 'After edit.';
    onMutation([{ type: 'characterData', target: original, addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
    expect(signal.aborted).toBe(true);
    resolveOld('오래된 결과.');
    await vi.advanceTimersByTimeAsync(120);
    expect(content.querySelector(translated)).toBeNull();
    await show(node);
    expect(content.querySelector(translated)?.textContent).toBe('수정 후.');
  });

  it('cancels an entirely detached translation job using the existing mutation callback', async () => {
    const node = message(101, 'Before leaving.');
    document.body.append(node);
    let resolveOld!: (value: string) => void;
    vi.mocked(translateMessage).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    observer.start();
    await show(node);
    const signal = vi.mocked(translateMessage).mock.calls[0]![3]!;
    node.remove();
    onMutation([{ type: 'childList', target: document.body, addedNodes: [], removedNodes: [node] } as unknown as MutationRecord]);
    expect(signal.aborted).toBe(true);
    resolveOld('늦은 결과.');
    await vi.advanceTimersByTimeAsync(120);
    expect(node.querySelector(translated)).toBeNull();
  });

  it('cancels outstanding requests on a settings change and on stop', async () => {
    const node = message(101, 'Pending.');
    document.body.append(node);
    let finish!: (value: string) => void;
    vi.mocked(translateMessage).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    observer.start();
    await show(node);
    const first = vi.mocked(translateMessage).mock.calls[0]![3]!;
    observer.cancelOutstanding();
    expect(first.aborted).toBe(true);
    finish('이전 설정.');
    await vi.advanceTimersByTimeAsync(120);
    await show(node);
    const next = vi.mocked(translateMessage).mock.calls[1]![3]!;
    observer.stop();
    expect(next.aborted).toBe(true);
    finish('늦은 번역.');
    await vi.advanceTimersByTimeAsync(120);
    expect(node.querySelector(translated)).toBeNull();
  });

  it('translates a remounted message with the same ID on channel re-entry', async () => {
    const original = message(101, 'Same message.');
    document.body.append(original);
    vi.mocked(translateMessage).mockResolvedValue('같은 메시지.');
    observer.start();
    await show(original);

    const remounted = message(101, 'Same message.');
    original.replaceWith(remounted);
    onMutation([{
      target: document.body,
      addedNodes: [remounted],
      removedNodes: [original],
    } as unknown as MutationRecord]);
    await show(remounted);

    expect(observe).toHaveBeenCalledWith(remounted);
    expect(remounted.querySelectorAll(translated)).toHaveLength(1);
    expect(remounted.querySelector(translated)?.textContent).toBe('같은 메시지.');
  });

  it('skips unchanged structured results without dropping other batch translations', async () => {
    const nodes = Array.from({ length: 10 }, (_, index) =>
      message(101 + index, index ? 'A translated sentence.' : '<h2>Heading</h2><p>Another block.</p>'));
    document.body.append(...nodes);
    vi.mocked(translateMessageBatch).mockImplementation(async (items) =>
      new Map(items.map(({ id, content }) => [id, content === 'A translated sentence.' ? '번역된 문장.' : content])));
    observer.start();
    await show(...nodes);

    expect(nodes[0]?.querySelector(translated)).toBeNull();
    expect(nodes[0]?.querySelector('h2')?.textContent).toBe('Heading');
    expect(nodes[1]?.querySelector(translated)?.textContent).toBe('번역된 문장.');
  });

  it('translates mixed chat and current Discord embeds while preserving rich markup', async () => {
    const node = message(101, 'Plain message.');
    node.insertAdjacentHTML('beforeend', `
      <div id="message-accessories-101">
        <article class="embedFull_XyW1ZT embed_XyW1ZT">
          <div class="embedTitle_XyW1ZT">Welcome!</div>
          <div class="embedDescription_XyW1ZT"><p>First paragraph.</p><p>Second paragraph.</p></div>
          <div class="embedFieldName_XyW1ZT">Instructions</div>
          <div class="embedFieldValue_XyW1ZT">
            <p>Ask <span class="mention" role="button">@Helper</span> or visit <a href="https://example.com/">Help</a>.</p>
            <ul><li>First step</li><li>Second step</li></ul>
            <pre><code>do_not_translate()</code></pre>
            <p>See <img src="/emoji.png" alt="sparkles"> the result.</p>
          </div>
          <img class="embedImage_XyW1ZT" src="/banner.png" alt="banner">
          <span class="embedFooterText_XyW1ZT">Community footer</span>
        </article>
      </div>`);
    document.body.append(node);
    vi.mocked(translateMessage).mockImplementation(async (_, text) => `번역 ${text}`);
    vi.mocked(translateMessageBatch).mockImplementation(async (items) => {
      expect(items.every(({ content }) => !content.includes('do_not_translate'))).toBe(true);
      return new Map(items.map(({ id, content }) => [id, `번역 ${content.replace(/§([MP])(\d+)§/g, '§ $1 $2 §')}`]));
    });
    observer.start();
    await show(node);

    expect(node.querySelectorAll(translated)).toHaveLength(6);
    expect(node.querySelector(`[class*="embedDescription"] ${translated}`)?.querySelectorAll('p')).toHaveLength(2);
    const field = node.querySelector(`[class*="embedFieldValue"] ${translated}`);
    expect(field?.querySelectorAll('ul > li')).toHaveLength(2);
    expect(field?.querySelector('pre > code')?.textContent).toBe('do_not_translate()');
    expect(field?.querySelector('.mention')?.textContent).toBe('@Helper');
    expect(field?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
    expect(field?.querySelector('img')?.getAttribute('src')).toBe('/emoji.png');
    expect(node.querySelectorAll('[class*="embedImage"]')).toHaveLength(1);
    expect(node.querySelector(`[class*="embedFooterText"] ${translated}`)?.textContent).toBe('번역 Community footer');
  });

  it.each([1, 10])('retries a missing embed when plain text succeeds (%i visible messages)', async (count) => {
    const nodes = Array.from({ length: count }, (_, index) => message(101 + index, 'Plain message.'));
    const node = nodes[0]!;
    node.insertAdjacentHTML('beforeend', `
      <div id="message-accessories-101">
        <article class="embed_XyW1ZT"><div class="embedTitle_XyW1ZT">Welcome!</div></article>
      </div>`);
    document.body.append(...nodes);
    let retry = false;
    const resultFor = (text: string) => text === 'Welcome!' && !retry ? text : `번역 ${text}`;
    vi.mocked(translateMessage).mockImplementation(async (_, text) => resultFor(text));
    vi.mocked(translateMessageBatch).mockImplementation(async (items) =>
      new Map(items.map(({ id, content }) => [id, resultFor(content)])));
    observer.start();
    await show(...nodes);
    expect(node.querySelectorAll(translated)).toHaveLength(1);
    expect(unobserve).not.toHaveBeenCalledWith(node);

    retry = true;
    await show(node);
    expect(node.querySelectorAll(translated)).toHaveLength(2);
    expect(unobserve).toHaveBeenCalledWith(node);
  });
});

describe('interleaved bilingual modes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', class {
      observe = observe;
      unobserve = unobserve;
      disconnect = vi.fn();
      constructor(callback: typeof onIntersection) { onIntersection = callback; }
    });
    vi.stubGlobal('MutationObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: typeof onMutation) { onMutation = callback; }
    });
    observer = new MessageTranslationObserver();
  });

  afterEach(() => {
    observer.stop();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([1, 10])('uses the existing batch path for sentence pairs with %i visible messages', async (count) => {
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, translationMode: 'append', bilingualGranularity: 'sentence' });
    vi.mocked(translateMessageBatch).mockImplementation(async (items) =>
      new Map(items.map(({ id, content }) => [id, content === 'First.' ? '첫째.' : '둘째.'])));
    const nodes = Array.from({ length: count }, (_, i) => message(200 + i, 'First. Second.'));
    document.body.append(...nodes);
    observer.start();
    await show(...nodes);
    expect(nodes[0]!.querySelectorAll('.basa-bilingual-unit')).toHaveLength(2);
    expect(nodes[0]!.querySelector('[id^="message-content-"]')?.textContent).toBe('First.첫째. Second.둘째.');
    expect(translateMessageBatch).toHaveBeenCalled();
    expect(translateMessage).not.toHaveBeenCalled();
  });

  it('uses the same request IDs in all four display modes', async () => {
    let ids: string[] | undefined;
    vi.mocked(translateMessageBatch).mockImplementation(async items => {
      const current = items.map(({ id }) => id);
      if (ids) expect(current).toEqual(ids);
      else ids = current;
      return new Map(items.map(({ id, content }) => [id, content === 'First.' ? '첫째.' : '둘째.']));
    });
    for (const mode of ['message', 'paragraph', 'sentence', 'replace'] as const) {
      vi.mocked(getSettings).mockResolvedValue({
        ...DEFAULT_SETTINGS,
        translationMode: mode === 'replace' ? 'replace' : 'append',
        bilingualGranularity: mode === 'replace' ? 'message' : mode,
      });
      const node = message(900, 'First. Second.');
      document.body.append(node);
      observer.start();
      await show(node);
      expect(node.querySelector(translated)).not.toBeNull();
      observer.stop();
      node.remove();
      observer = new MessageTranslationObserver();
    }
    expect(translateMessageBatch).toHaveBeenCalledTimes(4);
  });

  it('does not alter original replacement mode', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, translationMode: 'replace', bilingualGranularity: 'sentence' });
    vi.mocked(translateMessageBatch).mockImplementation(async items =>
      new Map(items.map(({ id, content }) => [id, content === 'First.' ? '첫째.' : '둘째.'])));
    const node = message(200, 'First. Second.');
    document.body.append(node);
    observer.start();
    await show(node);
    expect(node.querySelector('.basa-bilingual-unit')).toBeNull();
    expect(node.querySelector<HTMLElement>('.discord-translator-original')?.style.display).toBe('none');
    expect(node.querySelector(translated)?.textContent).toBe('첫째. 둘째.');
  });
});

describe('batched remote visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', class {
      observe = observe;
      unobserve = unobserve;
      disconnect = vi.fn();
      constructor(callback: typeof onIntersection) { onIntersection = callback; }
    });
    vi.stubGlobal('MutationObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: typeof onMutation) { onMutation = callback; }
    });
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, translationProvider: 'openai', translationMode: 'append', bilingualGranularity: 'sentence' });
    observer = new MessageTranslationObserver();
  });
  afterEach(() => {
    observer.stop();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('batches fewer than ten visible messages and never enqueues an in-flight message twice', async () => {
    let complete!: (value: Map<string, string>) => void;
    vi.mocked(translateMessageBatch).mockImplementationOnce(items => new Promise(resolve => {
      complete = () => resolve(new Map(items.map(({ id }) => [id, '번역.'])));
    }));
    const nodes = [message(501, 'First. Second.'), message(502, 'Third.')];
    document.body.append(...nodes);
    observer.start();
    await show(...nodes);
    await show(...nodes);
    expect(translateMessageBatch).toHaveBeenCalledTimes(1);
    const items = vi.mocked(translateMessageBatch).mock.calls[0]![0];
    expect(items).toHaveLength(3);
    expect(items[0]!.groupId).toBe(items[1]!.groupId);
    expect(items[0]!.groupId).not.toBe(items[2]!.groupId);
    complete(new Map());
    await vi.advanceTimersByTimeAsync(120);
    expect(nodes[0]!.querySelectorAll('.basa-bilingual-unit')).toHaveLength(2);
  });
});

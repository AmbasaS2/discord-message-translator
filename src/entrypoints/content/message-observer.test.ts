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
});

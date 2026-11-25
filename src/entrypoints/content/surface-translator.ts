import { createTranslationClient } from '@/lib/api/factory';
import type { Settings } from '@/types/settings';

const NAV = '#channels [class*="name_"], [data-list-item-id^="channels___"] [class*="name_"], [data-list-id*="channels"] [class*="name_"]';
const FORUM = '[class*="mainCard"] h3, [class*="mainCard"] [class*="postTitleText"], [class*="mainCard"] [class*="postBody"], [class*="mainCard"] [class*="threadTitle"], [class*="titleWrapper"] h1, section[class*="title"][class*="container"] [class*="topic"]';
const SEARCH = '[class*="searchResult"] [id^="message-content-"], [class*="searchResult"] [class*="messageContent"]';
const MARK = 'data-basa-surface';
const TRANSLATION = 'data-basa-translation';
const MAX_PENDING = 64;
const BATCH_SIZE = 6;
const CACHE_LIMIT = 256;

type SurfaceKind = 'nav' | 'forum' | 'search';
interface SurfaceState { source: string; kind: SurfaceKind }

export function isSearchSurface(element: Element): boolean {
  return element.closest('[class*="searchResult"]') !== null;
}

function isOwnContent(element: Element): boolean {
  return element.closest('.discord-translator-translation, .discord-translator-original, .basa-draft-tools') !== null;
}

export function surfaceText(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function shouldTranslate(source: string, language: string): boolean {
  if (!/\p{L}/u.test(source)) return false;
  if (language === 'ko' && /^[\p{Script=Hangul}\p{N}\p{P}\p{S}\s]+$/u.test(source)) return false;
  return true;
}

/** Shares the message observer's IntersectionObserver and request queue. */
export class SurfaceTranslator {
  private states = new WeakMap<HTMLElement, SurfaceState>();
  private pending = new Map<HTMLElement, SurfaceState>();
  private cache = new Map<string, string>();
  private selector = '';
  private settings: Settings | null = null;
  private epoch = 0;

  constructor(private readonly intersection: IntersectionObserver) {}

  configure(settings: Settings): void {
    this.clear();
    this.settings = settings;
    if (!settings.autoTranslate) return;
    this.selector = [
      settings.translateNavigation ? NAV : '',
      settings.translateForum ? FORUM : '',
      settings.translateSearch ? SEARCH : '',
    ].filter(Boolean).join(', ');
    if (this.selector && document.body) this.scan(document.body);
  }

  private kind(element: HTMLElement): SurfaceKind | null {
    if (this.settings?.translateSearch && element.matches(SEARCH)) return 'search';
    if (this.settings?.translateNavigation && element.matches(NAV)) return 'nav';
    if (this.settings?.translateForum && element.matches(FORUM)) return 'forum';
    return null;
  }

  scan(root: Element): void {
    if (!this.selector || !root.isConnected || isOwnContent(root)) return;
    if (root.closest('[id^="chat-messages-"]') && !isSearchSurface(root)) return;
    if (root instanceof HTMLElement && root.matches(this.selector)) this.register(root);
    if (root.childElementCount) root.querySelectorAll<HTMLElement>(this.selector).forEach((element) => this.register(element));
  }

  refreshParent(root: Element): void {
    if (!this.selector || isOwnContent(root)) return;
    const parent = root.closest<HTMLElement>(this.selector);
    if (parent) this.register(parent);
  }

  private register(element: HTMLElement): void {
    if (!element.isConnected || isOwnContent(element) || !this.settings || !this.selector) return;
    // Prefer the innermost matching label so nested title wrappers are not translated twice.
    if (element.childElementCount && element.querySelector(this.selector)) return;
    const kind = this.kind(element);
    if (!kind) return;
    const source = surfaceText(element);
    const previous = this.states.get(element);
    if (previous?.source === source && previous.kind === kind) return;
    if (previous) this.release(element);
    if (!source || source.length > (kind === 'nav' ? 120 : 1600) ||
        !shouldTranslate(source, this.settings.targetLanguage)) return;
    const state = { source, kind };
    this.states.set(element, state);
    element.setAttribute(MARK, kind);
    this.intersection.observe(element);
  }

  handleIntersection(entry: IntersectionObserverEntry): boolean {
    const element = entry.target;
    if (!(element instanceof HTMLElement)) return false;
    const state = this.states.get(element);
    if (!state) return false;
    if (!element.isConnected) {
      this.release(element);
      return true;
    }
    if (entry.isIntersecting && this.pending.size < MAX_PENDING) {
      this.intersection.unobserve(element);
      this.pending.set(element, state);
    }
    return true;
  }

  hasPending(): boolean { return this.pending.size > 0; }

  releaseSubtree(root: Element): void {
    if (!this.selector || root.isConnected) return;
    if (root instanceof HTMLElement && this.states.has(root)) this.release(root);
    if (root.childElementCount) root.querySelectorAll<HTMLElement>('[data-basa-surface]').forEach((element) => this.release(element));
  }

  private release(element: HTMLElement): void {
    this.intersection.unobserve(element);
    this.pending.delete(element);
    this.states.delete(element);
    element.removeAttribute(MARK);
    element.removeAttribute(TRANSLATION);
    element.removeAttribute('data-basa-label-mode');
    element.removeAttribute('data-basa-original');
  }

  private remember(key: string, translated: string): void {
    this.cache.delete(key);
    this.cache.set(key, translated);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  async process(settings: Settings): Promise<void> {
    if (!settings.autoTranslate || !this.settings) { this.pending.clear(); return; }
    const epoch = this.epoch;
    const work: Array<{ element: HTMLElement; state: SurfaceState; text: string; key: string }> = [];
    for (const [element, state] of this.pending) {
      this.pending.delete(element);
      if (!element.isConnected || this.states.get(element) !== state || surfaceText(element) !== state.source) continue;
      const text = state.kind === 'nav' ? state.source.replace(/(?<=\p{L})-(?=\p{L})/gu, ' ') : state.source;
      const key = JSON.stringify([settings.translationProvider, settings.activeOpenaiPresetId, settings.targetLanguage, text]);
      work.push({ element, state, text, key });
      if (work.length >= BATCH_SIZE) break;
    }
    if (!work.length) return;
    const results = new Map<string, string>();
    const missing = new Map<string, string>();
    for (const item of work) {
      const hit = this.cache.get(item.key);
      if (hit !== undefined) results.set(item.key, hit);
      else missing.set(item.key, item.text);
    }
    if (missing.size) {
      const client = createTranslationClient(settings);
      const entries = [...missing];
      const translated = await client.translateBatch(entries.map(([, text]) => text), settings.targetLanguage);
      if (epoch !== this.epoch) return;
      entries.forEach(([key, source], index) => {
        const result = translated[index]?.trim();
        if (!result) return;
        results.set(key, result);
        if (result !== source) this.remember(key, result);
      });
    }
    if (epoch !== this.epoch) return;
    for (const item of work) {
      const translation = results.get(item.key);
      if (!translation || translation === item.text || translation === item.state.source ||
          !item.element.isConnected || this.states.get(item.element) !== item.state ||
          surfaceText(item.element) !== item.state.source) continue;
      // Pseudo-elements display the translation without modifying React-owned children.
      item.element.setAttribute(TRANSLATION, translation);
      if (item.state.kind === 'nav' && item.element.children.length === 0) {
        item.element.setAttribute('data-basa-original', item.state.source);
        item.element.setAttribute('data-basa-label-mode', 'nav');
      }
    }
  }

  clear(): void {
    this.epoch++;
    document.querySelectorAll<HTMLElement>('[data-basa-surface]').forEach((element) => this.release(element));
    this.pending.clear();
    this.cache.clear();
    this.states = new WeakMap();
    this.selector = '';
    this.settings = null;
  }
}

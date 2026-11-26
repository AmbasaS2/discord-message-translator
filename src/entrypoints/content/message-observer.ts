import { getSettings } from '@/lib/utils/settings';
import { translateMessage, translateMessageBatch } from '@/lib/utils/translator';
import { isDiscordMessage, createDiscordMessage, findTranslatableElements, findAllTranslatableElements, type TranslatableElement } from './message-utils';
import { RequestQueue, debounce } from '@/lib/utils/async-control';
import { ChromeLanguageDetector } from '@/lib/api/chrome-language-detector';
import { extractBlocks, assembleTranslation, type StructuredBlock } from '@/lib/utils/structure-preserving';
import { shouldSkipText } from './language-skip';
import { collectBilingualLayout, renderBilingualLayout, bilingualUnitId, clearTranslationView, readOriginalSource, type BilingualLayout } from '@/lib/utils/bilingual-units';
import { SurfaceTranslator, isSearchSurface } from './surface-translator';

/**
 * Generate a unique key for TranslatableElement
 */
function getTranslatableElementKey(item: TranslatableElement): string {
  if (item.type === 'message-content') {
    const isReplyContext = item.element.closest('[id^="message-reply-context-"]') !== null;
    return `${item.id}-${isReplyContext ? 'reply' : 'main'}`;
  }
  // For embed sections, use the unique ID directly
  return `embed-${item.id}`;
}

// Configuration constants
const MAX_CONCURRENT_REQUESTS = 3; // Limit concurrent translation API requests
const DEBOUNCE_DELAY = 100; // Debounce delay in milliseconds for batch processing
const BATCH_SIZE = 10; // Number of messages to translate in a single batch

// Language detection constants
const LANGUAGE_DETECTION_MIN_CONFIDENCE = 0.7; // Minimum confidence for language detection

const MESSAGE_CONTAINER = '[id^="chat-messages-"], [id^="message-content-"]';
const SOURCE_REGION = '[id^="message-content-"], [id^="message-accessories-"], [id^="message-reply-context-"]';
const OWN_UI = '.discord-translator-translation, .basa-draft-tools, .basa-draft-feedback';
const VIEW_SELECTOR = '.discord-translator-translation';

interface SourceState { source: string; views: HTMLElement[] }
interface TranslationJob {
  controller: AbortController;
  path: string;
  messages: Array<[HTMLElement, string]>;
  invalidated: Set<HTMLElement>;
}

interface BlockEntry {
  block: StructuredBlock;
  id: string;
  send: boolean;
}

function resolveBlock(entry: BlockEntry, results: Map<string, string>, preserveTokens: boolean) {
  const { block, id } = entry;
  let translation = results.get(id) || block.text;
  let complete = !entry.send || Boolean(results.get(id));
  if (preserveTokens && block.placeholders.length) {
    translation = translation.replace(/§\s*([MCP])\s*(\d+)\s*§/gi,
      (_, prefix: string, index: string) => `§${prefix.toUpperCase()}${index}§`);
    if (block.placeholders.some(({ token }) => translation.split(token).length !== 2)) {
      translation = block.text;
      complete = false;
    }
  }
  return { block, translation, complete };
}

export class MessageTranslationObserver {
  private intersectionObserver: IntersectionObserver;
  private mutationObserver: MutationObserver;
  private surfaces: SurfaceTranslator;
  private surfaceWorkScheduled = false;
  private active = false;
  private surfaceSettingsRevision = 0;
  // Discord can remount the same message when returning to a channel.
  private observedMessages = new WeakMap<HTMLElement, string>();
  private translatedMessages = new WeakSet<HTMLElement>();
  private translatedElements = new WeakSet<HTMLElement>();
  private inFlightMessages = new WeakSet<HTMLElement>();
  private sourceStates = new WeakMap<HTMLElement, Map<HTMLElement, SourceState>>();
  private reobserveAfterJob = new WeakSet<HTMLElement>();
  private jobs = new Set<TranslationJob>();
  private requestEpoch = 0;
  private translationQueue: RequestQueue; // Request queue for rate limiting
  private pendingMessages = new Map<HTMLElement, string>();
  private processPendingDebounced: () => void;

  // Language detection state (not persisted - resets on page reload)
  private languageDetector: ChromeLanguageDetector | null = null;

  constructor() {
    // Initialize request queue with concurrency limit
    this.translationQueue = new RequestQueue(MAX_CONCURRENT_REQUESTS);

    // Debounced batch processor
    this.processPendingDebounced = debounce(() => {
      this.processPendingMessages();
    }, DEBOUNCE_DELAY);

    // Intersection Observer: Translate messages that enter the visible area
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (this.surfaces.handleIntersection(entry)) continue;
          const element = entry.target as HTMLElement;
          if (!element.isConnected) {
            this.intersectionObserver.unobserve(element);
            this.observedMessages.delete(element);
            this.pendingMessages.delete(element);
            continue;
          }
          const messageId = this.observedMessages.get(element);
          if (entry.isIntersecting && messageId && !this.translatedMessages.has(element) && !this.inFlightMessages.has(element)) {
            this.pendingMessages.set(element, messageId);
          }
        }

        if (this.pendingMessages.size || this.surfaces.hasPending()) this.processPendingDebounced();
      },
      {
        root: null, // Use viewport as root
        rootMargin: '100px', // Start loading 100px before viewport (prevent flickering during scroll)
        threshold: 0.1, // Trigger when 10% visible
      }
    );

    this.surfaces = new SurfaceTranslator(this.intersectionObserver);

    // Reuse the existing observer for source edits. Character-data changes
    // outside message bodies / registered surfaces need no processing.
    this.mutationObserver = new MutationObserver((mutations) => {
      const dirty = new Set<HTMLElement>();
      let removed = false;
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (!target || target.closest(OWN_UI)) continue;
        const search = isSearchSurface(target);
        const container = search ? null :
          (target.closest<HTMLElement>('[id^="chat-messages-"]') ?? target.closest<HTMLElement>('[id^="message-content-"]'));
        const ordinaryChat = Boolean(container || (!search && target.closest(SOURCE_REGION)));
        if (mutation.type === 'characterData') {
          if (container && this.sourceStates.has(container) && target.closest(SOURCE_REGION)) dirty.add(container);
          else if (!ordinaryChat && target.closest('[data-basa-surface]')) this.surfaces.refreshParent(target);
          continue;
        }
        const added = Array.from(mutation.addedNodes);
        const deleted = Array.from(mutation.removedNodes);
        if (deleted.length) removed = true;
        if (container && this.sourceStates.has(container)) {
          if (target.closest(SOURCE_REGION) || [...added, ...deleted].some(node =>
              node instanceof Element && (node.matches(SOURCE_REGION) || node.querySelector(SOURCE_REGION)))) {
            dirty.add(container);
          }
          // New children inside a tracked message are handled by reconciliation,
          // not by another scan for message containers.
          continue;
        }
        for (const node of deleted) {
          if (node instanceof Element && !ordinaryChat && !node.isConnected) this.surfaces.releaseSubtree(node);
        }
        if (!ordinaryChat) this.surfaces.refreshParent(target);
        for (const node of added) {
          if (!(node instanceof HTMLElement) || node.closest(OWN_UI)) continue;
          if (!ordinaryChat) this.surfaces.scan(node);
          if (isSearchSurface(node)) continue;
          if (node.id?.startsWith('chat-messages-')) {
            this.observeMessage(node);
            continue;
          }
          if (ordinaryChat) {
            if (container) this.observeMessage(container);
            continue;
          }
          const messageContainers = node.querySelectorAll<HTMLElement>('[id^="chat-messages-"]');
          messageContainers.forEach(message => this.observeMessage(message));
          if (!messageContainers.length && isDiscordMessage(node)) this.observeMessage(node);
        }
      }
      for (const container of dirty) this.reconcileMessage(container);
      if (this.jobs.size) this.cancelObsoleteJobs();
      if (removed) this.surfaces.cancelObsoleteRequest();
    });
  }

  private captureSource(parent: HTMLElement, element: HTMLElement): SourceState {
    let states = this.sourceStates.get(parent);
    if (!states) { states = new Map(); this.sourceStates.set(parent, states); }
    const existing = states.get(element);
    if (existing) return existing;
    const views = Array.from(element.querySelectorAll<HTMLElement>(VIEW_SELECTOR));
    const state = { source: views.length ? readOriginalSource(element) : element.textContent ?? '', views };
    states.set(element, state);
    return state;
  }

  private stateCurrent(parent: HTMLElement, element: HTMLElement, state: SourceState): boolean {
    return this.sourceStates.get(parent)?.get(element) === state &&
      element.isConnected && (parent === element || parent.contains(element)) &&
      state.views.every(view => element.contains(view)) &&
      readOriginalSource(element) === state.source;
  }

  private markElement(parent: HTMLElement, element: HTMLElement, state: SourceState): void {
    if (this.sourceStates.get(parent)?.get(element) !== state) return;
    state.views = Array.from(element.querySelectorAll<HTMLElement>(VIEW_SELECTOR));
    this.translatedElements.add(element);
  }

  private invalidateSource(parent: HTMLElement, element: HTMLElement, state: SourceState): void {
    const states = this.sourceStates.get(parent);
    if (states?.get(element) !== state) return;
    states.delete(element);
    this.translatedElements.delete(element);
    if (element.isConnected && (parent === element || parent.contains(element))) clearTranslationView(element);
    this.requeueChanged(parent);
  }

  private reconcileMessage(parent: HTMLElement): void {
    if (!this.active || !parent.isConnected) return;
    const states = this.sourceStates.get(parent);
    if (!states) return;
    let changed = false;
    for (const [element, state] of states) {
      if (this.stateCurrent(parent, element, state)) continue;
      states.delete(element);
      this.translatedElements.delete(element);
      if (element.isConnected && (parent === element || parent.contains(element))) clearTranslationView(element);
      changed = true;
    }
    // Late embed bodies and React replacements can introduce a new source
    // element without replacing the message container.
    if (!changed && this.translatedMessages.has(parent)) {
      changed = findAllTranslatableElements(parent).some(item => !states.has(item.element));
    }
    if (changed) this.requeueChanged(parent);
  }

  private reobserve(parent: HTMLElement): void {
    if (!this.active || !parent.isConnected || !this.observedMessages.has(parent)) return;
    this.intersectionObserver.unobserve(parent);
    this.intersectionObserver.observe(parent);
  }

  private requeueChanged(parent: HTMLElement): void {
    this.translatedMessages.delete(parent);
    if (this.inFlightMessages.has(parent)) {
      this.reobserveAfterJob.add(parent);
      for (const job of this.jobs) {
        if (job.messages.some(([element]) => element === parent)) job.invalidated.add(parent);
      }
      this.cancelObsoleteJobs();
    } else this.reobserve(parent);
  }

  private cancelObsoleteJobs(): void {
    const path = location.pathname;
    for (const job of this.jobs) {
      if (job.controller.signal.aborted) continue;
      if (job.path !== path || !job.messages.some(([element]) =>
          element.isConnected && !job.invalidated.has(element))) job.controller.abort();
    }
  }

  /** Called by the existing storage-change event, only for request settings. */
  cancelOutstanding(): void {
    this.requestEpoch++;
    for (const job of this.jobs) {
      for (const [element] of job.messages) {
        if (element.isConnected && !this.translatedMessages.has(element)) this.reobserveAfterJob.add(element);
      }
      job.controller.abort();
    }
  }

  private enqueueJob(messages: Array<[HTMLElement, string]>, settings: Awaited<ReturnType<typeof getSettings>>, batch: boolean): void {
    const job: TranslationJob = { controller: new AbortController(), path: location.pathname, messages, invalidated: new Set() };
    const signal = job.controller.signal;
    for (const [element] of messages) this.inFlightMessages.add(element);
    this.jobs.add(job);
    void this.translationQueue.add(async () => {
      if (!this.active || signal.aborted || job.path !== location.pathname) return;
      const live = messages.filter(([element]) => element.isConnected && !job.invalidated.has(element));
      if (!live.length) return;
      try {
        if (batch) await this.handleVisibleMessagesBatch(live, settings, signal);
        else await this.handleVisibleMessage(live[0]![0], settings, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }).catch(error => {
      if (!signal.aborted) console.error('[MessageObserver] Translation job failed:', error);
    }).finally(() => {
      this.jobs.delete(job);
      for (const [element] of messages) {
        this.inFlightMessages.delete(element);
        if (this.reobserveAfterJob.has(element)) {
          this.reobserveAfterJob.delete(element);
          if (job.path === location.pathname) this.reobserve(element);
        }
      }
    });
  }

  start() {
    console.log('[MessageObserver] Starting...');
    this.active = true;
    void this.refreshSurfaceSettings();

    // Add existing messages to observation list
    // Use multiple selectors for better compatibility
    const existingMessages = document.querySelectorAll(
      '[id^="chat-messages-"], [id^="message-content-"]'
    );
    const uniqueMessages = new Set<HTMLElement>();

    existingMessages.forEach((el) => {
      // If it's a message-content element, find its parent message container
      if (el.id?.startsWith('message-content-')) {
        const messageContainer = el.closest('[id^="chat-messages-"]') as HTMLElement;
        if (messageContainer) {
          uniqueMessages.add(messageContainer);
        } else {
          // No container found, observe the element itself
          uniqueMessages.add(el as HTMLElement);
        }
      } else {
        uniqueMessages.add(el as HTMLElement);
      }
    });

    uniqueMessages.forEach((msg) => this.observeMessage(msg));

    // Monitor new messages
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    console.log(`[MessageObserver] Observing ${uniqueMessages.size} existing messages`);
  }

  async refreshSurfaceSettings(): Promise<void> {
    const revision = ++this.surfaceSettingsRevision;
    const settings = await getSettings();
    if (this.active && revision === this.surfaceSettingsRevision) this.surfaces.configure(settings);
  }

  private observeMessage(element: HTMLElement) {
    if (this.observedMessages.has(element) || isSearchSurface(element)) return;
    const message = createDiscordMessage(element);
    if (message) {
      this.observedMessages.set(element, message.id);
      this.intersectionObserver.observe(element);
    }
  }

  /**
   * Initialize language detector if needed and available
   */
  private async initLanguageDetector(): Promise<boolean> {
    if (this.languageDetector) {
      return true;
    }

    if (!ChromeLanguageDetector.isAvailable()) {
      return false;
    }

    try {
      const status = await ChromeLanguageDetector.checkAvailability();
      if (status === 'unavailable') {
        return false;
      }

      this.languageDetector = new ChromeLanguageDetector();
      return true;
    } catch (error) {
      console.error('[MessageObserver] Failed to initialize language detector:', error);
      return false;
    }
  }

  /**
   * Process pending messages in batch with rate limiting
   * Uses batch translation API when multiple messages are pending
   */
  private async processPendingMessages() {
    if (!this.active) return;
    if (this.pendingMessages.size === 0) {
      this.scheduleSurfaceWork();
      return;
    }

    const epoch = this.requestEpoch;
    const settings = await getSettings();
    if (!this.active || epoch !== this.requestEpoch) {
      if (this.active && this.pendingMessages.size) this.processPendingDebounced();
      return;
    }
    if (!settings.autoTranslate) {
      this.pendingMessages.clear();
      return;
    }

    // Initialize language detector if skipTargetLanguage is enabled
    if (settings.skipTargetLanguage) {
      await this.initLanguageDetector();
    }
    if (!this.active || epoch !== this.requestEpoch) {
      if (this.active && this.pendingMessages.size) this.processPendingDebounced();
      return;
    }

    // Get all pending messages
    const messagesToProcess = Array.from(this.pendingMessages.entries());
    this.pendingMessages.clear();

    // Filter out already translated messages
    const filteredMessages = messagesToProcess.filter(
      ([element]) => element.isConnected && !this.translatedMessages.has(element) && !this.inFlightMessages.has(element)
    );

    if (filteredMessages.length === 0) {
      this.scheduleSurfaceWork();
      return;
    }

    console.log(`[MessageObserver] Processing ${filteredMessages.length} messages (queue: ${this.translationQueue.getQueueSize()}, running: ${this.translationQueue.getRunningCount()})`);

    // A visibility callback can fire again before a queued request finishes.
    // Mark the DOM element before enqueueing so it cannot create a second job.
    const remote = settings.translationProvider !== 'chrome-builtin';
    const paired = settings.translationMode === 'append' && settings.bilingualGranularity !== 'message';
    const batch = settings.translationProvider === 'openai' ||
      filteredMessages.length >= BATCH_SIZE ||
      (filteredMessages.length > 1 && (remote || paired));
    if (batch) this.enqueueJob(filteredMessages, settings, true);
    else for (const pair of filteredMessages) this.enqueueJob([pair], settings, false);
    this.scheduleSurfaceWork();
  }

  private scheduleSurfaceWork(): void {
    if (!this.active || this.surfaceWorkScheduled || !this.surfaces.hasPending()) return;
    this.surfaceWorkScheduled = true;
    // At most one auxiliary batch is queued; incoming messages retain priority.
    void this.translationQueue.add(async () => {
      if (this.active) await this.surfaces.process(await getSettings());
    }).catch((error) => console.warn('[SurfaceTranslator] Translation failed:', error))
      .finally(() => {
        this.surfaceWorkScheduled = false;
        if (this.active && this.surfaces.hasPending()) this.processPendingDebounced();
      });
  }

  /**
   * Handle batch translation for multiple visible messages
   * More efficient than translating individually
   * Translates all translatable elements including reply contexts and embeds
   */
  private async handleVisibleMessagesBatch(
    messagePairs: Array<[HTMLElement, string]>,
    settings: Awaited<ReturnType<typeof getSettings>>,
    signal: AbortSignal,
  ) {
    // Collect all translatable elements from all message containers.
    // Each plan is either "simple" (single text blob, existing flow) or
    // "structured" (block-level expansion for main message-content).
    type SimplePlan = {
      kind: 'simple';
      contentId: string;
      content: string;
      element: HTMLElement;
      parent: HTMLElement;
      type: 'message-content' | 'embed-section';
      state: SourceState;
    };
    type StructuredPlan = {
      kind: 'structured';
      element: HTMLElement;
      parent: HTMLElement;
      entries: BlockEntry[];
      embed: boolean;
      bilingual?: BilingualLayout;
      groupId: string;
      state: SourceState;
    };
    const plans: Array<SimplePlan | StructuredPlan> = [];

    for (const [container] of messagePairs) {
      if (!container.isConnected || this.translatedMessages.has(container)) {
        continue;
      }

      // Use findAllTranslatableElements to include embeds
      const translatableElements = findAllTranslatableElements(container);

      for (const item of translatableElements) {
        if (this.translatedElements.has(item.element)) {
          continue;
        }

        signal.throwIfAborted();
        const state = this.captureSource(container, item.element);
        if (state.views.length) { this.translatedElements.add(item.element); continue; }
        const text = state.source.trim();

        if (!text) {
          continue;
        }

        // Language detection: check if text is in target language
        if (settings.skipTargetLanguage && this.languageDetector) {
          const shouldSkip = await shouldSkipText(
            this.languageDetector,
            text,
            settings.targetLanguage,
            LANGUAGE_DETECTION_MIN_CONFIDENCE
          );
          signal.throwIfAborted();
          if (!this.stateCurrent(container, item.element, state)) {
            this.invalidateSource(container, item.element, state);
            continue;
          }
          if (shouldSkip) {
            this.translatedElements.add(item.element);
            continue;
          }
        }

        const plan = this.buildTranslationPlan(item, container, text, settings, state);
        if (plan) {
          plans.push(plan);
        }
      }
    }

    signal.throwIfAborted();
    if (plans.length === 0) {
      // Mark parent messages as processed even if all elements were skipped
      for (const [container] of messagePairs) {
        if (this.reobserveAfterJob.has(container) || !container.isConnected) continue;
        this.translatedMessages.add(container);
        this.intersectionObserver.unobserve(container);
      }
      return;
    }

    try {
      // Flatten all plans into a unique set of batch entries.
      const uniqueContents = new Map<string, { id: string; content: string; groupId?: string }>();
      const pushUnique = (id: string, content: string, groupId?: string) => {
        if (!uniqueContents.has(id)) {
          uniqueContents.set(id, { id, content, ...(groupId === undefined ? {} : { groupId }) });
        }
      };
      for (const plan of plans) {
        if (!this.stateCurrent(plan.parent, plan.element, plan.state)) {
          this.invalidateSource(plan.parent, plan.element, plan.state);
          continue;
        }
        if (plan.kind === 'simple') {
          pushUnique(plan.contentId, plan.content);
        } else {
          plan.entries.forEach(({ id, block, send }) => {
            if (send) pushUnique(id, block.text, plan.groupId);
          });
        }
      }

      signal.throwIfAborted();
      if (!uniqueContents.size) return;
      const translations = await translateMessageBatch(
        Array.from(uniqueContents.values()),
        settings.targetLanguage, signal, settings,
      );
      signal.throwIfAborted();
      this.cancelObsoleteJobs();
      signal.throwIfAborted();

      // Inject translations into all elements
      const translatedParents = new Set<HTMLElement>();
      const incompleteEmbeds = new Set<HTMLElement>();

      for (const plan of plans) {
        if (!this.active || !this.stateCurrent(plan.parent, plan.element, plan.state)) {
          this.invalidateSource(plan.parent, plan.element, plan.state);
          incompleteEmbeds.add(plan.parent);
          continue;
        }
        if (plan.kind === 'simple') {
          const translation = translations.get(plan.contentId);
          if (!translation || translation === plan.content) {
            if (settings.translationProvider === 'openai') {
              this.markElement(plan.parent, plan.element, plan.state);
              translatedParents.add(plan.parent);
            } else if (plan.type === 'embed-section') incompleteEmbeds.add(plan.parent);
            continue;
          }
          if (plan.type === 'embed-section') {
            this.injectTranslationToEmbedSection(plan.element, translation, settings.translationMode);
          } else {
            this.injectTranslationToElement(plan.element, translation, settings.translationMode);
          }
          this.markElement(plan.parent, plan.element, plan.state);
          translatedParents.add(plan.parent);
        } else {
          const translatedBlocks = plan.entries.map((entry) => resolveBlock(entry, translations, true));
          if (!translatedBlocks.some(({ block, translation }) => translation !== block.text)) {
            if (settings.translationProvider === 'openai') {
              this.markElement(plan.parent, plan.element, plan.state);
              translatedParents.add(plan.parent);
            } else if (plan.embed) incompleteEmbeds.add(plan.parent);
            continue;
          }
          if (plan.bilingual) {
            if (!this.active || !renderBilingualLayout(plan.element, plan.bilingual, translatedBlocks.map(({ translation, complete }) => complete ? translation : undefined))) {
              if (settings.translationProvider === 'openai' && plan.element.isConnected &&
                  plan.element.textContent === plan.bilingual.source) {
                // A missing pair must not trigger another paid request while
                // this same message remains mounted.
                this.markElement(plan.parent, plan.element, plan.state);
                translatedParents.add(plan.parent);
              } else incompleteEmbeds.add(plan.parent);
              continue;
            }
          } else {
            this.injectStructuredTranslationToElement(
              plan.element,
              translatedBlocks,
              settings.translationMode,
              plan.embed
            );
          }
          this.markElement(plan.parent, plan.element, plan.state);
          translatedParents.add(plan.parent);
        }
      }

      // Mark parent messages as translated
      for (const container of translatedParents) {
        if (incompleteEmbeds.has(container) || this.reobserveAfterJob.has(container)) continue;
        this.translatedMessages.add(container);
        this.intersectionObserver.unobserve(container);
      }

      console.log(`[MessageObserver] Batch translated ${plans.length} elements from ${translatedParents.size} messages`);
    } catch (error) {
      if (signal.aborted) return;
      console.error('[MessageObserver] Batch translation failed:', error);
      throw error;
    }
  }

  /**
   * Decide whether an element should use the simple (text) or structured
   * (block-level) translation flow.
   *
   * Structured flow is used for main message-content elements that contain
   * block-level markup (headings / lists) or multiple paragraphs. Reply
   * contexts use the simple flow. Embed blocks also protect rich inline content.
   */
  private buildTranslationPlan(
    item: TranslatableElement,
    parent: HTMLElement,
    fallbackText: string,
    settings: Awaited<ReturnType<typeof getSettings>>,
    state: SourceState,
  ):
    | { kind: 'simple'; contentId: string; content: string; element: HTMLElement; parent: HTMLElement; type: 'message-content' | 'embed-section'; state: SourceState }
    | { kind: 'structured'; element: HTMLElement; parent: HTMLElement; entries: BlockEntry[]; embed: boolean; bilingual?: BilingualLayout; groupId: string; state: SourceState }
    | null {
    const isReplyContext = item.element.closest('[id^="message-reply-context-"]') !== null;

    const embed = item.type === 'embed-section';
    const canStructure = !isReplyContext && (!embed || item.element.matches('div, section, article'));
    if (canStructure) {
      if (item.element.querySelector('.discord-translator-translation')) return null;
      const granularity = settings.translationMode === 'replace' ? 'replace' : settings.bilingualGranularity;
      const bilingual = collectBilingualLayout(item.element, granularity);
      if (bilingual) {
        if (!bilingual.units.some(({ send }) => send)) return null;
        const onePlain = bilingual.units.length === 1 &&
          bilingual.units[0]!.block.text === fallbackText &&
          !bilingual.units[0]!.block.placeholders.length;
        // Single unformatted sentences keep the cheap existing path in the
        // full-message modes, sharing the same cache key as the paired modes.
        if (onePlain && (granularity === 'message' || granularity === 'replace') &&
            !item.element.querySelector('h1,h2,h3,h4,h5,h6,p,ul,ol,pre,blockquote,br')) {
          return { kind: 'simple', contentId: item.id, content: fallbackText, element: item.element, parent, type: item.type, state };
        }
        const entries = bilingual.units.map(({ block, send }, index) => ({
          block,
          id: onePlain ? item.id : bilingualUnitId(item.id, block.text, index, bilingual.fingerprint),
          send,
        }));
        return { kind: 'structured', element: item.element, parent, entries, embed, bilingual, groupId: getTranslatableElementKey(item), state };
      }
      // Very fragmented messages use the same bounded block fallback in every mode.
      const blocks = extractBlocks(item.element, true);
      const hasStructure =
        blocks.length > 1 || blocks.some((b) => b.tagName !== 'p' || b.placeholders.length > 0);
      if (hasStructure && blocks.length > 0) {
        const revision = embed ? 'embed-structure-v1' : 'basa-structure-v1';
        const entries = blocks.map((block, i) => ({
          block,
          id: `${item.id}-${revision}-b${i}`,
          send: /\p{L}/u.test(block.text.replace(/§[MCP]\d+§/g, '')),
        }));
        if (!entries.some(({ send }) => send)) return null;
        return {
          kind: 'structured',
          element: item.element,
          parent,
          entries,
          embed,
          groupId: getTranslatableElementKey(item),
          state,
        };
      }
    }

    return {
      kind: 'simple',
      contentId: item.id,
      content: fallbackText,
      element: item.element,
      parent,
      type: item.type,
      state,
    };
  }

  /**
   * Handle translation for a single visible message
   * Translates all translatable elements including reply context and embeds
   */
  private async handleVisibleMessage(
    element: HTMLElement,
    settings: Awaited<ReturnType<typeof getSettings>>,
    signal: AbortSignal,
  ) {
    if (!this.active || !element.isConnected || this.translatedMessages.has(element)) return;

    // Find all translatable elements (main content + reply context + embeds)
    const translatableElements = findAllTranslatableElements(element);

    if (translatableElements.length === 0) {
      return;
    }

    // Process each translatable element
    let translatedAny = false;
    let incompleteEmbed = false;

    for (const item of translatableElements) {
      const elementKey = getTranslatableElementKey(item);

      // Skip if this specific element is already translated
      if (this.translatedElements.has(item.element)) {
        continue;
      }

      signal.throwIfAborted();
      const state = this.captureSource(element, item.element);
      if (state.views.length) { this.translatedElements.add(item.element); continue; }
      const text = state.source.trim();

      if (!text) {
        continue;
      }

      // Language detection: check if text is in target language
      if (settings.skipTargetLanguage && this.languageDetector) {
        const shouldSkip = await shouldSkipText(
          this.languageDetector,
          text,
          settings.targetLanguage,
          LANGUAGE_DETECTION_MIN_CONFIDENCE
        );
        signal.throwIfAborted();
        if (!this.stateCurrent(element, item.element, state)) {
          this.invalidateSource(element, item.element, state);
          incompleteEmbed = true;
          continue;
        }
        if (shouldSkip) {
          this.translatedElements.add(item.element);
          continue;
        }
      }

      const plan = this.buildTranslationPlan(item, element, text, settings, state);
      if (!plan) {
        continue;
      }

      try {
        if (plan.kind === 'simple') {
          const translation = await translateMessage(
            plan.contentId,
            plan.content,
            settings.targetLanguage, signal, settings,
          );
          this.cancelObsoleteJobs();
          signal.throwIfAborted();
          if (!this.stateCurrent(element, item.element, state)) {
            this.invalidateSource(element, item.element, state);
            incompleteEmbed = true;
            continue;
          }
          if (!translation || translation === plan.content) {
            if (plan.type === 'embed-section') incompleteEmbed = true;
            continue;
          }
          if (plan.type === 'embed-section') {
            this.injectTranslationToEmbedSection(plan.element, translation, settings.translationMode);
          } else {
            this.injectTranslationToElement(plan.element, translation, settings.translationMode);
          }
        } else {
          const blockTranslations = await translateMessageBatch(
            plan.entries.filter(({ send }) => send).map(({ id, block }) => ({ id, content: block.text, groupId: plan.groupId })),
            settings.targetLanguage, signal, settings,
          );
          this.cancelObsoleteJobs();
          signal.throwIfAborted();
          if (!this.stateCurrent(element, item.element, state)) {
            this.invalidateSource(element, item.element, state);
            incompleteEmbed = true;
            continue;
          }
          const translatedBlocks = plan.entries.map((entry) => resolveBlock(entry, blockTranslations, true));
          if (!translatedBlocks.some(({ block, translation }) => translation !== block.text)) {
            if (plan.embed) incompleteEmbed = true;
            continue;
          }
          if (plan.bilingual) {
            if (!this.active || !renderBilingualLayout(plan.element, plan.bilingual, translatedBlocks.map(({ translation, complete }) => complete ? translation : undefined))) {
              incompleteEmbed = true;
              continue;
            }
          } else {
            this.injectStructuredTranslationToElement(
              plan.element,
              translatedBlocks,
              settings.translationMode,
              plan.embed
            );
          }
        }
        this.markElement(element, item.element, state);
        translatedAny = true;
      } catch (error) {
        if (signal.aborted) return;
        console.error(`[MessageObserver] Translation failed for element ${elementKey}:`, error);
        if (item.type === 'embed-section') {
          incompleteEmbed = true;
          continue;
        }
        throw error;
      }
    }

    // Mark main message as translated
    if (translatedAny && !incompleteEmbed && !this.reobserveAfterJob.has(element)) {
      this.translatedMessages.add(element);
      this.intersectionObserver.unobserve(element);
    }
  }

  /**
   * Inject a structure-preserving translation into the content element.
   * Builds a sibling container whose block hierarchy (h1/h2/h3, ul/ol/li, p)
   * mirrors the original, with mentions and channel refs reinserted as live
   * DOM clones.
   */
  private injectStructuredTranslationToElement(
    contentElement: HTMLElement,
    translatedBlocks: Array<{ block: StructuredBlock; translation: string }>,
    mode: 'replace' | 'append',
    embed = false
  ) {
    if (!this.active || !contentElement.isConnected || contentElement.querySelector('.discord-translator-translation')) {
      return;
    }

    const translationContainer = assembleTranslation(translatedBlocks);
    if (mode === 'append') {
      contentElement.appendChild(translationContainer);
      return;
    }

    let originalWrapper = contentElement.querySelector('.discord-translator-original') as HTMLElement | null;
    if (!originalWrapper) {
      originalWrapper = document.createElement('span');
      originalWrapper.className = 'discord-translator-original';
      while (contentElement.firstChild) {
        originalWrapper.appendChild(contentElement.firstChild);
      }
      contentElement.appendChild(originalWrapper);
    }

    if (mode === 'replace') {
      originalWrapper.style.display = 'none';
      translationContainer.style.marginTop = '0';
    }

    contentElement.appendChild(translationContainer);
  }

  /**
   * Inject translation directly into a specific content element
   * Handles complex message structures (headings, lists, mentions, etc.)
   */
  private injectTranslationToElement(
    contentElement: HTMLElement,
    translation: string,
    mode: 'replace' | 'append'
  ) {
    // Check if already translated (avoid duplicate injections)
    if (!this.active || !contentElement.isConnected || contentElement.querySelector('.discord-translator-translation')) {
      return;
    }

    // Check if parent has message-reply-context-* (reply preview context)
    const isReplyContext = contentElement.closest('[id^="message-reply-context-"]') !== null;

    // Create a wrapper for original content if it doesn't exist
    let originalWrapper = contentElement.querySelector('.discord-translator-original') as HTMLElement | null;
    if (!originalWrapper && mode === 'replace') {
      // Wrap all existing children in a span for easier manipulation
      originalWrapper = document.createElement('span');
      originalWrapper.className = 'discord-translator-original';
      // Move all children into the wrapper
      while (contentElement.firstChild) {
        originalWrapper.appendChild(contentElement.firstChild);
      }
      contentElement.appendChild(originalWrapper);
    }

    // Create translation element
    const translationSpan = document.createElement('span');
    translationSpan.className = 'discord-translator-translation';
    translationSpan.style.cssText = 'font-size: 0.95em;';
    translationSpan.textContent = translation;

    if (mode === 'replace' && originalWrapper) {
      originalWrapper.style.display = 'none';
    } else if (isReplyContext) {
      translationSpan.style.marginInlineStart = '0.35em';
    } else {
      translationSpan.style.display = 'block';
    }
    contentElement.appendChild(translationSpan);
  }

  /**
   * Inject translation into an embed section element
   * Preserves paragraph structure by using separate div for translation
   */
  private injectTranslationToEmbedSection(
    sectionElement: HTMLElement,
    translation: string,
    mode: 'replace' | 'append'
  ) {
    // Check if already translated (avoid duplicate injections)
    if (!this.active || !sectionElement.isConnected || sectionElement.querySelector('.discord-translator-translation')) {
      return;
    }

    const translated = document.createElement('span');
    translated.className = 'discord-translator-translation';
    translated.style.cssText = 'display: block; font-size: 0.95em;';
    translated.textContent = translation;
    if (mode === 'replace') {
      const originalWrapper = document.createElement('span');
      originalWrapper.className = 'discord-translator-original';
      originalWrapper.style.display = 'none';
      originalWrapper.append(...sectionElement.childNodes);
      sectionElement.appendChild(originalWrapper);
    } else {
      translated.style.marginTop = '4px';
    }
    sectionElement.appendChild(translated);
  }

  stop() {
    console.log('[MessageObserver] Stopping...');
    this.active = false;
    this.requestEpoch++;
    for (const job of this.jobs) job.controller.abort();
    this.jobs.clear();
    this.inFlightMessages = new WeakSet();
    this.reobserveAfterJob = new WeakSet();
    this.surfaceSettingsRevision++;
    this.surfaces.clear();
    this.intersectionObserver.disconnect();
    this.mutationObserver.disconnect();
    this.pendingMessages.clear();
    this.translationQueue.clear();

    // Reset language detection state
    this.languageDetector = null;
  }
}

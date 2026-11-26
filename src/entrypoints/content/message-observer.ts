import { getSettings } from '@/lib/utils/settings';
import { translateMessage, translateMessageBatch } from '@/lib/utils/translator';
import { isDiscordMessage, createDiscordMessage, findTranslatableElements, findAllTranslatableElements, type TranslatableElement } from './message-utils';
import { RequestQueue, debounce } from '@/lib/utils/async-control';
import { ChromeLanguageDetector } from '@/lib/api/chrome-language-detector';
import { extractBlocks, assembleTranslation, type StructuredBlock } from '@/lib/utils/structure-preserving';
import { shouldSkipText } from './language-skip';
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

interface BlockEntry {
  block: StructuredBlock;
  id: string;
  send: boolean;
}

function resolveBlock(entry: BlockEntry, results: Map<string, string>, preserveTokens: boolean) {
  const { block, id } = entry;
  let translation = results.get(id) || block.text;
  if (preserveTokens && block.placeholders.length) {
    translation = translation.replace(/§\s*([MCP])\s*(\d+)\s*§/gi,
      (_, prefix: string, index: string) => `§${prefix.toUpperCase()}${index}§`);
    if (block.placeholders.some(({ token }) => !translation.includes(token))) {
      translation = block.text;
    }
  }
  return { block, translation };
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
          if (entry.isIntersecting && messageId && !this.translatedMessages.has(element)) {
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

    // Mutation Observer: Detect new messages and register with Intersection Observer
    this.mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        const target = mutation.target;
        if (target instanceof Element && target.closest('.discord-translator-translation, .discord-translator-original, .basa-draft-tools')) return;
        const ordinaryChat = target instanceof Element &&
          target.closest('[id^="chat-messages-"], [id^="message-content-"], [id^="message-accessories-"]') !== null &&
          !isSearchSurface(target);
        mutation.removedNodes.forEach((node) => {
          if (node instanceof Element && !ordinaryChat && !node.isConnected) this.surfaces.releaseSubtree(node);
        });
        if (!ordinaryChat && target instanceof Element) this.surfaces.refreshParent(target);
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            if (element.closest('.discord-translator-translation, .discord-translator-original, .basa-draft-tools')) return;
            if (!ordinaryChat) this.surfaces.scan(element);
            if (isSearchSurface(element)) return;

            // Check if the added element is a message container
            if (element.id?.startsWith('chat-messages-')) {
              this.observeMessage(element);
              return;
            }

            // Check if element contains message containers
            const messageContainers = element.querySelectorAll('[id^="chat-messages-"]');
            messageContainers.forEach((container) => {
              this.observeMessage(container as HTMLElement);
            });

            // Fallback: check with isDiscordMessage for legacy compatibility
            if (messageContainers.length === 0 && isDiscordMessage(element)) {
              this.observeMessage(element);
            }
          }
        });
      });
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

    const settings = await getSettings();
    if (!settings.autoTranslate) {
      this.pendingMessages.clear();
      return;
    }

    // Initialize language detector if skipTargetLanguage is enabled
    if (settings.skipTargetLanguage) {
      await this.initLanguageDetector();
    }

    // Get all pending messages
    const messagesToProcess = Array.from(this.pendingMessages.entries());
    this.pendingMessages.clear();

    // Filter out already translated messages
    const filteredMessages = messagesToProcess.filter(
      ([element]) => element.isConnected && !this.translatedMessages.has(element)
    );

    if (filteredMessages.length === 0) {
      this.scheduleSurfaceWork();
      return;
    }

    console.log(`[MessageObserver] Processing ${filteredMessages.length} messages (queue: ${this.translationQueue.getQueueSize()}, running: ${this.translationQueue.getRunningCount()})`);

    // Process messages in batches for efficiency
    if (filteredMessages.length >= BATCH_SIZE) {
      // Use batch translation for better performance
      this.translationQueue.add(async () => {
        await this.handleVisibleMessagesBatch(filteredMessages, settings);
      }).catch((error) => {
        console.error(`[MessageObserver] Batch translation failed:`, error);
      });
    } else {
      // For small numbers, use individual translation
      for (const [element, messageId] of filteredMessages) {
        this.translationQueue.add(async () => {
          await this.handleVisibleMessage(element, settings);
        }).catch((error) => {
          console.error(`[MessageObserver] Translation failed for message ${messageId}:`, error);
        });
      }
    }
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
    settings: Awaited<ReturnType<typeof getSettings>>
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
    };
    type StructuredPlan = {
      kind: 'structured';
      element: HTMLElement;
      parent: HTMLElement;
      entries: BlockEntry[];
      embed: boolean;
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

        const text = item.element.textContent?.trim() || '';

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
          if (shouldSkip) {
            // Mark as translated (skipped) to avoid reprocessing
            this.translatedElements.add(item.element);
            continue;
          }
        }

        const plan = this.buildTranslationPlan(item, container, text);
        if (plan) {
          plans.push(plan);
        }
      }
    }

    if (plans.length === 0) {
      // Mark parent messages as processed even if all elements were skipped
      for (const [container] of messagePairs) {
        this.translatedMessages.add(container);
        this.intersectionObserver.unobserve(container);
      }
      return;
    }

    try {
      // Flatten all plans into a unique set of batch entries.
      const uniqueContents = new Map<string, string>();
      const pushUnique = (id: string, content: string) => {
        if (!uniqueContents.has(id)) {
          uniqueContents.set(id, content);
        }
      };
      for (const plan of plans) {
        if (plan.kind === 'simple') {
          pushUnique(plan.contentId, plan.content);
        } else {
          plan.entries.forEach(({ id, block, send }) => {
            if (send) pushUnique(id, block.text);
          });
        }
      }

      const translations = await translateMessageBatch(
        Array.from(uniqueContents.entries()).map(([id, content]) => ({ id, content })),
        settings.targetLanguage
      );

      // Inject translations into all elements
      const translatedParents = new Set<HTMLElement>();
      const incompleteEmbeds = new Set<HTMLElement>();

      for (const plan of plans) {
        if (plan.kind === 'simple') {
          const translation = translations.get(plan.contentId);
          if (!translation || translation === plan.content) {
            if (plan.type === 'embed-section') incompleteEmbeds.add(plan.parent);
            continue;
          }
          if (plan.type === 'embed-section') {
            this.injectTranslationToEmbedSection(plan.element, translation, settings.translationMode);
          } else {
            this.injectTranslationToElement(plan.element, translation, settings.translationMode);
          }
          this.translatedElements.add(plan.element);
          translatedParents.add(plan.parent);
        } else {
          const translatedBlocks = plan.entries.map((entry) => resolveBlock(entry, translations, plan.embed));
          if (!translatedBlocks.some(({ block, translation }) => translation !== block.text)) {
            if (plan.embed) incompleteEmbeds.add(plan.parent);
            continue;
          }
          this.injectStructuredTranslationToElement(
            plan.element,
            translatedBlocks,
            settings.translationMode,
            plan.embed
          );
          this.translatedElements.add(plan.element);
          translatedParents.add(plan.parent);
        }
      }

      // Mark parent messages as translated
      for (const container of translatedParents) {
        if (incompleteEmbeds.has(container)) continue;
        this.translatedMessages.add(container);
        this.intersectionObserver.unobserve(container);
      }

      console.log(`[MessageObserver] Batch translated ${plans.length} elements from ${translatedParents.size} messages`);
    } catch (error) {
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
    fallbackText: string
  ):
    | { kind: 'simple'; contentId: string; content: string; element: HTMLElement; parent: HTMLElement; type: 'message-content' | 'embed-section' }
    | { kind: 'structured'; element: HTMLElement; parent: HTMLElement; entries: BlockEntry[]; embed: boolean }
    | null {
    const isReplyContext = item.element.closest('[id^="message-reply-context-"]') !== null;

    const embed = item.type === 'embed-section';
    if (!isReplyContext && (!embed || item.element.matches('div, section, article'))) {
      const blocks = extractBlocks(item.element, embed);
      const hasStructure =
        blocks.length > 1 || blocks.some((b) => b.tagName !== 'p' || (embed && b.placeholders.length > 0));
      if (hasStructure && blocks.length > 0) {
        const revision = embed ? 'embed-structure-v1' : 'basa-structure-v1';
        const entries = blocks.map((block, i) => ({
          block,
          id: `${item.id}-${revision}-b${i}`,
          send: !embed || /\p{L}/u.test(block.text.replace(/§[MCP]\d+§/g, '')),
        }));
        if (!entries.some(({ send }) => send)) return null;
        return {
          kind: 'structured',
          element: item.element,
          parent,
          entries,
          embed,
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
    };
  }

  /**
   * Handle translation for a single visible message
   * Translates all translatable elements including reply context and embeds
   */
  private async handleVisibleMessage(
    element: HTMLElement,
    settings: Awaited<ReturnType<typeof getSettings>>
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

      const text = item.element.textContent?.trim() || '';

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
        if (shouldSkip) {
          // Mark as translated (skipped) to avoid reprocessing
          this.translatedElements.add(item.element);
          continue;
        }
      }

      const plan = this.buildTranslationPlan(item, element, text);
      if (!plan) {
        continue;
      }

      try {
        if (plan.kind === 'simple') {
          const translation = await translateMessage(
            plan.contentId,
            plan.content,
            settings.targetLanguage
          );
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
            plan.entries.filter(({ send }) => send).map(({ id, block }) => ({ id, content: block.text })),
            settings.targetLanguage
          );
          const translatedBlocks = plan.entries.map((entry) => resolveBlock(entry, blockTranslations, plan.embed));
          if (!translatedBlocks.some(({ block, translation }) => translation !== block.text)) {
            if (plan.embed) incompleteEmbed = true;
            continue;
          }
          this.injectStructuredTranslationToElement(
            plan.element,
            translatedBlocks,
            settings.translationMode,
            plan.embed
          );
        }
        this.translatedElements.add(item.element);
        translatedAny = true;
      } catch (error) {
        console.error(`[MessageObserver] Translation failed for element ${elementKey}:`, error);
        if (item.type === 'embed-section') {
          incompleteEmbed = true;
          continue;
        }
        throw error;
      }
    }

    // Mark main message as translated
    if (translatedAny && !incompleteEmbed) {
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
    if (embed && mode === 'append') {
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
    let originalWrapper = contentElement.querySelector('.discord-translator-original') as HTMLElement;
    if (!originalWrapper) {
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

    if (mode === 'replace') {
      // Replace mode - hide original content and show translation
      originalWrapper.style.display = 'none';
      contentElement.appendChild(translationSpan);
    } else {
      // Append mode - show both original and translation
      if (isReplyContext) {
        // Reply context: inline without line break (space separated)
        contentElement.append(document.createTextNode(' '), translationSpan);
      } else {
        // Normal message: add line break between original and translation
        const br = document.createElement('br');
        contentElement.append(br, translationSpan);
      }
    }
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

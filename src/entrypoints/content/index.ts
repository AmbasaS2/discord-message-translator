import { MessageTranslationObserver } from './message-observer';
import { DraftTranslator } from './draft-translator';
import { getSettings } from '@/lib/utils/settings';
import './basa-content.css';

export default defineContentScript({
  matches: ['https://discord.com/*', 'https://*.discord.com/*'],
  runAt: 'document_end',
  main() {
    let observer: MessageTranslationObserver | null = null;
    const draft = new DraftTranslator();
    draft.start();

    // Start monitoring when extension launches
    function initializeObserver() {
      if (observer) {
        observer.stop();
      }

      observer = new MessageTranslationObserver();
      observer.start();
    }

    // Do not start observers when automatic translation is disabled.
    let observerRevision = 0;
    async function initializeIfEnabled() {
      const revision = ++observerRevision;
      const settings = await getSettings();
      if (revision === observerRevision && settings.autoTranslate) initializeObserver();
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { void initializeIfEnabled(); }, { once: true });
    } else {
      void initializeIfEnabled();
    }

    // Handle settings changes
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.draftEnabled) {
        void draft.configure();
      }
      if (area === 'local' && !changes.autoTranslate && [
        'translateNavigation', 'translateForum', 'translateSearch',
        'targetLanguage', 'translationProvider', 'activeOpenaiPresetId', 'openaiPresets',
        'apiKeys', 'skipTargetLanguage'
      ].some((key) => key in changes)) {
        if (['targetLanguage', 'translationProvider', 'activeOpenaiPresetId', 'openaiPresets', 'apiKeys', 'skipTargetLanguage']
          .some(key => key in changes)) observer?.cancelOutstanding();
        void observer?.refreshSurfaceSettings();
      }
      if (area === 'local' && changes.autoTranslate) {
        observerRevision++;
        if (changes.autoTranslate.newValue) {
          initializeObserver();
        } else {
          observer?.stop();
        }
      }
    });

    console.log('[Discord Translator] Content script loaded');
  },
});

import { ChromeStorageCache } from '@/lib/cache/chrome-storage';
import { initializeSettings } from '@/lib/utils/settings-migration';
import { serveCompletionRequests } from '@/lib/api/openai-background';

export default defineBackground(() => {
  // Initialize on extension install
  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    console.log('[Background] Extension installed/updated');

    // Write defaults on first install, or move settings from sync to local storage
    await initializeSettings(reason === 'install');

    // Set up cache cleanup alarm (every hour)
    chrome.alarms.create('cache-cleanup', { periodInMinutes: 60 });
    console.log('[Background] Cache cleanup alarm created');
  });

  // Alarm handler
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'cache-cleanup') {
      console.log('[Background] Running cache cleanup...');
      const cache = new ChromeStorageCache();
      await cache.cleanupExpired();
      console.log('[Background] Cache cleanup completed');
    }
  });

  serveCompletionRequests();

  console.log('[Background] Service worker started');
});

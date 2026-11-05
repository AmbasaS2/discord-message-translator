import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: '__MSG_extensionName__',
    version: '2.0.1',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://discord.com/*',
      'https://*.discord.com/*',
    ],
    // OpenAI-compatible endpoints are user-defined; the options page requests
    // the configured origin at runtime.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    icons: {
      16: '/icons/icon16.png',
      48: '/icons/icon48.png',
      128: '/icons/icon128.png',
    },
  },
});

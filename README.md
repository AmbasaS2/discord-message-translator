# Discord Message Translator — Basa development fork

Based on [yuiAs/discord-message-translator](https://github.com/yuiAs/discord-message-translator) 2.1.0 (MIT). Original author and license are retained.

## Install from a release

1. Download the ZIP named `discord-message-translator-basa-*-chrome-mv3.zip` from [GitHub Releases](https://github.com/AmbasaS2/discord-message-translator/releases).
2. Extract it to a folder you plan to keep. The folder should contain `manifest.json` directly.
3. In Chrome, open `chrome://extensions/`, enable **Developer mode**, select **Load unpacked**, and choose the extracted folder.
4. Open or refresh Discord. Chrome Built-in Translator works without an API key. Chrome may download a language model the first time you use a language pair.

### Update an existing installation

1. Download and extract the newer release ZIP.
2. Replace the contents of the currently loaded folder with the new extracted files, keeping the same folder path and extension entry. If Chrome is using files in that folder, close Chrome before replacing them.
3. On `chrome://extensions/`, click **Reload** on the Discord Message Translator · Basa card, then refresh any open Discord tabs. Keeping the same extension entry preserves its locally saved settings.

## Basa fork features

- Additional visible translation targets: channel/category labels, forum titles/descriptions, and search results. These share the existing mutation/intersection observers and request queue. Label rendering uses CSS pseudo-elements, not replacement of Discord's React-owned text nodes.
- Optional draft translation controls appear after focusing a composer. Translation is explicit, never automatically submitted. A changed or rich draft is left intact; a copyable translation is shown instead. Draft provider, target language and OpenAI preset can be set separately.
- Nested list hierarchy is reconstructed independently of the DOM observation layer.
- Korean UI localization and per-surface toggles in the popup.

Chrome Extension to automatically translate Discord messages with Google Translate, DeepL, or OpenAI-compatible APIs.

## Features

- **Auto Translation**: Automatically translate Discord messages as they appear
- **Multiple Translation Providers**: Support for Chrome Built-in Translator, Google Translate, DeepL, and OpenAI-compatible APIs
- **Chrome Built-in Translator**: Free translation using Chrome's native API (no API key required)
- **Language Detection**: Skip translation for messages already in target language (using Chrome's Language Detector API)
- **Smart Caching**: Message ID-based caching with automatic cleanup to reduce API costs
- **Intersection Observer**: Only translates visible messages for optimal performance
- **Translation Modes**: Replace original text or show both original and translation
- **Cache Visualization**: Monitor cache usage and storage statistics
- **Modern UI**: Built with DaisyUI and Tailwind CSS

## Build from source

### 1. Install Dependencies

Requires Node.js and pnpm (`corepack enable` picks up the version pinned in `package.json`).

```bash
pnpm install
```

### 2. Build the Extension

```bash
pnpm build
```

This will create a `.output/chrome-mv3` folder with the compiled extension.

### 3. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in the top right)
3. Click "Load unpacked"
4. Select the `.output/chrome-mv3` folder

### 4. Configure Translation Provider

1. Click the extension icon in Chrome, then click **Open settings** (or right-click the extension icon → **Options**)
2. In the **Translation Provider** section, select your preferred provider:
   - **Google Translate**: Get an API key from [Google Cloud Translation API](https://cloud.google.com/translate/docs)
   - **DeepL**: Get an API key from [DeepL API](https://www.deepl.com/pro-api)
   - **OpenAI-compatible API**: Configure with any OpenAI-compatible endpoint
3. Enter your API key and configure provider-specific settings (auto-saved, except OpenAI-compatible presets, which use **Save**)

For OpenAI-compatible APIs, add a preset for each endpoint you use. Click **Add preset** and fill in:
- **Name**: Label shown in the preset list
- **Base URL**: API endpoint (e.g., `https://api.openai.com/v1`, or a local server such as `http://127.0.0.1:8080/v1`). The extension appends `/chat/completions`, so enter the base URL without it. Save and Test ask for access to this URL, so the extension can reach the endpoint even when it doesn't send CORS headers.
- **Model**: Model name as expected by the endpoint. For a model ID starting with `pfnet/plamo-3-translate-` (or `plamo-3-translate`), the extension sends each text alone with the target language in `chat_template_kwargs`, as that model expects. Start llama-server with the model's bundled `chat_template.jinja` (`--chat-template-file`).
- **API Key**: Optional. Leave it empty for local servers that need no key.
- **Extra request body (JSON)**: Optional; see [Reasoning models](#reasoning-models)

Choose the radio button next to a preset to make it the active one for translations. **Edit** and **Delete** change or remove a preset. In the preset form, **Test** asks for access to the endpoint and runs a test translation; **Save** keeps the changes and **Cancel** discards them.

All settings and API keys are stored in `chrome.storage.local` on this device and are not synced. Settings from earlier versions are moved automatically when you update: the old OpenAI configuration becomes the first preset, which is active, and the copy in Chrome Sync is removed.

## Development

### Environment Setup

For development, you can create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Then configure your API keys:

```env
VITE_GOOGLE_TRANSLATE_API_KEY=your_google_api_key
VITE_DEEPL_API_KEY=your_deepl_api_key
VITE_OPENAI_API_KEY=your_openai_api_key
```

**Note**: In production (Chrome Extension), API keys are stored in `chrome.storage.local` on this device, not in environment variables. They are not synced.

### Run in Development Mode

```bash
pnpm dev
```

This will start Vite in development mode with hot reloading.

### Type Checking

```bash
pnpm type-check
```

## Project Structure

```
discord-message-translator/
├── src/
│   ├── entrypoints/
│   │   ├── background.ts    # Service Worker
│   │   ├── content/         # Content Script (injected into Discord)
│   │   ├── popup/           # Popup UI (quick toggles only)
│   │   └── options/         # Options page (opens in its own tab)
│   ├── lib/
│   │   ├── api/              # Translation API clients
│   │   ├── cache/            # Cache implementation
│   │   └── utils/            # Utility functions
│   └── types/                # TypeScript type definitions
├── public/
│   ├── _locales/            # i18n messages (en, ja)
│   └── icons/               # Extension icons
└── .output/                 # Build output (load this in Chrome)
```

## Usage

### Quick Start

1. Open Discord in Chrome
2. Click the extension icon
3. Toggle "Auto Translate" on
4. Select your target language
5. Messages will be automatically translated as you scroll

### Settings

Settings are split between the popup (quick toggles for everyday use) and the
options page (detailed configuration). Open the options page from the popup's
**Open settings** button, or by right-clicking the extension icon and choosing
**Options**.

**Popup**
- **Auto Translate**: Enable/disable automatic translation of messages
- **Target Language**: Choose which language to translate to
- **Translation Mode**:
  - **Replace Original**: Replace the original message with translation
  - **Show Both**: Display both original and translated text

**Options page**
- **Translation Provider**: Choose between Google Translate, DeepL, OpenAI-compatible APIs, or Chrome Built-in Translator
- **API Configuration**: Configure API keys, provider-specific settings, and OpenAI-compatible presets
- **Language Detection**: An API status panel plus **Skip Target Language**, which automatically skips translation for messages already in the target language (requires Chrome's Language Detector API)
- **Cache Settings**:
  - **Cache TTL**: How long to keep translations cached (default: 7 days)
  - **Cache Usage**: View current cache usage and storage statistics
  - **Clear Cache**: Manually clear all cached translations

## Technical Details

### Cache Management

- Uses Chrome Storage API (10MB limit)
- Automatic LRU (Least Recently Used) cleanup when reaching 80% capacity
- Reduces to 60% capacity by deleting oldest messages
- Ensures new messages can always be cached

### Performance Optimizations

- **Intersection Observer**: Only translates messages visible in viewport
- **Smart Caching**: Avoids duplicate API calls for the same message
- **100px Root Margin**: Pre-loads translations before scrolling to prevent flickering
- **Language Detection**: Skips translation for messages already in target language

### Translation Providers

#### Chrome Built-in Translator
- Free translation using Chrome's built-in Translator API
- No API key required
- Available in Chrome 138+ with experimental flags enabled
- Limited language pair support compared to cloud services

#### Google Translate
- Fast and reliable translation service
- Supports 100+ languages
- Cost-effective for high-volume translation

#### DeepL
- High-quality neural machine translation
- Excellent for European languages
- More accurate translations than traditional services

#### OpenAI-compatible APIs
- LLM-powered translation with context awareness
- Automatic source language detection
- Works with any service that exposes an OpenAI-compatible Chat Completions API
- Best for nuanced or contextual translations

#### Reasoning models
- The **Extra request body (JSON)** option takes a JSON object that is merged into every chat-completions request, e.g. `{"reasoning_effort": "low"}` or `{"max_tokens": 8000}`
- It can override `temperature` and `max_tokens`, but not `model` or `messages`
- A `null` value removes the field from the request, for endpoints that reject `max_tokens` or `temperature`, e.g. `{"max_tokens": null}`
- Each request times out after 120 seconds without a complete response, and a long reasoning phase counts against the limit. Requests run in the background service worker and are streamed (`stream: true`), falling back to plain JSON when the server does not stream
- If the model returns reasoning but no translated text, or stops at the token limit, the extension reports that instead of an empty translation; raise `max_tokens` or lower the reasoning effort via the extra request body
- Invalid JSON in the field is not saved; the options page shows the parse error

### Future Enhancements

- IndexedDB migration for unlimited cache storage
- Enhanced error handling and retry logic
- Custom translation prompts for LLM providers
- Translation quality feedback system

## Licence

[MIT](LICENSE)

### Icon attribution

Composer globe, rotate-left and copy icons: [Font Awesome Free 6.7.2](https://github.com/FortAwesome/Font-Awesome/tree/6.7.2/svgs), © 2024 Fonticons, Inc., [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Original vector paths; presentation attributes adapted for inline SVG. See `public/ICON-NOTICE.txt`.

### Independent translation engines and AI connections

The popup and settings page let incoming messages and outgoing drafts use different translation engines, target languages and AI connections. Configure NanoGPT (standard or subscription endpoint), OpenAI, OpenRouter or a custom OpenAI-compatible endpoint under API connections, regardless of the active incoming engine. Load models on demand or enter an exact model ID; keys stay in local extension storage. Selecting a remote incoming engine may send visible messages to that provider and incur charges. The outgoing AI style prompt is adapted from Phrase Desk and can be customized in settings. The mandatory source/language/output contract remains in force. Specialized PLaMo translation models continue to use their native template. No additional chat observer or polling is introduced.

### Draft prompt and release numbering

The outgoing detailed style prompt is enabled by default and editable in settings. Turning it off retains the saved style and sends only the mandatory translation contract; it does not disable translation. Optional JSON model parameters are under Advanced API options and normally remain empty.

Future verified builds use ordinary three-part version numbers in the package, manifest, release tag and ZIP filename (for example `2.1.2`, `v2.1.2`). Earlier revision-tagged releases remain unchanged.

### Bilingual reading layout

When Show Both is selected, choose whole message (the existing default), paragraph, or sentence in the popup or incoming settings. Paragraph and sentence layouts interleave each source unit with its translation in chat and supported embed bodies, preserving live source links, mentions and list structure. Code blocks remain untouched. Search previews, channel labels, short reply previews and forum card titles keep their existing compact layout. Refresh Discord to apply to already translated messages. All four display modes (whole message, paragraph pairs, sentence pairs, and replacement) share the same canonical source-unit IDs and verified cached translations. Changing the layout does not require translating successful cached units again. Exceptionally fragmented messages fall back to the same bounded block layout in all modes. No new observers, polling or background work are introduced.

AI batches follow the request length and configured output-token budget instead of splitting every five items. Units from the same message are grouped for context and share their canonical cache IDs. Missing aligned results are not retried individually: the source remains visible and successful results are retained. Visibility events cannot enqueue another job for a message already waiting or translating. The specialized PLaMo path still requires separate text requests.

Visible batches also read translation-cache entries together and save usable results in one storage operation. A truncated AI response retains complete indexed objects without guessing their alignment or issuing another paid request.

### Source validation and cancellation

Cached units include their exact local source text; old entries without source metadata are not reused until translated again on demand. This does not clear the cache or stored connections. Indexed results are checked for missing, repeated, unknown or malformed placeholders and conservatively checked for obvious wrong-script prose before caching. These local checks cannot prove semantic accuracy. Original text and usable translations are retained when alignment is incomplete; there is no paid per-item retry.

The existing message mutation observer also handles character-data edits, filtering unrelated changes and owned translation insertions. Only changed source elements lose their stale view; identical source remounts can reuse the completed alignment. The existing request queue cancels fully obsolete jobs on source edits, channel changes, disconnection, disabling auto-translation or incoming request-setting changes. A shared batch can finish if it still contains needed messages. Remote transport cancellation is best effort: a provider may have already billed or processed a transmitted request. The native Chrome translator stops between units without destroying shared model instances. No additional MutationObserver, IntersectionObserver, recurring timer, polling or whole-page layout redraw is introduced.

import { fetchChatCompletion, type CompletionRequest, type CompletionResult } from './openai-compatible';

// Requests run in the background service worker because a content script's
// fetch carries the page origin (https://discord.com), which Chrome's Local
// Network Access blocks for loopback endpoints such as a local LLM server.
export const OPENAI_COMPLETION_PORT = 'openai-completion';

// Must stay under Chrome's 30 s service-worker idle timeout.
const HEARTBEAT_MS = 20_000;

type CompletionPortMessage =
  | { type: 'ping' }
  | { type: 'result'; result: CompletionResult }
  | { type: 'error'; message: string };

/** Content-script transport: runs the request in the background service worker. */
export function requestCompletionViaBackground(request: CompletionRequest): Promise<CompletionResult> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: OPENAI_COMPLETION_PORT });
    let settled = false;

    port.onMessage.addListener((message: CompletionPortMessage) => {
      if (message.type === 'ping') return;
      settled = true;
      port.disconnect();
      if (message.type === 'result') {
        resolve(message.result);
      } else {
        reject(new Error(message.message));
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new Error('Background service worker stopped before the LLM responded'));
    });

    port.postMessage(request);
  });
}

/** Background side of {@link requestCompletionViaBackground}. */
export function serveCompletionRequests(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== OPENAI_COMPLETION_PORT) return;

    // Closing the Discord tab disconnects the port; stop the request with it.
    const controller = new AbortController();
    port.onDisconnect.addListener(() => controller.abort());
    const send = (message: CompletionPortMessage) => {
      if (!controller.signal.aborted) port.postMessage(message);
    };

    port.onMessage.addListener(async (request: CompletionRequest) => {
      // Messages on the port keep the worker alive while the stream is silent
      // (e.g. waiting for the first token).
      const heartbeat = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS);
      try {
        send({ type: 'result', result: await fetchChatCompletion(request, controller.signal) });
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        clearInterval(heartbeat);
      }
    });
  });
}

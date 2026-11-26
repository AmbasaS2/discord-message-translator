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
export function requestCompletionViaBackground(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: OPENAI_COMPLETION_PORT });
    let settled = false;
    const finish = (action: () => void, disconnect: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (disconnect) {
        try { port.disconnect(); } catch { /* Already disconnected. */ }
      }
      action();
    };
    const abort = () => finish(
      () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')), true,
    );

    port.onMessage.addListener((message: CompletionPortMessage) => {
      if (message.type === 'ping') return;
      finish(() => {
        if (message.type === 'result') resolve(message.result);
        else reject(new Error(message.message));
      }, true);
    });
    port.onDisconnect.addListener(() => {
      finish(() => reject(new Error('Background service worker stopped before the LLM responded')), false);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { port.postMessage(request); }
    catch (error) { finish(() => reject(error), true); }
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

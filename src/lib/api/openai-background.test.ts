import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestCompletionViaBackground } from './openai-background';

type Listener = (message?: unknown) => void;

function mockPort() {
  const messageListeners: Listener[] = [];
  const disconnectListeners: Listener[] = [];
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: Listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: Listener) => disconnectListeners.push(listener) },
    receive: (message: unknown) => messageListeners.forEach((listener) => listener(message)),
    drop: () => disconnectListeners.forEach((listener) => listener()),
  };
}

describe('requestCompletionViaBackground', () => {
  const request = { url: 'http://127.0.0.1:9931/v1/chat/completions', apiKey: 'k', body: {} };
  let port: ReturnType<typeof mockPort>;

  beforeEach(() => {
    port = mockPort();
    (chrome.runtime as unknown as { connect: unknown }).connect = vi.fn(() => port);
  });

  it('posts the request and resolves with the result, ignoring pings', async () => {
    const result = { content: 'Bonjour', reasoning: '', finishReason: 'stop' };
    const promise = requestCompletionViaBackground(request);

    expect(port.postMessage).toHaveBeenCalledWith(request);
    port.receive({ type: 'ping' });
    port.receive({ type: 'result', result });

    await expect(promise).resolves.toEqual(result);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('rejects with the background error message', async () => {
    const promise = requestCompletionViaBackground(request);
    port.receive({ type: 'error', message: 'OpenAI API Error (401): bad key' });

    await expect(promise).rejects.toThrow('OpenAI API Error (401): bad key');
  });

  it('disconnects an active request on cancellation and ignores late results', async () => {
    const controller = new AbortController();
    const promise = requestCompletionViaBackground(request, controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    port.receive({ type: 'result', result: { content: 'late', reasoning: '', finishReason: 'stop' } });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not open a background port for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(requestCompletionViaBackground(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('rejects when the port closes before a response', async () => {
    const promise = requestCompletionViaBackground(request);
    port.drop();

    await expect(promise).rejects.toThrow('Background service worker stopped');
  });
});

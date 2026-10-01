import { readFileSync } from 'node:fs';
import type { FetchInit, FetchLike, OllamaSettings } from '../../src/llm/ollama-client.ts';

/**
 * A fake Ollama server for tests: serves recorded /api/chat reply bodies (golden files in
 * tests/fixtures/llm/) and records every request. No test ever reaches a real model.
 */

/** A recorded reply body from tests/fixtures/llm/<name>.json. */
export function golden(name: string): string {
  return readFileSync(new URL(`./llm/${name}.json`, import.meta.url), 'utf8');
}

/** An Ollama chat reply body whose message content is `content` (for hand-made edge cases). */
export function chatBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'test-model',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    ...extra,
  });
}

export type FakeReply =
  | { status?: number; body: string }
  /** Never answers (until the request is aborted). */
  | 'hang'
  /** Never answers and ignores the abort signal too. */
  | 'hang-ignoring-abort'
  | Error;

export interface FakeCall {
  url: string;
  init: FetchInit;
  body: {
    model: string;
    stream: boolean;
    think: boolean;
    keep_alive: string;
    format: Record<string, unknown>;
    options: Record<string, unknown>;
    messages: Array<{ role: string; content: string }>;
  };
}

/** Replies in order; the last one repeats. */
export function fakeOllama(...replies: FakeReply[]): { fetch: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) as FakeCall['body'] });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === undefined) return Promise.reject(new Error('fakeOllama: no reply configured'));
    if (reply instanceof Error) return Promise.reject(reply);
    if (reply === 'hang-ignoring-abort') return new Promise(() => undefined);
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    }
    const status = reply.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(reply.body),
    });
  };
  return { fetch, calls };
}

export const TEST_LLM: OllamaSettings = {
  baseUrl: 'http://127.0.0.1:11434',
  allowedHostnames: [],
  timeoutMs: 5_000,
  keepAlive: '30s',
};

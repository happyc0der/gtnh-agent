import { z } from 'zod';
import { assertPrivateDestination, checkPrivateUrl } from '../config/network.ts';
import { errorMessage } from '../util/json.ts';

/**
 * A minimal client for a LOCAL Ollama server (POST /api/chat). It is the only code in the
 * agent that talks HTTP, and it only ever sends a prompt and receives text: the model gets
 * no tools, and nothing it says is executed. Callers parse and validate every reply.
 *
 *  - The base URL must be loopback, private LAN or Tailscale (or an allowlisted hostname that
 *    resolves only to such addresses, checked again before every request); redirects fail.
 *  - Output is constrained by a JSON Schema (`format`), sampled with temperature 0 and a fixed
 *    seed, bounded in length, and the whole request is bounded by a timeout.
 *  - `keep_alive` is short, so the model leaves VRAM soon after use (the GPU is shared).
 *  - It never throws: every failure is a `{ ok: false }` result.
 */

/** The subset of `fetch` the client uses, so tests can serve recorded responses. */
export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: 'error';
}
export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** The platform fetch (the only use of it in the agent). */
export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export interface OllamaSettings {
  baseUrl: string;
  allowedHostnames: readonly string[];
  timeoutMs: number;
  keepAlive: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  /** JSON Schema the reply must follow (Ollama structured output). */
  format: Record<string, unknown>;
  /** Upper bound on generated tokens (num_predict). */
  maxOutputTokens: number;
  /** Context window (num_ctx); omitted, the server's default applies. */
  contextTokens?: number;
}

export type ChatFailure = 'refused' | 'timeout' | 'http' | 'network' | 'bad-response';

export type ChatResult =
  | {
      ok: true;
      content: string;
      latencyMs: number;
      promptTokens: number | null;
      outputTokens: number | null;
      /** The reply stopped at maxOutputTokens (so it is probably cut off). */
      truncated: boolean;
    }
  | { ok: false; failure: ChatFailure; message: string; latencyMs: number };

export interface OllamaClientDeps {
  fetch?: FetchLike;
  /** DNS lookup for allowlisted hostnames (tests). */
  resolveHost?: (host: string) => Promise<string[]>;
  now?: () => number;
  /** Called after every request, successful or not (evaluation, diagnostics). */
  onCall?: (request: ChatRequest, result: ChatResult) => void;
}

/** Fixed sampling, so the same prompt gives the same answer. */
export const SAMPLING = { temperature: 0, seed: 7 } as const;
export const MAX_REQUEST_CHARS = 256_000;
export const MAX_RESPONSE_CHARS = 1_000_000;

const ChatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

const ErrorBodySchema = z.object({ error: z.string() });

export class OllamaClient {
  readonly #settings: OllamaSettings;
  readonly #fetch: FetchLike;
  readonly #resolveHost: ((host: string) => Promise<string[]>) | undefined;
  readonly #now: () => number;
  readonly #onCall: ((request: ChatRequest, result: ChatResult) => void) | undefined;

  constructor(settings: OllamaSettings, deps: OllamaClientDeps = {}) {
    this.#settings = settings;
    this.#fetch = deps.fetch ?? defaultFetch;
    this.#resolveHost = deps.resolveHost;
    this.#now = deps.now ?? Date.now;
    this.#onCall = deps.onCall;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    let result: ChatResult;
    try {
      result = await this.#chat(request);
    } catch (error) {
      result = { ok: false, failure: 'network', message: errorMessage(error), latencyMs: 0 };
    }
    this.#onCall?.(request, result);
    return result;
  }

  async #chat(request: ChatRequest): Promise<ChatResult> {
    const started = this.#now();
    const fail = (failure: ChatFailure, message: string): ChatResult => ({
      ok: false,
      failure,
      message: message.slice(0, 500),
      latencyMs: this.#now() - started,
    });

    const { baseUrl, allowedHostnames, timeoutMs, keepAlive } = this.#settings;
    const target = checkPrivateUrl(baseUrl, allowedHostnames, 'OLLAMA_ALLOWED_HOSTNAMES');
    if (!target.ok) return fail('refused', `Refusing to connect: ${target.reason}`);
    try {
      await assertPrivateDestination(
        target.host,
        allowedHostnames,
        this.#resolveHost,
        'OLLAMA_ALLOWED_HOSTNAMES',
      );
    } catch (error) {
      return fail('refused', errorMessage(error));
    }
    const base = target.url.href.endsWith('/') ? target.url.href : `${target.url.href}/`;
    const endpoint = new URL('api/chat', base).href;

    const body = JSON.stringify({
      model: request.model,
      stream: false,
      think: false,
      keep_alive: keepAlive,
      format: request.format,
      options: {
        ...SAMPLING,
        num_predict: request.maxOutputTokens,
        ...(request.contextTokens === undefined ? {} : { num_ctx: request.contextTokens }),
      },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    });
    if (body.length > MAX_REQUEST_CHARS) {
      return fail('refused', `request of ${body.length} chars exceeds ${MAX_REQUEST_CHARS}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const response = await abortable(
        this.#fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
          redirect: 'error',
        }),
        controller.signal,
      );
      status = response.status;
      ok = response.ok;
      text = await abortable(response.text(), controller.signal);
    } catch (error) {
      return controller.signal.aborted
        ? fail('timeout', `no reply within ${timeoutMs} ms`)
        : fail('network', errorMessage(error));
    } finally {
      clearTimeout(timer);
    }

    if (!ok) {
      const detail = ErrorBodySchema.safeParse(safeJson(text)).data?.error ?? text.slice(0, 200);
      return fail('http', `HTTP ${status}: ${detail}`);
    }
    if (text.length > MAX_RESPONSE_CHARS) {
      return fail('bad-response', `reply of ${text.length} chars exceeds ${MAX_RESPONSE_CHARS}`);
    }
    const parsed = ChatResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) return fail('bad-response', 'reply is not an Ollama chat response');
    const reply = parsed.data;
    return {
      ok: true,
      content: reply.message.content,
      latencyMs: this.#now() - started,
      promptTokens: reply.prompt_eval_count ?? null,
      outputTokens: reply.eval_count ?? null,
      truncated: reply.done_reason === 'length',
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Settles with `promise`, or rejects as soon as `signal` aborts (even if `promise` never settles). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    // Always observe `promise`, so a late rejection is never unhandled.
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

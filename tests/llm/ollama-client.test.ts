import { describe, expect, it } from 'vitest';
import { OllamaClient, type ChatRequest, type ChatResult } from '../../src/llm/ollama-client.ts';
import { chatBody, fakeOllama, TEST_LLM } from '../fixtures/fake-ollama.ts';

const request: ChatRequest = {
  model: 'qwen2.5:0.5b',
  system: 'system prompt',
  user: 'user prompt',
  format: { type: 'object' },
  maxOutputTokens: 64,
};

describe('OllamaClient', () => {
  it('sends one constrained, deterministic, non-streaming chat request', async () => {
    const fake = fakeOllama({ body: chatBody('{"ok":true}', { prompt_eval_count: 12 }) });
    const client = new OllamaClient(TEST_LLM, { fetch: fake.fetch });
    const result = await client.chat({ ...request, contextTokens: 8192 });

    expect(result).toMatchObject({ ok: true, content: '{"ok":true}', promptTokens: 12 });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(call?.body).toEqual({
      model: 'qwen2.5:0.5b',
      stream: false,
      think: false,
      keep_alive: '30s',
      format: { type: 'object' },
      options: { temperature: 0, seed: 7, num_predict: 64, num_ctx: 8192 },
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
  });

  it('flags a reply that stopped at the token limit', async () => {
    const fake = fakeOllama({ body: chatBody('{"cut', { done_reason: 'length' }) });
    const result = await new OllamaClient(TEST_LLM, { fetch: fake.fetch }).chat(request);
    expect(result).toMatchObject({ ok: true, truncated: true });
  });

  it.each([
    ['a public IP', 'http://8.8.8.8:11434', /public IP/],
    ['an unlisted hostname', 'http://ollama.example.com:11434', /OLLAMA_ALLOWED_HOSTNAMES/],
    ['credentials in the URL', 'http://user:pw@127.0.0.1:11434', /credentials/],
    ['a query string', 'http://127.0.0.1:11434/?x=1', /query/],
    ['another scheme', 'file:///etc/passwd', /http/],
    ['not a URL', 'localhost:11434 please', /not a valid URL|http/],
  ])('refuses %s without sending anything', async (_name, baseUrl, message) => {
    const fake = fakeOllama({ body: chatBody('{}') });
    const client = new OllamaClient({ ...TEST_LLM, baseUrl }, { fetch: fake.fetch });
    const result = await client.chat(request);
    expect(result).toMatchObject({ ok: false, failure: 'refused' });
    expect(result.ok ? '' : result.message).toMatch(message);
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts private addresses: LAN, Tailscale, IPv6 loopback, normalized IPv4', async () => {
    for (const baseUrl of [
      'http://192.168.1.20:11434',
      'http://100.101.102.103:11434/',
      'http://[::1]:11434',
      'http://127.1:11434',
      'http://localhost:11434',
    ]) {
      const fake = fakeOllama({ body: chatBody('{}') });
      const result = await new OllamaClient({ ...TEST_LLM, baseUrl }, { fetch: fake.fetch }).chat(
        request,
      );
      expect(result.ok, baseUrl).toBe(true);
    }
  });

  it('re-checks an allowlisted hostname by DNS before every request', async () => {
    const settings = { ...TEST_LLM, baseUrl: 'http://msi:11434', allowedHostnames: ['msi'] };
    const good = fakeOllama({ body: chatBody('{}') });
    const ok = await new OllamaClient(settings, {
      fetch: good.fetch,
      resolveHost: () => Promise.resolve(['100.64.0.5']),
    }).chat(request);
    expect(ok.ok).toBe(true);
    expect(good.calls[0]?.url).toBe('http://msi:11434/api/chat');

    const bad = fakeOllama({ body: chatBody('{}') });
    const refused = await new OllamaClient(settings, {
      fetch: bad.fetch,
      resolveHost: () => Promise.resolve(['100.64.0.5', '93.184.216.34']),
    }).chat(request);
    expect(refused).toMatchObject({ ok: false, failure: 'refused' });
    expect(bad.calls).toHaveLength(0);
  });

  it.each(['hang', 'hang-ignoring-abort'] as const)(
    'times out when the server does not answer (%s)',
    async (reply) => {
      const fake = fakeOllama(reply);
      const client = new OllamaClient({ ...TEST_LLM, timeoutMs: 30 }, { fetch: fake.fetch });
      const result = await client.chat(request);
      expect(result).toMatchObject({ ok: false, failure: 'timeout' });
      expect(fake.calls[0]?.init.signal.aborted).toBe(true);
    },
  );

  it('reports HTTP errors with the server message', async () => {
    const fake = fakeOllama({ status: 404, body: '{"error":"model \\"nope\\" not found"}' });
    const result = await new OllamaClient(TEST_LLM, { fetch: fake.fetch }).chat(request);
    expect(result).toMatchObject({ ok: false, failure: 'http' });
    expect(result.ok ? '' : result.message).toBe('HTTP 404: model "nope" not found');
  });

  it('reports network errors and malformed replies, and never throws', async () => {
    const down = fakeOllama(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    expect(await new OllamaClient(TEST_LLM, { fetch: down.fetch }).chat(request)).toMatchObject({
      ok: false,
      failure: 'network',
    });
    for (const body of ['not json', '{"message":{}}', '[]']) {
      const fake = fakeOllama({ body });
      expect(await new OllamaClient(TEST_LLM, { fetch: fake.fetch }).chat(request)).toMatchObject({
        ok: false,
        failure: 'bad-response',
      });
    }
    const throwing = new OllamaClient(TEST_LLM, {
      fetch: () => {
        throw new Error('synchronous failure');
      },
    });
    expect(await throwing.chat(request)).toMatchObject({ ok: false });
  });

  it('refuses oversized requests before sending them', async () => {
    const fake = fakeOllama({ body: chatBody('{}') });
    const result = await new OllamaClient(TEST_LLM, { fetch: fake.fetch }).chat({
      ...request,
      user: 'x'.repeat(300_000),
    });
    expect(result).toMatchObject({ ok: false, failure: 'refused' });
    expect(fake.calls).toHaveLength(0);
  });

  it('reports every call to onCall', async () => {
    const seen: ChatResult[] = [];
    const fake = fakeOllama({ body: chatBody('{}') }, new Error('down'));
    const client = new OllamaClient(TEST_LLM, {
      fetch: fake.fetch,
      onCall: (_req, result) => seen.push(result),
    });
    await client.chat(request);
    await client.chat(request);
    expect(seen.map((r) => r.ok)).toEqual([true, false]);
  });
});

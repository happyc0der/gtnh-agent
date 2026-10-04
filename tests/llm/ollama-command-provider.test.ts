import { describe, expect, it } from 'vitest';
import { createCommandTranslator } from '../../src/app/providers.ts';
import { defaultConfig } from '../../src/config/env.ts';
import { OllamaClient } from '../../src/llm/ollama-client.ts';
import {
  COMMAND_FORMAT,
  COMMAND_SYSTEM_PROMPT,
  OllamaCommandProvider,
} from '../../src/llm/ollama-command-provider.ts';
import { chatBody, fakeOllama, TEST_LLM, type FakeReply } from '../fixtures/fake-ollama.ts';

function translator(...replies: FakeReply[]) {
  const fake = fakeOllama(...replies);
  return {
    provider: new OllamaCommandProvider(
      new OllamaClient(TEST_LLM, { fetch: fake.fetch }),
      'qwen3:14b',
    ),
    calls: fake.calls,
  };
}
const reply = (content: unknown): FakeReply => ({ body: chatBody(JSON.stringify(content)) });

describe('OllamaCommandProvider', () => {
  it("turns the model's verb and words into a command, parsed like the structured form", async () => {
    const { provider, calls } = translator(reply({ verb: 'get', args: ['20', 'logs'] }));
    const t = await provider.translate('could you bring me twenty logs?');
    expect(t).toMatchObject({
      ok: true,
      command: { verb: 'get', count: 20, item: 'minecraft:log' },
    });
    const body = calls[0]?.body;
    expect(body?.model).toBe('qwen3:14b');
    expect(body?.format).toEqual(COMMAND_FORMAT);
    expect(body?.messages[0]).toEqual({ role: 'system', content: COMMAND_SYSTEM_PROMPT });
    // The owner's text is the only chat sent, as data in a JSON object.
    expect(JSON.parse(body?.messages[1]?.content ?? '')).toEqual({
      message: 'could you bring me twenty logs?',
    });
    expect(body?.options).toMatchObject({ temperature: 0, seed: 7 });
  });

  it('says why when there is no command: unknown, outside the schema, no such command, failures', async () => {
    const cases: Array<[FakeReply, RegExp]> = [
      [reply({ verb: 'unknown', args: [] }), /found no command/],
      [reply({ verb: 'op', args: ['Mallory'] }), /outside the command schema/],
      [reply({ verb: 'get', args: ['twenty', 'logs'] }), /no command \(usage: !get/],
      [reply({ verb: 'goto', args: ['1', '999', '2'] }), /no command \(usage: !goto/],
      [reply({ verb: 'come', args: [], extra: 1 }), /outside the command schema/],
      [{ body: chatBody('not json') }, /invalid JSON/],
      [{ status: 500, body: '{"error":"boom"}' }, /model failed \(http\)/],
      [new Error('ECONNREFUSED'), /model failed \(network\)/],
    ];
    for (const [r, why] of cases) {
      const t = await translator(r).provider.translate('do the thing');
      expect(t, String(why)).toMatchObject({ ok: false });
      expect(t.ok ? '' : t.reason).toMatch(why);
    }
  });

  it('is made only when asked for (AGENT_COMMANDS=ollama), with llm.commandModel', () => {
    expect(createCommandTranslator(defaultConfig())).toBeNull();
    const made = createCommandTranslator(
      defaultConfig({ commands: { translator: 'ollama' }, llm: { commandModel: 'qwen3:8b' } }),
    );
    expect(made?.name).toBe('ollama:qwen3:8b');
  });
});

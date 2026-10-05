import { describe, expect, it } from 'vitest';
import { gtOreByName } from '../../src/goals/ore-names.ts';
import { parseOwnerCommand } from '../../src/domain/owner-commands.ts';
import { OllamaCommandProvider } from '../../src/llm/ollama-command-provider.ts';

// Review 24, 2026-10-05: the join rule refused real item names of three words or more, typed with
// `!` or given by the translator ("flint and steel").
const names = { ore: gtOreByName };

describe('the join rule on real names', () => {
  // 061ef56 joined any words; 50522c3 only two, which refused three-word vanilla names. Two to
  // four plain words are joined now, never with a word no item's name has.
  it('"!get 1 flint and steel" parses (minecraft:flint_and_steel is a real 1.7.10 item)', () => {
    expect(parseOwnerCommand('!get 1 flint and steel', names)).toMatchObject({ ok: true });
  });

  it('the translator answering ["1", "flint and steel"] is a command', async () => {
    const provider = new OllamaCommandProvider(
      {
        chat: () =>
          Promise.resolve({
            ok: true,
            content: JSON.stringify({ verb: 'get', args: ['1', 'flint and steel'] }),
            latencyMs: 1,
          }),
      } as never,
      'test',
    );
    const t = await provider.translate('get me a flint and steel');
    expect(t.ok).toBe(true);
  });
});

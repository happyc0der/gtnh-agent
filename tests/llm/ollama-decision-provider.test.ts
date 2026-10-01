import { describe, expect, it } from 'vitest';
import type { MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { OllamaClient } from '../../src/llm/ollama-client.ts';
import {
  DECISION_FORMAT,
  DECISION_SYSTEM_PROMPT,
  decidingRule,
  ModelDecisionSchema,
  OllamaDecisionProvider,
  summarizeForDecision,
  type ModelDecision,
} from '../../src/llm/ollama-decision-provider.ts';
import { SafetyFirstDecisionProvider } from '../../src/system1/decision-provider.ts';
import { routeDecision } from '../../src/system1/deterministic-router.ts';
import { chatBody, fakeOllama, golden, TEST_LLM, type FakeReply } from '../fixtures/fake-ollama.ts';
import { makeState, routerCtx } from '../fixtures/index.ts';

function model(reply: FakeReply, settings = TEST_LLM) {
  const fake = fakeOllama(reply);
  const inner = new OllamaDecisionProvider(
    new OllamaClient(settings, { fetch: fake.fetch }),
    'qwen3:14b',
  );
  return { inner, wrapped: new SafetyFirstDecisionProvider(inner), calls: fake.calls };
}

const nominal = () => makeState();
const busyMachine = () =>
  makeState((w) => {
    const m = w.machines[0];
    if (m !== undefined) m.status = 'busy';
  });

describe('OllamaDecisionProvider', () => {
  it('turns a recorded reply into a decision, with the model and its rule in the facts', async () => {
    const { inner, calls } = model({ body: golden('decision-nominal.qwen3-14b') });
    const d = await inner.decide(nominal(), routerCtx());
    expect(d).toMatchObject({
      decision: 'EXECUTE_KNOWN_SAFE_STEP',
      reasonCodes: ['KNOWN_SAFE_STEP'],
      requiresHumanConfirmation: false,
      provider: 'ollama:qwen3:14b',
      factsUsed: { model: 'qwen3:14b', modelRule: 11 },
    });
    expect(d.confidence).toBeGreaterThan(0);
    expect(d.confidence).toBeLessThanOrEqual(1);
    const body = calls[0]?.body;
    expect(body?.messages[0]).toEqual({ role: 'system', content: DECISION_SYSTEM_PROMPT });
    expect(body?.format).toEqual(DECISION_FORMAT);
    // The planner's context size too, so one model serving both roles never reloads.
    expect(body?.options).toMatchObject({ temperature: 0, seed: 7, num_ctx: 8192 });
  });

  it('sends only code-computed facts: no names, goals or other free text from the world', async () => {
    const { inner, calls } = model({ body: golden('decision-nominal.qwen3-14b') });
    await inner.decide(nominal(), routerCtx());
    const sent = calls[0]?.body.messages[1]?.content ?? '';
    expect(JSON.parse(sent)).toEqual(summarizeForDecision(nominal(), routerCtx()));
    for (const text of [
      'Macerator (mock)',
      'Main storage chest',
      'Process iron ore',
      'Check the',
    ]) {
      expect(sent).not.toContain(text);
    }
  });

  it('summarizes thresholds as facts the rules name', () => {
    const s = summarizeForDecision(
      makeState((w) => {
        w.player.hunger = 8;
        w.player.health = 6;
        w.player.position = { x: 40, y: 64, z: 40 };
      }),
      routerCtx(),
    );
    expect(s).toMatchObject({
      hungry: true,
      starving: false,
      lowHealth: true,
      approvedFoodCarried: true,
      home: 'away',
      task: 'active',
      knownNextStep: 'INSPECT_MACHINE',
      requiredMachines: [{ id: 'machine.macerator.1', status: 'idle' }],
    });
    expect(s.dangers).toEqual(['LOW_HEALTH']);
  });

  it('the reply grammar ends the checks at the first true one', () => {
    const ok = {
      stateProblems: false,
      outOfBounds: false,
      danger: true,
      decision: 'RETREAT_HOME',
      reasonCodes: ['HOSTILES_NEARBY'],
      confidence: 90,
    };
    expect(ModelDecisionSchema.safeParse(ok).success).toBe(true);
    expect(decidingRule(ok as ModelDecision)).toBe(3);
    // Going on past a true check (the failure mode this shape prevents) is not a valid reply.
    expect(ModelDecisionSchema.safeParse({ ...ok, lowHealth: false }).success).toBe(false);
    expect(ModelDecisionSchema.safeParse({ ...ok, danger: false }).success).toBe(false);
    expect(ModelDecisionSchema.safeParse({ ...ok, confidence: 0.9 }).success).toBe(false);
    expect(ModelDecisionSchema.safeParse({ ...ok, reasonCodes: ['MOCK_DECISION'] }).success).toBe(
      false,
    );
  });
});

describe('OllamaDecisionProvider inside SafetyFirstDecisionProvider', () => {
  it("uses the model's decision when the router's is not binding", async () => {
    // A recorded WAIT_FOR_MACHINE reply, served for a state where the router would execute
    // the known step: the model's choice stands (it is not a safety decision).
    const { wrapped, calls } = model({ body: golden('decision-machine-busy.qwen3-14b') });
    const d = await wrapped.decide(nominal(), routerCtx());
    expect(d.decision).toBe('WAIT_FOR_MACHINE');
    expect(d.provider).toBe('ollama:qwen3:14b');
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      'lava nearby',
      (w: MockWorld) => {
        w.player.position = { x: 30, y: 64, z: 30 };
        w.hazards = [{ kind: 'lava', position: { x: 31, y: 64, z: 30 } }];
      },
      'RETREAT_HOME',
    ],
    [
      'a hostile nearby',
      (w: MockWorld) => {
        w.player.position = { x: 20, y: 64, z: 20 };
        w.hostiles = [{ x: 24, y: 64, z: 20 }];
      },
      'RETREAT_HOME',
    ],
    [
      'hunger',
      (w: MockWorld) => {
        w.player.hunger = 8;
      },
      'EAT',
    ],
    [
      'an unreliable state',
      (w: MockWorld) => {
        w.unobservable = ['health'];
      },
      'PAUSE_AND_ASK_USER',
    ],
    [
      'no active task (a human paused it)',
      (w: MockWorld) => {
        if (w.task !== null) w.task.status = 'paused';
      },
      'PAUSE_AND_ASK_USER',
    ],
    [
      'a switched-off machine',
      (w: MockWorld) => {
        const m = w.machines[0];
        if (m !== undefined) m.status = 'error';
      },
      'PAUSE_AND_ASK_USER',
    ],
  ])(
    'the router decides alone with %s: the model is never asked',
    async (_name, mutate, expected) => {
      // The recorded reply says "execute the known step"; it must not matter.
      const { wrapped, calls } = model({ body: golden('decision-nominal.qwen3-14b') });
      const state = makeState(mutate);
      const d = await wrapped.decide(state, routerCtx());
      expect(d.decision).toBe(expected);
      expect(d).toMatchObject({ ...routeDecision(state, routerCtx()), provider: wrapped.name });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    [
      'markdown-fenced JSON (recorded, no format constraint)',
      { body: golden('decision-markdown.qwen2.5-0.5b') },
    ],
    ['an older reply format (recorded)', { body: golden('decision-old-format.qwen3-14b') }],
    [
      'a reply cut off at the token limit',
      { body: chatBody('{"stateProblems":fal', { done_reason: 'length' }) },
    ],
    [
      'an unknown decision',
      {
        body: chatBody(
          '{"stateProblems":true,"decision":"LAUNCH_ROCKET","reasonCodes":["STATE_UNRELIABLE"],"confidence":90}',
        ),
      },
    ],
    ['an HTTP error', { status: 404, body: '{"error":"model \\"qwen3:14b\\" not found"}' }],
    ['a refused connection', new Error('connect ECONNREFUSED 127.0.0.1:11434')],
    ['a timeout', 'hang'],
  ] as Array<[string, FakeReply]>)('turns %s into PAUSE_AND_ASK_USER', async (_name, reply) => {
    const { wrapped } = model(reply, { ...TEST_LLM, timeoutMs: 30 });
    const d = await wrapped.decide(busyMachine(), routerCtx());
    expect(d).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['PROVIDER_OUTPUT_INVALID'],
      requiresHumanConfirmation: true,
      provider: 'safety-first(ollama:qwen3:14b)',
    });
  });

  it('keeps provider names within the decision schema limit', () => {
    const long = new OllamaDecisionProvider(
      new OllamaClient(TEST_LLM),
      `org/${'m'.repeat(90)}:tag`,
    );
    expect(new SafetyFirstDecisionProvider(long).name.length).toBeLessThanOrEqual(64);
  });
});

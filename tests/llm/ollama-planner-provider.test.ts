import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, isCodeOnlyActionType } from '../../src/domain/actions.ts';
import { isQuestBookActionType } from '../../src/domain/quest-book.ts';
import { OllamaClient } from '../../src/llm/ollama-client.ts';
import {
  OllamaPlannerProvider,
  PLANNER_SYSTEM_PROMPT,
  plannerFormat,
} from '../../src/llm/ollama-planner-provider.ts';
import type { PlannerRequest } from '../../src/planner/plan-schema.ts';
import { validatePlan } from '../../src/planner/plan-validator.ts';
import { buildPlannerRequest } from '../../src/planner/planner-provider.ts';
import { chatBody, fakeOllama, golden, TEST_LLM, type FakeReply } from '../fixtures/fake-ollama.ts';
import { makeState, safetyCtx } from '../fixtures/index.ts';

const request = (maxPlanSteps = 8): PlannerRequest =>
  buildPlannerRequest({
    state: makeState((w) => {
      if (w.recipe !== null) w.recipe.nextKnownSafeStep = null;
    }),
    safety: safetyCtx(),
    maxPlanSteps,
    recentActions: [],
    recentFailures: [],
  });

function planner(reply: FakeReply, settings = TEST_LLM) {
  const fake = fakeOllama(reply);
  const provider = new OllamaPlannerProvider(
    new OllamaClient(settings, { fetch: fake.fetch }),
    'qwen3:14b',
  );
  return { provider, calls: fake.calls };
}

describe('OllamaPlannerProvider', () => {
  it('asks for a schema-constrained reply with the sanitized request', async () => {
    const { provider, calls } = planner({ body: golden('planner-plan.qwen3-14b') });
    const req = request(4);
    await provider.plan(req);

    expect(provider.name).toBe('ollama:qwen3:14b');
    const body = calls[0]?.body;
    expect(body?.model).toBe('qwen3:14b');
    expect(body?.messages[0]).toEqual({ role: 'system', content: PLANNER_SYSTEM_PROMPT });
    expect(body?.messages[1]?.content).toContain(JSON.stringify(req));
    expect(body?.options).toMatchObject({ temperature: 0, seed: 7, num_ctx: 16_384 });
    expect(body?.format).toEqual(plannerFormat(4));
    expect(JSON.stringify(body?.format)).toContain('"maxItems":4');
    expect(JSON.stringify(body?.format)).not.toContain('BREAK_BLOCK');
  });

  it('the prompt names every action with its args, and the placing rule', () => {
    // Quest-book clicks are the play loop's and DIG_DOWN the night pit's, never a plan's:
    // the prompt does not offer them.
    for (const type of ACTION_TYPES.filter(
      (t) => !isQuestBookActionType(t) && !isCodeOnlyActionType(t),
    )) {
      expect(PLANNER_SYSTEM_PROMPT, type).toContain(`- ${type} {`);
    }
    expect(PLANNER_SYSTEM_PROMPT).not.toContain('SUBMIT_QUEST');
    expect(PLANNER_SYSTEM_PROMPT).not.toContain('- DIG_DOWN {');
    expect(PLANNER_SYSTEM_PROMPT).toContain('DIG_DOWN is never in a plan');
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      '- PLACE_BLOCK {"position":{"x":0,"y":64,"z":0},"item":"minecraft:dirt"}',
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/never sand or gravel above the player's own head/);
  });

  it("lets the model craft by a route step's recipe id and place a crafting table or furnace", () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      'recipe is a known recipe below, or the recipe id a route step names (GTNH\'s own recipes, e.g. "minecraft:wooden_pickaxe#1"; the step ends with the exact CRAFT_ITEM to use)',
    );
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      'A minecraft:crafting_table or minecraft:furnace goes only into a cell whose takesFalling is true (on the ground beside the player), never into a 1-wide passage',
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(
      /\n10\. Crafting: CRAFT_ITEM only with a known recipe or a route step's recipe id/,
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/\n14\. Placing: .*place it as its station step says/);
    // The output schema no longer pins recipe to the hand-verified ids.
    expect(JSON.stringify(plannerFormat(8))).not.toContain('"planks_oak","planks_spruce"');
  });

  it('tells the model what a tool saves, from the verified tables, and the tool recipes', () => {
    // Dig times come from src/domain/dig-time.ts and tools.ts, not from the model's memory.
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      '13. Tools: digging time in ticks: sand or dirt 21 by hand, 12 with a minecraft:wooden_shovel; ' +
        'gravel, grass or clay 25 by hand, 14 with the shovel; logs 77 by hand, 40 with a ' +
        'minecraft:wooden_axe, 21 with a minecraft:stone_axe. A wooden tool lasts 59 digs',
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/Before gathering 32 or more of a block/);
    // DIG_BLOCK picks the tool itself; the planner only decides whether to make one.
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/It holds the best tool from state\.tools/);
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      'wooden_shovel: 1 any of minecraft:planks|minecraft:planks@1|minecraft:planks@2|minecraft:planks@3|minecraft:planks@4|minecraft:planks@5 + 2 minecraft:stick -> 1 minecraft:wooden_shovel (3x3, at a table)',
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/sticks: 2 any of [^;]* -> 2 minecraft:stick \(2x2\)/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/wooden_axe: 3 any of [^;]* \+ 2 minecraft:stick/);
    // GTNH's own crafting table (2 flint above 2 logs, 2x2): the agent can place it.
    expect(PLANNER_SYSTEM_PROMPT).toMatch(
      /crafting_table: 2 minecraft:flint \+ 2 any of [^;]* \(2x2\)/,
    );
    // The request carries the tools the player has (none in this state).
    expect(request().state.tools).toEqual([]);
  });

  it('tells the model to gather with ONE GATHER step (rule 9); the rules stay numbered 1 to 19', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      '- GATHER {"block":"minecraft:sand","count":54} or {"animal":"minecraft:Cow","count":3} a plan step, not an action:',
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(
      /\n9\. Gathering \([^\n]*use ONE GATHER step[^\n]*never a list of DIG_BLOCK steps/,
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/Plans may also use the GATHER step/);
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      'Make EXPLORE the last step of its plan (code drops any step after it)',
    );
    const rules = [...PLANNER_SYSTEM_PROMPT.matchAll(/^(\d+b?)\. /gm)].map((m) => m[1]);
    expect(rules).toEqual([
      ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '11b'],
      ...['12', '13', '14', '15', '16', '17', '18', '19'],
    ]);
    expect(JSON.stringify(plannerFormat(8))).toContain('"GATHER"');
  });

  it('tells the model about EXPLORE, its arguments and when to explore (GTNH start)', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('EXPLORE {"toward":"north","maxDistance":64}');
    expect(PLANNER_SYSTEM_PROMPT).toContain('{"toward":{"x":40,"z":120},"maxDistance":64}');
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/15. Exploring. A good GTNH start has wood/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(
      /Never EXPLORE when state\.time\.phase is evening or night/,
    );
    expect(PLANNER_SYSTEM_PROMPT).not.toMatch(/exploring is not possible yet/);
    expect(JSON.stringify(plannerFormat(8))).toContain('"EXPLORE"');
  });

  it('returns a recorded valid plan, which then passes validatePlan', async () => {
    const { provider } = planner({ body: golden('planner-plan.qwen3-14b') });
    const response = await provider.plan(request());
    expect(response.kind).toBe('plan');
    if (response.kind !== 'plan') return;
    expect(response.plan.steps.map((s) => s.action.type)).toEqual([
      'MOVE_TO',
      'OPEN_CONTAINER',
      'WITHDRAW_ITEM',
    ]);
    expect(validatePlan(response.plan, safetyCtx(), 8).ok).toBe(true);
  });

  it("passes the model's own escalation through", async () => {
    const { provider } = planner({ body: golden('planner-escalation.qwen3-14b') });
    expect(await provider.plan(request())).toMatchObject({
      kind: 'escalation',
      escalation: { reason: 'UNSAFE' },
    });
  });

  it.each([
    [
      'an unconstrained reply that echoes the state into action args (recorded)',
      'planner-unconstrained.qwen2.5-0.5b',
      /not valid JSON/,
    ],
    [
      'a reply cut off at the token limit (recorded)',
      'planner-truncated.qwen2.5-0.5b',
      /token limit/,
    ],
  ])('turns %s into an INVALID_OUTPUT escalation', async (_name, fixture, message) => {
    const { provider } = planner({ body: golden(fixture) });
    const response = await provider.plan(request());
    expect(response).toMatchObject({
      kind: 'escalation',
      escalation: { reason: 'INVALID_OUTPUT' },
    });
    expect(response.kind === 'escalation' ? response.escalation.message : '').toMatch(message);
  });

  it.each([
    [
      'a non-allowlisted action',
      {
        kind: 'plan',
        plan: {
          goal: 'x',
          steps: [{ step: 1, action: { type: 'BREAK_BLOCK', args: {} }, rationale: 'x' }],
          requiresUserApproval: false,
          explanation: 'x',
          failureHandling: {
            onStepFailure: 'PAUSE_AND_ASK_USER',
            maxRetriesPerStep: 1,
            escalationMessage: 'x',
          },
        },
      },
    ],
    ['an extra field', { kind: 'plan', plan: {}, run: 'now' }],
    ['a wrong kind', { kind: 'code', js: 'bot.chat("/op me")' }],
  ])('turns schema-invalid output (%s) into an INVALID_OUTPUT escalation', async (_n, content) => {
    const { provider } = planner({ body: chatBody(JSON.stringify(content)) });
    expect(await provider.plan(request())).toMatchObject({
      kind: 'escalation',
      escalation: { reason: 'INVALID_OUTPUT' },
    });
  });

  it('turns a timeout into an escalation', async () => {
    const { provider } = planner('hang', { ...TEST_LLM, timeoutMs: 30 });
    const response = await provider.plan(request());
    expect(response).toMatchObject({ kind: 'escalation', escalation: { reason: 'OTHER' } });
    expect(response.kind === 'escalation' ? response.escalation.message : '').toMatch(/timed out/);
  });

  it('turns server and connection errors into escalations', async () => {
    for (const reply of [
      { status: 404, body: '{"error":"model \\"qwen3:14b\\" not found, try pulling it first"}' },
      { status: 500, body: 'internal error' },
      new Error('connect ECONNREFUSED 127.0.0.1:11434'),
    ] as FakeReply[]) {
      const { provider } = planner(reply);
      const response = await provider.plan(request());
      expect(response).toMatchObject({ kind: 'escalation', escalation: { reason: 'OTHER' } });
    }
  });

  it('never contacts a public server', async () => {
    const { provider, calls } = planner(
      { body: golden('planner-plan.qwen3-14b') },
      { ...TEST_LLM, baseUrl: 'http://203.0.113.9:11434' },
    );
    const response = await provider.plan(request());
    expect(response).toMatchObject({ kind: 'escalation' });
    expect(response.kind === 'escalation' ? response.escalation.message : '').toMatch(/public IP/);
    expect(calls).toHaveLength(0);
  });

  it('does not send a request that fails the request schema', async () => {
    const { provider, calls } = planner({ body: golden('planner-plan.qwen3-14b') });
    // A request the agent could never build (the schema caps maxPlanSteps at 16).
    const bad: PlannerRequest = { ...request(), maxPlanSteps: 99 };
    expect(await provider.plan(bad)).toMatchObject({ kind: 'escalation' });
    expect(calls).toHaveLength(0);
  });

  it('never throws, even if the transport does', async () => {
    const provider = new OllamaPlannerProvider(
      new OllamaClient(TEST_LLM, {
        fetch: () => {
          throw new Error('boom');
        },
      }),
      'qwen3:14b',
    );
    await expect(provider.plan(request())).resolves.toMatchObject({ kind: 'escalation' });
  });
});

describe('fitting the request to the context window', () => {
  it('trims history first and never the task, route or stock', async () => {
    const { buildPlannerRequest } = await import('../../src/planner/planner-provider.ts');
    const { fitPlannerRequest } = await import('../../src/llm/ollama-planner-provider.ts');
    const { makeState, safetyCtx } = await import('../fixtures/index.ts');
    const long = 'x'.repeat(190);
    const request = buildPlannerRequest({
      state: makeState(),
      safety: safetyCtx(),
      maxPlanSteps: 8,
      recentActions: Array.from({ length: 50 }, () => ({
        actionType: 'DIG_BLOCK' as const,
        status: 'succeeded',
        reason: long,
      })),
      recentFailures: [],
      journal: Array.from({ length: 32 }, (_, i) => `plan #${i} done: ${long}`),
    });
    const small = fitPlannerRequest(request, 2_500);
    expect(small.recentActions.length).toBeLessThanOrEqual(5);
    expect(small.journal.length).toBeLessThanOrEqual(6);
    expect(small.task).toEqual(request.task);
    expect(small.route).toEqual(request.route);
    // Plenty of room: nothing changes.
    expect(fitPlannerRequest(request, 1_000_000)).toBe(request);
  });
});

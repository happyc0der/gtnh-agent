import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '../../src/domain/actions.ts';
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
    expect(body?.options).toMatchObject({ temperature: 0, seed: 7, num_ctx: 8192 });
    expect(body?.format).toEqual(plannerFormat(4));
    expect(JSON.stringify(body?.format)).toContain('"maxItems":4');
    expect(JSON.stringify(body?.format)).not.toContain('BREAK_BLOCK');
  });

  it('the prompt names every action with its args, and the placing rule', () => {
    for (const type of ACTION_TYPES) expect(PLANNER_SYSTEM_PROMPT, type).toContain(`- ${type} {`);
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      '- PLACE_BLOCK {"position":{"x":0,"y":64,"z":0},"item":"minecraft:dirt"}',
    );
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/never sand or gravel above the player's own head/);
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

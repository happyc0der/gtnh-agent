import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockPlannerProvider } from '../../src/planner/mock-planner-provider.ts';
import { PlanSchema, plannerResponseJsonSchema, type Plan } from '../../src/planner/plan-schema.ts';
import { parsePlannerOutput, validatePlan } from '../../src/planner/plan-validator.ts';
import {
  buildPlannerRequest,
  sanitizeStateForPlanner,
} from '../../src/planner/planner-provider.ts';
import { makeState, safetyCtx } from '../fixtures/index.ts';

const validPlan: Plan = {
  goal: 'Inspect then wait',
  steps: [
    {
      step: 1,
      action: { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } },
      rationale: 'check it',
    },
    { step: 2, action: { type: 'WAIT', args: { durationMs: 1000 } }, rationale: 'let it run' },
  ],
  requiresUserApproval: false,
  explanation: 'Low-risk.',
  failureHandling: {
    onStepFailure: 'PAUSE_AND_ASK_USER',
    maxRetriesPerStep: 1,
    escalationMessage: 'stuck',
  },
};

describe('plan schema', () => {
  it('accepts a valid plan', () => {
    expect(PlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it.each([
    [
      'a non-allowlisted action',
      {
        ...validPlan,
        steps: [{ step: 1, action: { type: 'BREAK_BLOCK', args: {} }, rationale: 'x' }],
      },
    ],
    [
      'too many steps',
      {
        ...validPlan,
        steps: Array.from({ length: 17 }, (_, i) => ({
          step: i + 1,
          action: { type: 'WAIT', args: { durationMs: 100 } },
          rationale: 'w',
        })),
      },
    ],
    ['no steps', { ...validPlan, steps: [] }],
    ['non-sequential steps', { ...validPlan, steps: [{ ...validPlan.steps[0], step: 2 }] }],
    ['extra top-level fields', { ...validPlan, execute: 'now' }],
    [
      'extra fields in an action',
      {
        ...validPlan,
        steps: [
          {
            step: 1,
            action: { type: 'WAIT', args: { durationMs: 100, js: 'bot.dig()' } },
            rationale: 'x',
          },
        ],
      },
    ],
    [
      'too many retries',
      { ...validPlan, failureHandling: { ...validPlan.failureHandling, maxRetriesPerStep: 5 } },
    ],
    ['missing approval flag', { ...validPlan, requiresUserApproval: undefined }],
  ])('rejects %s', (_name, plan) => {
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it('exports a JSON Schema for constrained decoding', () => {
    const schema = JSON.stringify(plannerResponseJsonSchema());
    expect(schema).toContain('INSPECT_MACHINE');
    expect(schema).not.toContain('PLACE_BLOCK');
  });
});

describe('validatePlan', () => {
  it('passes a safe plan', () => {
    expect(validatePlan(validPlan, safetyCtx(), 8).ok).toBe(true);
  });

  it.each(['fetch-cobblestone.json', 'dig-pen.json'])('passes the example plan %s', (file) => {
    const plan: unknown = JSON.parse(readFileSync(join('examples', 'plans', file), 'utf8'));
    const r = validatePlan(plan, safetyCtx(), 8);
    expect(r.schemaIssues).toEqual([]);
    expect(r.stepViolations).toEqual([]);
  });

  it('enforces the configured step limit', () => {
    const r = validatePlan(validPlan, safetyCtx(), 1);
    expect(r.ok).toBe(false);
    expect(r.schemaIssues[0]).toMatch(/limit is 1/);
  });

  it('runs static safety checks on every step', () => {
    const plan: Plan = {
      ...validPlan,
      steps: [
        validPlan.steps[0] as Plan['steps'][number],
        {
          step: 2,
          action: { type: 'EAT_FOOD', args: { item: 'minecraft:diamond' } },
          rationale: 'hungry',
        },
      ],
    };
    const r = validatePlan(plan, safetyCtx(), 8);
    expect(r.ok).toBe(false);
    expect(r.stepViolations.map((s) => s.step)).toEqual([2]);
    expect(r.stepViolations[0]?.violations.map((v) => v.code)).toContain('PROTECTED_ITEM');
  });
});

describe('parsePlannerOutput (future LLM output path)', () => {
  it('parses valid JSON output', () => {
    expect(parsePlannerOutput(JSON.stringify({ kind: 'plan', plan: validPlan })).kind).toBe('plan');
  });

  it.each([
    ['prose', 'Sure! Here is the plan: step 1...'],
    ['truncated JSON', '{"kind":"plan","plan":{'],
    ['wrong shape', JSON.stringify({ kind: 'plan', steps: [] })],
    ['code instead of plan', JSON.stringify({ kind: 'code', js: 'bot.chat("/op me")' })],
  ])('turns %s into an INVALID_OUTPUT escalation', (_n, text) => {
    const r = parsePlannerOutput(text);
    expect(r).toMatchObject({ kind: 'escalation', escalation: { reason: 'INVALID_OUTPUT' } });
  });
});

describe('planner request and mock planner', () => {
  const request = () =>
    buildPlannerRequest({
      state: makeState(),
      safety: safetyCtx(),
      maxPlanSteps: 4,
      recentActions: [],
      recentFailures: [],
    });

  it('sanitizes state and lists unknowns instead of guessing', () => {
    const compact = sanitizeStateForPlanner(makeState((w) => void (w.unobservable = ['health'])));
    expect(compact.health).toBeNull();
    expect(compact.unknownFields).toEqual(['player.health', 'power.availableEUt']);
  });

  it('passes the observed diggable blocks, nearest first, and marks them unknown when hidden', () => {
    // The grass under the player's feet is never listed (the ground is never dug).
    const compact = sanitizeStateForPlanner(makeState());
    expect(compact.diggableBlocks.map((b) => b.block)).toEqual([
      'minecraft:dirt',
      'minecraft:log',
      'minecraft:leaves',
    ]);
    // The player stands at (1, 64, 1): eyes at y 65.62, the dirt's centre at (2.5, 64.5, 1.5).
    expect(compact.diggableBlocks[0]).toEqual({
      block: 'minecraft:dirt',
      position: { x: 2, y: 64, z: 1 },
      reach: Number(Math.hypot(1.5, 1.12, 0.5).toFixed(2)),
      standAt: null,
    });
    const hidden = sanitizeStateForPlanner(makeState((w) => void (w.unobservable = ['blocks'])));
    expect(hidden.diggableBlocks).toEqual([]);
    expect(hidden.unknownFields).toContain('nearbyBlocks');
  });

  it('lists the tools DIG_BLOCK may hold, best first, with the digs they have left', () => {
    const state = makeState((w) => {
      Object.assign(w.inventory.items, {
        'minecraft:wooden_shovel': 2,
        'minecraft:wooden_shovel@57': 1,
        'minecraft:wooden_shovel@59': 1, // worn out for the agent
        'minecraft:stone_axe@1': 1,
        'minecraft:iron_shovel': 1, // digs nothing on this server: not a tool for the agent
        'minecraft:diamond_axe': 1, // protected below
      });
    });
    const shovel = [
      'minecraft:dirt',
      'minecraft:grass',
      'minecraft:sand',
      'minecraft:gravel',
      'minecraft:clay',
    ];
    const axe = ['minecraft:log', 'minecraft:log2'];
    expect(sanitizeStateForPlanner(state, new Set(['minecraft:diamond_axe'])).tools).toEqual([
      { item: 'minecraft:stone_axe', count: 1, durabilityLeft: 130, digsFaster: axe },
      { item: 'minecraft:wooden_shovel', count: 2, durabilityLeft: 59, digsFaster: shovel },
      { item: 'minecraft:wooden_shovel', count: 1, durabilityLeft: 2, digsFaster: shovel },
      { item: 'minecraft:wooden_shovel', count: 1, durabilityLeft: 0, digsFaster: shovel },
    ]);
    // Through buildPlannerRequest, protected tools come from the safety context.
    const r = buildPlannerRequest({
      state,
      safety: safetyCtx(),
      maxPlanSteps: 4,
      recentActions: [],
      recentFailures: [],
    });
    expect(r.state.tools.map((t) => t.item)).toContain('minecraft:diamond_axe');
    const guarded = buildPlannerRequest({
      state,
      safety: { ...safetyCtx(), protectedItems: new Set(['minecraft:stone_axe']) },
      maxPlanSteps: 4,
      recentActions: [],
      recentFailures: [],
    });
    expect(guarded.state.tools.map((t) => t.item)).not.toContain('minecraft:stone_axe');
    // No tools, or an unknown inventory: an empty list.
    expect(request().state.tools).toEqual([]);
    const blind = sanitizeStateForPlanner(makeState((w) => void (w.unobservable = ['inventory'])));
    expect(blind.tools).toEqual([]);
  });

  it('the request carries the allowlist and constraints', () => {
    const r = request();
    expect(r.allowedActions).toHaveLength(13);
    expect(r.allowedActions).toContain('DIG_BLOCK');
    expect(r.allowedActions).toContain('CRAFT_ITEM');
    expect(r.safetyConstraints.protectedItems).toEqual([
      'minecraft:diamond',
      'minecraft:nether_star',
    ]);
    expect(r.safetyConstraints.safeLocations).toEqual(['home']);
    // 'DIG' stays a forbidden keyword; exactly DIG_BLOCK is the operator's exception.
    expect(r.safetyConstraints.forbidden).toContain('DIG');
    expect(r.safetyConstraints.forbiddenExceptions).toEqual(['DIG_BLOCK']);
    expect(r.safetyConstraints.diggableBlocks).toContain('minecraft:log');
  });

  it('a plan may dig an allowlisted block, but not a block outside the boundary', () => {
    const dig = (y: number): Plan => ({
      ...validPlan,
      steps: [
        {
          step: 1,
          action: { type: 'DIG_BLOCK', args: { position: { x: 2, y, z: 1 } } },
          rationale: 'gather dirt',
        },
      ],
    });
    expect(validatePlan(dig(64), safetyCtx(), 8).ok).toBe(true);
    const outside = validatePlan(dig(255), safetyCtx(), 8);
    expect(outside.stepViolations[0]?.violations.map((v) => v.code)).toEqual(['OUT_OF_BOUNDS']);
  });

  it('MockPlannerProvider is fixture-driven and deterministic', async () => {
    const planner = new MockPlannerProvider([
      {
        name: 'other',
        when: { taskId: 'nope' },
        response: { kind: 'plan', plan: { ...validPlan, goal: 'wrong' } },
      },
      {
        name: 'match',
        when: { goalIncludes: 'iron' },
        response: { kind: 'plan', plan: validPlan },
      },
    ]);
    const a = await planner.plan(request());
    const b = await planner.plan(request());
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'plan', plan: { goal: 'Inspect then wait' } });
    expect(planner.requests).toHaveLength(2);
  });

  it('escalates when no fixture matches or a fixture is malformed', async () => {
    expect((await new MockPlannerProvider([]).plan(request())).kind).toBe('escalation');
    const bad = new MockPlannerProvider([
      { name: 'bad', when: {}, response: { kind: 'plan', plan: { goal: 'x' } } },
    ]);
    expect(await bad.plan(request())).toMatchObject({
      kind: 'escalation',
      escalation: { reason: 'INVALID_OUTPUT' },
    });
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOCK_CONFIG } from '../../src/app/scenarios.ts';
import { defaultConfig } from '../../src/config/env.ts';
import type { PlaceableItem } from '../../src/domain/blocks.ts';
import { MockPlannerProvider } from '../../src/planner/mock-planner-provider.ts';
import {
  MAX_COMPACT_RESOURCES,
  PlanSchema,
  plannerResponseJsonSchema,
  type Plan,
} from '../../src/planner/plan-schema.ts';
import {
  parsePlannerOutput,
  trimStaleSteps,
  validatePlan,
} from '../../src/planner/plan-validator.ts';
import {
  buildPlannerRequest,
  sanitizeStateForPlanner,
} from '../../src/planner/planner-provider.ts';
import { summarizeExploration } from '../../src/domain/world-memory.ts';
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
    expect(schema).toContain('PLACE_BLOCK');
    // The item is an enum of the place allowlist, so decoding cannot invent another block.
    expect(schema).toContain('"enum":["minecraft:dirt","minecraft:cobblestone"');
    expect(schema).not.toContain('BREAK_BLOCK');
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

  it('shares the diggable list between kinds, so a log behind many grass blocks shows', () => {
    const base = makeState();
    if (!base.nearbyBlocks.known) throw new Error('blocks unknown');
    const grass = Array.from({ length: 40 }, (_, i) => ({
      block: 'minecraft:grass' as const,
      position: { x: 2 + (i % 8), y: 64, z: 2 + Math.floor(i / 8) },
    }));
    const log = { block: 'minecraft:log' as const, position: { x: 14, y: 65, z: 14 } };
    const compact = sanitizeStateForPlanner({
      ...base,
      nearbyBlocks: {
        known: true,
        value: { ...base.nearbyBlocks.value, resources: [...grass, log] },
      },
    });
    expect(compact.diggableBlocks).toHaveLength(MAX_COMPACT_RESOURCES);
    expect(compact.diggableBlocks.filter((b) => b.block === 'minecraft:log')).toHaveLength(1);
    // Still nearest first: the log, farthest, comes last.
    expect(compact.diggableBlocks.at(-1)?.block).toBe('minecraft:log');
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
    expect(r.allowedActions).toHaveLength(18);
    expect(r.allowedActions).toContain('DIG_BLOCK');
    expect(r.allowedActions).toContain('PLACE_BLOCK');
    expect(r.allowedActions).toContain('CRAFT_ITEM');
    expect(r.allowedActions).toEqual(
      expect.arrayContaining(['INTERACT_BLOCK', 'SMELT', 'TAKE_OUTPUT']),
    );
    expect(r.allowedActions).toContain('ATTACK_ENTITY');
    expect(r.safetyConstraints.protectedItems).toEqual([
      'minecraft:diamond',
      'minecraft:nether_star',
    ]);
    expect(r.safetyConstraints.safeLocations).toEqual(['home']);
    // 'DIG', 'PLACE' and 'ATTACK' stay forbidden keywords; exactly DIG_BLOCK, PLACE_BLOCK and
    // ATTACK_ENTITY are the operator's exceptions.
    expect(r.safetyConstraints.forbidden).toEqual(
      expect.arrayContaining(['DIG', 'PLACE', 'ATTACK']),
    );
    expect(r.safetyConstraints.forbiddenExceptions).toEqual([
      'DIG_BLOCK',
      'PLACE_BLOCK',
      'ATTACK_ENTITY',
    ]);
    expect(r.safetyConstraints.diggableBlocks).toContain('minecraft:log');
    expect(r.safetyConstraints.placeableItems).toEqual(
      expect.arrayContaining(['minecraft:dirt', 'minecraft:cobblestone', 'minecraft:planks@5']),
    );
  });

  it('passes the placeable cells, nearest first, with their reach', () => {
    // The mock player's eyes are at (1, 65.62, 1); dirt at (2, 64, 1) is a block to place on.
    const s = sanitizeStateForPlanner(makeState());
    expect(s.placeableCells[0]).toEqual({
      position: { x: 2, y: 65, z: 1 },
      reach: 1.59,
      takesFalling: true,
    });
    const reaches = s.placeableCells.map((c) => c.reach ?? Infinity);
    expect(reaches).toEqual([...reaches].sort((a, b) => a - b));
    const hidden = sanitizeStateForPlanner(makeState((w) => void (w.unobservable = ['blocks'])));
    expect(hidden.placeableCells).toEqual([]);
  });

  it('a plan may place an allowlisted block, but not outside the boundary or a protected one', () => {
    const place = (x: number, item: PlaceableItem): Plan => ({
      ...validPlan,
      steps: [
        {
          step: 1,
          action: { type: 'PLACE_BLOCK', args: { position: { x, y: 65, z: 1 }, item } },
          rationale: 'close the gap',
        },
      ],
    });
    expect(validatePlan(place(2, 'minecraft:cobblestone'), safetyCtx(), 8).ok).toBe(true);
    const outside = validatePlan(place(300, 'minecraft:cobblestone'), safetyCtx(), 8);
    expect(outside.stepViolations[0]?.violations.map((v) => v.code)).toEqual(['OUT_OF_BOUNDS']);
    // Protecting minecraft:log protects every wood type of it.
    const ctx = safetyCtx(
      defaultConfig({ ...MOCK_CONFIG, safety: { protectedItems: ['minecraft:log'] } }),
    );
    expect(
      validatePlan(place(2, 'minecraft:log@2'), ctx, 8).stepViolations[0]?.violations.map(
        (v) => v.code,
      ),
    ).toEqual(['PROTECTED_ITEM']);
  });

  it('offers EXPLORE, with what world memory knows, only when the agent can explore', () => {
    expect(request().allowedActions).not.toContain('EXPLORE');
    expect(request().exploration).toBeUndefined();
    const exploration = summarizeExploration({
      chunks: [
        {
          dimension: 'overworld',
          chunkX: 0,
          chunkZ: 4,
          biome: { id: 229, name: 'Hot Forest', share: 1 },
          counts: { log: 9 },
          examples: { log: [{ x: 4, y: 64, z: 70 }] },
          seenAt: '2026-01-01T11:58:00.000Z',
        },
      ],
      from: { x: 1, y: 64, z: 1 },
      boundary: safetyCtx().config.boundary,
      now: new Date('2026-01-01T12:00:00.000Z'),
    });
    const r = buildPlannerRequest({
      state: makeState(),
      safety: safetyCtx(),
      maxPlanSteps: 4,
      recentActions: [],
      recentFailures: [],
      exploration,
    });
    expect(r.allowedActions).toContain('EXPLORE');
    expect(r.allowedActions).toHaveLength(19);
    expect(r.exploration?.places).toEqual([
      {
        resource: 'log',
        x: 4,
        y: 64,
        z: 70,
        distance: 69,
        direction: 'south',
        count: 9,
        biome: 'Hot Forest',
        seenMinutesAgo: 2,
      },
    ]);
    expect(JSON.stringify(plannerResponseJsonSchema())).toContain('north_east');
  });

  it('a plan may explore toward a point inside the boundary, not outside it', () => {
    const exploreTo = (x: number, z: number): Plan => ({
      ...validPlan,
      steps: [
        {
          step: 1,
          action: { type: 'EXPLORE', args: { toward: { x, z }, maxDistance: 96 } },
          rationale: 'find wood',
        },
      ],
    });
    expect(validatePlan(exploreTo(40, 70), safetyCtx(), 8).ok).toBe(true);
    expect(
      validatePlan(exploreTo(4000, 70), safetyCtx(), 8).stepViolations[0]?.violations.map(
        (v) => v.code,
      ),
    ).toEqual(['OUT_OF_BOUNDS']);
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

describe('trimStaleSteps: no step runs on a view its own plan replaced', () => {
  type Action = Plan['steps'][number]['action'];
  const explore: Action = { type: 'EXPLORE', args: { toward: 'east', maxDistance: 64 } };
  const dig: Action = { type: 'DIG_BLOCK', args: { position: { x: 9, y: 64, z: 1 } } };
  const walk: Action = {
    type: 'MOVE_TO',
    args: { target: { x: 8.5, y: 64, z: 1.5 }, tolerance: 0.5 },
  };
  const gather: Action = { type: 'GATHER', args: { block: 'minecraft:log', count: 4 } };
  const planks: Action = {
    type: 'CRAFT_ITEM',
    args: { recipe: 'planks_oak', times: 4, craftingTableId: null },
  };
  const planOf = (...actions: Action[]): Plan => ({
    ...validPlan,
    steps: actions.map((action, i) => ({ step: i + 1, action, rationale: 'x' })),
  });

  it('drops every step after the first EXPLORE, and says so in the explanation', () => {
    // Seen live: EXPLORE, EXPLORE, DIG_BLOCK; the dig target was 7.3 blocks away by then.
    const { plan, note } = trimStaleSteps(planOf(explore, explore, dig));
    expect(plan.steps).toEqual([{ step: 1, action: explore, rationale: 'x' }]);
    expect(note).toBe('dropped steps 2-3 after the EXPLORE at step 1');
    expect(plan.explanation).toBe(
      'Low-risk. (Code dropped steps 2-3 after the EXPLORE at step 1: planned from the view ' +
        'before it, they would run stale; the next plan starts from what the agent sees then.)',
    );
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    // A long explanation is shortened to make room; the plan stays valid.
    const long = trimStaleSteps({ ...planOf(dig, explore, dig), explanation: 'x'.repeat(1000) });
    expect(long.plan.steps).toHaveLength(2);
    expect(long.plan.explanation).toHaveLength(1000);
    expect(long.plan.explanation).toMatch(/dropped step 3 after the EXPLORE at step 2/);
    expect(PlanSchema.safeParse(long.plan).success).toBe(true);
  });

  it('after a GATHER, drops the first step that names a position or a creature, and the rest', () => {
    const r = trimStaleSteps(planOf(gather, planks, dig, planks));
    expect(r.plan.steps.map((s) => s.action.type)).toEqual(['GATHER', 'CRAFT_ITEM']);
    expect(r.note).toBe('dropped steps 3-4 after the GATHER at step 1');
    expect(trimStaleSteps(planOf(dig, gather, walk)).note).toBe(
      'dropped step 3 after the GATHER at step 2',
    );
  });

  it('drops a walk right before a GATHER (it walks to its blocks by itself)', () => {
    // Seen live: MOVE_TO the dirt block's own position (not walkable), then GATHER dirt.
    const r = trimStaleSteps(planOf(walk, gather));
    expect(r.plan.steps).toEqual([{ step: 1, action: gather, rationale: 'x' }]);
    expect(r.note).toBe(
      'dropped the MOVE_TO at step 1 before a GATHER (it walks to its blocks by itself)',
    );
    expect(r.plan.explanation).toMatch(/dropped the MOVE_TO at step 1 before a GATHER/);
    expect(PlanSchema.safeParse(r.plan).success).toBe(true);
    // With a step after the GATHER that names the view, both happen.
    expect(trimStaleSteps(planOf(walk, gather, walk)).note).toBe(
      'dropped the MOVE_TO at step 1 before a GATHER (it walks to its blocks by itself); ' +
        'dropped step 2 after the GATHER at step 1',
    );
  });

  it('keeps plans whose steps do not depend on a view an earlier step replaced', () => {
    for (const plan of [
      planOf(walk, dig),
      planOf(dig, explore),
      planOf(gather, gather, planks, explore),
      validPlan,
    ]) {
      const r = trimStaleSteps(plan);
      expect(r.note).toBeNull();
      expect(r.plan).toBe(plan);
    }
  });
});

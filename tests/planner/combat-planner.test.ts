import { describe, expect, it } from 'vitest';
import type { MockMob } from '../../src/bot/mock-minecraft-client.ts';
import { defaultConfig } from '../../src/config/env.ts';
import { MOCK_CONFIG } from '../../src/app/scenarios.ts';
import { PLANNER_SYSTEM_PROMPT } from '../../src/llm/ollama-planner-provider.ts';
import { PlannerRequestSchema, type Plan } from '../../src/planner/plan-schema.ts';
import { validatePlan } from '../../src/planner/plan-validator.ts';
import {
  buildPlannerRequest,
  sanitizeStateForPlanner,
} from '../../src/planner/planner-provider.ts';
import { makeState, safetyCtx } from '../fixtures/index.ts';

const at = (x: number, z: number) => ({ x, y: 64, z });
const mobs: MockMob[] = [
  { id: 1, type: 'minecraft:Cow', category: 'passive', position: at(3, 1), health: 10 },
  {
    id: 2,
    type: 'minecraft:Cow',
    category: 'passive',
    position: at(4, 1),
    health: 10,
    owned: true,
  },
  { id: 3, type: 'player', category: 'player', position: at(1, 4), health: 20 },
  { id: 4, type: 'minecraft:Villager', category: 'passive', position: at(1, 6), health: 20 },
];

describe('what the planner sees of creatures', () => {
  it('creatures only (no players), each with attackable, plus the weapon and fight problems', () => {
    const compact = sanitizeStateForPlanner(makeState((w) => void (w.mobs = mobs)));
    expect(compact.entities).toEqual([
      {
        id: 1,
        type: 'minecraft:Cow',
        category: 'passive',
        distance: 2,
        health: 10,
        attackable: true,
      },
      {
        id: 2,
        type: 'minecraft:Cow',
        category: 'passive',
        distance: 3,
        health: 10,
        attackable: false,
      },
      {
        id: 4,
        type: 'minecraft:Villager',
        category: 'passive',
        distance: 5,
        health: 20,
        attackable: false,
      },
    ]);
    expect(compact.weapon).toEqual({ item: null, damage: 1 });
    expect(compact.fightProblems).toEqual([]);
    const hungry = sanitizeStateForPlanner(makeState((w) => void (w.player.hunger = 6)));
    expect(hungry.fightProblems).toEqual(['LOW_HUNGER']);
  });

  it('uses the configured fighting thresholds, and lists unobserved entities as unknown', () => {
    const config = defaultConfig({
      ...MOCK_CONFIG,
      safety: { ...MOCK_CONFIG.safety, combat: { minHealthToFight: 20 } },
    });
    const request = buildPlannerRequest({
      state: makeState((w) => void (w.player.health = 19)),
      safety: safetyCtx(config),
      maxPlanSteps: 8,
      recentActions: [],
      recentFailures: [],
    });
    expect(request.state.fightProblems).toEqual(['LOW_HEALTH']);
    expect(PlannerRequestSchema.safeParse(request).success).toBe(true);
    const blind = sanitizeStateForPlanner(makeState((w) => void (w.unobservable = ['threats'])));
    expect(blind.unknownFields).toEqual(expect.arrayContaining(['nearbyEntities']));
    expect(blind.entities).toEqual([]);
  });

  it('the prompt names ATTACK_ENTITY with its exact args and the rule for it', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('- ATTACK_ENTITY {"entityId":123}');
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/11\. Fighting: ATTACK_ENTITY only a listed creature/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/Never anything else/);
    expect(PLANNER_SYSTEM_PROMPT).not.toMatch(/placing blocks, fighting/);
  });

  it('a hunting plan passes the static checks (the live state is checked step by step)', () => {
    const plan: Plan = {
      goal: 'Get leather for the Cow Tipper quest',
      steps: [
        {
          step: 1,
          action: { type: 'MOVE_TO', args: { target: at(2, 1), tolerance: 1 } },
          rationale: 'next to the cow',
        },
        { step: 2, action: { type: 'ATTACK_ENTITY', args: { entityId: 1 } }, rationale: 'hunt' },
      ],
      requiresUserApproval: false,
      explanation: 'Walk to the cow and strike it.',
      failureHandling: {
        onStepFailure: 'REPLAN',
        maxRetriesPerStep: 1,
        escalationMessage: 'The cow got away.',
      },
    };
    expect(validatePlan(plan, safetyCtx(), 8)).toMatchObject({ ok: true });
  });
});

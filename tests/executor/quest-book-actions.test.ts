import { describe, expect, it } from 'vitest';
import type { ActionSpec } from '../../src/domain/actions.ts';
import type { GameState } from '../../src/domain/game-state.ts';
import type { QuestBookQuest } from '../../src/domain/quest-book.ts';
import { validateCandidate } from '../../src/executor/action-executor.ts';
import { verifyPostcondition } from '../../src/executor/action-verifier.ts';
import { emptyFailureHistory } from '../../src/safety/safety-policy.ts';
import { action, makeState, safetyCtx } from '../fixtures/index.ts';

const DIRT = { item: 'minecraft:dirt', count: 8, oreDict: null, anyDamage: false };
const LOGS = { item: 'minecraft:log', count: 2, oreDict: 'logWood', anyDamage: false };

const quest = (id: string, extra: Partial<QuestBookQuest> = {}): QuestBookQuest => ({
  id,
  name: `Quest ${id}`,
  active: true,
  unlocked: true,
  completed: false,
  claimed: false,
  taskLogic: 'AND',
  tasks: [],
  rewards: [],
  ...extra,
});

const QUESTS: QuestBookQuest[] = [
  // Active: 8 dirt (counted 5 so far) and a checkbox.
  quest('0:0', {
    tasks: [
      {
        index: 0,
        type: 'bq_standard:retrieval',
        complete: false,
        consume: false,
        items: [DIRT],
        progress: [5],
      },
      {
        index: 1,
        type: 'bq_standard:checkbox',
        complete: false,
        consume: false,
        items: [],
        progress: [],
      },
    ],
  }),
  // Active: two logs (any log, by ore dictionary) are handed in.
  quest('0:2', {
    tasks: [
      {
        index: 0,
        type: 'bq_standard:retrieval',
        complete: false,
        consume: true,
        items: [LOGS],
        progress: [0],
      },
    ],
  }),
  // Not active yet.
  quest('0:4', { active: false, unlocked: false }),
  // Active but locked (Better Questing's lockedProgress).
  quest('0:6', { unlocked: false }),
  // Completed, with an item reward and a choice reward.
  quest('0:5', {
    active: false,
    completed: true,
    rewards: [
      {
        index: 0,
        type: 'bq_standard:item',
        choice: false,
        items: [{ item: 'dreamcraft:item.CoinSmith', count: 5, oreDict: null, anyDamage: false }],
        selected: null,
      },
      {
        index: 1,
        type: 'bq_standard:choice',
        choice: true,
        items: [
          { item: 'minecraft:planks', count: 10, oreDict: null, anyDamage: false },
          { item: 'minecraft:cookie', count: 1, oreDict: null, anyDamage: false },
        ],
        selected: null,
      },
    ],
  }),
];

/** The mock state (which holds a protected diamond) with a quest book and an inventory. */
function stateWith(
  quests: QuestBookQuest[] = QUESTS,
  items?: Record<string, number>,
  usedSlots?: number,
): GameState {
  const base = makeState();
  const inventory =
    items === undefined
      ? base.inventory
      : {
          known: true as const,
          value: { items, usedSlots: usedSlots ?? Object.keys(items).length, capacitySlots: 36 },
        };
  return { ...base, inventory, questBook: { known: true, value: { totalQuests: 3739, quests } } };
}

function validate(spec: ActionSpec, state: GameState = stateWith(), ctx = safetyCtx()) {
  const { report } = validateCandidate(action(spec), state, ctx, emptyFailureHistory);
  return {
    ok: report.ok,
    codes: report.violations.map((v) => v.code),
    pre: report.preconditionFailures,
  };
}

describe('quest-book actions: the safety policy', () => {
  it('acts only on quests the observed quest book lists', () => {
    const unknownBook = { ...makeState() };
    expect(validate({ type: 'SUBMIT_QUEST', args: { questId: '0:0' } }, unknownBook).codes).toEqual(
      ['UNKNOWN_TARGET'],
    );
    expect(validate({ type: 'SUBMIT_QUEST', args: { questId: '0:99' } }).codes).toEqual([
      'UNKNOWN_TARGET',
    ]);
  });

  it('submits and ticks only quests the server lists as active and unlocked', () => {
    expect(validate({ type: 'SUBMIT_QUEST', args: { questId: '0:4' } }).codes).toEqual([
      'QUEST_NOT_ACTIVE',
    ]);
    expect(validate({ type: 'SUBMIT_QUEST', args: { questId: '0:6' } }).codes).toEqual([
      'QUEST_NOT_ACTIVE',
    ]);
    expect(
      validate({ type: 'CHECK_QUEST_BOX', args: { questId: '0:4', taskIndex: 0 } }).codes,
    ).toEqual(['QUEST_NOT_ACTIVE']);
    expect(validate({ type: 'SUBMIT_QUEST', args: { questId: '0:0' } })).toEqual({
      ok: true,
      codes: [],
      pre: [],
    });
  });

  it('never submits a consume task while a protected item could be handed in', () => {
    // logWood is an ore dictionary name: the agent cannot rule out that a diamond is in it.
    const withDiamond = validate({ type: 'SUBMIT_QUEST', args: { questId: '0:2' } });
    expect(withDiamond.codes).toEqual(['PROTECTED_ITEM']);
    const noDiamond = stateWith(QUESTS, { 'minecraft:log': 4, 'minecraft:bread': 6 });
    expect(validate({ type: 'SUBMIT_QUEST', args: { questId: '0:2' } }, noDiamond).ok).toBe(true);
    // Protecting logs themselves (any damage counts as the same item) refuses it too.
    const ctx = safetyCtx();
    const logsProtected = {
      ...ctx,
      protectedItems: new Set([...ctx.protectedItems, 'minecraft:log']),
    };
    const birch = stateWith(QUESTS, { 'minecraft:log@2': 4 });
    expect(
      validate({ type: 'SUBMIT_QUEST', args: { questId: '0:2' } }, birch, logsProtected).codes,
    ).toEqual(['PROTECTED_ITEM']);
    // A task that only looks at the inventory never takes anything: the diamond does not matter.
    expect(validate({ type: 'SUBMIT_QUEST', args: { questId: '0:0' } }).ok).toBe(true);
  });

  it('is refused in danger like any other action', () => {
    const base = stateWith();
    if (!base.nearbyThreats.known) throw new Error('fixture');
    const danger = {
      ...base,
      nearbyThreats: {
        known: true as const,
        value: { ...base.nearbyThreats.value, hostileCount: 1, nearestHostileDistance: 3 },
      },
    };
    expect(
      validate({ type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: 0 } }, danger).codes,
    ).toEqual(['ACTION_NOT_ALLOWED_IN_DANGER']);
  });
});

describe('quest-book actions: preconditions', () => {
  it('ticks only an unticked checkbox task', () => {
    expect(validate({ type: 'CHECK_QUEST_BOX', args: { questId: '0:0', taskIndex: 1 } }).ok).toBe(
      true,
    );
    expect(
      validate({ type: 'CHECK_QUEST_BOX', args: { questId: '0:0', taskIndex: 0 } }).pre,
    ).toEqual(['task 0 of "Quest 0:0" is bq_standard:retrieval, not a checkbox']);
    expect(
      validate({ type: 'CHECK_QUEST_BOX', args: { questId: '0:0', taskIndex: 7 } }).pre,
    ).toEqual(['"Quest 0:0" lists no task 7']);
  });

  it('claims a completed quest once, with a valid choice and room for the rewards', () => {
    expect(validate({ type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: 1 } }).ok).toBe(
      true,
    );
    expect(
      validate({ type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: null } }).pre,
    ).toEqual(['"Quest 0:5" has a choice reward: choose one of its 2 items (0-1)']);
    expect(validate({ type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: 2 } }).ok).toBe(
      false,
    );
    expect(
      validate({ type: 'CLAIM_QUEST_REWARD', args: { questId: '0:0', choice: null } }).pre,
    ).toEqual(['"Quest 0:0" is not completed']);
    // 5 coins and 10 planks: one slot each in stacks of 16, plus two spare = 4 free slots.
    const full = stateWith(QUESTS, { 'minecraft:bread': 6 }, 33);
    expect(
      validate({ type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: 0 } }, full).pre,
    ).toEqual([
      'the rewards of "Quest 0:5" need 4 free inventory slots and 3 are free (rewards that do not fit are dropped)',
    ]);
    const claimed = stateWith([quest('0:5', { active: false, completed: true, claimed: true })]);
    expect(
      validate({ type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: null } }, claimed).pre,
    ).toEqual(['the rewards of "Quest 0:5" are already claimed']);
  });
});

describe('quest-book actions: verification against the server records', () => {
  const verify = (spec: ActionSpec, before: GameState, after: GameState) =>
    verifyPostcondition({
      action: action(spec),
      before,
      after,
      execution: { ok: true, code: 'OK', message: 'ok', data: {} },
      ctx: safetyCtx(),
    });

  it('a submit is verified by the quest completing, and only consume items may leave', () => {
    const before = stateWith(QUESTS, { 'minecraft:log@2': 3, 'minecraft:bread': 6 });
    const done = [quest('0:2', { active: false, completed: true })];
    const ok = verify(
      { type: 'SUBMIT_QUEST', args: { questId: '0:2' } },
      before,
      stateWith(done, { 'minecraft:log@2': 1, 'minecraft:bread': 6 }),
    );
    expect(ok.verified).toBe(true);
    const greedy = verify(
      { type: 'SUBMIT_QUEST', args: { questId: '0:2' } },
      before,
      stateWith(done, { 'minecraft:log@2': 1, 'minecraft:bread': 5 }),
    );
    expect(greedy.verified).toBe(false);
    expect(greedy.checks.find((c) => c.name === 'only-handed-in-items')?.detail).toBe(
      'items left that no consume task asks for: minecraft:bread -1',
    );
    const notDone = verify({ type: 'SUBMIT_QUEST', args: { questId: '0:2' } }, before, before);
    expect(notDone.checks.find((c) => c.name === 'quest-completed')).toMatchObject({
      passed: false,
    });
  });

  it('a claim is verified by the server record and exactly the reward items', () => {
    const before = stateWith(QUESTS, { 'minecraft:bread': 6 });
    const claimed = [quest('0:5', { active: false, completed: true, claimed: true })];
    const spec: ActionSpec = { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: 1 } };
    expect(
      verify(
        spec,
        before,
        stateWith(claimed, {
          'minecraft:bread': 6,
          'dreamcraft:item.CoinSmith': 5,
          'minecraft:cookie': 1,
        }),
      ).verified,
    ).toBe(true);
    const wrongChoice = verify(
      spec,
      before,
      stateWith(claimed, {
        'minecraft:bread': 6,
        'dreamcraft:item.CoinSmith': 5,
        'minecraft:planks': 10,
      }),
    );
    expect(wrongChoice.verified).toBe(false);
    const dropped = verify(
      spec,
      before,
      stateWith(claimed, { 'minecraft:bread': 6, 'minecraft:cookie': 1 }),
    );
    expect(dropped.checks.find((c) => c.name === 'reward-items')?.passed).toBe(false);
  });

  it('a checkbox is verified by the task (or the whole quest) being done', () => {
    const spec: ActionSpec = { type: 'CHECK_QUEST_BOX', args: { questId: '0:0', taskIndex: 1 } };
    const ticked = QUESTS.map((q) =>
      q.id === '0:0' ? { ...q, tasks: q.tasks.map((t) => ({ ...t, complete: t.index === 1 })) } : q,
    );
    expect(verify(spec, stateWith(), stateWith(ticked)).verified).toBe(true);
    expect(verify(spec, stateWith(), stateWith()).verified).toBe(false);
    expect(
      verify(spec, stateWith(), stateWith([quest('0:0', { active: false, completed: true })]))
        .verified,
    ).toBe(true);
  });
});

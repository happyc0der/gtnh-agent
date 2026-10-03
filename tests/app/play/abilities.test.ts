import { describe, expect, it } from 'vitest';
import { liveAbilities } from '../../../src/app/play/play.ts';
import type { QuestBookQuest } from '../../../src/domain/quest-book.ts';
import { AGE0_QUESTS } from '../../../src/goals/age0-quests.ts';
import { isDoable, nextGoal, type Quest } from '../../../src/goals/quest-goals.ts';

const quest = (name: string): Quest => {
  const q = AGE0_QUESTS.find((x) => x.name === name);
  if (q === undefined) throw new Error(`no quest ${name}`);
  return q;
};

/** The server's record of a quest that is active and unlocked, nothing done yet. */
const active = (q: Quest): QuestBookQuest => ({
  id: q.id,
  name: q.name,
  active: true,
  unlocked: true,
  completed: false,
  claimed: false,
  taskLogic: q.taskLogic,
  tasks: q.tasks.map((t) => ({
    index: t.index,
    type: t.type,
    complete: false,
    consume: t.consume,
    items: t.items,
    progress: t.items.map(() => 0),
  })),
  rewards: [],
});

// Building the abilities reads the knowledge base: a moment on a busy machine.
describe("play's abilities: 3x3 recipes with a table it can use", { timeout: 30_000 }, () => {
  const noTable = liveAbilities({ configured: false, placing: false });
  const placing = liveAbilities({ configured: false, placing: true });
  const configured = liveAbilities({ configured: true, placing: false });

  it('"Tools" and "Monster Hunter" need one: configured, or held or made, and placed', () => {
    for (const name of ['Tools', 'Monster Hunter']) {
      expect(isDoable(quest(name), noTable), name).toBe(false);
      expect(isDoable(quest(name), placing), name).toBe(true);
      expect(isDoable(quest(name), configured), name).toBe(true);
    }
    // GTNH's crafting table is a 2x2 recipe: doable either way.
    expect(isDoable(quest('Crafting Time'), noTable)).toBe(true);
    // What the recipes make from what is gathered, not every recipe's output: no torches
    // (coal is not gathered), no furnace (cobblestone needs a pickaxe and a dig of stone).
    expect(placing.craft.has('minecraft:wooden_pickaxe')).toBe(true);
    expect(placing.craft.has('minecraft:torch')).toBe(false);
    expect(placing.craft.has('minecraft:furnace')).toBe(false);
  });

  it('after "Crafting Time" the next quest is "Tools" (seen live: "no quest the agent can do is left")', () => {
    const server = new Map([quest('Tools'), quest('Monster Hunter')].map((q) => [q.id, active(q)]));
    const inventory = { 'minecraft:log': 6, 'minecraft:flint': 2, 'minecraft:crafting_table': 1 };
    expect(nextGoal(AGE0_QUESTS, server, inventory, noTable)).toBeNull();
    const goal = nextGoal(AGE0_QUESTS, server, inventory, placing);
    expect(goal?.quest.name).toBe('Tools');
    expect(goal?.requirements).toEqual({
      'minecraft:wooden_pickaxe': 1,
      'minecraft:wooden_shovel': 1,
      'minecraft:wooden_axe': 1,
      'minecraft:wooden_hoe': 1,
    });
  });
});

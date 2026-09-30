/**
 * Goals for autonomous play, from GTNH's quest book: which quest to work on next, what is
 * still missing, and which quests are done. The agent tracks its own completions (claiming
 * in the quest book is a GUI action): a quest counts as done once its prerequisites are
 * done and every required task is satisfied.
 *
 *  - checkbox tasks are satisfied at once (in game they are a click in the quest book);
 *  - retrieval tasks are satisfied when the inventory holds the items;
 *  - crafting tasks are satisfied when the inventory holds the crafted items (an
 *    approximation: the quest book counts crafts, the agent keeps what it crafts);
 *  - optional_retrieval tasks never block a quest; other task types (hunt, location,
 *    fluid, ...) are beyond the agent's abilities, so those quests are never picked.
 */

export interface QuestItem {
  /** Registry name, with @damage when the quest needs a specific non-zero damage. */
  item: string;
  count: number;
  /** An ore dictionary name the quest also accepts (not resolvable by the agent). */
  oreDict: string | null;
  /** Any damage value accepted (quest damage 32767). */
  anyDamage: boolean;
}

export interface QuestTask {
  type: string;
  consume: boolean;
  items: QuestItem[];
}

export interface Quest {
  /** questIDHigh:questIDLow, exact. */
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  /** Better Questing quest logic for prerequisites: AND (all) or OR (any). */
  prerequisiteLogic: string;
  /** A main quest (the quest book draws it larger). */
  main: boolean;
  tasks: QuestTask[];
  layout: { x: number; y: number };
}

export const TASK = {
  retrieval: 'bq_standard:retrieval',
  crafting: 'bq_standard:crafting',
  checkbox: 'bq_standard:checkbox',
  optionalRetrieval: 'bq_standard:optional_retrieval',
} as const;

/** What the agent can obtain today, by registry name (damage ignored). */
export interface Abilities {
  /** Items it can gather (dig, pick up). */
  gather: ReadonlySet<string>;
  /** Items it can craft (inputs permitting). */
  craft: ReadonlySet<string>;
}

/** Items the digging ability yields from its allowlisted blocks. */
export const BASE_ABILITIES: Abilities = {
  gather: new Set([
    'minecraft:gravel',
    'minecraft:sand',
    'minecraft:dirt',
    'minecraft:clay_ball',
    'minecraft:flint',
    'minecraft:log',
    'minecraft:sapling',
    'minecraft:cobblestone',
  ]),
  craft: new Set(),
};

const base = (item: string): string => item.replace(/@\d+$/, '');

/** How many of a quest item the inventory holds (any damage when the quest allows it). */
export function held(inventory: Readonly<Record<string, number>>, q: QuestItem): number {
  if (!q.anyDamage) return inventory[q.item] ?? 0;
  return Object.entries(inventory)
    .filter(([name]) => base(name) === base(q.item))
    .reduce((n, [, c]) => n + c, 0);
}

/** The tasks that decide completion (optional retrieval never does). */
export function requiredTasks(quest: Quest): QuestTask[] {
  return quest.tasks.filter((t) => t.type !== TASK.optionalRetrieval);
}

/** Items still missing for the quest's required item tasks (empty = satisfied). */
export function missingItems(
  quest: Quest,
  inventory: Readonly<Record<string, number>>,
): Record<string, number> {
  const missing: Record<string, number> = {};
  for (const task of requiredTasks(quest)) {
    if (task.type !== TASK.retrieval && task.type !== TASK.crafting) continue;
    for (const q of task.items) {
      const need = q.count - held(inventory, q);
      if (need > 0) missing[q.item] = (missing[q.item] ?? 0) + need;
    }
  }
  return missing;
}

function taskSatisfiable(task: QuestTask, abilities: Abilities): boolean {
  const can = (i: QuestItem, sets: ReadonlySet<string>[]): boolean =>
    sets.some((s) => s.has(base(i.item)));
  switch (task.type) {
    case TASK.checkbox:
      return true;
    case TASK.retrieval:
      return (
        task.items.length > 0 &&
        task.items.every((i) => can(i, [abilities.gather, abilities.craft]))
      );
    case TASK.crafting:
      return task.items.length > 0 && task.items.every((i) => can(i, [abilities.craft]));
    default:
      return false;
  }
}

/** True when the agent's abilities cover every required task. */
export function isDoable(quest: Quest, abilities: Abilities = BASE_ABILITIES): boolean {
  return requiredTasks(quest).every((t) => taskSatisfiable(t, abilities));
}

/** True when every required task is satisfied now (checkboxes always are). */
export function tasksSatisfied(quest: Quest, inventory: Readonly<Record<string, number>>): boolean {
  const known = requiredTasks(quest).every((t) =>
    [TASK.checkbox, TASK.retrieval, TASK.crafting].includes(t.type as never),
  );
  return known && Object.keys(missingItems(quest, inventory)).length === 0;
}

export function prerequisitesMet(
  quest: Quest,
  completed: ReadonlySet<string>,
  known: ReadonlySet<string>,
): boolean {
  // Prerequisites outside this quest line (other chapters) cannot be tracked: treat as met.
  const relevant = quest.prerequisites.filter((p) => known.has(p));
  if (relevant.length === 0) return true;
  return quest.prerequisiteLogic.toUpperCase() === 'OR'
    ? relevant.some((p) => completed.has(p))
    : relevant.every((p) => completed.has(p));
}

/**
 * Quests that complete now, given what is already completed and what the inventory holds,
 * repeated until nothing more completes (a checkbox can unlock a quest that is already
 * satisfied). Returns only the newly completed ids, in completion order.
 */
export function newlyCompleted(
  quests: readonly Quest[],
  completed: ReadonlySet<string>,
  inventory: Readonly<Record<string, number>>,
): string[] {
  const known = new Set(quests.map((q) => q.id));
  const done = new Set(completed);
  const added: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const q of quests) {
      if (done.has(q.id) || !prerequisitesMet(q, done, known) || !tasksSatisfied(q, inventory)) {
        continue;
      }
      done.add(q.id);
      added.push(q.id);
      changed = true;
    }
  }
  return added;
}

/** Longest chain of in-line prerequisites below each quest (0 for a root). */
export function questDepths(quests: readonly Quest[]): Map<string, number> {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const depth = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const d = depth.get(id);
    if (d !== undefined) return d;
    if (stack.has(id)) return 0; // a cycle in the data: cut it
    stack.add(id);
    const q = byId.get(id);
    const pre = q ? q.prerequisites.filter((p) => byId.has(p)) : [];
    const value = pre.length === 0 ? 0 : 1 + Math.max(...pre.map((p) => visit(p, stack)));
    stack.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const q of quests) visit(q.id, new Set());
  return depth;
}

export interface Goal {
  quest: Quest;
  missing: Record<string, number>;
  /** The quest as a task goal (stable; at most 300 characters, the task goal limit). */
  text: string;
  /** What is still missing, or null when the items are all held. */
  subgoal: string | null;
}

/** The quest's requirement in one line: "Age 0 quest "X": have 128 minecraft:sand". */
export function goalText(quest: Quest): string {
  const parts = requiredTasks(quest).flatMap((t) => {
    const list = t.items.map((i) => `${i.count} ${i.item}`).join(', ');
    if (t.type === TASK.retrieval) return [`have ${list}`];
    if (t.type === TASK.crafting) return [`craft ${list}`];
    return [];
  });
  const want = parts.length === 0 ? 'claim it in the quest book' : parts.join('; ');
  return `Age 0 quest "${quest.name}": ${want}`.slice(0, 300);
}

export function missingText(missing: Record<string, number>): string | null {
  const list = Object.entries(missing).map(([item, n]) => `${n} ${item}`);
  return list.length === 0 ? null : `still missing: ${list.join(', ')}`.slice(0, 300);
}

/**
 * The next quest to work on: not completed, prerequisites met, doable with the agent's
 * abilities; shallowest first (closest to the start of the book), main quests before side
 * quests, then quest-book layout. Null when nothing doable is left.
 */
export function nextGoal(
  quests: readonly Quest[],
  completed: ReadonlySet<string>,
  inventory: Readonly<Record<string, number>>,
  abilities: Abilities = BASE_ABILITIES,
): Goal | null {
  const known = new Set(quests.map((q) => q.id));
  const depth = questDepths(quests);
  const candidates = quests
    .filter(
      (q) =>
        !completed.has(q.id) && isDoable(q, abilities) && prerequisitesMet(q, completed, known),
    )
    .sort(
      (a, b) =>
        (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) ||
        Number(b.main) - Number(a.main) ||
        a.layout.y - b.layout.y ||
        a.layout.x - b.layout.x,
    );
  const quest = candidates[0];
  if (quest === undefined) return null;
  const missing = missingItems(quest, inventory);
  return { quest, missing, text: goalText(quest), subgoal: missingText(missing) };
}

export interface QuestProgress {
  total: number;
  completed: number;
  main: { total: number; completed: number };
  /** Quests the agent's abilities cover (whether or not they are unlocked yet). */
  doable: number;
}

export function questProgress(
  quests: readonly Quest[],
  completed: ReadonlySet<string>,
  abilities: Abilities = BASE_ABILITIES,
): QuestProgress {
  const mains = quests.filter((q) => q.main);
  return {
    total: quests.length,
    completed: quests.filter((q) => completed.has(q.id)).length,
    main: { total: mains.length, completed: mains.filter((q) => completed.has(q.id)).length },
    doable: quests.filter((q) => isDoable(q, abilities)).length,
  };
}

import { heldOf } from '../../domain/common.ts';
import type { GameState, WorldTime } from '../../domain/game-state.ts';
import {
  missingText,
  questView,
  serverQuests,
  type Abilities,
  type Quest,
  type QuestBookStep,
} from '../../goals/quest-goals.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import type { SessionResult } from '../loop/live-session.ts';
import { stepFailureOf } from './command-base.ts';
import { foodDue, type FoodStatus } from './food.ts';
import { planOf } from './narration.ts';
import { isDark, nightReason, nightSoon } from './night.ts';
import {
  commandWaiting,
  CONTINUE_AFTER,
  done,
  mobPause,
  waitOutMob,
  type PlayState,
} from './play-state.ts';
import type { FreeGoal, PlayResult } from './play.ts';
import {
  adoptGoal,
  freeSlotsOf,
  questTaskId,
  updateQuests,
  type QuestUpdate,
} from './quest-progress.ts';

/**
 * The goal round, play's usual round (runPlay in play.ts): what to work on, the player's own
 * goal or the next quest by the server's quest book (the quest-book clicks that are due come
 * first); whether it is stuck; and one session on it, and what follows the session.
 */

/**
 * What `requirements` still needs beyond `inventory` (item -> missing count); of the items in
 * `anyKind`, every kind held counts (FreeGoal.anyKind).
 */
export function missingFor(
  requirements: Readonly<Record<string, number>>,
  inventory: Readonly<Record<string, number>>,
  anyKind: readonly string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [item, n] of Object.entries(requirements)) {
    const need = n - heldOf(inventory, item, anyKind.includes(item));
    if (need > 0) out[item] = need;
  }
  return out;
}

/** Makes a free goal the current task, with its requirements (the planner's route). */
function adoptFreeGoal(
  repos: Repositories,
  goal: FreeGoal,
  missing: Record<string, number>,
): { taskId: string; created: boolean; status: string } {
  const existing = repos.tasks.get(goal.taskId);
  const task = repos.transaction(() => {
    const t = repos.tasks.ensure({
      id: goal.taskId,
      goal: goal.name.slice(0, 300),
      subgoal: missingText(missing),
      status: 'active',
    });
    repos.memory.setTaskRequirements(goal.taskId, { ...goal.requirements }, goal.anyKind);
    if (t.status === 'active') repos.memory.setValue(CURRENT_TASK_KEY, goal.taskId);
    return t;
  });
  return { taskId: goal.taskId, created: existing === null, status: task.status };
}

/** The goal is held: its task completes and stops being current. */
export function reachGoal(repos: Repositories, goal: FreeGoal): void {
  repos.transaction(() => {
    if (repos.tasks.get(goal.taskId) !== null) repos.tasks.setStatus(goal.taskId, 'completed');
    if (repos.memory.getValue(CURRENT_TASK_KEY) === goal.taskId) {
      repos.memory.setValue(CURRENT_TASK_KEY, null);
    }
    repos.memory.appendJournal(goal.taskId, `GOAL "${goal.name}" reached`);
  });
}

function hungerReason(s: FoodStatus): string {
  return `hungry (food ${s.hunger}/20) with nothing to eat: getting food first`;
}

export const total = (missing: Record<string, number>): number =>
  Object.values(missing).reduce((n, c) => n + c, 0);

/**
 * A quest-book click that failed (or was refused, e.g. in danger) this many times in a row is
 * not tried again until a session has run. The executor's repeated-failure rule still caps
 * clicks the server did not honour.
 */
const MAX_CLICK_FAILURES = 2;

/**
 * Better Questing completes a quest whose tasks are done in its quest loop, every 60 of the
 * player's ticks (3 s): with nothing else to do, play waits this long for it, this many times.
 */
const QUEST_LOOP_WAIT_MS = 3_000;
const MAX_QUEST_LOOP_WAITS = 5;

const clickKey = (s: QuestBookStep): string => `${s.spec.type} ${JSON.stringify(s.spec.args)}`;

/**
 * By an observation: the quest is completed, or quest-book clicks finish it now (null when
 * the observation does not show the quest book and the inventory).
 */
function questMet(quest: Quest, after: GameState, abilities: Abilities): boolean | null {
  if (!after.questBook.known || !after.inventory.known) return null;
  const view = questView(
    quest,
    serverQuests(after.questBook.value),
    after.inventory.value.items,
    abilities,
  );
  return view.completed || view.completableNow;
}

/** What play works on this round: the player's own goal, or the next quest. */
export interface RoundGoal {
  id: string;
  name: string;
  text: string;
  missing: Record<string, number>;
  /** Met by the observation after a cycle (null: it does not tell). */
  met: (after: GameState) => boolean | null;
  adopt: () => { taskId: string; created: boolean; status: string };
}

/**
 * The round's goal and one session on it, unless play ends first (the goal reached, no quest
 * left, a task that needs a human, no progress) or a quest-book click or a wait for the
 * server's quest loop takes the round.
 */
export async function goalRound(play: PlayState): Promise<PlayResult | 'next-round'> {
  // What to work on this round: the player's own goal, or the next quest.
  const current =
    play.deps.goal !== undefined ? await freeGoal(play, play.deps.goal) : await nextQuest(play);
  if (current === 'next-round' || 'stopReason' in current) return current;
  return stuckOn(play, current) ?? (await goalSession(play, current));
}

/** The player's own goal, by the inventory: play ends once the goal is held. */
async function freeGoal(play: PlayState, free: FreeGoal): Promise<RoundGoal | PlayResult> {
  const { deps } = play;
  const inventory = await deps.inventory();
  if (inventory === null) return done(play, 'the inventory is unknown, so progress is unknown');
  const missing = missingFor(free.requirements, inventory, free.anyKind);
  if (total(missing) === 0) {
    reachGoal(deps.repos, free);
    return done(play, `the goal "${free.name}" is reached`);
  }
  return freeRoundGoal(deps.repos, free, missing);
}

/**
 * A goal of items to have as a round's goal (`cli play --needs`, an owner's `get` or `mine`):
 * met once the inventory holds them; its task is adopted with the items as requirements.
 */
export function freeRoundGoal(
  repos: Repositories,
  free: FreeGoal,
  missing: Record<string, number>,
): RoundGoal {
  return {
    id: free.taskId,
    name: free.name,
    text: free.name,
    missing,
    met: (after) =>
      after.inventory.known
        ? total(missingFor(free.requirements, after.inventory.value.items, free.anyKind)) === 0
        : null,
    adopt: () => adoptFreeGoal(repos, free, missing),
  };
}

/**
 * The next quest, by the server's quest book: the quests it now records as completed are
 * noted, a quest-book click that is due takes the round, and so does a wait for the server's
 * quest loop. Play ends when no quest the agent can do is left, saying why.
 */
async function nextQuest(play: PlayState): Promise<RoundGoal | PlayResult | 'next-round'> {
  const { deps, abilities, quests, now, emit, sleep } = play;
  if (deps.questBook === undefined) {
    return done(
      play,
      "quest goals need the server's quest book (Better Questing), and none is read",
    );
  }
  const observed = await deps.questBook();
  if (!observed.questBook.known) {
    return done(
      play,
      `the server's quest book is unknown (${observed.questBook.reason}); quests count ` +
        'only as the server records them',
    );
  }
  if (!observed.inventory.known) {
    return done(play, 'the inventory is unknown, so progress is unknown');
  }
  const update = updateQuests(
    deps.repos,
    observed.questBook.value,
    { items: observed.inventory.value.items, freeSlots: freeSlotsOf(observed) },
    abilities,
    quests,
    new Date(now()),
  );
  play.progress = update.progress;
  for (const q of update.added) {
    play.questsCompleted.push(q.name);
    deps.repos.memory.appendJournal(`quest-${q.id}`, `QUEST "${q.name}" completed`);
    emit({
      kind: 'quest-completed',
      quest: q.name,
      completed: update.progress.completed,
      total: update.progress.total,
    });
  }

  if (await questBookClick(play, update)) return 'next-round';

  const goal = update.next;
  if (goal === null && update.pending.length > 0 && play.loopWaits < MAX_QUEST_LOOP_WAITS) {
    // Tasks all done: the server's quest loop completes the quest within a few seconds.
    play.loopWaits += 1;
    await sleep(QUEST_LOOP_WAIT_MS);
    return 'next-round';
  }
  play.loopWaits = 0;
  if (goal === null) {
    const due = update.clicks.map((c) => c.reason).slice(0, 3);
    const notes =
      due.length === 0
        ? []
        : deps.questAction === undefined
          ? [
              `${update.clicks.length} quest-book click(s) are due and quest-book clicks ` +
                `are off (MC_ENABLE_QUEST_BOOK): ${due.join('; ')}`,
            ]
          : [`quest-book clicks failed ${MAX_CLICK_FAILURES} times: ${due.join('; ')}`];
    const waiting = update.waiting.map((w) => w.reason).slice(0, 3);
    const pending = update.pending.map(
      (q) => `the server has not completed "${q.name}" although its tasks are done`,
    );
    return done(
      play,
      ['no quest the agent can do is left', ...notes, ...waiting, ...pending.slice(0, 3)].join(
        '; ',
      ),
    );
  }
  return {
    id: goal.quest.id,
    name: goal.quest.name,
    text: goal.text,
    missing: goal.missing,
    met: (after) => questMet(goal.quest, after, abilities),
    adopt: () => adoptGoal(deps.repos, goal),
  };
}

/**
 * Quest-book clicks first, one per round: decided here from the server's records. Makes the
 * first due click that has not failed MAX_CLICK_FAILURES times, when quest-book clicks are on
 * (deps.questAction); true when it made one.
 */
async function questBookClick(play: PlayState, update: QuestUpdate): Promise<boolean> {
  const { deps, emit, failedClicks } = play;
  const act = deps.questAction;
  const click = update.clicks.find(
    (c) => (failedClicks.get(clickKey(c)) ?? 0) < MAX_CLICK_FAILURES,
  );
  if (act !== undefined && click !== undefined) {
    const r = await act(click.spec, click.reason, questTaskId(click.quest.id));
    const ok = r.status === 'succeeded';
    if (!ok) failedClicks.set(clickKey(click), (failedClicks.get(clickKey(click)) ?? 0) + 1);
    emit({
      kind: 'quest-book',
      quest: click.quest.name,
      action: click.spec.type,
      ok,
      detail: r.outcome?.execution?.message ?? r.summary,
    });
    return true;
  }
  return false;
}

/**
 * Progress is fewer missing items for the same goal (read from the inventory, not from what
 * a session claims); moving to another goal resets the count. Play ends after
 * maxStuckSessions sessions in a row without progress on the same goal.
 */
function stuckOn(play: PlayState, current: RoundGoal): PlayResult | null {
  const missingNow = total(current.missing);
  const { last } = play;
  if (last !== null && last.questId === current.id) {
    // Seeing new ground is progress too: exploring for a block not seen yet gathers none.
    // Progress always counts; a session with none that a new command, dusk or hunger cut short
    // counts no failure (an independent review, 2026-10-05: three quick !status whispers failed a !get for "no progress in 3 sessions").
    if (missingNow < last.missing || play.explored) last.stuck = 0;
    else if (last.cutShort !== true) last.stuck += 1;
    last.cutShort = false;
    last.missing = missingNow;
    if (last.stuck >= play.limits.maxStuckSessions) {
      return done(
        play,
        `no progress on "${current.name}" in ${last.stuck} sessions in a row (last: ${play.lastStop})`,
      );
    }
  } else {
    play.last = { questId: current.id, missing: missingNow, stuck: 0 };
  }
  return null;
}

/**
 * One session on the goal, its task adopted first (a task that is not active needs a human).
 * The session also ends as soon as an observation shows the quest's items are all held, so
 * the planner is never asked to do what is already done; or that the agent is hungry with
 * nothing to eat (the next round gets food); or that it is shelter time.
 */
async function goalSession(
  play: PlayState,
  current: RoundGoal,
): Promise<PlayResult | 'next-round'> {
  const adopted = current.adopt();
  if (adopted.status !== 'active') {
    return done(
      play,
      `the task ${adopted.taskId} for "${current.name}" is ${adopted.status}; ` +
        'it needs you (plan-approve, task-resume) before play goes on',
    );
  }
  play.emit({
    kind: 'goal',
    quest: current.name,
    goal: current.text,
    missing: current.missing,
    taskId: adopted.taskId,
    created: adopted.created,
  });
  if (play.wakeNote !== null) {
    play.deps.repos.memory.appendJournal(adopted.taskId, play.wakeNote);
    play.wakeNote = null;
  }
  const ended = await runGoalSession(play, current, foodDue);
  return afterGoalSession(play, adopted.taskId, ended);
}

/** How a goal's session ended (runGoalSession). */
export interface GoalSessionEnd {
  result: SessionResult;
  /** An observation showed the goal met. */
  met: boolean;
  /** Shelter time (or dark, without shelters) ended it. */
  dark: WorldTime | null;
  /** Hunger with nothing to eat ended it (`hungerEnds`). */
  hungry: FoodStatus | null;
  /** An owner's new command ended it: commands come before the goal (commands.ts). */
  preempted: string | null;
  /** The session's last step that did not go, in the client's or the rules' words, or null. */
  stepFailure: string | null;
}

/**
 * One bounded session on a goal whose task is adopted and current. It ends as soon as an
 * observation shows the goal met (so the planner is never asked to do what is already done),
 * at shelter time, when `hungerEnds` says the agent must get food first (a quest: hungry with
 * nothing to eat, foodDue; an owner's goal: only a food bar nearly empty, starving), or when
 * an owner's new command is waiting.
 */
export async function runGoalSession(
  play: PlayState,
  current: RoundGoal,
  hungerEnds: (s: FoodStatus) => boolean,
): Promise<GoalSessionEnd> {
  const { deps, limits, hooks, emit } = play;
  let met = false;
  let dark: WorldTime | null = null;
  let hungry: FoodStatus | null = null;
  let preempted: string | null = null;
  let stepFailure: string | null = null;
  const session = play.sessions + 1;
  const seenBefore = deps.scouting?.chunksSeen() ?? null;
  const result = await deps.session(limits.session, {
    stopRequested: () =>
      met
        ? `"${current.name}" is satisfied`
        : dark !== null
          ? nightReason(dark)
          : hungry !== null
            ? hungerReason(hungry)
            : ((preempted ??= commandWaiting(play)) ?? hooks.stopRequested()),
    // A cycle's own observation too, before anyone decides: the server completes a
    // crafting task on the craft and sends it a moment after the craft's own observation
    // (seen live: the third flint crafted, the next cycle asked the planner, which said
    // the task was done and paused play).
    stopOnState: (state) => {
      const metNow = current.met(state);
      if (metNow !== null) met = metNow;
      return met ? `"${current.name}" is satisfied` : null;
    },
    onCycle: (r, index) => {
      play.lastDecision = r.decision ?? null;
      stepFailure = stepFailureOf(r) ?? stepFailure;
      emit({
        kind: 'cycle',
        session,
        index,
        summary: r.summary,
        decision:
          r.decision === null || r.decision === undefined
            ? null
            : {
                provider: r.decision.provider,
                decision: r.decision.decision,
                reasons: r.decision.reasonCodes,
                confidence: r.decision.confidence,
              },
        newPlan: r.planner?.kind === 'plan-accepted' ? planOf(deps.repos, r.planner.planId) : null,
        detail: r.outcome?.execution?.message ?? null,
      });
      const after = r.outcome?.stateAfter;
      const metNow = after === undefined || after === null ? null : current.met(after);
      if (metNow !== null) met = metNow;
      // Shelter time (or dark, without shelters) ends the session in time to act on it.
      if (
        after?.time.known === true &&
        (deps.shelter === undefined ? isDark(after.time.value) : nightSoon(after.time.value))
      ) {
        dark = after.time.value;
      }
      // So does food time (by day: at dusk the shelter comes first).
      const fedNow = after === undefined || after === null ? null : (deps.food?.of(after) ?? null);
      if (fedNow !== null && dark === null && hungerEnds(fedNow)) hungry = fedNow;
    },
  });
  play.sessions = session;
  play.lastStop = result.stopReason;
  play.explored = seenBefore !== null && (deps.scouting?.chunksSeen() ?? 0) > seenBefore;
  // The world has moved on (a mob gone, items gathered): failed clicks may be tried again.
  play.failedClicks.clear();
  emit({
    kind: 'session-end',
    session,
    stopKind: result.stopKind,
    stopReason: result.stopReason,
    cycles: result.cycles.length,
    system1: result.system1,
  });
  return { result, met, dark, hungry, preempted, stepFailure };
}

/**
 * What follows a session on the goal: the next round (the shelter at dusk, food when hungry,
 * more of the goal), or the end of play when the session stopped for the stop file / Ctrl+C,
 * a mob near home, or anything that needs a human.
 */
function afterGoalSession(
  play: PlayState,
  taskId: string,
  ended: GoalSessionEnd,
): PlayResult | 'next-round' {
  const { deps } = play;
  const { result, met, dark, hungry, preempted } = ended;
  if ((dark !== null || hungry !== null || preempted !== null) && play.last !== null) {
    play.last.cutShort = true;
  }
  // Interruptions are checkpoints too: the planner reads them in the task's journal.
  if (dark !== null || !['limit', 'task-finished'].includes(result.stopKind)) {
    deps.repos.memory.appendJournal(
      taskId,
      `interrupted: ${dark !== null ? nightReason(dark) : result.stopReason}`,
    );
  }
  // A mob pause first: only its offline wait sets the task (which the pause left paused) active
  // again; dusk or hunger seen in the same session wait for the next play (an independent
  // review, 2026-10-04: a pause whose cycle first saw dusk left the task needing a person).
  const mob = mobPause(result.stopKind, play.lastDecision);
  if (mob !== null) return waitOutMob(play, taskId, mob);
  if (dark !== null) {
    if (deps.shelter === undefined) return done(play, nightReason(dark), dark);
    return 'next-round'; // the next round builds the shelter
  }
  if (hungry !== null && result.stopKind === 'stop-requested') return 'next-round'; // the next round gets food
  // An owner's command comes first; the goal goes on after it.
  if (preempted !== null && result.stopKind === 'stop-requested') return 'next-round';
  if (result.stopKind === 'stop-requested' && !met) return done(play, result.stopReason);
  if (!CONTINUE_AFTER.has(result.stopKind)) return done(play, result.stopReason);
  return 'next-round';
}

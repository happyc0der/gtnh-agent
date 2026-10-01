import {
  BASE_ABILITIES,
  type Abilities,
  type Quest,
  type QuestBookStep,
  type QuestProgress,
} from '../../goals/quest-goals.ts';
import { needsCraftingTable, RECIPE_IDS, RECIPES } from '../../domain/recipes.ts';
import type { GameState, WorldTime } from '../../domain/game-state.ts';
import type { ShelterStatus } from '../../goals/shelter.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import type { System1Stats } from '../../system1/model-cadence.ts';
import type { CycleResult } from '../loop/agent-loop.ts';
import {
  checkLimits,
  DEFAULT_SESSION_LIMITS,
  type SessionLimits,
  type SessionResult,
  type SessionStopKind,
} from '../loop/live-session.ts';
import { scoutingRound, type Scouting } from './scouting.ts';
import { foodRound, type FoodStatus } from './food.ts';
import { morningRound, nightRound } from './night.ts';
import { goalRound } from './goal-round.ts';
import { done, startPlay, type PlayState } from './play-state.ts';

/**
 * Autonomous play: the agent works through the Age 0 quest book by itself. Each round it
 * reads the SERVER's quest book (Better Questing) and the inventory, records the quests the
 * server now lists as completed, makes the quest-book clicks that are due (claims, checkbox
 * ticks, submits: decided here in code, never by a model, each validated, executed and
 * verified like any action), then takes the next quest as its current task and runs one
 * bounded session on it. In the session the configured decision maker and planner choose
 * what to do; every action is still validated, executed and verified exactly like any
 * other. Between sessions it checks progress. Quests count only as the server records them.
 *
 * Hungry with nothing to eat, by day, it first goes and gets food (src/app/play/food.ts), as it
 * turns to a shelter at dusk; the quest goes on once about a day of food is carried.
 *
 * It stops, and says why, when:
 *  - no quest it can do is left, or its inventory or the server's quest book cannot be read;
 *  - a session asks for a human (an approval, a safety stop) or the quest's task was
 *    paused, blocked or closed by someone else (it never resumes those by itself), except
 *    a pause only for a mob near home: that it waits out (mobPause);
 *  - the same quest has made no progress for `maxStuckSessions` sessions in a row;
 *  - the time or session limit, the stop file or Ctrl+C.
 * A failed action or a safe detour (retreating, eating) does not stop it by itself: that
 * is part of playing, and the planner sees it in its recent history. A streak of sessions
 * without progress ends as "stuck".
 */
export interface PlayLimits {
  /** Hard cap on wall-clock time for the whole play (1-480 minutes). */
  maxMinutes: number;
  /** Hard cap on sessions (1-1000). */
  maxSessions: number;
  /** Sessions in a row without progress on the same quest before it gives up (1-20). */
  maxStuckSessions: number;
  /** Limits of each session (see live-session). */
  session: SessionLimits;
}

export const DEFAULT_PLAY_LIMITS: PlayLimits = {
  maxMinutes: 30,
  maxSessions: 100,
  maxStuckSessions: 3,
  session: DEFAULT_SESSION_LIMITS,
};

export function checkPlayLimits(limits: PlayLimits): string | null {
  if (!(limits.maxMinutes >= 1 && limits.maxMinutes <= 480)) return 'max minutes must be 1-480';
  if (
    !Number.isInteger(limits.maxSessions) ||
    limits.maxSessions < 1 ||
    limits.maxSessions > 1000
  ) {
    return 'max sessions must be 1-1000';
  }
  if (
    !Number.isInteger(limits.maxStuckSessions) ||
    limits.maxStuckSessions < 1 ||
    limits.maxStuckSessions > 20
  ) {
    return 'max stuck sessions must be 1-20';
  }
  return checkLimits(limits.session);
}

export interface PlayDeps {
  repos: Repositories;
  /** Reads the live inventory now, or null when it is unknown. */
  inventory: () => Promise<Readonly<Record<string, number>> | null>;
  /** Reads the world's clock now (null when unknown). Without it, play ignores the time. */
  time?: () => Promise<WorldTime | null>;
  /**
   * What a night shelter around the player still needs (null when unknown): at night
   * ('night') the shelter to make and its steps, in the morning ('morning') whether the
   * player is walled in and the way out. With it, play shelters at dusk and waits for the
   * morning inside; without it, play stops before dark.
   */
  shelter?: (purpose?: 'night' | 'morning') => Promise<ShelterStatus | null>;
  /** Waits (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A goal of the player's own instead of the quest book: items to have (item -> count).
   * Play pursues it like a quest (the planner gets its route) and ends when it is reached.
   */
  goal?: FreeGoal;
  /**
   * The server's quest book and the inventory, from one fresh observation. Quest goals need
   * it: a quest counts only once the server's quest book records it.
   */
  questBook?: () => Promise<Pick<GameState, 'questBook' | 'inventory'>>;
  /**
   * Makes one quest-book click the play loop chose (runQuestBookAction: validated, executed
   * and verified). Absent while quest-book clicks are off (MC_ENABLE_QUEST_BOOK).
   */
  questAction?: (
    spec: QuestBookStep['spec'],
    reason: string,
    taskId: string,
  ) => Promise<CycleResult>;
  /** Runs one bounded session on the current task (runSession on the live connection). */
  session: (
    limits: SessionLimits,
    hooks: {
      stopRequested: () => string | null;
      stopOnState?: (state: GameState) => string | null;
      onCycle: (result: CycleResult, index: number) => void;
    },
  ) => Promise<SessionResult>;
  abilities?: Abilities;
  quests?: readonly Quest[];
  /** Milliseconds since the epoch (injectable for tests). */
  now?: () => number;
  /**
   * Given when the agent can explore: play then begins by scouting the area once, while world
   * memory has seen little (src/app/play/scouting.ts).
   */
  scouting?: Scouting;
  /**
   * The food situation (hunger, food carried), now or in an observation a cycle made. Given
   * when the agent may eat: play then gets food when hungry with none carried (food.ts).
   */
  food?: {
    now: () => Promise<FoodStatus | null>;
    of: (state: GameState) => FoodStatus | null;
  };
}

export interface FreeGoal {
  /** The task id it is worked under (e.g. goal-minecraft:diamond-100). */
  taskId: string;
  /** Shown to the planner and in messages, e.g. "get 100 minecraft:diamond". */
  name: string;
  requirements: Readonly<Record<string, number>>;
}

export type PlayEvent =
  | { kind: 'quest-completed'; quest: string; completed: number; total: number }
  | { kind: 'scout'; taskId: string; chunksSeen: number; created: boolean }
  | {
      kind: 'goal';
      quest: string;
      goal: string;
      missing: Record<string, number>;
      taskId: string;
      created: boolean;
    }
  | {
      kind: 'cycle';
      session: number;
      index: number;
      summary: string;
      /** System 1's choice this cycle: which provider, the decision, and why. */
      decision: {
        provider: string;
        decision: string;
        reasons: string[];
        confidence: number;
      } | null;
      /** A plan the planner just made: its goal, explanation and steps (one line each). */
      newPlan: { goal: string; explanation: string; steps: string[] } | null;
      /** What the executor reported for the action, if one ran. */
      detail: string | null;
    }
  | { kind: 'night'; message: string }
  /** A food trip: why it began or ended. */
  | { kind: 'food'; message: string }
  | {
      /** A quest-book click play made itself (claim, checkbox, submit), and its outcome. */
      kind: 'quest-book';
      quest: string;
      action: string;
      ok: boolean;
      detail: string;
    }
  | {
      kind: 'session-end';
      session: number;
      stopKind: SessionStopKind;
      stopReason: string;
      cycles: number;
      /** How System 1 decided the session's cycles (model, continuing, binding). */
      system1?: System1Stats | undefined;
    };

export interface PlayResult {
  stopReason: string;
  /**
   * Play stopped because it is getting dark and no shelter can be made (or play has none),
   * so the agent leaves (goes offline until sunrise) before the mobs come. The clock then.
   */
  night: WorldTime | null;
  /**
   * Play stopped because a mob is near the player while it is home (or has no home to go
   * to): the pause's reasons. The task is active again; the caller waits offline a little
   * (MOB_WAIT_MS) and plays on, as a person would wait it out.
   */
  mobNearby: string | null;
  sessions: number;
  /** Quests completed during this play, in order. */
  questsCompleted: string[];
  progress: QuestProgress | null;
  elapsedMs: number;
}

/** What the caller gives play besides its deps and limits. */
export interface PlayHooks {
  /** A reason to stop (stop file, Ctrl+C), checked before every session and cycle. */
  stopRequested: () => string | null;
  onEvent?: (event: PlayEvent) => void;
}

/** How long the caller waits offline for a mob near home to leave, before playing on. */
export const MOB_WAIT_MS = 30_000;
/** Mob waits in a row after which play stops and says so. */
export const MAX_MOB_WAITS = 6;

/**
 * What the live agent can obtain: everything digging gathers, and the results of the
 * recipes it can craft (2x2 always; 3x3 only when a crafting table is configured). The
 * crafting table itself is never counted: the agent cannot place it, so making one (from
 * GTNH's flint recipe) would only spend flint.
 */
export function liveAbilities(hasCraftingTable: boolean): Abilities {
  const craft = RECIPE_IDS.map((id) => RECIPES[id])
    .filter((r) => hasCraftingTable || !needsCraftingTable(r))
    .map((r) => r.result.item.replace(/@\d+$/, ''));
  return { gather: BASE_ABILITIES.gather, craft: new Set(craft) };
}

/**
 * Plays, round after round, after scouting the area first when that is due (scouting.ts).
 * Each round, unless the stop file or a limit ends play, runs the first of these with
 * something to do: the night shelter at dusk, the way out of it in the morning (night.ts),
 * food when hungry with none (food.ts); else the goal: a quest-book click, or a session on
 * the player's own goal or the next quest (goal-round.ts). They share play-state.ts's
 * PlayState.
 */
export async function runPlay(
  deps: PlayDeps,
  limits: PlayLimits,
  hooks: PlayHooks,
): Promise<PlayResult> {
  const problem = checkPlayLimits(limits);
  if (problem !== null) throw new Error(problem);
  const play = startPlay(deps, limits, hooks);

  // GTNH start: look around once before settling (scouting.ts), when the agent can explore.
  const scouted = await scoutingRound(play);
  if (scouted !== null) return scouted;

  for (;;) {
    const round =
      stopOrLimit(play) ??
      (await nightRound(play)) ??
      (await morningRound(play)) ??
      (await foodRound(play)) ??
      (await goalRound(play));
    if (round !== 'next-round') return round;
  }
}

/** Before every round: the stop file / Ctrl+C, and the time and session limits. */
function stopOrLimit(play: PlayState): PlayResult | null {
  const { hooks, limits, now, started } = play;
  const stop = hooks.stopRequested();
  if (stop !== null) return done(play, stop);
  if (now() - started >= limits.maxMinutes * 60_000) {
    return done(play, `reached the limit of ${limits.maxMinutes} minutes`);
  }
  if (play.sessions >= limits.maxSessions) {
    return done(play, `reached the limit of ${limits.maxSessions} sessions`);
  }
  return null;
}

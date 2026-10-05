import {
  BASE_ABILITIES,
  type Abilities,
  type Quest,
  type QuestBookStep,
  type QuestProgress,
} from '../../goals/quest-goals.ts';
import { craftableFrom } from '../../domain/recipes.ts';
import type { GameState, WorldTime } from '../../domain/game-state.ts';
import { HURT_IN_SHELTER, STARVING_IN_SHELTER, type ShelterStatus } from '../../goals/shelter.ts';
import type { TunnelPlan } from '../../bot/gtnh1710/tunnel.ts';
import type { BlockPosition } from '../../domain/common.ts';
import type { TunnelDirection, TunnelSlope } from '../../domain/owner-commands.ts';

/** An owner's tunnel: where it starts (a feet block), which way, how many blocks, how steep. */
export interface TunnelRequest {
  start: BlockPosition;
  direction: TunnelDirection;
  length: number;
  slope: TunnelSlope;
}
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
import {
  cancelActions,
  commandRound,
  commandsAtNight,
  idleFor,
  idleRound,
  intake,
  type CommandDeps,
} from './commands.ts';
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
  /**
   * The next steps of an owner's tunnel (src/bot/gtnh1710/tunnel.ts planTunnel, with the live
   * client's dig rules), or null when the blocks or the position are not known. Without it,
   * a tunnel command fails.
   */
  tunnel?: (req: TunnelRequest) => Promise<TunnelPlan | null>;
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
  /**
   * The owners' commands (MC_OWNERS; commands.ts): heard in chat or queued with `cli
   * command`, answered with whispers, run before food trips and quests.
   */
  commands?: CommandDeps;
  /**
   * Stay online for commands when play has nothing of its own to do (no quest left, paused):
   * wait for them instead of ending (cli play --listen).
   */
  listen?: boolean;
}

export interface FreeGoal {
  /** The task id it is worked under (e.g. goal-minecraft:diamond-100). */
  taskId: string;
  /** Shown to the planner and in messages, e.g. "get 100 minecraft:diamond". */
  name: string;
  requirements: Readonly<Record<string, number>>;
  /**
   * Requirement items of which every kind and wear counts (all their damage values): an
   * owner's "get 16 logs" is any wood. Others count exactly.
   */
  anyKind?: readonly string[];
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
    }
  /** An owner's command: heard, understood, acknowledged, a reply, done or failed. */
  | { kind: 'command'; id: number; sender: string; message: string }
  /** Nothing of its own to do: waiting for commands (cli play --listen), or standing by. */
  | { kind: 'idle'; message: string };

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
  /**
   * The operator stopped play (Ctrl+C, the stop file of `cli halt`), not a lost connection or a
   * limit: the owners' commands end with it. Absent: never.
   */
  operatorStopped?: () => boolean;
  onEvent?: (event: PlayEvent) => void;
}

/** How long the caller waits offline for a mob near home to leave, before playing on. */
export const MOB_WAIT_MS = 30_000;
/** Mob waits in a row after which play stops and says so (with --listen: waits longer). */
export const MAX_MOB_WAITS = 6;
/** With --listen, each wait after MAX_MOB_WAITS of them: the bot stays for its owners. */
export const MOB_LONG_WAIT_MS = 5 * 60_000;

/**
 * What the live agent can obtain: everything digging gathers, and what the recipes CRAFT_ITEM
 * makes (the hand-verified table's and the knowledge base's) make of it, step by step: a
 * recipe counts once each of its ingredients can be had (craftableFrom). 2x2 recipes always;
 * 3x3 ones when a crafting table can be used:
 *  - one is configured (`tables.configured`); or
 *  - the agent may place one (`tables.placing`: MC_ENABLE_PLACING) and holds one or can make
 *    one (GTNH's 2x2 recipe: flint above logs): play's route then says "is held: place it"
 *    or "make one, then place it", with the exact PLACE_BLOCK, and the crafts that follow use
 *    the table it placed, which it then sees.
 * A table the agent merely sees nearby is no ability: play chooses its quest before a session
 * looks around, and the table may be out of reach by then; the route uses one it sees
 * (stations available). Inputs are judged by item name (`@damage` ignored), like the
 * abilities themselves.
 */
export function liveAbilities(tables: { configured: boolean; placing: boolean }): Abilities {
  const handGrid = craftableFrom(BASE_ABILITIES.gather, { table: false });
  const table = tables.configured || (tables.placing && handGrid.has('minecraft:crafting_table'));
  return {
    gather: BASE_ABILITIES.gather,
    craft: table ? craftableFrom(BASE_ABILITIES.gather, { table: true }) : handGrid,
  };
}

/**
 * Plays, round after round, after scouting the area first when that is due (scouting.ts).
 * Each round, unless the stop file or a limit ends play, runs the first of these with
 * something to do: the night shelter at dusk, the way out of it in the morning (night.ts),
 * the owners' commands (commands.ts), food when hungry with none (food.ts), waiting while an
 * owner paused play (commands.ts idleRound); else the goal: a quest-book click, or a session
 * on the player's own goal or the next quest (goal-round.ts). They share play-state.ts's
 * PlayState. With `listen`, play ends only for the stop file, Ctrl+C, the limits, the night
 * and a mob (offline waits): anything else that would end it makes it wait for commands.
 */
export async function runPlay(
  deps: PlayDeps,
  limits: PlayLimits,
  hooks: PlayHooks,
): Promise<PlayResult> {
  const problem = checkPlayLimits(limits);
  if (problem !== null) throw new Error(problem);
  const play = startPlay(deps, limits, hooks);
  play.whileSheltered = () => commandsAtNight(play);

  // GTNH start: look around once before settling (scouting.ts), when the agent can explore.
  const scouted = await scoutingRound(play);
  if (scouted !== null && (await endsPlay(play, scouted))) return leave(play, scouted);

  for (;;) {
    // An owner's stop has stopped the session it interrupted: actions may run again.
    deps.commands?.clearInterrupt();
    // A mob came near the idle bot at home: wait offline for it to leave.
    if (play.mobAlarm !== null) {
      const reasons = play.mobAlarm;
      play.mobAlarm = null;
      return leave(play, {
        ...done(play, `a mob is near the player (${reasons}): waiting offline for it to leave`),
        mobNearby: reasons,
      });
    }
    const round =
      stopOrLimit(play) ??
      (await nightRound(play)) ??
      (await morningRound(play)) ??
      (await commandRound(play)) ??
      (await foodRound(play)) ??
      (await idleRound(play)) ??
      (await goalRound(play));
    if (round !== 'next-round' && (await endsPlay(play, round))) return leave(play, round);
  }
}

/**
 * Whether `round` ends play. Without --listen it always does. With --listen only the stop
 * file, Ctrl+C, the limits (stopOrLimit), the night and a mob (offline waits) end play;
 * anything else (no quest left, a task that needs a person) makes play wait for commands, and
 * look again later (commands.ts idleRound).
 */
async function endsPlay(play: PlayState, round: PlayResult): Promise<boolean> {
  if (play.deps.listen !== true || round.night !== null || round.mobNearby !== null) return true;
  if (stopOrLimit(play) !== null) return true;
  if (play.idle?.reason !== round.stopReason) {
    play.idle = { reason: round.stopReason, since: play.now() };
  }
  await idleFor(play, round.stopReason);
  return false;
}

/**
 * Play ends: its result, or the stop that ended it meanwhile. An owner whose command waits is
 * told when the agent goes offline (the night with no shelter, a mob near home).
 */
function leave(play: PlayState, round: PlayResult): PlayResult {
  // What the owners said lately is stored before the client goes: the heard lines live only in
  // this connection (an independent review, 2026-10-04: a !stop whispered just before an
  // offline wait was lost, and the trip it stopped went on after).
  intake(play);
  // The operator stopped play (the stop file, cli halt, Ctrl+C): the owners' commands end with
  // it, rather than come back unannounced at the next play, perhaps days later.
  const operator = play.hooks.operatorStopped?.() === true ? play.hooks.stopRequested() : null;
  if (operator !== null) {
    // The whisper names no local path (the stop file's); the log says which stop it was.
    const stopped = cancelActions(play, 'Stopped: my operator stopped play', { tell: true });
    if (stopped.length > 0) {
      play.emit({
        kind: 'idle',
        message: `play was stopped (${operator}): the owners' commands end with it (${stopped.join('; ')})`,
      });
    }
  }
  const result = play.deps.listen === true ? (stopOrLimit(play) ?? round) : round;
  if ((result.night !== null || result.mobNearby !== null) && play.deps.commands !== undefined) {
    const { repos } = play.deps;
    // The running command's sender, and those whose commands wait (one heard just before: an
    // independent review, 2026-10-05: home from a retreat, it went offline for a mob at once,
    // and a !goto whispered meanwhile went unanswered), each once.
    const senders = new Set(
      [repos.commands.running(), ...repos.commands.queued()].flatMap((c) =>
        c === null ? [] : [c.sender],
      ),
    );
    const text =
      result.night !== null
        ? nightReply(result.stopReason)
        : 'A mob is near: I go offline a moment for it to leave';
    for (const sender of senders) play.deps.commands.reply(sender, text);
  }
  return result;
}

/**
 * What an owner whose command is running is told as play goes offline for the night: why
 * (an independent review, 2026-10-05: hurt inside its shelter, it said it had none).
 */
function nightReply(stopReason: string): string {
  if (stopReason.includes(STARVING_IN_SHELTER)) {
    return 'I am starving in my shelter: I go offline until sunrise';
  }
  if (stopReason.includes(HURT_IN_SHELTER)) {
    return 'Something hurt me in my shelter: I go offline until sunrise';
  }
  return 'It is getting dark and I have no shelter here: I go offline until sunrise';
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

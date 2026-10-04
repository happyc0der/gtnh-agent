import type { BlockPosition } from '../../domain/common.ts';
import type { DecisionResult } from '../../domain/decisions.ts';
import type { WorldTime } from '../../domain/game-state.ts';
import { AGE0_QUESTS } from '../../goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  type Abilities,
  type Quest,
  type QuestProgress,
} from '../../goals/quest-goals.ts';
import { OWNER_PAUSED_KEY, QUESTS_OFF_KEY } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import type { SessionStopKind } from '../loop/live-session.ts';
import type { PlayDeps, PlayEvent, PlayHooks, PlayLimits, PlayResult } from './play.ts';

/**
 * What play keeps from round to round (runPlay in play.ts): what it was given, and what it
 * counts and remembers on the way. Each kind of round reads and updates it: scouting
 * (scouting.ts), the night shelter and the way out of it in the morning (night.ts), food
 * (food.ts), and the goal (goal-round.ts).
 */
export interface PlayState {
  readonly deps: PlayDeps;
  readonly limits: PlayLimits;
  readonly hooks: PlayHooks;
  readonly now: () => number;
  readonly quests: readonly Quest[];
  readonly abilities: Abilities;
  readonly started: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly emit: (e: PlayEvent) => void;
  readonly questsCompleted: string[];
  progress: QuestProgress | null;
  sessions: number;
  /** Why the last scouting, food or goal session stopped (for the messages that cite it). */
  lastStop: string;
  /** Shelter sessions tonight (reset in daylight). */
  shelterTries: number;
  /** Sessions this morning trying to dig out of last night's shelter. */
  exitTries: number;
  /** A note for the next goal's journal (e.g. how to leave the night shelter). */
  wakeNote: string | null;
  /** The last session saw chunks near that world memory had not seen near before. */
  explored: boolean;
  /** Missing items of the quest worked on last, and sessions in a row without fewer. */
  last: { questId: string; missing: number; stuck: number } | null;
  /** Quest-book clicks that failed, by click. */
  readonly failedClicks: Map<string, number>;
  /** Waits in a row for the server's quest loop, with nothing else to do. */
  loopWaits: number;
  /** Food sessions in a row that got no food and saw no new ground. */
  foodStuck: number;
  /** System 1's decision in the latest cycle (for mobPause). */
  lastDecision: DecisionResult | null;
  /** Owners' commands (commands.ts): how each running one is going, by command id. */
  readonly commandRuns: Map<number, CommandRun>;
  /** The newest command id the command round has handled (newer ones preempt sessions). */
  commandsSeen: number;
  /**
   * Why play has nothing to do now (no quest left, a task that needs a person...), and since
   * when: with --listen play waits for commands instead of ending, and looks again later.
   */
  idle: { reason: string; since: number } | null;
  /** The idle reason last told (each is told once). */
  idleNote: string | null;
  /**
   * Run every few seconds while play waits in the shelter for the morning: owners' commands
   * are heard and answered meanwhile (commands.ts; set by runPlay).
   */
  whileSheltered: () => Promise<void>;
  /**
   * A mob near the idle bot at home (standby: commands.ts idleFor): its reasons, until play
   * ends to wait offline for it to leave (play.ts); else null.
   */
  mobAlarm: string | null;
  /**
   * In the shelter, waiting: for the morning (until when, on play.now's clock), or in the
   * morning for the hostiles near it to go (what they are); else null.
   */
  sheltered: { until: number } | { mobs: string } | null;
}

/** How an owner's running command is going (commands.ts). */
export interface CommandRun {
  /** Steps (travel) or sessions (a goal) in a row that failed, and the last failure. */
  failures: number;
  lastFailure: string | null;
  /** Replies said once for it ("night", "food", "half"...). */
  said: Set<string>;
  /** Travel: blocks to go when progress was last told. */
  reportedDistance: number | null;
  /** A goal: items missing before the last session, and sessions in a row with no fewer. */
  missing: number | null;
  stuck: number;
  /** A goal: how many of its item the inventory held when the command began. */
  startHave: number | null;
  /** Explore: the point it heads for, fixed when it began (x, z). */
  exploreTo: { x: number; z: number; direction: string } | null;
  /** Tunnel: its first cell (where the bot stood when it began), and the cells dug then. */
  tunnelFrom: BlockPosition | null;
  tunnelDone: number | null;
}

/**
 * What a kind of round did: play ends (its result), the next round begins ('next-round'), or
 * null: this round is not of its kind, and runPlay tries the next kind.
 */
export type RoundEnd = PlayResult | 'next-round' | null;

/** Play's state as it starts. */
export function startPlay(deps: PlayDeps, limits: PlayLimits, hooks: PlayHooks): PlayState {
  const now = deps.now ?? Date.now;
  return {
    deps,
    limits,
    hooks,
    now,
    quests: deps.quests ?? AGE0_QUESTS,
    abilities: deps.abilities ?? BASE_ABILITIES,
    started: now(),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    emit: (e: PlayEvent): void => hooks.onEvent?.(e),
    questsCompleted: [],
    progress: null,
    sessions: 0,
    lastStop: '',
    shelterTries: 0,
    exitTries: 0,
    wakeNote: null,
    explored: false,
    last: null,
    failedClicks: new Map<string, number>(),
    loopWaits: 0,
    foodStuck: 0,
    lastDecision: null,
    commandRuns: new Map(),
    commandsSeen: 0,
    idle: null,
    idleNote: null,
    whileSheltered: () => Promise.resolve(),
    mobAlarm: null,
    sheltered: null,
  };
}

/**
 * Why the session running now should end for an owner's command, or null: one heard in chat
 * and not taken yet, or one `cli command` queued since the command round last looked.
 * Commands come before quests, food trips and scouting; the night shelter and a food trip on
 * a nearly empty food bar do not ask.
 */
export function commandWaiting(play: PlayState): string | null {
  const commands = play.deps.commands;
  if (commands === undefined) return null;
  if (commands.waiting()) return 'an owner gave a new command';
  return play.deps.repos.commands.hasQueuedAfter(play.commandsSeen)
    ? 'an owner queued a new command'
    : null;
}

/** Why autonomous play is off (an owner's pause or stop, or quests off), or null when it is on. */
export function autonomyOff(repos: Repositories): string | null {
  const paused = repos.memory.getValue(OWNER_PAUSED_KEY);
  if (paused !== null) return `paused: ${paused}`;
  const off = repos.memory.getValue(QUESTS_OFF_KEY);
  return off === null ? null : `quests are off: ${off}`;
}

/** Ends play: why (and the clock, when it stops for the night), with what play has done. */
export function done(
  play: PlayState,
  stopReason: string,
  night: WorldTime | null = null,
): PlayResult {
  const { now } = play;
  return {
    stopReason,
    night,
    mobNearby: null,
    sessions: play.sessions,
    questsCompleted: play.questsCompleted,
    progress: play.progress,
    elapsedMs: now() - play.started,
  };
}

/** Ends play for a mob near home: the paused task is active again (see mobPause). */
export function waitOutMob(play: PlayState, taskId: string, reasons: string): PlayResult {
  play.deps.repos.tasks.setStatus(taskId, 'active');
  play.deps.repos.memory.appendJournal(
    taskId,
    `a mob came near (${reasons}): the agent waited offline for it to leave`,
  );
  return {
    ...done(play, `a mob is near the player (${reasons}): waiting offline for it to leave`),
    mobNearby: reasons,
  };
}

/** Session ends after which play goes on (anything else needs a human). */
export const CONTINUE_AFTER: ReadonlySet<SessionStopKind> = new Set([
  'task-finished',
  'limit',
  'cycle-failed',
  'non-task-decision',
  'stop-requested', // only when the quest itself was met: see goal-round.ts
]);

/** Pause reasons that only say a mob is near, with the agent home or without a home. */
const MOB_PAUSE_REASONS: ReadonlySet<string> = new Set([
  'HOSTILES_NEARBY',
  'UNCLASSIFIED_ENTITY_NEARBY',
  'CREEPER_NEARBY',
  'TOO_MANY_HOSTILES',
  'ALREADY_AT_SAFE_LOCATION',
  'NO_SAFE_LOCATION',
]);

/**
 * The reasons of a session that ended on a pause only because a mob was near (System 1's
 * last decision: PAUSE_AND_ASK_USER with HOSTILES_NEARBY or UNCLASSIFIED_ENTITY_NEARBY, and
 * nothing but the home codes besides), else null. Mobs move on or burn in daylight, and an
 * offline player cannot be hurt: such a pause is waited out, not handed to a person.
 */
export function mobPause(stopKind: SessionStopKind, last: DecisionResult | null): string | null {
  if (stopKind !== 'needs-attention' || last === null) return null;
  if (last.decision !== 'PAUSE_AND_ASK_USER') return null;
  const codes = last.reasonCodes;
  const mob = codes.includes('HOSTILES_NEARBY') || codes.includes('UNCLASSIFIED_ENTITY_NEARBY');
  return mob && codes.every((c) => MOB_PAUSE_REASONS.has(c)) ? codes.join(', ') : null;
}

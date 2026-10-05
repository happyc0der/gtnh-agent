import { z } from 'zod';
import { BlockPositionSchema, type BlockPosition, type Position } from '../../domain/common.ts';
import { TUNNEL_DIRECTIONS, type HeardCommand } from '../../domain/owner-commands.ts';
import type { Boundary, NamedLocation } from '../../domain/safety.ts';
import type { CommandTranslation } from '../../llm/ollama-command-provider.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import type { CycleResult } from '../loop/agent-loop.ts';
import { setKnownSteps } from '../loop/known-steps.ts';
import type { TravelStep, TravelTarget } from './owner-travel.ts';
import { type CommandRun, type PlayState } from './play-state.ts';

/**
 * What every part of the owners' commands shares (commands.ts and the command-*.ts modules):
 * what play needs of the live game (CommandDeps), the limits, a command's run state, and the
 * replies to its owner.
 */

/** What the command round needs of the live game (live-play.ts: the client; tests: fakes). */
export interface CommandDeps {
  /** The owners' commands heard in chat since the last call (the client's queue). */
  take: () => readonly HeardCommand[];
  /** Whether owners' commands are waiting in chat (without taking them). */
  waiting: () => boolean;
  /** Whispers to an owner (the client makes it plain, cuts it into lines and paces it). */
  reply: (owner: string, text: string) => void;
  /** Ends the interrupt an owner's stop set: the session it stopped is over. */
  clearInterrupt: () => void;
  /** An owner's natural language as a command (the local model); absent: not understood. */
  translate?: (text: string) => Promise<CommandTranslation>;
  /** What the bot knows now (live: the client's world model). */
  view: () => CommandView;
  /** The next step toward a target, with the client's walk rules (owner-travel.ts). */
  step: (target: TravelTarget) => TravelStep;
  /**
   * Why a get or mine cannot be done at all with what is held (route-book.ts cannotGet: no
   * way known, or a tool none can make), or null; absent: not checked.
   */
  goalProblem?: (item: string, count: number, anyKind: boolean) => string | null;
  /**
   * Blocks of these kinds the bot sees (a face open to air: no x-ray), nearest first
   * (world-model.ts findBlocks); absent: it cannot look.
   */
  findBlock?: (names: readonly string[]) => Array<{ position: BlockPosition; distance: number }>;
  /**
   * GregTech ores the bot sees (a face open to air), with their material's metadata when the
   * server sent it (world-model.ts gtOresInView); absent: a !mine of one is not strip-mined.
   */
  gtOres?: () => Array<{ position: BlockPosition; ore?: number }>;
  /** Where `!surface` goes (owner-travel.ts surfaceTarget); absent: it cannot here. */
  surface?: () => { point: Position; here: boolean } | { problem: string };
  /** The owners (MC_OWNERS): `follow` follows only them. */
  owners: readonly string[];
  /** The named location `home` and `sethome` mean (routing.homeLocationName). */
  homeName: string;
  /** Named locations from agent.config.json: they win over saved ones, and chat never changes them. */
  configLocations: ReadonlyMap<string, NamedLocation>;
  /** The safety boundary: no command goes beyond it. */
  boundary: Boundary;
  /**
   * While idle: what System 1 would do now, when it must act (a reflex: a retreat, a meal, a
   * rest) or a mob near home has the bot wait offline; else null.
   */
  standby?: () => Promise<StandbyCall | null>;
  /**
   * Sends the replies waiting (at the chat rate, a few seconds at most): play calls it before
   * it goes, then stores what the owners said meanwhile, which the closing connection would
   * lose (an independent review, 2026-10-05). Absent: nothing waits.
   */
  flush?: () => Promise<void>;
}

/** What an idle bot must do now (live-play.ts standbyReason). */
export type StandbyCall =
  /** One of System 1's reflexes, run in a standby session: its decision and reasons. */
  | { kind: 'reflex'; text: string }
  /** A mob near the bot at home (or with no home): play waits offline (PlayState.mobAlarm). */
  | { kind: 'mob'; reasons: string };

/** What the bot knows now, for commands. */
export interface CommandView {
  position: Position | null;
  dimension: string | null;
  health: number | null;
  food: number | null;
  inventory: Readonly<Record<string, number>> | null;
  /** Where a player is (its feet), by exact name, when the bot sees it. */
  playerAt: (name: string) => Position | null;
}

export const NOT_UNDERSTOOD = 'I did not understand; say !help';
/** Travel steps, or goal sessions, that may fail in a row before the command fails. */
export const MAX_COMMAND_FAILURES = 3;
/** How near `come` and `follow` go to the player. */
export const COME_WITHIN = 2.5;
export const FOLLOW_WITHIN = 3;
/** Following a player already near: wait this long, then look again. */
export const FOLLOW_WAIT_MS = 1_000;
/** A long trip says how far it has left every this many blocks. */
export const PROGRESS_EVERY = 64;
/** A travel step that failed is planned again after this long. */
export const TRAVEL_RETRY_MS = 1_000;
/** System 1's reflexes: a session one of them ended was interrupted, not stuck. */
const REFLEXES: ReadonlySet<string> = new Set(['RETREAT_HOME', 'DEFEND', 'EAT', 'REST']);
/** A tunnel whose next steps cannot be planned yet (blocks not known) tries again after this. */
export const TUNNEL_RETRY_MS = 3_000;
/** The task an action command's steps (or its goal) run under. */
export const commandTaskId = (id: number): string => `command-${id}`;
/** The task a !mine's strip mine digs under: the goal's own is its GATHER's (command-dig.ts). */
export const stripTaskId = (id: number): string => `${commandTaskId(id)}-strip`;

export const fmt = (p: { x: number; y: number | null; z: number }): string =>
  [p.x, p.y, p.z]
    .filter((v): v is number => v !== null)
    .map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)))
    .join(' ');

/**
 * What of a command's run outlives a restart of play (a wait offline for a mob, a reconnect, a
 * night offline), kept in agent memory: its strip mine (the level, the leg, the cells dug, the
 * ores passed over) and its tunnel's first cell. Else a restart chose a new level 6 blocks
 * deeper and began the count again (an independent review, 2026-10-04).
 */
const PROGRESS_KEY = (id: number): string => `command_progress:${id}`;
const LegSchema = z.strictObject({
  start: BlockPositionSchema,
  direction: z.enum(['north', 'south', 'east', 'west']),
  slope: z.enum(['level', 'down']),
  length: z.int().min(0),
});
const ProgressSchema = z.strictObject({
  strip: z
    .strictObject({
      level: z.int(),
      leg: LegSchema,
      dug: z.int().min(0),
      turns: z.int().min(0),
    })
    .nullable(),
  stripSkipped: z.array(z.string().max(40)).max(256),
  tunnelFrom: BlockPositionSchema.nullable(),
  /** Kept since 2026-10-04: progress saved before has none. */
  tunnelDirection: z.enum(TUNNEL_DIRECTIONS).nullable().default(null),
  tunnelBefore: z.int().min(0).default(0),
  tunnelTurns: z.int().min(0).default(0),
  tunnelPrevious: z.enum(TUNNEL_DIRECTIONS).nullable().default(null),
});

/** Keeps the run's lasting progress (PROGRESS_KEY) for a restart of play. */
export function saveProgress(play: PlayState, id: number): void {
  const run = runOf(play, id);
  play.deps.repos.memory.setValue(
    PROGRESS_KEY(id),
    JSON.stringify({
      strip: run.strip,
      stripSkipped: [...run.stripSkipped].slice(-256),
      tunnelFrom: run.tunnelFrom,
      tunnelDirection: run.tunnelDirection,
      tunnelBefore: run.tunnelBefore,
      tunnelTurns: run.tunnelTurns,
      tunnelPrevious: run.tunnelPrevious,
    }),
  );
}

function loadProgress(play: PlayState, id: number): z.infer<typeof ProgressSchema> | null {
  const raw = play.deps.repos.memory.getValue(PROGRESS_KEY(id));
  if (raw === null) return null;
  try {
    const parsed = ProgressSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Why a cycle's step did not go, in the client's or the safety rules' own words: a step that
 * failed says what the client met; one the executor rejected, its first violation or unmet
 * precondition (seen live 2026-10-04: a reply said only "rejected [NOT_DIGGABLE]"). Null for a
 * step that went, or a cycle with none.
 */
export function stepFailureOf(r: CycleResult): string | null {
  // Loosely typed: a session's cycles come from many places (and tests), some without these.
  const outcome = r.outcome as Partial<NonNullable<CycleResult['outcome']>> | null | undefined;
  const execution = outcome?.execution;
  if (execution !== null && execution !== undefined && !execution.ok) return execution.message;
  const v = outcome?.validation;
  if (v !== undefined && !v.ok) {
    return v.violations[0]?.message ?? v.preconditionFailures[0] ?? null;
  }
  return null;
}

/**
 * Walks a hostile stopped a trip or a dig tries again before it fails (follow: no end); only
 * a step of its own that went starts the count again, never a retreat that went.
 */
export const MAX_MOB_STOPS = 20;
/** After a walk a hostile stopped, the next try waits this long, unless the mob is close. */
export const MOB_RETRY_MS = 2_000;
/** A mob this close (the walk's own close radius): the next try at once, System 1 first. */
const CLOSE_MOB = 6;
/** The walk's own words when a hostile stops it (movement-actions.ts walkInterruption). */
const MOB_STOP = /\b(?:hostile|unclassified) entity (\S+) ([\d.]+) blocks away/;

/**
 * A walk a hostile stopped (the walk's own rule: one within the threat radius on the way; the
 * bot does not fight unless combat is on) is not a failure of the way: the owner is told once,
 * and the next round tries again a moment later, System 1 seeing the mob first (it may retreat
 * or flee). Seen live 2026-10-04: a zombie in the Hot Forest's shade stopped a follow's walks
 * three times in 15 s, and the follow failed. (A retreat from a mob that fails is no such stop:
 * play then waits offline, play-state.ts mobPause.) 'retry' after MOB_RETRY_MS (at once when
 * the mob is within CLOSE_MOB: no blind wait beside it, an independent review, 2026-10-04);
 * 'give-up' after MAX_MOB_STOPS (`endless`: never, as for a follow), and play then waits
 * offline for the mob to leave rather than stand idle beside it; null when `why` is no mob's
 * stop.
 */
export async function mobInTheWay(
  play: PlayState,
  cmd: OwnerCommandRecord,
  why: string,
  endless = false,
): Promise<'retry' | 'give-up' | null> {
  const m = MOB_STOP.exec(why);
  if (m === null) return null;
  const run = runOf(play, cmd.id);
  run.mobStops += 1;
  const name = (m[1] ?? 'mob').replace(/^.*[:.]/, '');
  if (!endless && run.mobStops > MAX_MOB_STOPS) {
    play.mobAlarm = `${name} in the way`;
    return 'give-up';
  }
  const distance = Number(m[2]);
  sayOnce(
    play,
    cmd,
    'mob-in-way',
    `A ${name} ${Math.round(distance)} blocks off is in my way: I keep away (I do not fight) and try again`,
  );
  if (!(distance <= CLOSE_MOB)) await play.sleep(MOB_RETRY_MS);
  return 'retry';
}

export function runOf(play: PlayState, id: number): CommandRun {
  let run = play.commandRuns.get(id);
  if (run === undefined) {
    const kept = loadProgress(play, id);
    run = {
      failures: 0,
      lastFailure: null,
      said: new Set(),
      reportedDistance: null,
      missing: null,
      stuck: 0,
      startHave: null,
      exploreTo: null,
      surfaceTo: null,
      blockTo: null,
      strip: kept?.strip ?? null,
      stripSkipped: new Set(kept?.stripSkipped ?? []),
      tunnelFrom: kept?.tunnelFrom ?? null,
      tunnelDone: null,
      tunnelDirection: kept?.tunnelDirection ?? null,
      tunnelBefore: kept?.tunnelBefore ?? 0,
      tunnelTurns: kept?.tunnelTurns ?? 0,
      tunnelPrevious: kept?.tunnelPrevious ?? null,
      worked: false,
      interrupted: false,
      mobStops: 0,
      visits: new Map(),
    };
    play.commandRuns.set(id, run);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** Tells the command's sender (a whisper), and keeps it as the command's latest reply. */
export function say(play: PlayState, cmd: OwnerCommandRecord, text: string): void {
  play.deps.commands?.reply(cmd.sender, text);
  play.deps.repos.commands.setReply(cmd.id, text);
  play.emit({ kind: 'command', id: cmd.id, sender: cmd.sender, message: text });
}

/** Says `text` about the command once (a deferral, a milestone). */
export function sayOnce(play: PlayState, cmd: OwnerCommandRecord, key: string, text: string): void {
  const run = runOf(play, cmd.id);
  if (run.said.has(key)) return;
  run.said.add(key);
  say(play, cmd, text);
}

/** The command is over: its status and the reply that says so; its task, if any, ends. */
export function finish(
  play: PlayState,
  cmd: OwnerCommandRecord,
  status: 'done' | 'failed' | 'cancelled',
  text: string,
): void {
  play.deps.commands?.reply(cmd.sender, text);
  play.deps.repos.commands.finish(cmd.id, status, text);
  play.emit({ kind: 'command', id: cmd.id, sender: cmd.sender, message: text });
  play.commandRuns.delete(cmd.id);
  endCommandTask(play.deps.repos, cmd.id, status);
}

/**
 * An action command's tasks end with it (its own, and its strip mine's): no longer current,
 * their blueprints and plans closed.
 */
export function endCommandTask(repos: Repositories, id: number, status: string): void {
  for (const taskId of [commandTaskId(id), stripTaskId(id)]) endTask(repos, taskId, status);
  repos.memory.setValue(PROGRESS_KEY(id), null);
}

function endTask(repos: Repositories, taskId: string, status: string): void {
  repos.transaction(() => {
    setKnownSteps(repos, taskId, null);
    const task = repos.tasks.get(taskId);
    if (task !== null && task.status !== 'completed') {
      repos.tasks.setStatus(taskId, status === 'done' ? 'completed' : 'failed');
    }
    const open = repos.plans.openForTask(taskId);
    if (open !== null) {
      repos.plans.setStatus(
        open.id,
        status === 'done' ? 'completed' : 'failed',
        `the command is ${status}`,
      );
    }
    if (repos.memory.getValue(CURRENT_TASK_KEY) === taskId) {
      repos.memory.setValue(CURRENT_TASK_KEY, null);
    }
  });
}

/** The named locations: the saved ones, and agent.config.json's over them. */
export function locations(play: PlayState): Map<string, NamedLocation> {
  const commands = play.deps.commands as CommandDeps;
  return new Map([...play.deps.repos.locations.all(), ...commands.configLocations]);
}

export function outsideBoundary(
  b: Boundary,
  p: { x: number; y: number | null; z: number },
): string | null {
  const out =
    p.x < b.min.x ||
    p.x > b.max.x ||
    p.z < b.min.z ||
    p.z > b.max.z ||
    (p.y !== null && (p.y < b.min.y || p.y > b.max.y));
  return out
    ? `${fmt(p)} is outside my safety boundary (x ${b.min.x}..${b.max.x}, z ${b.min.z}..${b.max.z})`
    : null;
}

export const roundPoint = (p: Position): Position => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
  z: Math.floor(p.z),
});

/** Whether the session's last decision was one of System 1's reflexes (REFLEXES). */
export function reflexEnded(play: PlayState): boolean {
  return play.lastDecision !== null && REFLEXES.has(play.lastDecision.decision);
}

export const blocks = (n: number): string => `${n} block${n === 1 ? '' : 's'}`;

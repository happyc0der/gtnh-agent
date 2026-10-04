import { MIN_EXPLORE_DISTANCE } from '../../domain/actions.ts';
import type { WorldTime } from '../../domain/game-state.ts';
import {
  COMPASS,
  summarizeExploration,
  wanderTarget,
  type PlaceKind,
} from '../../domain/world-memory.ts';
import { gtOreByItem, gtOreByName, gtOreHeights } from '../../goals/ore-names.ts';
import { heldOf, type BlockPosition, type Position } from '../../domain/common.ts';
import {
  describeCommand,
  HELP_TEXT,
  isActionCommand,
  isStructured,
  isTravelCommand,
  blockName,
  parseOwnerCommand,
  type ActionCommand,
  type GoalCommand,
  type HeardCommand,
  type InstantCommand,
  type OwnerCommand,
  type TravelCommand,
  type TunnelCommand,
} from '../../domain/owner-commands.ts';
import type { Boundary, NamedLocation } from '../../domain/safety.ts';
import type { CommandTranslation } from '../../llm/ollama-command-provider.ts';
import {
  CURRENT_TASK_KEY,
  OWNER_PAUSED_KEY,
  QUESTS_OFF_KEY,
} from '../../persistence/memory-repository.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { checkWithinBoundary } from '../../safety/coordinate-boundaries.ts';
import { setKnownSteps } from '../loop/known-steps.ts';
import { starving, type FoodStatus } from './food.ts';
import { freeRoundGoal, missingFor, reachGoal, runGoalSession, total } from './goal-round.ts';
import { cycleEvent } from './narration.ts';
import { blueprintSession, isDark, nightReason, nightSoon } from './night.ts';
import type { TravelStep, TravelTarget } from './owner-travel.ts';
import {
  autonomyOff,
  commandWaiting,
  done,
  mobPause,
  waitOutMob,
  type CommandRun,
  type PlayState,
  type RoundEnd,
} from './play-state.ts';
import type { FreeGoal, PlayResult } from './play.ts';

/**
 * Owners' commands in play (src/domain/owner-commands.ts): the command round, and the idle
 * round of `cli play --listen`.
 *
 * Each round, after the night shelter and the morning (night.ts), the command round hears
 * the commands that came (chat, and `cli command` through the database), answers the ones
 * done at once (stop, pause, status, waypoints...), and runs the action command, one at a
 * time (the newest replaces any other): a travel command as code-made steps, a goal as a
 * FreeGoal. Owners' commands come before food trips and quests: a new one ends the session
 * running at its next cycle (commandWaiting, in each session's stopRequested), and a stop also
 * stops the action in progress (the client's interrupt). Only the night shelter and a food bar
 * nearly empty (food.ts starving) keep priority; travel and goals wait for them, and say so.
 *
 * Nothing here acts by itself: a travel step is a MOVE_TO, EXPLORE or WAIT that code
 * proposes as the command task's known step (known-steps.ts), so System 1 still decides first
 * (a mob, low health, a meal) and the executor validates, executes and verifies the step like
 * any other; a goal is pursued by the planner and GATHER exactly as `cli play --needs`.
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
const COME_WITHIN = 2.5;
const FOLLOW_WITHIN = 3;
/** Following a player already near: wait this long, then look again. */
export const FOLLOW_WAIT_MS = 1_000;
/** A long trip says how far it has left every this many blocks. */
const PROGRESS_EVERY = 64;
/** A travel step that failed is planned again after this long. */
const TRAVEL_RETRY_MS = 1_000;
/** Idle: commands are looked for this often, this many times, before play looks around again. */
export const IDLE_POLL_MS = 500;
const IDLE_POLLS = 20;
/** Idle with nothing to do: play looks for something to do again after this long. */
export const IDLE_RETRY_MS = 120_000;
/** System 1's reflexes: a session one of them ended was interrupted, not stuck. */
const REFLEXES: ReadonlySet<string> = new Set(['RETREAT_HOME', 'DEFEND', 'EAT', 'REST']);
/** A tunnel whose next steps cannot be planned yet (blocks not known) tries again after this. */
const TUNNEL_RETRY_MS = 3_000;
/** The task the idle bot stands by under, when System 1 must act (standby). */
export const STANDBY_TASK_ID = 'owner-standby';

/** The task an action command's steps (or its goal) run under. */
export const commandTaskId = (id: number): string => `command-${id}`;

const fmt = (p: { x: number; y: number | null; z: number }): string =>
  [p.x, p.y, p.z]
    .filter((v): v is number => v !== null)
    .map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)))
    .join(' ');

function runOf(play: PlayState, id: number): CommandRun {
  let run = play.commandRuns.get(id);
  if (run === undefined) {
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
      tunnelFrom: null,
      tunnelDone: null,
      worked: false,
      interrupted: false,
    };
    play.commandRuns.set(id, run);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** Tells the command's sender (a whisper), and keeps it as the command's latest reply. */
function say(play: PlayState, cmd: OwnerCommandRecord, text: string): void {
  play.deps.commands?.reply(cmd.sender, text);
  play.deps.repos.commands.setReply(cmd.id, text);
  play.emit({ kind: 'command', id: cmd.id, sender: cmd.sender, message: text });
}

/** Says `text` about the command once (a deferral, a milestone). */
function sayOnce(play: PlayState, cmd: OwnerCommandRecord, key: string, text: string): void {
  const run = runOf(play, cmd.id);
  if (run.said.has(key)) return;
  run.said.add(key);
  say(play, cmd, text);
}

/** The command is over: its status and the reply that says so; its task, if any, ends. */
function finish(
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

/** An action command's task ends with it: no longer current, its blueprint and plan closed. */
function endCommandTask(repos: Repositories, id: number, status: string): void {
  const taskId = commandTaskId(id);
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

// ---------------------------------------------------------------------------
// Hearing commands
// ---------------------------------------------------------------------------

/**
 * The owners' commands heard in chat are stored, queued: parsed when they are of the
 * structured form. The structured form is code's alone, so a typo in it (or natural language
 * without a translator) is answered at once, never sent to a model.
 */
function intake(play: PlayState): void {
  const commands = play.deps.commands;
  if (commands === undefined) return;
  for (const heard of commands.take()) {
    const parsed = parseOwnerCommand(heard.text, { ore: gtOreByName });
    const record = play.deps.repos.commands.add({
      source: 'chat',
      sender: heard.sender,
      rawText: heard.text,
      command: parsed.ok ? parsed.command : null,
    });
    play.emit({
      kind: 'command',
      id: record.id,
      sender: heard.sender,
      message: `heard (${heard.via}): ${heard.text}`,
    });
    if (parsed.ok) continue;
    if (parsed.kind === 'usage') finish(play, record, 'failed', parsed.usage);
    else if (isStructured(heard.text) || commands.translate === undefined) {
      finish(play, record, 'failed', NOT_UNDERSTOOD);
    }
  }
}

/**
 * Hears the commands that came and handles the queued ones, oldest first: natural language
 * translated, instant commands done, an action command started (acknowledged), or at night
 * left queued until the morning (said once).
 */
export async function takeCommands(play: PlayState, mode: 'day' | 'night'): Promise<void> {
  if (play.deps.commands === undefined) return;
  intake(play);
  for (const cmd of play.deps.repos.commands.queued()) await handleQueued(play, cmd, mode);
}

async function handleQueued(
  play: PlayState,
  cmd: OwnerCommandRecord,
  mode: 'day' | 'night',
): Promise<void> {
  const commands = play.deps.commands as CommandDeps;
  const { repos } = play.deps;
  play.commandsSeen = Math.max(play.commandsSeen, cmd.id);
  let command = cmd.command;
  if (command === null) {
    const t = commands.translate === undefined ? null : await commands.translate(cmd.rawText);
    if (t === null || !t.ok) {
      if (t !== null) {
        play.emit({ kind: 'command', id: cmd.id, sender: cmd.sender, message: t.reason });
      }
      finish(play, cmd, 'failed', NOT_UNDERSTOOD);
      return;
    }
    command = t.command;
    repos.commands.setCommand(cmd.id, command);
    play.emit({
      kind: 'command',
      id: cmd.id,
      sender: cmd.sender,
      message: `understood as: ${describeCommand(command)}`,
    });
  }
  if (!isActionCommand(command)) {
    instant(play, cmd, command);
    return;
  }
  // One action command at a time: the newest replaces the others.
  const replaced = replaceOthers(play, cmd.id);
  if (mode === 'night') {
    sayOnce(play, cmd, nightKey(play), nightNote(play, command));
    return;
  }
  const problem = checkAction(play, cmd, command);
  if (problem !== null) {
    finish(play, cmd, 'failed', `Failed: ${problem}`);
    return;
  }
  const ack =
    `OK: ${acknowledge(play, cmd, command)}` +
    (replaced.length === 0 ? '' : ` (instead of: ${replaced.join('; ')})`);
  repos.commands.start(cmd.id, ack);
  commands.reply(cmd.sender, ack);
  play.emit({ kind: 'command', id: cmd.id, sender: cmd.sender, message: ack });
}

const nightNote = (play: PlayState, c: OwnerCommand): string =>
  play.sheltered !== null && 'mobs' in play.sheltered
    ? `Hostiles are near my shelter: I stay inside until they go, then I ${describeCommand(c)}`
    : `It is night: I stay in my shelter until morning, then I ${describeCommand(c)}`;

/** The say-once key of nightNote: its words change when the morning's wait is for mobs. */
const nightKey = (play: PlayState): string =>
  play.sheltered !== null && 'mobs' in play.sheltered ? 'mobs' : 'night';

/**
 * In the shelter at night (night.ts): commands are heard and answered; travel and goals wait
 * for the morning, and their sender is told so once.
 */
export async function commandsAtNight(play: PlayState): Promise<void> {
  if (play.deps.commands === undefined) return;
  await takeCommands(play, 'night');
  const running = play.deps.repos.commands.running();
  if (running?.command != null && isActionCommand(running.command)) {
    sayOnce(play, running, nightKey(play), nightNote(play, running.command));
  }
}

/** Cancels the running action command and the queued ones before `newId`; what they were. */
function replaceOthers(play: PlayState, newId: number): string[] {
  const { repos } = play.deps;
  const others = [
    repos.commands.running(),
    ...repos.commands.queued().filter((q) => q.id < newId),
  ].filter(
    (c): c is OwnerCommandRecord =>
      c !== null && c.id !== newId && c.command !== null && isActionCommand(c.command),
  );
  for (const c of others) {
    repos.commands.finish(c.id, 'cancelled', `Replaced by command #${newId}`);
    play.commandRuns.delete(c.id);
    endCommandTask(repos, c.id, 'cancelled');
  }
  return others.map((c) => describeCommand(c.command as OwnerCommand));
}

/** The named locations: the saved ones, and agent.config.json's over them. */
function locations(play: PlayState): Map<string, NamedLocation> {
  const commands = play.deps.commands as CommandDeps;
  return new Map([...play.deps.repos.locations.all(), ...commands.configLocations]);
}

function outsideBoundary(
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

/** Why an action command cannot even start, or null. */
function checkAction(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: ActionCommand,
): string | null {
  const commands = play.deps.commands as CommandDeps;
  switch (command.verb) {
    case 'follow':
      return command.player !== null && !commands.owners.includes(command.player)
        ? `I follow only my owners (${commands.owners.join(', ')})`
        : null;
    case 'goto':
      return outsideBoundary(commands.boundary, command);
    case 'goto-block': {
      // The block it heads for is fixed now (blockTarget): none, and it fails.
      const to = blockTarget(play, cmd, command.block);
      return 'problem' in to ? to.problem : null;
    }
    case 'goto-waypoint':
    case 'home': {
      const name = command.verb === 'home' ? commands.homeName : command.name;
      const at = locations(play).get(name);
      if (at === undefined && command.verb === 'goto-waypoint') {
        // No waypoint of that name: perhaps a block ("!goto chest").
        const block = blockName([name]);
        const to = block === null ? null : blockTarget(play, cmd, block);
        if (to !== null && !('problem' in to)) return null;
        const looked = commands.findBlock === undefined ? '' : `, and I see no ${name} near here`;
        return `I know no waypoint ${name}${looked}: say !waypoints`;
      }
      if (at === undefined) return 'I have no home yet: say !sethome where it should be';
      const here = commands.view().dimension;
      if (here !== null && at.dimension !== here) return `${name} is in ${at.dimension}`;
      return outsideBoundary(commands.boundary, at.position);
    }
    case 'explore': {
      // Its point is fixed now, from here (exploreTarget): none, and it fails.
      const to = exploreTarget(play, cmd, command);
      return 'problem' in to ? to.problem : null;
    }
    case 'surface': {
      // Likewise its open-sky cell (surfaceTarget).
      const to = surfaceTarget(play, cmd);
      return 'problem' in to ? to.problem : null;
    }
    case 'get':
    case 'mine': {
      const why = commands.goalProblem?.(
        command.item,
        command.count,
        anyKindOf(command).length > 0,
      );
      return why === undefined || why === null ? null : `I cannot get ${command.item}: ${why}`;
    }
    case 'come':
    case 'tunnel':
      return null;
  }
}

/**
 * For a GregTech ore asked for while the bot stands outside the heights its veins lie at:
 * where they are, and how to dig there (GT ores lie underground, and the bot mines only ores
 * it has seen exposed: no x-ray). Empty otherwise.
 */
function oreDepthHint(item: string, at: Position | null): string {
  const ore = gtOreByItem(item);
  const heights = ore === null ? null : gtOreHeights(ore.material);
  if (heights === null || at === null) return '';
  const y = Math.floor(at.y + 1e-6);
  if (y >= heights.minY && y <= heights.maxY) return '';
  const way = y > heights.maxY ? `!tunnel <direction> ${Math.min(64, y - heights.maxY)} down` : '';
  return (
    `; its veins lie at y ${heights.minY}-${heights.maxY}, I am at y ${y}` +
    (way === '' ? '' : `: "${way}" digs down to them, then "!tunnel <direction> 40" looks along`)
  );
}

/** What an action command's acknowledgement says it will do. */
function acknowledge(play: PlayState, cmd: OwnerCommandRecord, c: ActionCommand): string {
  const view = (play.deps.commands as CommandDeps).view();
  switch (c.verb) {
    case 'come':
      return 'coming to you';
    case 'follow':
      return c.player === null || c.player === cmd.sender
        ? 'following you'
        : `following ${c.player}`;
    case 'goto':
      return `going to ${fmt(c)}`;
    case 'tunnel': {
      const p = view.position;
      return `${describeCommand(c).replace(/^dig /, 'digging ')}${p === null ? '' : ` from ${fmt(roundPoint(p))}`}`;
    }
    case 'explore': {
      const to = exploreTarget(play, cmd, c);
      return 'problem' in to
        ? `not exploring: ${to.problem}`
        : `exploring ${to.direction.replace('_', '-')} toward ${fmt({ x: to.x, y: null, z: to.z })}`;
    }
    case 'goto-waypoint':
    case 'home': {
      const name = c.verb === 'home' ? (play.deps.commands as CommandDeps).homeName : c.name;
      const at = locations(play).get(name);
      const block = runOf(play, cmd.id).blockTo;
      if (at === undefined && block !== null) return blockAck(block);
      const where = at === undefined ? '' : ` (${fmt(at.position)})`;
      return c.verb === 'home' ? `going home${where}` : `going to ${name}${where}`;
    }
    case 'goto-block': {
      const to = blockTarget(play, cmd, c.block);
      return 'problem' in to ? `not going: ${to.problem}` : blockAck(to);
    }
    case 'surface': {
      const to = surfaceTarget(play, cmd);
      return 'problem' in to
        ? `not going up: ${to.problem}`
        : `going up to open sky at ${fmt(roundPoint(to))}`;
    }
    case 'get':
    case 'mine': {
      const have = heldOf(view.inventory ?? {}, c.item, anyKindOf(c).includes(c.item));
      const what =
        c.verb === 'get' || c.block === c.item
          ? `${c.verb === 'get' ? 'getting' : 'mining'} ${c.verb === 'get' ? c.item : c.block} until I have ${c.count}`
          : `mining ${c.block} until I have ${c.count} ${c.item}`;
      return `${what} (I have ${have})${c.verb === 'mine' ? oreDepthHint(c.item, view.position) : ''}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Instant commands
// ---------------------------------------------------------------------------

/** Cancels every action command (running or queued); what they were. */
function cancelActions(play: PlayState, why: string): string[] {
  const { repos } = play.deps;
  const actions = [repos.commands.running(), ...repos.commands.queued()].filter(
    (c): c is OwnerCommandRecord => c !== null && c.command !== null && isActionCommand(c.command),
  );
  for (const c of actions) {
    repos.commands.finish(c.id, 'cancelled', why);
    play.commandRuns.delete(c.id);
    endCommandTask(repos, c.id, 'cancelled');
  }
  return actions.map((c) => describeCommand(c.command as OwnerCommand));
}

function instant(play: PlayState, cmd: OwnerCommandRecord, c: InstantCommand): void {
  const { repos } = play.deps;
  const commands = play.deps.commands as CommandDeps;
  switch (c.verb) {
    case 'stop': {
      // The client stopped the action in progress already (a stop in chat), or a stop from
      // the command line did (live-play.ts): what is left is the command, and play's own goals.
      const stopped = cancelActions(play, `Stopped by ${cmd.sender}`);
      repos.memory.setValue(OWNER_PAUSED_KEY, `${cmd.sender} said stop`);
      finish(
        play,
        cmd,
        'done',
        `OK: stopped${stopped.length === 0 ? '' : ` (${stopped.join('; ')})`}. ` +
          'I wait for !resume or a new command',
      );
      return;
    }
    case 'pause':
      repos.memory.setValue(OWNER_PAUSED_KEY, `${cmd.sender} said pause`);
      finish(
        play,
        cmd,
        'done',
        'OK: paused my own play; commands still work. Say !resume to go on',
      );
      return;
    case 'resume': {
      repos.memory.setValue(OWNER_PAUSED_KEY, null);
      play.idle = null;
      const off = repos.memory.getValue(QUESTS_OFF_KEY) !== null;
      finish(
        play,
        cmd,
        'done',
        off ? 'OK: resumed, but quests are off: say !quests on' : 'OK: resuming my own play',
      );
      return;
    }
    case 'quests':
      if (c.on) {
        repos.memory.setValue(QUESTS_OFF_KEY, null);
        repos.memory.setValue(OWNER_PAUSED_KEY, null);
        play.idle = null;
        finish(play, cmd, 'done', 'OK: quests on');
      } else {
        repos.memory.setValue(QUESTS_OFF_KEY, `${cmd.sender} said quests off`);
        finish(play, cmd, 'done', 'OK: quests off: I only take commands now');
      }
      return;
    case 'status':
      finish(play, cmd, 'done', statusText(play));
      return;
    case 'help':
      finish(play, cmd, 'done', HELP_TEXT);
      return;
    case 'find':
      finish(play, cmd, 'done', findText(play, c.block));
      return;
    case 'sethome':
      saveLocation(play, cmd, commands.homeName);
      return;
    case 'waypoint':
      saveLocation(play, cmd, c.name);
      return;
    case 'waypoint-delete':
      deleteLocation(play, cmd, c.name);
      return;
    case 'waypoints': {
      const all = [...locations(play)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      finish(
        play,
        cmd,
        'done',
        all.length === 0
          ? 'No waypoints yet: say !waypoint <name> where you want one'
          : `Waypoints: ${all.map(([n, l]) => `${n} (${fmt(roundPoint(l.position))})`).join(', ')}`,
      );
      return;
    }
  }
}

const roundPoint = (p: Position): Position => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
  z: Math.floor(p.z),
});

/** Where the bot stands, as `name` (home: the safe location retreats go to; else a waypoint). */
function saveLocation(play: PlayState, cmd: OwnerCommandRecord, name: string): void {
  const commands = play.deps.commands as CommandDeps;
  const home = name === commands.homeName;
  const view = commands.view();
  const fail = (why: string): void => finish(play, cmd, 'failed', `Failed: ${why}`);
  if (view.position === null || view.dimension === null) return fail('my position is not known');
  if (commands.configLocations.has(name)) {
    return fail(`${name} is set in agent.config.json (locations): change it there`);
  }
  if (checkWithinBoundary(view.position, view.dimension, commands.boundary, 'here').length > 0) {
    return fail('here is outside my safety boundary');
  }
  play.deps.repos.locations.upsert(name, {
    dimension: view.dimension,
    position: { ...view.position },
    kind: home ? 'safe' : 'other',
    note: `set by ${cmd.sender}`,
  });
  finish(
    play,
    cmd,
    'done',
    `OK: ${home ? 'home' : `waypoint ${name}`} is at ${fmt(roundPoint(view.position))}`,
  );
}

function deleteLocation(play: PlayState, cmd: OwnerCommandRecord, name: string): void {
  const commands = play.deps.commands as CommandDeps;
  const fail = (why: string): void => finish(play, cmd, 'failed', `Failed: ${why}`);
  if (name === commands.homeName) {
    return fail('home is where I retreat to: move it with !sethome, it is never deleted');
  }
  if (commands.configLocations.has(name)) {
    return fail(`${name} is set in agent.config.json (locations): change it there`);
  }
  if (!play.deps.repos.locations.delete(name)) return fail(`I know no waypoint ${name}`);
  finish(play, cmd, 'done', `OK: waypoint ${name} deleted`);
}

/** Position, health, food, what it is doing, and a few items it carries. */
/**
 * An item's registry name as a chat line shows it: no namespace, "item."/"tile." prefix or
 * damage value, words split ("dreamcraft:item.CoinForestry" -> "coin forestry").
 */
export function chatItemName(item: string): string {
  const path = item.slice(item.indexOf(':') + 1).replace(/@\d+$/, '');
  return path
    .replace(/^(item|tile)\./, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `text` cut to at most `max` characters at a word, with "..." when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.:;]+$/, '')}...`;
}

function statusText(play: PlayState): string {
  const { repos } = play.deps;
  const view = (play.deps.commands as CommandDeps).view();
  const p = view.position;
  const where = p === null ? 'position unknown' : `at ${fmt(roundPoint(p))}`;
  const vitals = `health ${view.health ?? '?'}/20, food ${view.food ?? '?'}/20`;
  const running = repos.commands.running();
  const off = autonomyOff(repos);
  const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
  const task = taskId === null ? null : repos.tasks.get(taskId);
  const shelter = play.sheltered;
  const doing =
    running?.command != null
      ? `doing: ${describeCommand(running.command)}`
      : off !== null
        ? off
        : shelter !== null
          ? 'mobs' in shelter
            ? `staying in my shelter until the hostiles near it go (${shelter.mobs.slice(0, 80)})`
            : `sheltered for the night (morning in about ${Math.max(1, Math.round((shelter.until - play.now()) / 60_000))} min)`
          : task !== null && task.status === 'active'
            ? `working on: ${clip(task.goal, 80)}`
            : 'idle';
  const items = Object.entries(view.inventory ?? {})
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, 4)
    .map(([item, n]) => `${n} ${chatItemName(item)}`);
  return `${where}, ${vitals}; ${doing}${items.length === 0 ? '' : `; carrying ${items.join(', ')}`}`;
}

// ---------------------------------------------------------------------------
// The command round: the running action command
// ---------------------------------------------------------------------------

/**
 * Hears and handles the commands that came, then runs one session of the running action
 * command: a travel command's steps (travelRound), or its goal (goalRound). Null when there
 * is no action command to run (or it waits for food): the next kind of round goes on.
 */
export async function commandRound(play: PlayState): Promise<RoundEnd> {
  if (play.deps.commands === undefined) return null;
  await takeCommands(play, 'day');
  const running = play.deps.repos.commands.running();
  const command = running?.command ?? null;
  if (running === null || command === null || !isActionCommand(command)) return null;
  // A food bar nearly empty keeps priority (food.ts): the command waits for the food trip.
  const fed = play.deps.food === undefined ? null : await play.deps.food.now();
  if (fed !== null && starving(fed)) {
    sayOnce(
      play,
      running,
      'food',
      `My food bar is nearly empty (food ${fed.hunger}/20): I get food first, then I ${describeCommand(command)}`,
    );
    return null;
  }
  return isTravelCommand(command)
    ? travelRound(play, running, command)
    : command.verb === 'tunnel'
      ? tunnelRound(play, running, command)
      : goalCommandRound(play, running, command);
}

/**
 * One session of an owner's tunnel: the next few cells, planned by code from where the bot
 * stands (PlayDeps.tunnel: tunnel.ts), run as known safe steps, each validated, executed and
 * verified by the executor. It starts where the bot stood when the command began. Done at its
 * length; failed, saying why and how far it got, when the next cell may not be dug (a fluid,
 * a cave floor, a block it cannot harvest...), when a step fails, or after sessions with no
 * cell gained. Dusk, a food bar nearly empty and an owner's new command interrupt it, as they
 * do a trip.
 */
async function tunnelRound(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: TunnelCommand,
): Promise<PlayResult | 'next-round'> {
  const { deps, limits, hooks } = play;
  const run = runOf(play, cmd.id);
  const fail = (why: string): 'next-round' => {
    finish(play, cmd, 'failed', `Failed: ${why}`.slice(0, 400));
    return 'next-round';
  };
  if (deps.tunnel === undefined) return fail('I cannot dig a tunnel here');
  if (run.tunnelFrom === null) {
    const at = (deps.commands as CommandDeps).view().position;
    if (at === null) return fail('I do not know where I am');
    run.tunnelFrom = { x: Math.floor(at.x), y: Math.floor(at.y + 1e-6), z: Math.floor(at.z) };
  }
  const plan = await deps.tunnel({
    start: run.tunnelFrom,
    direction: command.direction,
    length: command.length,
    slope: command.slope,
  });
  if (plan === null) {
    // Just after joining or respawning the chunks are still coming: wait a moment between tries.
    run.failures += 1;
    if (run.failures >= MAX_COMMAND_FAILURES) return fail('the blocks around me are not known');
    await play.sleep(TUNNEL_RETRY_MS);
    return 'next-round';
  }
  if (!plan.ok) return fail(plan.reason);
  const dug = `${plan.done} of ${command.length} blocks dug`;
  if (plan.steps.length === 0) {
    if (plan.done >= command.length) {
      finish(play, cmd, 'done', `Done: ${describeCommand(command).replace(/^dig /, 'dug ')}`);
      return 'next-round';
    }
    return fail(`${plan.problem ?? 'there is nothing to dig'} (${dug})`);
  }
  run.stuck = run.tunnelDone !== null && plan.done <= run.tunnelDone ? run.stuck + 1 : 0;
  run.tunnelDone = plan.done;
  if (run.stuck >= limits.maxStuckSessions) {
    return fail(`no progress in ${run.stuck} sessions (${play.lastStop}; ${dug})`);
  }
  let dark: WorldTime | null = null;
  let hungry: FoodStatus | null = null;
  let preempted: string | null = null;
  const result = await blueprintSession(play, {
    taskId: commandTaskId(cmd.id),
    goal: `Owner command #${cmd.id} from ${cmd.sender}: ${describeCommand(command)} (code digs it)`,
    subgoal: dug,
    steps: plan.steps.map((s, i) => `${i + 1}. ${s.text}`),
    known: plan.steps,
    label: `owner command #${cmd.id}`,
    text: `${describeCommand(command)} (${dug})`,
    missing: {},
    maxCycles: plan.steps.length * 2 + 2,
    stopRequested: () =>
      dark !== null
        ? nightReason(dark)
        : hungry !== null
          ? 'the food bar is nearly empty'
          : ((preempted ??= commandWaiting(play)) ?? hooks.stopRequested()),
    onCycle: (r) => {
      const after = r.outcome?.stateAfter;
      if (
        after?.time.known === true &&
        (deps.shelter === undefined ? isDark(after.time.value) : nightSoon(after.time.value))
      ) {
        dark = after.time.value;
      }
      const fed = after === undefined || after === null ? null : (deps.food?.of(after) ?? null);
      if (fed !== null && starving(fed)) hungry = fed;
    },
  });
  play.lastStop = result.stopReason;
  if (dark !== null) {
    sayOnce(
      play,
      cmd,
      'dusk',
      `It is getting dark: I shelter for the night, then I ${describeCommand(command)}`,
    );
    return 'next-round';
  }
  const mob = mobPause(result.stopKind, play.lastDecision);
  if (mob !== null) return waitOutMob(play, commandTaskId(cmd.id), mob);
  if (result.stopKind === 'cycle-failed' || result.stopKind === 'needs-attention') {
    return fail(`${result.stopReason} (${dug})`);
  }
  run.failures = 0;
  return 'next-round';
}

/** Where a travel command goes now (a player may have moved), or why it cannot go. */
function travelTarget(
  play: PlayState,
  cmd: OwnerCommandRecord,
  c: TravelCommand,
): { target: TravelTarget } | { problem: string } {
  const commands = play.deps.commands as CommandDeps;
  switch (c.verb) {
    case 'come':
    case 'follow': {
      const who = c.verb === 'follow' && c.player !== null ? c.player : cmd.sender;
      const at = commands.view().playerAt(who);
      if (at === null) {
        return { problem: `I cannot see ${who === cmd.sender ? 'you' : who} from here` };
      }
      return {
        target: {
          kind: 'near',
          point: at,
          within: c.verb === 'come' ? COME_WITHIN : FOLLOW_WITHIN,
          // Follow walks about a second at a time and plans again: the owner moves on.
          ...(c.verb === 'follow' ? { step: true } : {}),
        },
      };
    }
    case 'goto':
      return { target: { kind: 'point', point: { x: c.x, y: c.y, z: c.z } } };
    case 'explore': {
      const to = exploreTarget(play, cmd, c);
      return 'problem' in to
        ? to
        : { target: { kind: 'point', point: { x: to.x, y: null, z: to.z } } };
    }
    case 'surface': {
      const to = surfaceTarget(play, cmd);
      return 'problem' in to ? to : { target: { kind: 'point', point: to } };
    }
    case 'goto-block': {
      const to = blockTarget(play, cmd, c.block);
      return 'problem' in to ? to : { target: blockTravel(to) };
    }
    case 'goto-waypoint':
    case 'home': {
      const name = c.verb === 'home' ? commands.homeName : c.name;
      const at = locations(play).get(name);
      const block = runOf(play, cmd.id).blockTo;
      if (at === undefined && block !== null) return { target: blockTravel(block) };
      return at === undefined
        ? { problem: `the waypoint ${name} is gone` }
        : { target: { kind: 'point', point: at.position } };
    }
  }
}

/** Where a block command heads: one in view (near it), or a place world memory keeps. */
type BlockTo = CommandRun['blockTo'] & object;

/** Kinds of one block that `!find` and `!goto <block>` count as it (any log is a log). */
const SAME_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  'minecraft:log': ['minecraft:log', 'minecraft:log2'],
  'minecraft:water': ['minecraft:water', 'minecraft:flowing_water'],
};

/** World memory's kind of place for a block an owner names (world-memory.ts PLACE_KINDS). */
const REMEMBERED_AS: Readonly<Record<string, PlaceKind>> = {
  'minecraft:log': 'log',
  'minecraft:log2': 'log',
  'minecraft:dirt': 'dirt',
  'minecraft:grass': 'dirt',
  'minecraft:sand': 'sand',
  'minecraft:gravel': 'gravel',
  'minecraft:clay': 'clay',
  'minecraft:water': 'water',
  'minecraft:stone': 'stone',
  'gregtech:gt.blockores': 'ore',
};

/** How near a block `!goto <block>` stops (across, from its centre). */
const BLOCK_WITHIN = 2.5;

/**
 * Where a block command heads, fixed when it begins (so it does not switch blocks on the
 * way): the nearest such block the bot sees (a face open to air), else the nearest place
 * world memory keeps for its kind (logs, sand, water...).
 */
function blockTarget(
  play: PlayState,
  cmd: OwnerCommandRecord,
  block: string,
): BlockTo | { problem: string } {
  const run = runOf(play, cmd.id);
  if (run.blockTo !== null) return run.blockTo;
  const found = findNear(play, block);
  if ('problem' in found) return found;
  run.blockTo = found;
  return found;
}

/** The nearest block of a kind in view, else a remembered place of it, else why none. */
function findNear(play: PlayState, block: string): BlockTo | { problem: string } {
  const commands = play.deps.commands as CommandDeps;
  if (commands.findBlock === undefined) return { problem: 'I cannot look for blocks here' };
  const seen = commands.findBlock(SAME_BLOCKS[block] ?? [block])[0];
  if (seen !== undefined) {
    return { block, position: { ...seen.position }, distance: seen.distance, seen: true };
  }
  const place = rememberedPlace(play, block);
  return place ?? { problem: `I see no ${block} near here, and remember none` };
}

/** The nearest place world memory keeps for the block's kind, or null. */
function rememberedPlace(play: PlayState, block: string): BlockTo | null {
  const kind = REMEMBERED_AS[block];
  const commands = play.deps.commands as CommandDeps;
  const view = commands.view();
  if (kind === undefined || view.position === null || view.dimension === null) return null;
  const summary = summarizeExploration({
    chunks: play.deps.repos.worldMemory.chunks(view.dimension),
    from: view.position,
    boundary: commands.boundary,
    now: new Date(play.now()),
  });
  const place = summary.places.find((p) => p.resource === kind);
  if (place === undefined) return null;
  return {
    block,
    position: { x: place.x, y: place.y, z: place.z },
    distance: place.distance,
    seen: false,
  };
}

const blockAck = (to: BlockTo): string =>
  to.seen
    ? `going to the ${to.block} at ${fmt(to.position)}`
    : `going to where I remember ${to.block} (${fmt(to.position)}, ${blocks(Math.round(to.distance))} away)`;

/** A block in view: near it; a remembered place: to it (its column, when y is not known). */
const blockTravel = (to: BlockTo): TravelTarget =>
  to.seen && to.position.y !== null
    ? {
        kind: 'near',
        point: { x: to.position.x + 0.5, y: to.position.y, z: to.position.z + 0.5 },
        within: BLOCK_WITHIN,
      }
    : { kind: 'point', point: { ...to.position } };

/** What `!find` says: the nearest blocks of a kind in view, else a remembered place. */
function findText(play: PlayState, block: string): string {
  const commands = play.deps.commands as CommandDeps;
  if (commands.findBlock === undefined) return 'I cannot look for blocks here';
  const seen = commands.findBlock(SAME_BLOCKS[block] ?? [block]);
  const [first, ...rest] = seen;
  if (first !== undefined) {
    const also = rest
      .slice(0, 3)
      .map((f) => `${fmt(f.position)} (${Math.round(f.distance)})`)
      .join(', ');
    return (
      `${block}: the nearest at ${fmt(first.position)}, ${blocks(Math.round(first.distance))} away` +
      (also === '' ? '' : `; also ${also}`)
    );
  }
  const place = rememberedPlace(play, block);
  return place === null
    ? `I see no ${block} near here, and remember none`
    : `I see no ${block} near here; I remember some at ${fmt(place.position)}, ${blocks(Math.round(place.distance))} away`;
}

/**
 * Where an explore command heads: `distance` blocks toward its direction (or, with none, the
 * one world memory has seen least: wanderTarget) from where the bot stood when it began, no
 * farther than the room left to the safety boundary that way; fixed then, so it does not
 * move on with the bot.
 */
function exploreTarget(
  play: PlayState,
  cmd: OwnerCommandRecord,
  c: Extract<TravelCommand, { verb: 'explore' }>,
): { x: number; z: number; direction: string } | { problem: string } {
  const run = runOf(play, cmd.id);
  if (run.exploreTo !== null) return run.exploreTo;
  const commands = play.deps.commands as CommandDeps;
  const view = commands.view();
  const at = view.position;
  if (at === null || view.dimension === null) return { problem: 'I do not know where I am' };
  const summary = summarizeExploration({
    chunks: play.deps.repos.worldMemory.chunks(view.dimension),
    from: at,
    boundary: commands.boundary,
    now: new Date(play.now()),
  });
  const direction = c.direction ?? wanderTarget(summary, at, MIN_EXPLORE_DISTANCE)?.direction;
  if (direction === undefined) return { problem: 'no way out of my safety boundary is left' };
  const room = summary.directions[direction]?.room ?? 0;
  const distance = Math.min(c.distance, room);
  if (distance < MIN_EXPLORE_DISTANCE) {
    return {
      problem: `my safety boundary is ${room} blocks ${direction.replace('_', '-')} of here`,
    };
  }
  const u = COMPASS[direction];
  run.exploreTo = {
    x: Math.round(at.x + u.x * distance),
    z: Math.round(at.z + u.z * distance),
    direction,
  };
  return run.exploreTo;
}

/** Where a surface command heads: the open-sky cell found when it began (surfaceTarget). */
function surfaceTarget(play: PlayState, cmd: OwnerCommandRecord): Position | { problem: string } {
  const run = runOf(play, cmd.id);
  if (run.surfaceTo !== null) return run.surfaceTo;
  const find = (play.deps.commands as CommandDeps).surface;
  if (find === undefined) return { problem: 'I cannot look for the surface here' };
  const to = find();
  if ('problem' in to) return to;
  run.surfaceTo = to.point;
  return run.surfaceTo;
}

const blocks = (n: number): string => `${n} block${n === 1 ? '' : 's'}`;

function arrivedText(play: PlayState, c: TravelCommand, distance: number): string {
  switch (c.verb) {
    case 'come':
    case 'follow':
      return `Done: here, ${blocks(distance)} from you`;
    case 'goto':
      return `Done: at ${fmt(c)}`;
    case 'explore':
      return `Done: explored ${c.distance} blocks${c.direction === null ? '' : ` ${c.direction.replace('_', '-')}`}`;
    case 'surface':
      return 'Done: under open sky';
    case 'goto-waypoint':
      return `Done: at ${c.name}`;
    case 'goto-block':
      return `Done: at the ${c.block}`;
    case 'home':
      return `Done: home (${(play.deps.commands as CommandDeps).homeName})`;
  }
}

/** Following a player already near: a moment's wait (System 1 still decides first). */
const waitStep = (distance: number): TravelStep & { kind: 'step' } => ({
  kind: 'step',
  spec: { type: 'WAIT', args: { durationMs: FOLLOW_WAIT_MS } },
  text: 'wait a moment: near enough',
  distance,
});

/**
 * Makes `step` the command task's one known step (and the task active and current): System 1's
 * rule 6 runs it as EXECUTE_KNOWN_SAFE_STEP after its reflexes, the executor checks it.
 */
function armStep(
  repos: Repositories,
  taskId: string,
  goal: string,
  step: TravelStep & { kind: 'step' },
): void {
  repos.transaction(() => {
    repos.tasks.ensure({
      id: taskId,
      goal: goal.slice(0, 300),
      subgoal: step.text.slice(0, 300),
      status: 'active',
    });
    repos.tasks.setStatus(taskId, 'active');
    repos.memory.setTaskRequirements(taskId, null);
    repos.memory.setTaskBlueprint(taskId, [step.text.slice(0, 300)]);
    setKnownSteps(repos, taskId, [{ spec: step.spec, text: step.text }]);
    repos.memory.setValue(CURRENT_TASK_KEY, taskId);
  });
}

/**
 * One session of a travel command: its next step, re-planned from what the bot knows after
 * every cycle (follow keeps on doing so: a step toward the player, or a moment's wait near
 * it), until it arrives, a step cannot be planned or fails, a new command comes, the night or
 * a nearly empty food bar takes over, or the session's limits.
 */
async function travelRound(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: TravelCommand,
): Promise<PlayResult | 'next-round'> {
  const { deps, limits, hooks } = play;
  const commands = deps.commands as CommandDeps;
  const run = runOf(play, cmd.id);
  const follow = command.verb === 'follow';
  const plan = (): TravelStep => {
    const t = travelTarget(play, cmd, command);
    return 'problem' in t ? { kind: 'refused', reason: t.problem } : commands.step(t.target);
  };
  const first = plan();
  if (first.kind === 'arrived' && !follow) {
    finish(play, cmd, 'done', arrivedText(play, command, first.distance));
    return 'next-round';
  }
  if (first.kind === 'refused') return travelFailed(play, cmd, first.reason);
  const taskId = commandTaskId(cmd.id);
  const goal = `Owner command #${cmd.id} from ${cmd.sender}: ${describeCommand(command)}`;
  armStep(deps.repos, taskId, goal, first.kind === 'step' ? first : waitStep(first.distance));

  let ended: TravelStep | null = null;
  let dark: WorldTime | null = null;
  let hungry: FoodStatus | null = null;
  let preempted: string | null = null;
  let distance = first.distance;
  const session = play.sessions + 1;
  const result = await deps.session(limits.session, {
    stopRequested: () =>
      dark !== null
        ? nightReason(dark)
        : hungry !== null
          ? 'the food bar is nearly empty'
          : ((preempted ??= commandWaiting(play)) ?? hooks.stopRequested()),
    onCycle: (r, index) => {
      play.lastDecision = r.decision ?? null;
      play.emit(cycleEvent(deps.repos, session, r, index));
      const after = r.outcome?.stateAfter;
      if (
        after?.time.known === true &&
        (deps.shelter === undefined ? isDark(after.time.value) : nightSoon(after.time.value))
      ) {
        dark = after.time.value;
      }
      const fed = after === undefined || after === null ? null : (deps.food?.of(after) ?? null);
      if (fed !== null && starving(fed)) hungry = fed;
      // The next step, from what the bot knows now: the player may have moved.
      const next = plan();
      if (next.kind === 'step' || (next.kind === 'arrived' && follow)) {
        distance = next.distance;
        armStep(deps.repos, taskId, goal, next.kind === 'step' ? next : waitStep(next.distance));
      } else {
        ended = next;
        // No step left: the session ends at its next check.
        setKnownSteps(deps.repos, taskId, null);
        const task = deps.repos.tasks.get(taskId);
        if (task !== null && task.status === 'active')
          deps.repos.tasks.setStatus(taskId, 'completed');
      }
    },
  });
  play.sessions = session;
  play.lastStop = result.stopReason;
  play.emit({
    kind: 'session-end',
    session,
    stopKind: result.stopKind,
    stopReason: result.stopReason,
    cycles: result.cycles.length,
    system1: result.system1,
  });

  const end = ended as TravelStep | null;
  if (end?.kind === 'arrived') {
    finish(play, cmd, 'done', arrivedText(play, command, end.distance));
    return 'next-round';
  }
  if (end?.kind === 'refused') return travelFailed(play, cmd, end.reason);
  if (dark !== null) {
    sayOnce(
      play,
      cmd,
      'dusk',
      `It is getting dark: I shelter for the night, then I ${describeCommand(command)}`,
    );
    return 'next-round';
  }
  const mob = mobPause(result.stopKind, play.lastDecision);
  if (mob !== null) return waitOutMob(play, taskId, mob);
  if (result.stopKind === 'cycle-failed' || result.stopKind === 'needs-attention') {
    return travelFailed(play, cmd, result.stopReason);
  }
  // A step went: the failures in a row are over. A long trip says how far is left.
  run.failures = 0;
  if (!follow && command.verb !== 'come') {
    if (run.reportedDistance === null) run.reportedDistance = distance;
    else if (run.reportedDistance - distance >= PROGRESS_EVERY) {
      run.reportedDistance = distance;
      say(play, cmd, `On my way: ${blocks(Math.round(distance))} to go`);
    }
  }
  return 'next-round';
}

/**
 * A travel step failed or could not be planned. Not seeing the player ends come and follow
 * at once; anything else fails the command after MAX_COMMAND_FAILURES in a row, and is
 * planned again a moment later (the world may have changed: a mob gone, a chunk arrived).
 */
async function travelFailed(
  play: PlayState,
  cmd: OwnerCommandRecord,
  reason: string,
): Promise<'next-round'> {
  const run = runOf(play, cmd.id);
  run.failures += 1;
  run.lastFailure = reason;
  if (/^I cannot see /.test(reason) || run.failures >= MAX_COMMAND_FAILURES) {
    finish(play, cmd, 'failed', `Failed: ${reason}`);
  } else {
    await play.sleep(TRAVEL_RETRY_MS);
  }
  return 'next-round';
}

/** A get or mine command as a goal of items to have, under the command's own task. */
function freeGoalOf(cmd: OwnerCommandRecord, c: GoalCommand): FreeGoal {
  return {
    taskId: commandTaskId(cmd.id),
    name: `${describeCommand(c)} (owner command #${cmd.id} from ${cmd.sender})`.slice(0, 300),
    requirements: { [c.item]: c.count },
    anyKind: anyKindOf(c),
  };
}

/**
 * A goal command's items of which every kind and wear counts: one named without a damage
 * value ("logs": any wood).
 */
function anyKindOf(c: GoalCommand): string[] {
  return c.item.includes('@') ? [] : [c.item];
}

/**
 * One session of a get or mine command: its goal pursued exactly like `cli play --needs`'s
 * (the planner plans from its route, GATHER digs). Done once the inventory holds the items;
 * halfway is told once; it fails after maxStuckSessions sessions with no fewer items missing
 * (new ground seen counts as progress), or when its task needs a person.
 */
async function goalCommandRound(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: GoalCommand,
): Promise<PlayResult | 'next-round'> {
  const { deps, limits } = play;
  const run = runOf(play, cmd.id);
  const free = freeGoalOf(cmd, command);
  const inventory = await deps.inventory();
  if (inventory === null) {
    run.failures += 1;
    if (run.failures >= MAX_COMMAND_FAILURES) {
      finish(play, cmd, 'failed', 'Failed: my inventory is not known');
    }
    return 'next-round';
  }
  const have = heldOf(inventory, command.item, free.anyKind?.includes(command.item) === true);
  if (have >= command.count) {
    reachGoal(deps.repos, free);
    finish(play, cmd, 'done', `Done: I have ${have} ${command.item}`);
    return 'next-round';
  }
  // Halfway through what was missing when the command began, not through the count: seen
  // live, "get me 14 dirt" holding 12 said "Halfway: 12/14" before it had dug anything.
  run.startHave ??= have;
  if (have > run.startHave && (have - run.startHave) * 2 >= command.count - run.startHave) {
    sayOnce(play, cmd, 'half', `Halfway: ${have}/${command.count} ${command.item}`);
  }
  const missing = missingFor(free.requirements, inventory, free.anyKind);
  const left = total(missing);
  // Progress: fewer missing, new ground seen, or work on the way there (more of anything: a
  // pickaxe from nothing takes logs, flint, a table... before the pickaxe itself; seen live
  // 2026-10-04, such sessions counted as none and the command failed). A session System 1
  // ended with a reflex (a retreat from a mob, a fight, a meal, a rest) was interrupted, not
  // stuck: it counts neither way (seen live the same day: three retreats from mobs failed a
  // pickaxe command for "no progress").
  if (!run.interrupted) {
    run.stuck =
      run.missing !== null && left >= run.missing && !play.explored && !run.worked
        ? run.stuck + 1
        : 0;
  }
  run.worked = false;
  run.interrupted = false;
  run.missing = left;
  if (run.stuck >= limits.maxStuckSessions) {
    finish(play, cmd, 'failed', `Failed: no progress in ${run.stuck} sessions (${play.lastStop})`);
    return 'next-round';
  }
  const current = freeRoundGoal(deps.repos, free, missing);
  const adopted = current.adopt();
  if (adopted.status !== 'active') {
    finish(play, cmd, 'failed', `Failed: its task is ${adopted.status} (${play.lastStop})`);
    return 'next-round';
  }
  play.emit({
    kind: 'goal',
    quest: current.name,
    goal: current.text,
    missing,
    taskId: adopted.taskId,
    created: adopted.created,
  });
  // Only a food bar nearly empty ends an owner's goal for food: hunger alone waits for it.
  const ended = await runGoalSession(play, current, starving);
  // Work on the way: more of anything than before the session (logs, flint, planks...).
  const after = await deps.inventory();
  run.worked =
    after !== null && Object.entries(after).some(([item, n]) => n > (inventory[item] ?? 0));
  run.interrupted = play.lastDecision !== null && REFLEXES.has(play.lastDecision.decision);
  if (ended.dark !== null) {
    sayOnce(
      play,
      cmd,
      'dusk',
      `It is getting dark: I shelter for the night, then I ${describeCommand(command)}`,
    );
    return 'next-round';
  }
  if (ended.met || ended.preempted !== null || ended.hungry !== null) return 'next-round';
  const mob = mobPause(ended.result.stopKind, play.lastDecision);
  if (mob !== null) return waitOutMob(play, adopted.taskId, mob);
  if (ended.result.stopKind === 'needs-attention' || ended.result.stopKind === 'task-halted') {
    finish(play, cmd, 'failed', `Failed: ${ended.result.stopReason}`);
  }
  return 'next-round';
}

// ---------------------------------------------------------------------------
// Idle (cli play --listen)
// ---------------------------------------------------------------------------

/** The idle bot's one step: a moment's wait, after System 1's reflexes. */
const STANDBY_STEP = {
  spec: { type: 'WAIT' as const, args: { durationMs: 1_000 } },
  text: 'stand by: System 1 acts first (a retreat, a fight, a meal, a rest)',
};

/**
 * Play has nothing of its own to do: an owner paused it (or turned quests off), or with
 * --listen, nothing is left (play.idle). With --listen it waits for commands (and looks for
 * something to do again after IDLE_RETRY_MS); without, play ends and says why. Null when play
 * is not idle.
 */
export async function idleRound(play: PlayState): Promise<RoundEnd> {
  if (play.idle !== null && play.now() - play.idle.since >= IDLE_RETRY_MS) play.idle = null;
  const off = autonomyOff(play.deps.repos);
  const why = off ?? play.idle?.reason ?? null;
  if (why === null) return null;
  if (play.deps.listen !== true) {
    return done(play, `${why}: nothing else to do (cli play --listen stays online for commands)`);
  }
  await idleFor(play, why);
  return 'next-round';
}

/**
 * Waits up to IDLE_POLLS x IDLE_POLL_MS for a command (or the stop file), then lets System 1
 * act if it must (standby): a mob near, low health, a meal. A bot standing idle is still
 * defended, fed and rested like a playing one.
 */
export async function idleFor(play: PlayState, why: string): Promise<void> {
  if (play.idleNote !== why) {
    play.idleNote = why;
    play.emit({ kind: 'idle', message: `${why}; waiting for commands` });
  }
  for (let i = 0; i < IDLE_POLLS; i++) {
    if (play.hooks.stopRequested() !== null || commandWaiting(play) !== null) return;
    await play.sleep(IDLE_POLL_MS);
  }
  const call = (await play.deps.commands?.standby?.()) ?? null;
  if (call === null) return;
  if (call.kind === 'mob') {
    play.emit({ kind: 'idle', message: `a mob is near (${call.reasons}): waiting offline` });
    play.mobAlarm = call.reasons;
    return;
  }
  const reflex = call.text;
  play.emit({ kind: 'idle', message: `standing by: ${reflex}` });
  await blueprintSession(play, {
    taskId: STANDBY_TASK_ID,
    goal: 'Stand by for owner commands: System 1 acts first (a retreat, a fight, a meal, a rest)',
    subgoal: reflex.slice(0, 300),
    steps: [STANDBY_STEP.text],
    known: [STANDBY_STEP],
    label: 'stand by',
    text: reflex,
    missing: {},
    maxCycles: 3,
  });
}

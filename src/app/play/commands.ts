import { heldOf } from '../../domain/common.ts';
import {
  blockName,
  describeCommand,
  HELP_TEXT,
  isActionCommand,
  isStructured,
  isTravelCommand,
  parseOwnerCommand,
  type ActionCommand,
  type InstantCommand,
  type OwnerCommand,
} from '../../domain/owner-commands.ts';
import { gtOreByName } from '../../goals/ore-names.ts';
import {
  CURRENT_TASK_KEY,
  OWNER_PAUSED_KEY,
  QUESTS_OFF_KEY,
} from '../../persistence/memory-repository.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import { checkWithinBoundary } from '../../safety/coordinate-boundaries.ts';
import { starving } from './food.ts';
import { blueprintSession } from './night.ts';
import { autonomyOff, commandWaiting, done, type PlayState, type RoundEnd } from './play-state.ts';

import {
  endCommandTask,
  finish,
  fmt,
  locations,
  NOT_UNDERSTOOD,
  outsideBoundary,
  roundPoint,
  runOf,
  sayOnce,
  type CommandDeps,
} from './command-base.ts';
import { oreDepthHint, stripMines, tunnelRound } from './command-dig.ts';
import { blockAck, blockTarget, findOreText, findText } from './command-find.ts';
import { anyKindOf, goalCommandRound } from './command-goal.ts';
import { exploreTarget, surfaceTarget, travelRound } from './command-travel.ts';

// What play, the command line and the tests use of the owners' commands.
export {
  NOT_UNDERSTOOD,
  type CommandDeps,
  type CommandView,
  type StandbyCall,
} from './command-base.ts';

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

/** Idle: commands are looked for this often, this many times, before play looks around again. */
export const IDLE_POLL_MS = 500;
const IDLE_POLLS = 20;
/** Idle with nothing to do: play looks for something to do again after this long. */
export const IDLE_RETRY_MS = 120_000;
/** The task the idle bot stands by under, when System 1 must act (standby). */
export const STANDBY_TASK_ID = 'owner-standby';

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

/** Why an action command cannot even start, or null. */
function checkAction(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: ActionCommand,
): string | null {
  const commands = play.deps.commands as CommandDeps;
  switch (command.verb) {
    case 'come':
    case 'follow': {
      if (
        command.verb === 'follow' &&
        command.player !== null &&
        !commands.owners.includes(command.player)
      ) {
        return `I follow only my owners (${commands.owners.join(', ')})`;
      }
      // Not seen now (logged off, or out of view): said at once, before any "OK".
      const who =
        command.verb === 'follow' && command.player !== null ? command.player : cmd.sender;
      return commands.view().playerAt(who) === null
        ? `I cannot see ${who === cmd.sender ? 'you' : who} from here`
        : null;
    }
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
    case 'tunnel':
      return null;
  }
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
      if ('problem' in to) return `not going up: ${to.problem}`;
      const p = view.position;
      const here =
        p !== null &&
        Math.floor(p.x) === Math.floor(to.x) &&
        Math.floor(p.y + 1e-6) === Math.floor(to.y + 1e-6) &&
        Math.floor(p.z) === Math.floor(to.z);
      return here ? 'under open sky already' : `going up to open sky at ${fmt(roundPoint(to))}`;
    }
    case 'get':
    case 'mine': {
      const have = heldOf(view.inventory ?? {}, c.item, anyKindOf(c).includes(c.item));
      const what =
        c.verb === 'get' || c.block === c.item
          ? `${c.verb === 'get' ? 'getting' : 'mining'} ${c.verb === 'get' ? c.item : c.block} until I have ${c.count}`
          : `mining ${c.block} until I have ${c.count} ${c.item}`;
      // A GregTech ore it strip-mines for needs no hint of where its veins lie.
      const hint =
        c.verb === 'mine' && !stripMines(play, c) ? oreDepthHint(c.item, view.position) : '';
      return `${what} (I have ${have})${hint}`;
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
      finish(
        play,
        cmd,
        'done',
        c.item === undefined ? findText(play, c.block) : findOreText(play, c.item),
      );
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

/** Position, health, food, what it is doing, and a few items it carries. */
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
  const result = await blueprintSession(play, {
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
  // A retreat from a mob that could not run (no way home, or refused after failing there
  // before): the mob is waited out offline, as a pause for one is, not tried again every few
  // seconds (seen live 2026-10-04: 37 refused retreats in a row, from a pit the morning had
  // opened).
  const last = play.lastDecision;
  if (
    result.stopKind === 'cycle-failed' &&
    last !== null &&
    last.decision === 'RETREAT_HOME' &&
    (last.reasonCodes.includes('HOSTILES_NEARBY') ||
      last.reasonCodes.includes('UNCLASSIFIED_ENTITY_NEARBY'))
  ) {
    const reasons = last.reasonCodes.join(', ');
    play.emit({
      kind: 'idle',
      message: `a mob is near and no retreat works (${reasons}): waiting offline`,
    });
    play.mobAlarm = reasons;
  }
}

import { heldOf } from '../../domain/common.ts';
import {
  blockName,
  describeCommand,
  HELP_TEXT,
  isActionCommand,
  isStopText,
  isStructured,
  isTravelCommand,
  parseOwnerCommand,
  type ActionCommand,
  type InstantCommand,
  type OwnerCommand,
} from '../../domain/owner-commands.ts';
import { gtOreByItem, gtOreByName } from '../../goals/ore-names.ts';
import {
  CURRENT_TASK_KEY,
  OWNER_PAUSED_KEY,
  QUESTS_OFF_KEY,
} from '../../persistence/memory-repository.ts';
import type { DecisionResult } from '../../domain/decisions.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { checkWithinBoundary } from '../../safety/coordinate-boundaries.ts';
import { starving } from './food.ts';
import { blueprintSession } from './night.ts';
import {
  autonomyOff,
  commandWaiting,
  done,
  mobPause,
  type PlayState,
  type RoundEnd,
} from './play-state.ts';

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

/**
 * Idle: commands are looked for this often, this many times, before play looks around again
 * (the standby: a mob near, low health, a meal). Every 3 s: in 10 s a creeper closes in from
 * the edge of the scan (seen live 2026-10-04: the bot stood idle in a ravine of mobs and was
 * killed).
 */
export const IDLE_POLL_MS = 500;
const IDLE_POLLS = 6;
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
export function intake(play: PlayState): void {
  const commands = play.deps.commands;
  if (commands === undefined) return;
  for (const heard of commands.take()) {
    // A stop in plain words is a stop, never left to a model (isStopText).
    const parsed: ReturnType<typeof parseOwnerCommand> = isStopText(heard.text)
      ? { ok: true, command: { verb: 'stop' } }
      : parseOwnerCommand(heard.text, { ore: gtOreByName });
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
    // Plain words that start like a command but do not fit it ("come back home", "stop that")
    // are natural language: the translator takes them. A `!` command gets its usage at once.
    const plain = !isStructured(heard.text) && commands.translate !== undefined;
    if (parsed.kind === 'usage' && !plain) finish(play, record, 'failed', parsed.usage);
    else if (!plain) finish(play, record, 'failed', NOT_UNDERSTOOD);
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
  for (const cmd of play.deps.repos.commands.queued()) {
    // One before it may have ended it (a stop cancels the commands before it).
    if (play.deps.repos.commands.get(cmd.id)?.status !== 'queued') continue;
    await handleQueued(play, cmd, mode);
  }
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
  // A command that cannot even start fails at once, by night too (not promised for the
  // morning), and replaces nothing (an independent review, 2026-10-04: a !come out of sight
  // failed and still cancelled the !get it came after). By night the owner's whereabouts are not
  // checked (they may step out of view and back by the morning; a block, a direction or the
  // surface is still looked for from the shelter), and the command waits, replacing the running
  // one only when it starts (an independent review, 2026-10-05: a !come at night failed when
  // its owner stepped away, after it had replaced the !get).
  const problem = checkAction(play, cmd, command, mode);
  if (problem !== null) {
    finish(play, cmd, 'failed', `Failed: ${problem}`);
    return;
  }
  if (mode === 'night') {
    // It will replace the running one in the morning, and says so now (an independent review,
    // 2026-10-05: the last word of the night promised the old command).
    const old = [repos.commands.running(), ...repos.commands.queued().filter((q) => q.id < cmd.id)]
      .filter(
        (c): c is OwnerCommandRecord =>
          c !== null && c.id !== cmd.id && c.command !== null && isActionCommand(c.command),
      )
      .map((c) => describeFor(c, cmd.sender));
    sayOnce(play, cmd, nightKey(play), nightNote(play, command, old));
    return;
  }
  // With a newer action command waiting that can start too, this one waits for it: the newer
  // replaces it as it starts, one "OK ... (instead of: ...)", rather than "OK" for this one and
  // "instead of" it a moment later (two commands waited out the night, say).
  if (newerStarts(play, cmd)) return;
  // One action command at a time: the newest replaces the others, and says so.
  const replaced = replaceOthers(play, cmd, command);
  const instead = replaced.length === 0 ? '' : ` (instead of: ${replaced.join('; ')})`;
  const ack = `OK: ${acknowledge(play, cmd, command)}${instead}`;
  repos.commands.start(cmd.id, ack);
  commands.reply(cmd.sender, ack);
  play.emit({ kind: 'command', id: cmd.id, sender: cmd.sender, message: ack });
}

const nightNote = (play: PlayState, c: OwnerCommand, instead: readonly string[] = []): string => {
  const shelter = play.sheltered;
  const then = `then I ${describeCommand(c)}${instead.length === 0 ? '' : ` (instead of: ${instead.join('; ')})`}`;
  if (shelter !== null && 'mobs' in shelter) {
    return `Hostiles are near my shelter: I stay inside until they go, ${then}`;
  }
  const minutes =
    shelter === null ? null : Math.max(1, Math.round((shelter.until - play.now()) / 60_000));
  const when = minutes === null ? 'morning' : `morning (in about ${minutes} min)`;
  return `It is night: I stay in my shelter until ${when}, ${then}`;
};

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
  const { repos } = play.deps;
  const running = repos.commands.running();
  // Not with a newer action command waiting: that one replaces it in the morning, and its own
  // note said so (an independent review, 2026-10-05).
  const newer = repos.commands
    .queued()
    .some(
      (q) =>
        running !== null && q.id > running.id && q.command !== null && isActionCommand(q.command),
    );
  if (running?.command != null && isActionCommand(running.command) && !newer) {
    sayOnce(play, running, nightKey(play), nightNote(play, running.command));
  }
}

/** `c` described to `reader`: "come to you" is "come to Keshav" to another owner. */
const describeFor = (c: OwnerCommandRecord, reader: string): string =>
  describeCommand(c.command as OwnerCommand, c.sender === reader ? undefined : c.sender);

/**
 * Cancels the running action command and the queued ones before `cmd`; what they were. Another
 * owner whose command it was is told (an independent review, 2026-10-05: with two owners, the
 * older one's command ended without a word).
 */
function replaceOthers(play: PlayState, cmd: OwnerCommandRecord, command: OwnerCommand): string[] {
  const { repos } = play.deps;
  const newId = cmd.id;
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
    if (c.sender !== cmd.sender) {
      const text = `Stopped: ${cmd.sender} asked me to ${describeCommand(command, cmd.sender)} instead`;
      (play.deps.commands as CommandDeps).reply(c.sender, text);
      play.emit({ kind: 'command', id: c.id, sender: c.sender, message: text });
    }
  }
  return others.map((c) => describeFor(c, cmd.sender));
}

/** A queued action command newer than `cmd` passes its check now (it would replace `cmd`). */
function newerStarts(play: PlayState, cmd: OwnerCommandRecord): boolean {
  return play.deps.repos.commands
    .queued()
    .some(
      (q) =>
        q.id > cmd.id &&
        q.command !== null &&
        isActionCommand(q.command) &&
        checkAction(play, q, q.command) === null,
    );
}

/**
 * Why an action command cannot even start, or null. By night (`mode`), not whether its
 * player is in view: by the morning, when it starts, that may well have changed.
 */
function checkAction(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: ActionCommand,
  mode: 'day' | 'night' = 'day',
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
      if (mode === 'night') return null;
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
      if (why === undefined || why === null) return null;
      // A GregTech ore by its name, and its pickaxe in a few words: the route's own words
      // (its veins, its registry names) were cut off in a whisper (seen live 2026-10-04).
      const ore = gtOreByItem(command.item);
      const level = /pickaxe level >= (\d+)/.exec(why)?.[1];
      if (ore !== null && level !== undefined) {
        const name = ore.material.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
        return `I cannot mine ${name} ore: it takes a pickaxe of level ${level} or more, and I have none and know no way to make one`;
      }
      return `I cannot get ${command.item}: ${why}`;
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

/**
 * Cancels the action commands (running, or queued before command `before`: never the ones sent
 * after the stop, an independent review, 2026-10-04); what they were. With `tell`, each sender
 * hears `why` (a stop command answers for itself).
 */
export function cancelActions(
  play: PlayState,
  why: string,
  opts: { before?: number; tell?: boolean } = {},
): string[] {
  const actions = cancelActionRecords(play.deps.repos, why, opts.before);
  for (const c of actions) {
    if (opts.tell === true) play.deps.commands?.reply(c.sender, why);
    play.commandRuns.delete(c.id);
  }
  return actions.map((c) => describeCommand(c.command as OwnerCommand));
}

/**
 * The owners' action commands (running, or queued before command `before`) cancelled in the
 * database, `why` their reply, their tasks ended; what they were. cli play calls it when the
 * operator stops play while the bot waits offline, where no play is left to (an independent
 * review, 2026-10-05: a halt during an offline night left the command running for next time).
 */
export function cancelActionRecords(
  repos: Repositories,
  why: string,
  before = Number.POSITIVE_INFINITY,
): OwnerCommandRecord[] {
  const actions = [
    repos.commands.running(),
    ...repos.commands.queued().filter((q) => q.id < before),
  ].filter(
    (c): c is OwnerCommandRecord => c !== null && c.command !== null && isActionCommand(c.command),
  );
  for (const c of actions) {
    repos.commands.finish(c.id, 'cancelled', why);
    endCommandTask(repos, c.id, 'cancelled');
  }
  return actions;
}

function instant(play: PlayState, cmd: OwnerCommandRecord, c: InstantCommand): void {
  const { repos } = play.deps;
  const commands = play.deps.commands as CommandDeps;
  switch (c.verb) {
    case 'stop': {
      // The client stopped the action in progress already (a stop in chat), or a stop from
      // the command line did (live-play.ts): what is left is the command, and play's own goals.
      const stopped = cancelActions(play, `Stopped by ${cmd.sender}`, { before: cmd.id });
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
  return (
    path
      .replace(/^(item|tile)\./, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_.]+/g, ' ')
      .trim()
      .toLowerCase()
      // HarvestCraft's produce: harvestcraft:cucumberItem is a cucumber.
      .replace(/(.) item$/, '$1')
  );
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
  const sheltered =
    shelter === null
      ? null
      : 'mobs' in shelter
        ? `staying in my shelter until the hostiles near it go (${shelter.mobs.slice(0, 80)})`
        : `sheltered for the night (morning in about ${Math.max(1, Math.round((shelter.until - play.now()) / 60_000))} min)`;
  const doing =
    running?.command != null
      ? `doing: ${describeCommand(running.command)}${sheltered === null ? '' : `, but first ${sheltered}`}`
      : off !== null
        ? off
        : sheltered !== null
          ? sheltered
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
  // This session's decisions only (a session of no cycle leaves none).
  play.lastDecision = null;
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
  // before), or a pause for a mob (under attack, say): the mob is waited out offline, as
  // after any session, not tried again every few seconds (seen live 2026-10-04: 37 refused
  // retreats in a row, from a pit the morning had opened). A retreat that failed ends the
  // session 'cycle-failed'; one refused as a repeated failure, or a pause, 'needs-attention'.
  // Set by the session's cycles (TypeScript keeps the null from before it).
  const last = play.lastDecision as DecisionResult | null;
  const reasons = mobPause(result.stopKind, last);
  if (reasons !== null) {
    play.emit({
      kind: 'idle',
      message: `a mob is near and no retreat works (${reasons}): waiting offline`,
    });
    play.mobAlarm = reasons;
    return;
  }
  // Home from a retreat: a look at once, so a mob that followed it there sends it offline now,
  // not at the next look 3 s on (seen live 2026-10-05: a Fire Creeper 4.5 blocks away followed
  // the 8.8-block retreat and exploded about 3 s after the bot arrived: 20 health to 12).
  if (last?.decision === 'RETREAT_HOME' && play.hooks.stopRequested() === null) {
    const again = (await play.deps.commands?.standby?.()) ?? null;
    if (again?.kind === 'mob') {
      play.emit({ kind: 'idle', message: `a mob followed it (${again.reasons}): waiting offline` });
      play.mobAlarm = again.reasons;
    }
  }
}

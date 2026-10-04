import { GT_ORE_BLOCK } from '../../domain/blocks.ts';
import { type Position } from '../../domain/common.ts';
import type { WorldTime } from '../../domain/game-state.ts';
import type { ShelterStep } from '../../domain/night-shelter.ts';
import {
  describeCommand,
  type GoalCommand,
  type TunnelCommand,
  type TunnelDirection,
} from '../../domain/owner-commands.ts';
import { summarizeExploration } from '../../domain/world-memory.ts';
import { gtOreByItem, gtOreHeights, gtOreVeins } from '../../goals/ore-names.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import { starving, type FoodStatus } from './food.ts';
import { blueprintSession, isDark, nightReason, nightSoon } from './night.ts';
import { commandWaiting, mobPause, waitOutMob, type PlayState } from './play-state.ts';
import type { PlayResult } from './play.ts';
import {
  firstLeg,
  nextLeg,
  STRIP_MAX,
  STRIP_MAX_TURNS,
  stripDirection,
  stripLevel,
} from './strip-mine.ts';

import {
  commandTaskId,
  finish,
  MAX_COMMAND_FAILURES,
  reflexEnded,
  runOf,
  say,
  sayOnce,
  TUNNEL_RETRY_MS,
  type CommandDeps,
  stripTaskId,
  saveProgress,
} from './command-base.ts';

/**
 * Commands that dig as they go: an owner's tunnel, and the strip mine a !mine of a GregTech
 * ore digs for it (strip-mine.ts), each a few cells at a time as known safe steps.
 */

/**
 * For a GregTech ore asked for while the bot stands outside the heights its veins lie at:
 * where they are, and how to dig there (GT ores lie underground, and the bot mines only ores
 * it has seen exposed: no x-ray). Empty otherwise.
 */
export function oreDepthHint(item: string, at: Position | null): string {
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

/**
 * One session of an owner's tunnel: the next few cells, planned by code from where the bot
 * stands (PlayDeps.tunnel: tunnel.ts), run as known safe steps, each validated, executed and
 * verified by the executor. It starts where the bot stood when the command began. Done at its
 * length; failed, saying why and how far it got, when the next cell may not be dug (a fluid,
 * a cave floor, a block it cannot harvest...), when a step fails, or after sessions with no
 * cell gained. Dusk, a food bar nearly empty and an owner's new command interrupt it, as they
 * do a trip.
 */
export async function tunnelRound(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: TunnelCommand,
): Promise<PlayResult | 'next-round'> {
  const { deps, limits } = play;
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
    saveProgress(play, cmd.id);
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
  return digSession(play, cmd, command, plan.steps, dug, fail);
}

/**
 * One session of a tunnel's next steps (tunnelRound, stripRound), run as known safe steps:
 * dusk, a food bar nearly empty and an owner's new command end it, as they do a trip; a mob
 * near has play wait for it; a step that fails fails the command.
 */
async function digSession(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: TunnelCommand | GoalCommand,
  steps: readonly ShelterStep[],
  dug: string,
  fail: (why: string) => 'next-round',
  taskId = commandTaskId(cmd.id),
): Promise<PlayResult | 'next-round'> {
  const { deps, hooks } = play;
  const run = runOf(play, cmd.id);
  let dark: WorldTime | null = null;
  let hungry: FoodStatus | null = null;
  let preempted: string | null = null;
  const result = await blueprintSession(play, {
    taskId: taskId,
    goal: `Owner command #${cmd.id} from ${cmd.sender}: ${describeCommand(command)} (code digs it)`,
    subgoal: dug,
    steps: steps.map((s, i) => `${i + 1}. ${s.text}`),
    known: [...steps],
    label: `owner command #${cmd.id}`,
    text: `${describeCommand(command)} (${dug})`,
    missing: {},
    maxCycles: steps.length * 2 + 2,
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
  if (mob !== null) return waitOutMob(play, taskId, mob);
  if (result.stopKind === 'cycle-failed' && reflexEnded(play)) {
    // One of System 1's reflexes failed (a retreat with no way home, seen live 2026-10-04: a
    // stairs command failed with 0 blocks dug): the dig was interrupted, not refused. It goes
    // on next round, MAX_COMMAND_FAILURES times in a row at most.
    run.failures += 1;
    if (run.failures >= MAX_COMMAND_FAILURES) return fail(`${result.stopReason} (${dug})`);
    await play.sleep(TUNNEL_RETRY_MS);
    return 'next-round';
  }
  if (result.stopKind === 'cycle-failed' || result.stopKind === 'needs-attention') {
    return fail(`${result.stopReason} (${dug})`);
  }
  run.failures = 0;
  return 'next-round';
}

/** Whether a !mine is of a GregTech ore the live client can strip-mine for. */
export function stripMines(play: PlayState, command: GoalCommand): boolean {
  return (
    command.verb === 'mine' &&
    command.block === GT_ORE_BLOCK &&
    play.deps.tunnel !== undefined &&
    (play.deps.commands as CommandDeps).gtOres !== undefined
  );
}

/**
 * One session of strip mining for a !mine of a GregTech ore with none of it in view: stairs
 * down to the height where its veins lie most (strip-mine.ts stripLevel, no lower than the
 * safety boundary), then straight tunnels, turning clockwise where one may go no further,
 * each planned a few cells at a time like an owner's tunnel. Between sessions the goal round
 * looks again: an ore of the material in the walls is dug by the goal's GATHER. It fails at
 * STRIP_MAX cells of tunnel, or when every way is blocked.
 */
export async function stripRound(
  play: PlayState,
  cmd: OwnerCommandRecord,
  command: GoalCommand,
): Promise<PlayResult | 'next-round'> {
  const { deps } = play;
  const commands = deps.commands as CommandDeps;
  const run = runOf(play, cmd.id);
  const ore = gtOreByItem(command.item);
  const name =
    ore === null
      ? command.item
      : `${ore.material.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ore`;
  const fail = (why: string): 'next-round' => {
    finish(play, cmd, 'failed', `Failed: ${why}`.slice(0, 400));
    return 'next-round';
  };
  const view = commands.view();
  const at = view.position;
  if (at === null || deps.tunnel === undefined) return fail('I do not know where I am');
  const feet = { x: Math.floor(at.x), y: Math.floor(at.y + 1e-6), z: Math.floor(at.z) };
  if (run.strip === null) {
    const level = stripLevel(gtOreVeins(ore?.material ?? ''), feet.y, commands.boundary.min.y);
    if (level === null) {
      return fail(
        `no vein of ${name} lies between my safety boundary (y ${commands.boundary.min.y}) and here (y ${feet.y})`,
      );
    }
    const summary =
      view.dimension === null
        ? null
        : summarizeExploration({
            chunks: deps.repos.worldMemory.chunks(view.dimension),
            from: at,
            boundary: commands.boundary,
            now: new Date(play.now()),
          });
    const room = (d: TunnelDirection): number | undefined => summary?.directions[d]?.room;
    const direction = stripDirection(room);
    run.strip = { level, leg: firstLeg(feet, level, direction), dug: 0, turns: 0 };
    saveProgress(play, cmd.id);
    say(
      play,
      cmd,
      `No ${name} in view: I dig ${feet.y > level ? `stairs down to y ${level}, then ` : ''}tunnels ${direction} until some shows`,
    );
  }
  const strip = run.strip;
  const plan = await deps.tunnel({
    start: strip.leg.start,
    direction: strip.leg.direction,
    length: strip.leg.length,
    slope: strip.leg.slope,
  });
  if (plan === null) {
    run.failures += 1;
    if (run.failures >= MAX_COMMAND_FAILURES) return fail('the blocks around me are not known');
    await play.sleep(TUNNEL_RETRY_MS);
    return 'next-round';
  }
  const total = strip.dug + (plan.ok ? plan.done : 0);
  const dug = `${total} blocks of tunnel dug for ${name}`;
  if (total >= STRIP_MAX)
    return fail(`no ${name} showed in ${dug.replace(/ dug.*/, '')} at y ${strip.level}`);
  const blocked = !plan.ok || (plan.steps.length === 0 && plan.done < strip.leg.length);
  if (!plan.ok || plan.steps.length === 0) {
    // The leg is dug to its end, or may go no further: the next one, from here.
    run.strip = nextLeg(strip, feet, plan.ok ? plan.done : 0, blocked);
    saveProgress(play, cmd.id);
    if (run.strip.turns >= STRIP_MAX_TURNS) {
      return fail(
        `every way is blocked (${plan.ok ? (plan.problem ?? 'nothing to dig') : plan.reason}; ${dug})`,
      );
    }
    return 'next-round';
  }
  // Its own task: the goal's (the command's) is the GATHER's, and a blueprint completes its task.
  return digSession(play, cmd, command, plan.steps, dug, fail, stripTaskId(cmd.id));
}

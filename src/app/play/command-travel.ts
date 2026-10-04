import { MIN_EXPLORE_DISTANCE } from '../../domain/actions.ts';
import { type Position } from '../../domain/common.ts';
import type { WorldTime } from '../../domain/game-state.ts';
import { blockName, describeCommand, type TravelCommand } from '../../domain/owner-commands.ts';
import { COMPASS, summarizeExploration, wanderTarget } from '../../domain/world-memory.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { setKnownSteps } from '../loop/known-steps.ts';
import { starving, type FoodStatus } from './food.ts';
import { cycleEvent } from './narration.ts';
import { isDark, nightReason, nightSoon } from './night.ts';
import type { TravelStep, TravelTarget } from './owner-travel.ts';
import { commandWaiting, mobPause, waitOutMob, type PlayState } from './play-state.ts';
import type { PlayResult } from './play.ts';

import {
  blocks,
  COME_WITHIN,
  commandTaskId,
  finish,
  fmt,
  FOLLOW_WAIT_MS,
  FOLLOW_WITHIN,
  locations,
  MAX_COMMAND_FAILURES,
  PROGRESS_EVERY,
  runOf,
  say,
  sayOnce,
  mobInTheWay,
  mobReflexEnded,
  stepFailureOf,
  TRAVEL_RETRY_MS,
  type CommandDeps,
} from './command-base.ts';
import { blockTarget, blockTravel } from './command-find.ts';

/**
 * An owner's travel commands (come, follow, goto, home, waypoints, explore, surface, goto a
 * block) as code-made steps: the target, each next step (owner-travel.ts), and the replies.
 */

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
      // Arrived only in that very cell: one block across and up is still under the roof.
      const to = surfaceTarget(play, cmd);
      return 'problem' in to ? to : { target: { kind: 'point', point: to, exact: true } };
    }
    case 'goto-block': {
      const to = blockTarget(play, cmd, c.block);
      return 'problem' in to ? to : { target: blockTravel(to) };
    }
    case 'goto-waypoint':
    case 'home': {
      const name = c.verb === 'home' ? commands.homeName : c.name;
      const at = locations(play).get(name);
      if (at === undefined && c.verb === 'goto-waypoint') {
        // No waypoint of that name: the block it names, found again after a restart of play
        // (the run that held it is gone, the command is not).
        const block = blockName([name]);
        const to = block === null ? null : blockTarget(play, cmd, block);
        if (to !== null && !('problem' in to)) return { target: blockTravel(to) };
      }
      return at === undefined
        ? { problem: `the waypoint ${name} is gone` }
        : { target: { kind: 'point', point: at.position } };
    }
  }
}

/**
 * Where an explore command heads: `distance` blocks toward its direction (or, with none, the
 * one world memory has seen least: wanderTarget) from where the bot stood when it began, no
 * farther than the room left to the safety boundary that way; fixed then, so it does not
 * move on with the bot.
 */
export function exploreTarget(
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
export function surfaceTarget(
  play: PlayState,
  cmd: OwnerCommandRecord,
): Position | { problem: string } {
  const run = runOf(play, cmd.id);
  if (run.surfaceTo !== null) return run.surfaceTo;
  const find = (play.deps.commands as CommandDeps).surface;
  if (find === undefined) return { problem: 'I cannot look for the surface here' };
  const to = find();
  if ('problem' in to) return to;
  run.surfaceTo = to.point;
  return run.surfaceTo;
}

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
export async function travelRound(
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
  /** The last step's failure, in the client's words (the reply says why, not just "failed"). */
  let stepFailure: string | null = null;
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
      stepFailure = stepFailureOf(r) ?? stepFailure;
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
    // Seen live: "Failed: stopped after: EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed", when
    // the walk had said why (a hostile 9.7 blocks off stopped its pillar).
    const why: string = stepFailure ?? result.stopReason;
    const reflex = result.stopKind === 'cycle-failed' && mobReflexEnded(play);
    const mobbed = await mobInTheWay(play, cmd, why, follow, reflex);
    if (mobbed === 'retry') return 'next-round';
    if (mobbed === 'give-up') {
      return travelFailed(play, cmd, `${why} (${run.mobStops - 1} tries)`.slice(0, 300), true);
    }
    return travelFailed(play, cmd, why.slice(0, 300));
  }
  // A step went: the failures in a row are over. A long trip says how far is left.
  run.failures = 0;
  run.mobStops = 0;
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
  final = false,
): Promise<'next-round'> {
  const run = runOf(play, cmd.id);
  run.failures += 1;
  run.lastFailure = reason;
  if (final || /^I cannot see /.test(reason) || run.failures >= MAX_COMMAND_FAILURES) {
    finish(play, cmd, 'failed', `Failed: ${reason}`);
  } else {
    await play.sleep(TRAVEL_RETRY_MS);
  }
  return 'next-round';
}

import { heldOf } from '../../domain/common.ts';
import { describeCommand, type GoalCommand } from '../../domain/owner-commands.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import { starving } from './food.ts';
import { freeRoundGoal, missingFor, reachGoal, runGoalSession, total } from './goal-round.ts';
import { mobPause, waitOutMob, type PlayState } from './play-state.ts';
import type { FreeGoal, PlayResult } from './play.ts';

import {
  commandTaskId,
  finish,
  MAX_COMMAND_FAILURES,
  mobInTheWay,
  reflexEnded,
  runOf,
  sayOnce,
  saveProgress,
} from './command-base.ts';
import { stripMines, stripRound } from './command-dig.ts';
import { cellKey, oreInView, oresFor } from './command-find.ts';

/**
 * An owner's get and mine: a goal of items to have, pursued like `cli play --needs`
 * (goal-round.ts), strip-mining for a GregTech ore with none in view (command-dig.ts).
 */

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
export function anyKindOf(c: GoalCommand): string[] {
  return c.item.includes('@') ? [] : [c.item];
}

/**
 * One session of a get or mine command: its goal pursued exactly like `cli play --needs`'s
 * (the planner plans from its route, GATHER digs). Done once the inventory holds the items;
 * halfway is told once; it fails after maxStuckSessions sessions with no fewer items missing
 * (new ground seen counts as progress), or when its task needs a person.
 */
export async function goalCommandRound(
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
  // A GregTech ore with none of it in view: dig for it (strip-mine.ts), as a person does.
  // Before the count of sessions without progress: the tunnel's cells are its progress, and
  // STRIP_MAX cells its end.
  const strip = stripMines(play, command);
  if (strip && !oreInView(play, command.item, run.stripSkipped)) {
    run.missing = left;
    run.stuck = 0;
    run.worked = false;
    run.interrupted = false;
    return stripRound(play, cmd, command);
  }
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
  run.interrupted = reflexEnded(play);
  // A walk a hostile stopped: interrupted, not stuck (mobInTheWay; seen live 2026-10-04 on
  // trips: zombies in the forest's shade failed a follow).
  const mobbed =
    ended.result.stopKind === 'cycle-failed' && ended.stepFailure !== null
      ? await mobInTheWay(play, cmd, ended.stepFailure)
      : null;
  if (mobbed === 'give-up') {
    finish(play, cmd, 'failed', `Failed: ${ended.stepFailure} (${run.mobStops - 1} tries)`);
    return 'next-round';
  }
  if (mobbed === 'retry') run.interrupted = true;
  else if (!run.interrupted) run.mobStops = 0;
  // Cut short by a new command (any whisper), dusk or a food bar nearly empty: it tried
  // nothing, and counts neither way (an independent review, 2026-10-05: three quick !status whispers failed a !get for "no progress in 3 sessions").
  if (ended.preempted !== null || ended.dark !== null || ended.hungry !== null) {
    run.interrupted = true;
  }
  // Only a session that ran its course counts: one a new command, dusk, a food bar nearly
  // empty, a reflex or a mob cut short tried nothing (an independent review, 2026-10-04: a
  // !status abandoned a copper ore in view).
  const cutShort =
    ended.dark !== null ||
    ended.preempted !== null ||
    ended.hungry !== null ||
    run.interrupted ||
    mobPause(ended.result.stopKind, play.lastDecision) !== null ||
    ended.result.cycles.length === 0;
  if (
    strip &&
    !cutShort &&
    after !== null &&
    (after[command.item] ?? 0) <= (inventory[command.item] ?? 0)
  ) {
    // The ores in view gave none (out of reach, refused): passed over, and the strip mine
    // goes on past them.
    for (const o of oresFor(play, command.item, run.stripSkipped)) {
      run.stripSkipped.add(cellKey(o.position));
    }
    saveProgress(play, cmd.id);
  }
  // A mob pause first: only its offline wait sets the task active again (see goal-round.ts).
  const mob = mobPause(ended.result.stopKind, play.lastDecision);
  if (mob !== null) return waitOutMob(play, adopted.taskId, mob);
  if (ended.dark !== null) {
    sayOnce(
      play,
      cmd,
      `dusk-${play.nights}`,
      `It is getting dark: I shelter for the night, then I ${describeCommand(command)}`,
    );
    return 'next-round';
  }
  if (ended.met || ended.preempted !== null || ended.hungry !== null) return 'next-round';
  if (ended.result.stopKind === 'needs-attention' || ended.result.stopKind === 'task-halted') {
    finish(play, cmd, 'failed', `Failed: ${ended.result.stopReason}`);
  }
  return 'next-round';
}

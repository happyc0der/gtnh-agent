import { createAction, type ActionSpec } from '../../domain/actions.ts';
import type { BlockPosition, Position } from '../../domain/common.ts';
import type { GameState } from '../../domain/game-state.ts';
import { formatPosition } from '../../domain/geometry.ts';
import { known } from '../../domain/known.ts';
import { validateCandidate, type ExecutionOutcome } from '../../executor/action-executor.ts';
import { TASK_GATHER_PREFIX } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import {
  chooseGatherAction,
  gatherBound,
  gatherDrops,
  gatheredSoFar,
  gatherMinutes,
  GatherProgressSchema,
  GATHER_MAX_ACTIONS,
  GATHER_REPORT_EVERY,
  givesSame,
  progressSource,
  recordGatherAction,
  sourceName,
  startGather,
  withSkipped,
  withSkippedEntities,
  type GatherAct,
  type GatherEnd,
  type GatherOptions,
  type GatherProgress,
  type GatherStep,
} from '../../planner/gather.ts';
import type { FailureHistory, SafetyContext } from '../../safety/safety-policy.ts';

/**
 * The agent loop's side of a GATHER plan step (src/planner/gather.ts chooses the actions):
 * its progress between cycles, kept in agent memory (`task_gather:<taskId>`, one record per
 * task, since a task has one open plan), and its lines in the task journal: started, every
 * 16 blocks dug, and ended with why. Plan statuses stay with the agent loop.
 */

/** Which GATHER step: of which task, plan and plan step. */
export interface GatherRef {
  taskId: string;
  planId: number;
  /** The plan step (0-based). */
  stepIndex: number;
  gather: GatherStep;
}

/**
 * The action a GATHER step takes this cycle (`entity`: the animal it is for, or null for a
 * block; `travel`: an EXPLORE toward a place the block is remembered at), or how it ended
 * before taking one.
 */
export type GatherTurn =
  | {
      kind: 'act';
      spec: ActionSpec;
      target: BlockPosition;
      walk: boolean;
      entity: number | null;
      travel?: boolean;
      reason: string;
    }
  | { kind: 'end'; end: GatherEnd; why: string };

/**
 * Refusals about the state or the moment rather than the block (an unreliable observation,
 * danger). System 1 routes those before a plan step runs; should one still show up, the
 * action is proposed anyway, so the executor refuses it exactly as it refuses any plan step.
 */
const ABOUT_THE_MOMENT: ReadonlySet<string> = new Set([
  'STATE_STALE',
  'STATE_UNKNOWN',
  'STATE_INCONSISTENT',
  'ACTION_NOT_ALLOWED_IN_DANGER',
]);

/**
 * A dry run of the executor's validation (schema, safety policy, preconditions, the
 * repeated-failure rule) for an action GATHER might take: null if it would pass, else why
 * not. `from` other than the player's position asks about the dig after the walk there.
 */
export function previewCheck(
  history: FailureHistory,
  taskId: string | null,
  state: GameState,
  ctx: SafetyContext,
): (spec: ActionSpec, from: Position) => string | null {
  const here = state.player.position.known ? state.player.position.value : null;
  return (spec, from) => {
    const there = here !== null && here.x === from.x && here.y === from.y && here.z === from.z;
    const at: GameState = there
      ? state
      : { ...state, player: { ...state.player, position: known({ ...from }) } };
    const action = createAction(
      { spec, reason: 'GATHER preview', origin: 'planner', taskId },
      { newId: () => 'gather-preview', now: () => ctx.now },
    );
    const { report } = validateCandidate(action, at, ctx, history);
    if (report.ok) return null;
    if (there && report.violations.some((v) => ABOUT_THE_MOMENT.has(v.code))) return null;
    return [...report.violations.map((v) => v.code), ...report.preconditionFailures]
      .join('; ')
      .slice(0, 200);
  };
}

const progressKey = (taskId: string): string => `${TASK_GATHER_PREFIX}${taskId}`;

/** The task's GATHER progress, if it belongs to this plan step. */
function loadProgress(repos: Repositories, ref: GatherRef): GatherProgress | null {
  const raw = repos.memory.getValue(progressKey(ref.taskId));
  const p = raw === null ? null : parseProgress(raw);
  return p !== null && p.planId === ref.planId && p.step === ref.stepIndex ? p : null;
}

function parseProgress(raw: string): GatherProgress | null {
  try {
    const parsed = GatherProgressSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function saveProgress(repos: Repositories, taskId: string, p: GatherProgress | null): void {
  repos.memory.setValue(progressKey(taskId), p === null ? null : JSON.stringify(p));
}

/** "GATHER 54 minecraft:sand" (or "GATHER 3 minecraft:Cow"): how its journal lines start. */
const head = (p: GatherProgress): string => `GATHER ${p.count} ${sourceName(progressSource(p))}`;

/** "16 dug, 16/54 gathered, 19 action(s), 0.8 min" ("2 attack(s)" when hunting) */
function tally(p: GatherProgress, gathered: number, now: Date): string {
  const did = p.animal === undefined ? `${p.dug} dug` : `${p.dug} attack(s)`;
  return (
    `${did}, ${gathered}/${p.count} gathered, ${p.actions} action(s), ` +
    `${gatherMinutes(p, now).toFixed(1)} min`
  );
}

/** How a step ended, for the journal (which is what the planner reads next). */
function ending(end: GatherEnd, why: string): string {
  switch (end) {
    case 'done':
      return 'done';
    case 'bound':
      return `ended at ${why}: a checkpoint, plan again with fresh stock`;
    case 'no-target':
      return `ended: ${why}; plan again (EXPLORE for more if the task still needs it)`;
  }
}

/**
 * The step's next action, chosen in code from this cycle's observation, or how it ended:
 * done, at a bound, or with nothing left to dig. Starts the step's progress (the baseline is
 * what the inventory holds now) the first time; an end is journaled and clears it.
 */
export function gatherTurn(
  repos: Repositories,
  ref: GatherRef,
  state: GameState,
  ctx: SafetyContext,
  remembered: GatherOptions['remembered'] = [],
  wander: NonNullable<GatherOptions['wander']> | null = null,
): GatherTurn {
  const saved = loadProgress(repos, ref);
  const started = saved ?? startGather(ref.planId, ref.stepIndex, ref.gather, state, ctx.now);
  const choice = chooseGatherAction(ref.gather, started, state, {
    reach: ctx.config.interactionReach,
    now: ctx.now,
    check: previewCheck(repos.actions, ref.taskId, state, ctx),
    remembered,
    wander,
  });
  const p = {
    ...started,
    skipped: withSkipped(started.skipped, choice.skip),
    skippedEntities: withSkippedEntities(started.skippedEntities, choice.skipEntities),
  };
  const gathered = gatheredSoFar(p, state);
  const where = `plan #${ref.planId} step ${ref.stepIndex + 1}`;
  if (choice.kind === 'end') {
    repos.memory.appendJournal(
      ref.taskId,
      saved === null
        ? `${head(p)} (${where}) ${ending(choice.end, choice.why)}`
        : `${head(p)} ${ending(choice.end, choice.why)}; ${tally(p, gathered, ctx.now)}`,
    );
    saveProgress(repos, ref.taskId, null);
    return { kind: 'end', end: choice.end, why: choice.why };
  }
  if (saved === null) {
    const source = progressSource(p);
    const name = sourceName(source);
    const listed =
      'block' in source
        ? state.nearbyBlocks.known
          ? state.nearbyBlocks.value.resources.filter((r) => givesSame(r.block, source, r.ore))
              .length
          : 0
        : state.nearbyEntities.known
          ? state.nearbyEntities.value.entities.filter((e) => e.type === source.animal).length
          : 0;
    repos.memory.appendJournal(
      ref.taskId,
      `${head(p)} (${where}) started: counts ${gatherDrops(source).join(' or ')}, ` +
        `${p.startHeld} held; ${listed} ${name} listed in view`,
    );
  }
  saveProgress(repos, ref.taskId, p);
  const name = sourceName(progressSource(p));
  const what =
    choice.travel === true
      ? `head for the ${name} remembered at ${formatPosition(choice.target)}`
      : choice.entity !== null
        ? choice.spec.type === 'MOVE_TO'
          ? `walk to ${formatPosition(choice.spec.args.target)} next to ${name} ${choice.entity}`
          : `strike ${name} ${choice.entity}`
        : choice.spec.type === 'MOVE_TO'
          ? `walk to ${formatPosition(choice.spec.args.target)} to dig ${formatPosition(choice.target)}`
          : `dig ${formatPosition(choice.target)}`;
  return {
    kind: 'act',
    spec: choice.spec,
    target: choice.target,
    walk: choice.walk,
    entity: choice.entity,
    ...(choice.travel === true ? { travel: true } : {}),
    reason:
      `${head(p)}: ${what} (${gathered}/${p.count} gathered, ` +
      `action ${p.actions + 1} of at most ${GATHER_MAX_ACTIONS})`,
  };
}

/**
 * After one of the step's actions ran: counts it (a block whose action did not succeed is
 * not tried again), writes a journal line every 16 blocks dug, and says what comes next:
 *  - 'done': the inventory now holds the count (the step is verified; journaled);
 *  - 'bound': 64 actions or 5 minutes, a checkpoint (journaled);
 *  - 'more': the step goes on next cycle;
 *  - 'failed': the action did not succeed; the plan's own failure handling decides.
 */
export function gatherAfterAction(
  repos: Repositories,
  ref: GatherRef,
  act: GatherAct,
  outcome: ExecutionOutcome,
  now: Date,
): { next: 'done' | 'bound' | 'more' | 'failed'; why: string } {
  const saved = loadProgress(repos, ref);
  const succeeded = outcome.status === 'succeeded';
  if (saved === null) {
    return succeeded ? { next: 'more', why: '' } : { next: 'failed', why: '' };
  }
  const p = recordGatherAction(saved, act, succeeded);
  if (!succeeded) {
    saveProgress(repos, ref.taskId, p);
    return { next: 'failed', why: `its ${outcome.actionType} did not succeed` };
  }
  const gathered = outcome.stateAfter === null ? 0 : gatheredSoFar(p, outcome.stateAfter);
  const bound = gatherBound(p, now);
  if (gathered >= p.count || bound !== null) {
    const end = gathered >= p.count ? 'done' : 'bound';
    const why = end === 'bound' && bound !== null ? bound : `${p.count} gathered`;
    repos.memory.appendJournal(
      ref.taskId,
      `${head(p)} ${ending(end, why)}; ${tally(p, gathered, now)}`,
    );
    saveProgress(repos, ref.taskId, null);
    return { next: end, why };
  }
  if (Math.floor(p.dug / GATHER_REPORT_EVERY) > Math.floor(p.reported / GATHER_REPORT_EVERY)) {
    repos.memory.appendJournal(ref.taskId, `${head(p)}: ${tally(p, gathered, now)}`);
    saveProgress(repos, ref.taskId, { ...p, reported: p.dug });
  } else {
    saveProgress(repos, ref.taskId, p);
  }
  return { next: 'more', why: '' };
}

/** The step's plan stopped (its failure handling, or a refused action): journal it and clear. */
export function gatherStopped(
  repos: Repositories,
  ref: GatherRef,
  why: string,
  now: Date,
  state: GameState | null,
): void {
  const p = loadProgress(repos, ref);
  if (p === null) return;
  const gathered = state === null ? 0 : gatheredSoFar(p, state);
  repos.memory.appendJournal(
    ref.taskId,
    `${head(p)} ended with its plan: ${why}; ${tally(p, gathered, now)}`,
  );
  saveProgress(repos, ref.taskId, null);
}

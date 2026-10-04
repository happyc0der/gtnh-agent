import { createAction, isAllowlistedActionType, type ActionSpec } from '../../domain/actions.ts';
import type { BlockPosition } from '../../domain/common.ts';
import type { GameState } from '../../domain/game-state.ts';
import { MEAL_HISTORY_LENGTH } from '../../domain/food.ts';
import { validateCandidate, type ExecutionOutcome } from '../../executor/action-executor.ts';
import type { StoredPlan } from '../../persistence/plan-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { DIG_YIELDS } from '../../goals/route-book.ts';
import {
  chooseGatherAction,
  GATHER,
  gatherSourceOf,
  sourceName,
  startGather,
  type GatherOptions,
  type GatherStep,
} from '../../planner/gather.ts';
import {
  MAX_JOURNAL_LINE,
  PlannerResponseSchema,
  type Plan,
  type PlannerRequest,
  type PlannerResponse,
} from '../../planner/plan-schema.ts';
import { trimStaleSteps, validatePlan } from '../../planner/plan-validator.ts';
import {
  buildPlannerRequest,
  goalRouteOf,
  rememberedPlacesOf,
} from '../../planner/planner-provider.ts';
import {
  actionFingerprint,
  assessStateReliability,
  type SafetyContext,
} from '../../safety/safety-policy.ts';
import { errorMessage, stableStringify } from '../../util/json.ts';
import type { AgentDeps, ChosenAction, CycleStatus, PlannerOutcome } from './agent-loop.ts';
import { explorationFor } from './agent-memory.ts';
import {
  gatherAfterAction,
  gatherStopped,
  gatherTurn,
  previewCheck,
  type GatherRef,
} from './gather-step.ts';
import { rememberDeadEnd } from './dead-ends.ts';
import { nextKnownStep } from './known-steps.ts';

/**
 * The plan side of a cycle (runSingleCycle in agent-loop.ts): which step runs when System 1
 * asks for the planner (a code-made blueprint's next step, the open plan's next step, or the
 * first step of a new plan the planner is asked for, which code dry-runs first:
 * consultPlanner), and what the step's outcome does to its plan (updatePlanProgress).
 */

/** The planner name for plans a human wrote (`cli task-add --plan`). */
export const OPERATOR_PLANNER = 'operator';

export interface PlanStepRef {
  planId: number;
  /** 0-based index of the step being executed. */
  stepIndex: number;
  failureHandling: Plan['failureHandling'];
  /** Who wrote the plan (OPERATOR_PLANNER for a human's plan). */
  planner: string;
  /**
   * The step is a GATHER (gather-step.ts), which runs many actions: this one is for the
   * block at `target` (`walk`: the walk to its stand spot; `travel`: an EXPLORE toward a
   * place it is remembered at), or for the animal `entity`.
   */
  gather?: {
    ref: GatherRef;
    target: BlockPosition;
    walk: boolean;
    entity: number | null;
    travel?: boolean;
  };
}

const reviewHint = (taskId: string, planId: number): string =>
  `Review: node src/app/cli.ts plan-show --task ${taskId}; then plan-approve (or plan-reject) --task ${taskId} --plan ${planId}.`;

type Consulted =
  | { chosen: ChosenAction; outcome: PlannerOutcome; planStep: PlanStepRef | null }
  /** A GATHER step ended before choosing an action: nothing runs this cycle. */
  | {
      chosen: null;
      outcome: PlannerOutcome;
      ended: { status: CycleStatus; label: string; why: string };
    };

/**
 * Where world memory remembers a GATHER step's block, for a step with none of it in view
 * (gather.ts GatherOptions.remembered). None for an animal: animals wander, and world memory
 * keeps places of blocks only.
 */
function rememberedFor(
  deps: AgentDeps,
  gather: GatherStep,
  state: GameState,
  now: Date,
): NonNullable<GatherOptions['remembered']> {
  if (!('block' in gather.args)) return [];
  return rememberedPlacesOf(
    gather.args.block,
    state,
    explorationFor(deps.config, deps.repos, state, now),
  );
}

function stepOf(
  deps: AgentDeps,
  stored: StoredPlan,
  outcomeKind: 'plan-accepted' | 'plan-step',
  state: GameState,
  ctx: SafetyContext,
): Consulted {
  const step = stored.plan.steps[stored.nextStep];
  if (step === undefined) throw new Error(`plan ${stored.id} has no step ${stored.nextStep}`);
  const total = stored.plan.steps.length;
  const outcome: PlannerOutcome =
    outcomeKind === 'plan-accepted'
      ? { kind: 'plan-accepted', planId: stored.id, goal: stored.plan.goal, steps: total }
      : {
          kind: 'plan-step',
          planId: stored.id,
          goal: stored.plan.goal,
          step: stored.nextStep + 1,
          steps: total,
        };
  const head = `plan #${stored.id} "${stored.plan.goal}" step ${stored.nextStep + 1}/${total}`;
  const planStep: PlanStepRef = {
    planId: stored.id,
    stepIndex: stored.nextStep,
    failureHandling: stored.plan.failureHandling,
    planner: stored.planner,
  };
  if (step.action.type === GATHER) {
    // Code picks this cycle's action from the fresh observation (no model is asked).
    const ref: GatherRef = {
      taskId: stored.taskId,
      planId: stored.id,
      stepIndex: stored.nextStep,
      gather: step.action,
    };
    const turn = gatherTurn(
      deps.repos,
      ref,
      state,
      ctx,
      rememberedFor(deps, step.action, state, ctx.now),
    );
    if (turn.kind === 'end') return gatherEnded(deps.repos, stored, turn, outcome);
    return {
      chosen: {
        spec: turn.spec,
        reason: `${head}: ${turn.reason}`.slice(0, 500),
        origin: 'planner',
      },
      outcome,
      planStep: {
        ...planStep,
        gather: {
          ref,
          target: turn.target,
          walk: turn.walk,
          entity: turn.entity,
          ...(turn.travel === true ? { travel: true } : {}),
        },
      },
    };
  }
  return {
    chosen: {
      spec: step.action,
      reason: `${head}: ${step.rationale}`.slice(0, 500),
      origin: 'planner',
    },
    outcome,
    planStep,
  };
}

/**
 * A GATHER step that ended before choosing an action (its journal line is written):
 *  - done: the step is verified, and the plan advances like after any verified step;
 *  - at its bound (64 actions or 5 minutes): a checkpoint; and nothing left to dig: a stale
 *    step. Either fails the plan, so the next cycle asks the planner again (it reads why in
 *    the journal, and can EXPLORE).
 * Nothing runs this cycle. A plan the planner has just made, whose GATHER finds nothing to
 * dig, is refused like a first step the executor refuses as stale: the cycle is
 * 'rejected', and the task goes on.
 */
function gatherEnded(
  repos: Repositories,
  stored: StoredPlan,
  turn: { end: 'done' | 'bound' | 'no-target'; why: string },
  outcome: PlannerOutcome,
): Consulted {
  const step = stored.nextStep + 1;
  if (turn.end === 'no-target' && step < stored.plan.steps.length) {
    // Nothing of it to dig here, but the plan goes on: skip to its next step (seen live:
    // GATHER gravel with none in view, before GATHER logs with 66 in view). The next plan
    // sees the item still missing in the route, and can EXPLORE for it.
    repos.memory.appendJournal(
      stored.taskId,
      `plan #${stored.id} step ${step} GATHER skipped (${turn.why}); on to step ${step + 1}`.slice(
        0,
        300,
      ),
    );
    repos.plans.advance(stored.id);
    return {
      chosen: null,
      outcome,
      ended: { status: 'succeeded', label: 'GATHER:no-target, skipped', why: turn.why },
    };
  }
  if (turn.end === 'done') {
    stepVerified(repos, stored.id);
  } else {
    const kind = turn.end === 'bound' ? 'checkpoint' : 'stale';
    repos.plans.setStatus(
      stored.id,
      'failed',
      `step ${step} GATHER ${kind}: ${turn.why}`.slice(0, 500),
    );
  }
  const stale = turn.end === 'no-target' && outcome.kind === 'plan-accepted';
  return {
    chosen: null,
    outcome,
    ended: { status: stale ? 'rejected' : 'succeeded', label: `GATHER:${turn.end}`, why: turn.why },
  };
}

/** The plan's current step is verified: advance (completing the plan after its last step). */
function stepVerified(repos: Repositories, planId: number): void {
  const plan = repos.plans.advance(planId);
  if (plan.status === 'completed') {
    repos.memory.appendJournal(
      plan.taskId,
      `plan #${plan.id} done: ${plan.plan.goal}`.slice(0, 300),
    );
  }
  // A plan a human wrote for the task IS the task: finishing it finishes the task.
  if (plan.status === 'completed' && plan.planner === OPERATOR_PLANNER) {
    repos.tasks.setStatus(plan.taskId, 'completed');
  }
}

/**
 * Safety refusals that only say a step no longer matches what is observed, not that it is
 * dangerous: NOT_DIGGABLE means the block is not in the current list of observed diggable
 * blocks (already dug, or out of the scan since the player moved); NOT_INTERACTABLE the
 * same for blocks to interact with (a furnace out of the scan, or gone); TARGET_GONE means
 * the entity to attack is no longer near (it died, wandered off or despawned). The step is
 * still refused; only the reaction differs (see isStaleRejection).
 */
const STALE_VIOLATION_CODES: ReadonlySet<string> = new Set([
  'NOT_DIGGABLE',
  'NOT_PLACEABLE',
  'NOT_INTERACTABLE',
  'TARGET_GONE',
]);

/**
 * A planner's step rejected only because it no longer fits the world NOW: preconditions
 * (out of reach, too few items, the block gone) and/or a stale-observation refusal
 * (STALE_VIOLATION_CODES), and nothing else. The player moved or the world changed since
 * the plan was made: a stale plan, not an unsafe one. Or a danger came up after System 1
 * decided (ACTION_NOT_ALLOWED_IN_DANGER alone): System 1 meets it next cycle (a retreat, a
 * flight, a fight), and the planner is asked again after (seen live: a gatling skeleton came
 * in range while the planner planned, the EXPLORE was refused, and the task was blocked for a
 * human). A human's plan is never treated this way, and any other safety violation still
 * halts the task.
 */
export function isStaleRejection(ref: PlanStepRef | null, outcome: ExecutionOutcome): boolean {
  const v = outcome.validation;
  return (
    ref !== null &&
    ref.planner !== OPERATOR_PLANNER &&
    outcome.status === 'rejected' &&
    v.violations.every(
      (x) => STALE_VIOLATION_CODES.has(x.code) || x.code === 'ACTION_NOT_ALLOWED_IN_DANGER',
    ) &&
    (v.violations.length > 0 || v.preconditionFailures.length > 0)
  );
}

/**
 * Rejected only because the step no longer fits what is observed (preconditions and/or
 * STALE_VIOLATION_CODES), nothing else: for a code-made blueprint's step (known-steps.ts),
 * whose plan is made again from the new view.
 */
export function onlyStaleRefusals(outcome: ExecutionOutcome): boolean {
  const v = outcome.validation;
  return (
    outcome.status === 'rejected' &&
    v.violations.every((x) => STALE_VIOLATION_CODES.has(x.code)) &&
    (v.violations.length > 0 || v.preconditionFailures.length > 0)
  );
}

/**
 * After a plan step ran: advance on success; on failure count it against the plan's retry
 * budget and, once exhausted, fail the plan. Returns true if the task must now wait for a
 * human (a rejected step, or a failure policy other than REPLAN). A stale rejection fails
 * the plan but lets the task go on: the next cycle asks the planner again, with the
 * rejection in its recent history.
 *
 * A GATHER step runs many actions: a verified one advances the plan only once the
 * inventory holds the step's count; until then the step goes on (its failures are counted
 * in a row again), and at its bound (64 actions or 5 minutes) the plan ends for a
 * checkpoint, so the next cycle asks the planner. An action of it that does not succeed
 * meets the plan's own failure handling, like any step.
 */
export function updatePlanProgress(
  repos: Repositories,
  ref: PlanStepRef,
  outcome: ExecutionOutcome,
  now: Date,
  stateBefore: GameState,
): boolean {
  const journal = (text: string): void => {
    const plan = repos.plans.get(ref.planId);
    if (plan !== null) repos.memory.appendJournal(plan.taskId, text);
  };
  const gather = ref.gather;
  if (gather !== undefined) {
    const after = gatherAfterAction(repos, gather.ref, gather, outcome, now);
    if (after.next === 'more') {
      repos.plans.resetStepFailures(ref.planId);
      return false;
    }
    if (after.next === 'bound') {
      repos.plans.setStatus(
        ref.planId,
        'failed',
        `step ${ref.stepIndex + 1} GATHER checkpoint: ${after.why}`.slice(0, 500),
      );
      return false;
    }
    // 'done' is a verified step (below); 'failed' meets the plan's failure handling (below).
  }
  /** A GATHER whose plan stops here: its last journal line. */
  const gatherEnds = (why: string): void => {
    if (gather !== undefined) {
      gatherStopped(repos, gather.ref, why, now, outcome.stateAfter ?? stateBefore);
    }
  };
  switch (outcome.status) {
    case 'succeeded':
      stepVerified(repos, ref.planId);
      return false;
    case 'rejected':
      gatherEnds(`its ${outcome.actionType} was refused`);
      journal(
        `plan #${ref.planId} failed at step ${ref.stepIndex + 1} (${outcome.actionType}): ` +
          (outcome.validation.preconditionFailures[0] ??
            outcome.validation.violations[0]?.message ??
            'rejected'),
      );
      repos.plans.setStatus(
        ref.planId,
        'failed',
        `step ${ref.stepIndex + 1} rejected: ${outcome.validation.violations.map((v) => v.code).join(', ') || outcome.validation.preconditionFailures.join('; ')}`.slice(
          0,
          500,
        ),
      );
      return !isStaleRejection(ref, outcome);
    case 'failed':
    case 'verification_failed': {
      const failures = repos.plans.recordStepFailure(ref.planId);
      if (failures <= ref.failureHandling.maxRetriesPerStep) return false; // retry next cycle
      gatherEnds(`its ${outcome.actionType} did not succeed ${failures} time(s) in a row`);
      journal(
        `plan #${ref.planId} failed at step ${ref.stepIndex + 1} (${outcome.actionType}) ` +
          `${failures} time(s): ${outcome.execution?.message ?? 'not verified'}`,
      );
      repos.plans.setStatus(
        ref.planId,
        'failed',
        `step ${ref.stepIndex + 1} failed ${failures} time(s)`,
      );
      // REPLAN: the next cycle asks the planner again. PAUSE_AND_ASK_USER and RETREAT_HOME
      // (no retreat directive exists yet) wait for a human.
      return ref.failureHandling.onStepFailure !== 'REPLAN';
    }
  }
}

/**
 * A plan's DIG_BLOCK steps that dig a listed block giving nothing the task still needs (a
 * resource goal: currentTask.requirements, or a raw material its route gathers for them), as a
 * refusal like refusedFirstStep's, with a note that names them and the GATHER that digs the
 * right blocks; null when every dig gives something needed, or the task names no
 * requirements. Seen live: "dig the nearest gravel block" eight times at blocks that were
 * sand, dirt and grass; every dig was valid, and none gave gravel. And the route counts: logs
 * dug for "Tools" (wooden tools, made from planks and sticks) were refused as giving nothing
 * the task needs before the route's raw materials were counted.
 */
function digsForNothing(plan: Plan, state: GameState): ReturnType<typeof refusedFirstStep> {
  const needs = state.currentTask?.requirements;
  if (needs === undefined || Object.keys(needs).length === 0 || !state.nearbyBlocks.known) {
    return null;
  }
  const listed = state.nearbyBlocks.value.resources;
  if (!plan.steps.some((s) => s.action.type === 'DIG_BLOCK')) return null;
  // What the route gathers for the requirements: its raw materials and the blocks it digs.
  const route = goalRouteOf(state);
  const wanted = new Set([...Object.keys(needs), ...Object.keys(route?.raw ?? {})]);
  const routeBlocks = new Set(
    (route?.legs ?? []).flatMap((l) => (l.kind === 'gather' ? l.blocks : [])),
  );
  const useless: string[] = [];
  for (const s of plan.steps) {
    if (s.action.type !== 'DIG_BLOCK') continue;
    const at = s.action.args.position;
    const block = listed.find(
      (r) => r.position.x === at.x && r.position.y === at.y && r.position.z === at.z,
    )?.block;
    if (block === undefined) continue; // not listed: the executor refuses it as NOT_DIGGABLE
    if (routeBlocks.has(block) || DIG_YIELDS[block].some((y) => wanted.has(y.item))) continue;
    useless.push(`(${at.x}, ${at.y}, ${at.z}) is ${block}`);
  }
  if (useless.length === 0) return null;
  const first = plan.steps.find((s) => s.action.type === 'DIG_BLOCK')?.action as ActionSpec;
  const needed = Object.entries(needs)
    .map(([item, n]) => `${n} ${item}`)
    .join(', ');
  const why = `it digs blocks that give nothing the task needs (${needed}): ${useless.join('; ')}`;
  const tail = '. To get a block, plan GATHER {block, count}: code digs only that block.';
  const head = 'Your plan would dig the wrong blocks';
  const room = MAX_JOURNAL_LINE - head.length - tail.length - 3;
  return {
    step: `DIG_BLOCK x${useless.length}`,
    why,
    note: `${head} (${why.slice(0, Math.max(0, room))})${tail}`,
    action: first,
    lastFailure: null,
    repeated: false,
  };
}

/**
 * Refusals a new plan cannot change: the observation is not trustworthy, or a danger allows
 * only escapes. System 1 deals with those, not the planner.
 */
const NOT_THE_PLANS: ReadonlySet<string> = new Set(['ACTION_NOT_ALLOWED_IN_DANGER']);

/**
 * The plan's first step when code would refuse it: the executor's own checks (schema, safety
 * policy, preconditions: validateCandidate), dry run on this state. Null when it would run,
 * when it is a GATHER (code expands that), or when the refusal is not the plan's to fix
 * (danger, an unreliable observation). With why, and a note for the planner; for a repeated
 * failure, also what the last failure said (for a walk: from this very block).
 */
function refusedFirstStep(
  deps: AgentDeps,
  plan: Plan,
  state: GameState,
  ctx: SafetyContext,
  taskId: string,
): {
  step: string;
  why: string;
  note: string;
  action: { type: string; args: unknown };
  /** What the last failure of this very step said, when it is a repeated failure. */
  lastFailure: string | null;
  /** The repeated-failure rule is among the refusals. */
  repeated: boolean;
} | null {
  // GATHER steps run first to last, one with nothing to dig skipped (gatherEnded): the step
  // that would act first is the one to check, and with none, the plan would do nothing (seen
  // live: "GATHER logs, GATHER gravel" again and again, the logs walled in, no gravel in view).
  const idle: string[] = [];
  let first: ActionSpec | undefined;
  for (const s of plan.steps) {
    if (s.action.type !== GATHER) {
      first = s.action;
      break;
    }
    const choice = chooseGatherAction(
      s.action,
      startGather(0, 0, s.action, state, ctx.now),
      state,
      {
        reach: ctx.config.interactionReach,
        now: ctx.now,
        check: previewCheck(deps.repos.actions, taskId, state, ctx),
        remembered: rememberedFor(deps, s.action, state, ctx.now),
      },
    );
    if (choice.kind === 'act') return null;
    if (choice.end === 'no-target') {
      idle.push(`GATHER ${sourceName(gatherSourceOf(s.action))}: ${choice.why}`);
    }
  }
  if (first === undefined) {
    if (idle.length === 0) return null;
    const why = idle.join('; ');
    const head = 'Your plan would dig nothing';
    const tail = '. Plan something else: EXPLORE toward where it can be reached, or another step.';
    const room = MAX_JOURNAL_LINE - head.length - tail.length - 3;
    const lead = plan.steps[0]?.action as { type: string; args: unknown };
    return {
      step: idle.map((l) => l.slice(0, l.indexOf(': '))).join(', '),
      why,
      note: `${head} (${why.slice(0, Math.max(0, room))})${tail}`,
      action: lead,
      lastFailure: null,
      repeated: false,
    };
  }
  const action = createAction(
    { spec: first, reason: "dry run of a new plan's first step", origin: 'planner', taskId },
    { newId: () => 'dry-run', now: () => deps.clock.now() },
  );
  const { report } = validateCandidate(action, state, ctx, deps.repos.actions);
  if (report.ok) return null;
  const unreliable = new Set(assessStateReliability(state, ctx).map((v) => v.code));
  if (report.violations.some((v) => NOT_THE_PLANS.has(v.code) || unreliable.has(v.code))) {
    return null;
  }
  let why = [...report.violations.map((v) => v.message), ...report.preconditionFailures].join('; ');
  let lastFailure: string | null = null;
  const repeated = report.violations.some((v) => v.code === 'REPEATED_FAILURE');
  if (repeated) {
    const from = state.player.position.known ? state.player.position.value : null;
    const fingerprint = actionFingerprint(first, from);
    const last = deps.repos.actions
      .recent(50, taskId)
      .find(
        (a) =>
          a.fingerprint === fingerprint &&
          (a.status === 'failed' || a.status === 'verification_failed'),
      );
    const e = last?.execution;
    const failures = deps.repos.actions.countFailures(taskId, fingerprint);
    // A walk's failures count from this very block only (actionFingerprint).
    const here = fingerprint === actionFingerprint(first) ? '' : ' from where the player stands';
    if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') {
      why = `it failed ${failures} time(s)${here}: ${e.message}`;
      lastFailure = e.message;
    }
  }
  const step = `${first.type} ${stableStringify(first.args)}`.slice(0, 120);
  const head = `Step 1 of your plan, ${step}, would be refused`;
  const tail = '. Plan something else: another target or kind of step.';
  // Why, in the room the journal line leaves.
  const room = MAX_JOURNAL_LINE - head.length - tail.length - 3;
  return {
    step,
    why,
    note: `${head} (${why.slice(0, Math.max(0, room))})${tail}`,
    action: first,
    lastFailure,
    repeated,
  };
}

/** What the planner is told when it escalated for want of a place while exploring was open. */
const EXPLORE_REMINDER =
  'You escalated for want of a place, but EXPLORE is in allowedActions, it is day, and the ' +
  'route says where to look: plan an EXPLORE toward the place or biome it names (or a ' +
  'direction with little seen) as the last step. A failed EXPLORE from elsewhere or toward ' +
  'another point says nothing here.';

/** EXPLORE is offered, it is day, and the route points at somewhere to explore. */
function explorationOpen(request: PlannerRequest): boolean {
  return (
    request.allowedActions.includes('EXPLORE') &&
    request.state.time?.phase === 'day' &&
    (request.route?.steps ?? []).some((s) => s.includes('no known place yet: explore'))
  );
}

export async function consultPlanner(
  deps: AgentDeps,
  state: GameState,
  ctx: SafetyContext,
  cycleId: string,
  stateSnapshotId: number,
): Promise<Consulted> {
  const { config, repos, planner } = deps;
  const pauseWith = (question: string, outcome: PlannerOutcome): Consulted => ({
    chosen: {
      spec: { type: 'PAUSE_AND_ASK_USER', args: { question: question.slice(0, 500) } },
      reason: `planner: ${outcome.kind}`,
      origin: 'deterministic-router',
    },
    outcome,
    planStep: null,
  });

  const taskId = state.currentTask?.taskId ?? null;
  if (taskId === null) {
    return pauseWith('There is no task to plan for. What should the agent do?', {
      kind: 'unavailable',
    });
  }

  // A code-made blueprint (the night shelter, the way out of it) runs its next step as a
  // known safe step whatever the decision provider chose: code's own steps never go through
  // the planner (known-steps.ts).
  const known = nextKnownStep(repos, taskId);
  if (known !== null) {
    return {
      chosen: {
        spec: known.spec,
        reason: `code's step ${known.index + 1}/${known.total}: ${known.text}`.slice(0, 500),
        origin: 'deterministic-router',
      },
      outcome: { kind: 'known-step', step: known.index + 1, steps: known.total },
      planStep: null,
    };
  }

  // An open plan takes precedence over asking the planner again.
  const open = repos.plans.openForTask(taskId);
  if (open?.status === 'pending_approval') {
    return pauseWith(
      `Plan #${open.id} "${open.plan.goal}" (${open.plan.steps.length} steps) is still waiting for approval. ${reviewHint(taskId, open.id)}`,
      {
        kind: 'approval-pending',
        planId: open.id,
        goal: open.plan.goal,
        steps: open.plan.steps.length,
      },
    );
  }
  if (open?.status === 'active') {
    // The open plan's next step, dry run like a new plan's first (refusedFirstStep): one the
    // repeated-failure rule would refuse now ends the plan, and the planner is asked again
    // below, told why. Seen live: an EXPLORE failed twice from one spot; the next session ran
    // the open plan's step a third time, the rule refused it, and play stopped for a human.
    // Other refusals still meet the plan's own handling when the step runs (a machine taken
    // for a chest blocks the task); a GATHER runs on as code expands it.
    const next = open.plan.steps[open.nextStep];
    const refused =
      next === undefined || next.action.type === GATHER
        ? null
        : refusedFirstStep(
            deps,
            { ...open.plan, steps: open.plan.steps.slice(open.nextStep) },
            state,
            ctx,
            taskId,
          );
    if (refused === null || !refused.repeated) return stepOf(deps, open, 'plan-step', state, ctx);
    repos.plans.setStatus(
      open.id,
      'failed',
      `step ${open.nextStep + 1} would be refused: ${refused.why}`.slice(0, 500),
    );
    repos.memory.appendJournal(
      taskId,
      `plan #${open.id} ended: its step ${open.nextStep + 1}, ${refused.step}, would be refused (${refused.why})`.slice(
        0,
        MAX_JOURNAL_LINE,
      ),
    );
    if (refused.lastFailure !== null) {
      rememberDeadEnd(
        repos.memory,
        refused.action,
        { ok: false, message: refused.lastFailure },
        state.player.position.known ? state.player.position.value : null,
      );
    }
  }

  if (planner === null || config.planner.provider === 'none') {
    return pauseWith(
      'No planner is configured and no known safe step exists. What should the agent do?',
      {
        kind: 'unavailable',
      },
    );
  }

  const limit = config.planner.recentHistoryLimit;
  const requestNow = (): PlannerRequest => {
    const exploration = explorationFor(config, repos, state, ctx.now);
    return buildPlannerRequest({
      state,
      safety: ctx,
      maxPlanSteps: config.planner.maxPlanSteps,
      ...(exploration === undefined ? {} : { exploration }),
      recentMeals: repos.actions.recentMeals(MEAL_HISTORY_LENGTH),
      combatEnabled: config.minecraft.combat.enabled,
      recentActions: repos.actions
        .recent(limit, taskId)
        .flatMap((a) =>
          isAllowlistedActionType(a.actionType)
            ? [{ actionType: a.actionType, status: a.status, reason: a.reason.slice(0, 200) }]
            : [],
        ),
      recentFailures: repos.actions
        .failureSummary(taskId, limit)
        .flatMap((f) =>
          isAllowlistedActionType(f.actionType) ? [{ ...f, actionType: f.actionType }] : [],
        ),
      journal: repos.memory.journal(taskId).map((e) => e.text),
    });
  };
  const request = requestNow();

  const ask = async (req: PlannerRequest): Promise<PlannerResponse> => {
    try {
      // A journal line past the request's limit fails the whole request before the model
      // sees it (seen live: both re-ask notes were too long, so neither re-ask ever ran).
      const journal = req.journal.map((line) => line.slice(0, MAX_JOURNAL_LINE));
      const parsed = PlannerResponseSchema.safeParse(await planner.plan({ ...req, journal }));
      return parsed.success
        ? parsed.data
        : {
            kind: 'escalation',
            escalation: {
              reason: 'INVALID_OUTPUT',
              message: 'Planner response failed schema validation',
              questionForUser: 'The planner produced invalid output. How should the agent proceed?',
            },
          };
    } catch (error) {
      return {
        kind: 'escalation',
        escalation: {
          reason: 'OTHER',
          message: `Planner error: ${errorMessage(error)}`.slice(0, 500),
          questionForUser: 'The planner failed. How should the agent proceed?',
        },
      };
    }
  };
  let response = await ask(request);
  // An escalation for want of a place while exploring is open, in daylight, with the route
  // saying where to look, contradicts the request: ask once more and say so (seen live: the
  // model kept escalating "no way to explore" with EXPLORE allowed and a forest in the route).
  if (
    response.kind === 'escalation' &&
    response.escalation.reason === 'INSUFFICIENT_STATE' &&
    explorationOpen(request)
  ) {
    repos.events.append(cycleId, 'PLAN', { provider: planner.name, response });
    repos.memory.appendJournal(
      taskId,
      `planner escalated (${response.escalation.reason}) although EXPLORE was open; asked again`,
    );
    response = await ask({ ...request, journal: [...request.journal, EXPLORE_REMINDER] });
  }
  repos.events.append(cycleId, 'PLAN', { provider: planner.name, response });

  if (response.kind === 'escalation') {
    const e = response.escalation;
    repos.memory.appendJournal(taskId, `planner escalated (${e.reason}): ${e.message}`);
    return pauseWith(e.questionForUser, {
      kind: 'escalation',
      reason: e.reason,
      message: e.message,
    });
  }

  // Steps after an EXPLORE (and view-bound steps after a GATHER) were planned from a view
  // that will be gone when they run: they are dropped first, and only the steps that will run
  // are checked (seen live: a starving agent's food plan, EXPLORE, GATHER garden, then
  // EAT_FOOD of the garden block, was rejected whole for its third step, and it paused).
  const firstTrim = trimStaleSteps(response.plan);
  const validation = validatePlan(firstTrim.plan, ctx, config.planner.maxPlanSteps);
  if (!validation.ok || validation.plan === null) {
    repos.checkpoints.add(
      taskId,
      'plan-rejected',
      { plan: response.plan, validation },
      stateSnapshotId,
    );
    const stepViolations = validation.stepViolations.flatMap((s) => s.violations);
    const issues = [
      ...validation.schemaIssues,
      ...validation.stepViolations.flatMap((s) =>
        s.violations.map((v) => `step ${s.step}: ${v.code}`),
      ),
    ];
    repos.violations.insertMany(cycleId, null, [
      {
        code: 'PLAN_INVALID',
        severity: 'pause',
        message: `Planner plan rejected: ${issues.join('; ')}`.slice(0, 500),
        details: { goal: response.plan.goal.slice(0, 200) },
      },
      ...stepViolations,
    ]);
    return pauseWith(
      `The planner's plan was rejected (${issues.join('; ')}). How should the agent proceed?`,
      {
        kind: 'plan-rejected',
        issues,
      },
    );
  }

  // The next plan starts from where the dropped steps would have (firstTrim above).
  let plan = validation.plan;
  let trimmed = firstTrim.note;
  // A first step code would refuse ends the session, often for a human (seen live: the model
  // planned the same EXPLORE toward an unreachable tree a third time, and EXPLORE toward the
  // forest it stood in, 1.6 blocks away, three sessions running). Code checks the step the
  // way the executor will, and if it would refuse it for a reason the planner can change,
  // asks once more, saying why; should that answer not do, the first plan stands and the
  // executor refuses its step as before.
  const refused = digsForNothing(plan, state) ?? refusedFirstStep(deps, plan, state, ctx, taskId);
  if (refused !== null) {
    repos.memory.appendJournal(
      taskId,
      `planner chose ${refused.step}, which code would refuse (${refused.why}); asked again`.slice(
        0,
        MAX_JOURNAL_LINE,
      ),
    );
    // An EXPLORE that found no way further from here is a dead end (dead-ends.ts): remember
    // it now, so the request asked again no longer offers the places around its point.
    let base = request;
    if (refused.lastFailure !== null) {
      rememberDeadEnd(
        repos.memory,
        refused.action,
        { ok: false, message: refused.lastFailure },
        state.player.position.known ? state.player.position.value : null,
      );
      base = requestNow();
    }
    const again = await ask({ ...base, journal: [...base.journal, refused.note] });
    repos.events.append(cycleId, 'PLAN', { provider: planner.name, response: again });
    const againTrim = again.kind === 'plan' ? trimStaleSteps(again.plan) : null;
    const checked =
      againTrim === null ? null : validatePlan(againTrim.plan, ctx, config.planner.maxPlanSteps);
    if (againTrim !== null && checked?.ok === true && checked.plan !== null) {
      plan = checked.plan;
      trimmed = againTrim.note;
    }
  }
  const stored = repos.plans.create(
    taskId,
    plan,
    plan.requiresUserApproval ? 'pending_approval' : 'active',
    planner.name,
  );
  repos.checkpoints.add(
    taskId,
    'plan',
    { planId: stored.id, status: stored.status, plan, ...(trimmed === null ? {} : { trimmed }) },
    stateSnapshotId,
  );
  if (stored.status === 'pending_approval') {
    // The commands come before the planner's explanation so truncation cannot cut them off.
    return pauseWith(
      `Approve plan #${stored.id} "${plan.goal}" (${plan.steps.length} steps)? ${reviewHint(taskId, stored.id)} Planner: ${plan.explanation}`,
      { kind: 'approval-required', planId: stored.id, goal: plan.goal, steps: plan.steps.length },
    );
  }
  repos.memory.appendJournal(
    taskId,
    `new plan #${stored.id}: ${stored.plan.goal} (${stored.plan.steps.length} steps` +
      `${trimmed === null ? '' : `; code ${trimmed}`})`,
  );
  return stepOf(deps, stored, 'plan-accepted', state, ctx);
}

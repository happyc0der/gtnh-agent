import type { ModelCadence } from '../config/env.ts';
import type { Decision, DecisionResult, FactValue, ReasonCode } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import { assessDangers } from '../safety/safety-policy.ts';
import {
  isBindingRouterDecision,
  SafetyFirstDecisionProvider,
  type DecisionProvider,
} from './decision-provider.ts';
import { routeDecision } from './deterministic-router.ts';
import { inventoryFillFraction, type PlanFacts, type RouterContext } from './state-queries.ts';

/**
 * System 1 with a model, asked only at decision points (decisions.modelCadence).
 *
 * On live runs the rule router decided what qwen3:14b decided on 88 of 89 cycles, while the
 * model took about 2 s a decision (10 s at worst). So the model decides where a decision is
 * due, when something changed; between those cycles the router's decision continues the open
 * plan at once (REQUEST_PLANNER runs the plan's next step, or a GATHER's next dig, with no
 * planner call either). The router's binding decisions (safety, every pause) win as before,
 * without asking anyone.
 */

/** What a decision rests on. A change between two cycles is a decision point. */
export interface DecisionConditions {
  /** The rule router's decision, and its reason codes (sorted). */
  routerDecision: Decision;
  routerReasons: readonly ReasonCode[];
  /** The safety policy's dangers, sorted: a mob, a hazard, low health or food, the bounds. */
  dangers: readonly string[];
  /** Below the eating threshold (food runs low before it is a danger). */
  hungry: boolean;
  /** "<task id> (<status>)", or null without a task. */
  task: string | null;
  /** day, evening, night or dawn; unknown while the clock is. */
  timePhase: string;
  inventoryNearlyFull: boolean;
}

/** One cycle as the cadence sees it; each is compared with the one before. */
export interface CycleView {
  conditions: DecisionConditions;
  taskId: string | null;
  /** The task's latest plan (RouterContext.plan; null: none, or not given). */
  plan: PlanFacts | null;
  /** The last logged action, which agent memory puts into the observation. */
  lastAction: { id: string; type: string; result: string } | null;
  /** What the model decided this cycle; null when it was not asked. */
  modelDecision: Decision | null;
}

export function cycleView(state: GameState, ctx: RouterContext, router: DecisionResult): CycleView {
  const { config } = ctx.safety;
  const hunger = state.player.hunger.known ? state.player.hunger.value : null;
  const fill = inventoryFillFraction(state);
  const task = state.currentTask;
  const last = state.lastAction;
  return {
    conditions: {
      routerDecision: router.decision,
      routerReasons: [...new Set(router.reasonCodes)].sort(),
      dangers: [...new Set(assessDangers(state, ctx.safety).map((d) => d.code))].sort(),
      hungry: hunger !== null && hunger < config.hungerEatThreshold,
      task: task === null ? null : `${task.taskId} (${task.status})`,
      timePhase: state.time.known ? state.time.value.phase : 'unknown',
      inventoryNearlyFull: fill !== null && fill >= config.inventoryNearlyFullFraction,
    },
    taskId: task?.taskId ?? null,
    plan: ctx.plan ?? null,
    lastAction:
      last === null ? null : { id: last.actionId, type: last.actionType, result: last.result },
    modelDecision: null,
  };
}

/** Whether the model decides this cycle, and why (or why not). */
export type DecisionPoint = { askModel: true; why: string[] } | { askModel: false; why: string };

/** Plan statuses after which it no longer runs (pending approval has not run yet). */
const PLAN_ENDED: ReadonlySet<string> = new Set(['completed', 'failed', 'rejected', 'superseded']);

const NOT_SUCCEEDED: Readonly<Record<string, string>> = {
  failed: 'failed',
  rejected: 'was rejected',
  verification_failed: 'was not verified',
};

const routerText = (c: DecisionConditions): string =>
  `${c.routerDecision} [${c.routerReasons.join(', ')}]`;
const listText = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));

/** What changed between two cycles' conditions, one phrase each. */
function conditionChanges(a: DecisionConditions, b: DecisionConditions): string[] {
  const out: string[] = [];
  if (routerText(a) !== routerText(b)) {
    out.push(`the router's decision changed: ${routerText(a)} -> ${routerText(b)}`);
  }
  if (listText(a.dangers) !== listText(b.dangers)) {
    out.push(`dangers changed: ${listText(a.dangers)} -> ${listText(b.dangers)}`);
  }
  if (a.hungry !== b.hungry) out.push(b.hungry ? 'hungry now' : 'no longer hungry');
  if (a.task !== b.task) out.push(`the task changed: ${a.task ?? 'none'} -> ${b.task ?? 'none'}`);
  if (a.timePhase !== b.timePhase) {
    out.push(`the time of day changed: ${a.timePhase} -> ${b.timePhase}`);
  }
  if (a.inventoryNearlyFull !== b.inventoryNearlyFull) {
    out.push(
      b.inventoryNearlyFull ? 'the inventory is nearly full' : 'the inventory has room again',
    );
  }
  return out;
}

/** What a continuing cycle goes on with. */
function goesOn(now: CycleView): string {
  const p = now.plan;
  const what =
    now.conditions.routerDecision === 'REQUEST_PLANNER' && p !== null
      ? `plan #${p.planId} step ${p.step}/${p.steps}${p.stepType === null ? '' : ` (${p.stepType})`}`
      : now.conditions.routerDecision;
  return `nothing changed since the previous cycle: ${what} goes on`;
}

/**
 * The decision-point check, pure: whether the model decides this cycle. `previous` is the
 * previous cycle of the session (null: this is the session's first). With cadence
 * 'decision-points' a decision is due when:
 *  - it is the session's first cycle;
 *  - the previous cycle's action failed, was rejected or not verified, or paused;
 *  - the model decided the previous cycle and chose otherwise than the router (going on with
 *    the router's decision would undo its choice);
 *  - the task's plan ended since the previous cycle began (completed, failed, superseded;
 *    also a plan that cycle made and finished at once), or the router asks for the planner
 *    and there is no open plan (or GATHER step) to continue;
 *  - a condition changed: the router's decision or reason codes, the dangers (a mob, a
 *    hazard, low health or food), hunger, the task, the time of day, the inventory nearly
 *    full (or no longer).
 * Otherwise the router's decision goes on. With 'every-cycle' every cycle is a decision
 * point. A binding router decision is the caller's to apply first: then nobody is asked.
 */
export function decisionPoint(
  cadence: ModelCadence,
  previous: CycleView | null,
  now: CycleView,
): DecisionPoint {
  if (cadence === 'every-cycle') {
    return { askModel: true, why: ['every cycle (decisions.modelCadence: every-cycle)'] };
  }
  if (previous === null) return { askModel: true, why: ['the first cycle of the session'] };
  const why: string[] = [];

  const last = now.lastAction;
  if (last !== null && last.id !== previous.lastAction?.id) {
    if (last.type === 'PAUSE_AND_ASK_USER') why.push('the previous cycle paused');
    else if (last.result !== 'succeeded') {
      why.push(`the previous ${last.type} ${NOT_SUCCEEDED[last.result] ?? last.result}`);
    }
  }

  // Going on with the router's decision would undo a different choice the model just made.
  const chose = previous.modelDecision;
  if (chose !== null && chose !== previous.conditions.routerDecision) {
    why.push(
      `the model chose ${chose} last cycle, the router ${previous.conditions.routerDecision}`,
    );
  }

  // The task's latest plan ended since the previous cycle began: the plan that cycle went on
  // with, or one it made and finished (a one-step plan).
  const was = previous.plan;
  const is = now.plan;
  if (now.taskId === previous.taskId) {
    const wasOpen = was !== null && was.status === 'active';
    if (is !== null && PLAN_ENDED.has(is.status) && (is.planId !== was?.planId || wasOpen)) {
      why.push(`plan #${is.planId} ended (${is.status})`);
    } else if (was !== null && wasOpen && is?.planId !== was.planId) {
      why.push(`plan #${was.planId} ended`);
    }
  }
  if (now.conditions.routerDecision === 'REQUEST_PLANNER' && is?.status !== 'active') {
    why.push('no open plan to continue');
  }

  why.push(...conditionChanges(previous.conditions, now.conditions));
  return why.length > 0 ? { askModel: true, why } : { askModel: false, why: goesOn(now) };
}

/** factsUsed.cadence: which way this cycle's System 1 decision went. */
export type CadenceWay = 'model' | 'continuing' | 'binding';

export interface ModelCadenceOptions {
  /** Milliseconds, to time the model's calls (injectable for tests). */
  now?: () => number;
}

function withWay(
  d: DecisionResult,
  way: CadenceWay,
  why: string,
  extra: Record<string, FactValue> = {},
): DecisionResult {
  return {
    ...d,
    factsUsed: { ...d.factsUsed, cadence: way, cadenceWhy: why.slice(0, 300), ...extra },
  };
}

/**
 * A model decision provider asked at its cadence. It IS a SafetyFirstDecisionProvider, so
 * whenever the model is asked, its answer meets exactly the safety-first rules as before
 * (schema check, invalid output or an error pauses, pauses and retreats the facts rule out
 * are overruled). Each cycle:
 *  - the router's binding decision (safety, any pause) wins; nobody else is asked;
 *  - at a decision point (decisionPoint) the model decides;
 *  - otherwise the router's decision goes on, without the model (provider
 *    `continuing(deterministic-router)`).
 * Every decision records in factsUsed which way it went (`cadence`: model, continuing or
 * binding), why (`cadenceWhy`), and for the model the call's time (`modelMs`). A session
 * start forgets the previous cycle, so a session's first cycle asks the model.
 */
export class ModelCadenceProvider extends SafetyFirstDecisionProvider {
  readonly cadence: ModelCadence;
  readonly #now: () => number;
  /** The previous cycle of this session; null before its first. */
  #previous: CycleView | null = null;

  constructor(model: DecisionProvider, cadence: ModelCadence, options: ModelCadenceOptions = {}) {
    super(model);
    this.cadence = cadence;
    this.#now = options.now ?? Date.now;
  }

  startSession(): void {
    this.#previous = null;
  }

  override async decide(state: GameState, ctx: RouterContext): Promise<DecisionResult> {
    const router = routeDecision(state, ctx);
    const view = cycleView(state, ctx, router);
    const point = decisionPoint(this.cadence, this.#previous, view);
    this.#previous = view;
    if (isBindingRouterDecision(router)) {
      return withWay(
        { ...router, provider: this.name },
        'binding',
        `the router's decision is binding (${router.reasonCodes.join(', ')}): the model is not asked`,
      );
    }
    if (!point.askModel) {
      return withWay(
        { ...router, provider: `continuing(${router.provider})` },
        'continuing',
        point.why,
      );
    }
    const started = this.#now();
    const decided = await super.decide(state, ctx);
    this.#previous = { ...view, modelDecision: decided.decision };
    return withWay(decided, 'model', point.why.join('; '), {
      modelMs: Math.max(0, Math.round(this.#now() - started)),
    });
  }
}

/** How System 1 decided over a run of cycles (from the decisions' factsUsed). */
export interface System1Stats {
  /** Decisions counted: one per cycle that reached System 1. */
  decisions: number;
  /** Cycles the model decided (at a decision point, or every cycle). */
  model: number;
  /** Cycles that went on with the router's decision, without the model. */
  continued: number;
  /** The router's binding decisions (safety, pauses), with a model configured. */
  binding: number;
  /** Each model call's time (ms), in order. */
  modelMs: readonly number[];
}

export const NO_SYSTEM1_STATS: System1Stats = Object.freeze({
  decisions: 0,
  model: 0,
  continued: 0,
  binding: 0,
  modelMs: Object.freeze([]),
});

export function system1Stats(
  decisions: ReadonlyArray<DecisionResult | null | undefined>,
): System1Stats {
  let counted = 0;
  let model = 0;
  let continued = 0;
  let binding = 0;
  const modelMs: number[] = [];
  for (const d of decisions) {
    if (d === null || d === undefined) continue;
    counted += 1;
    const way = d.factsUsed['cadence'];
    if (way === 'model') {
      model += 1;
      const ms = d.factsUsed['modelMs'];
      if (typeof ms === 'number') modelMs.push(ms);
    } else if (way === 'continuing') continued += 1;
    else if (way === 'binding') binding += 1;
  }
  return { decisions: counted, model, continued, binding, modelMs };
}

export function mergeSystem1Stats(a: System1Stats, b: System1Stats): System1Stats {
  return {
    decisions: a.decisions + b.decisions,
    model: a.model + b.model,
    continued: a.continued + b.continued,
    binding: a.binding + b.binding,
    modelMs: [...a.modelMs, ...b.modelMs],
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The stats line for a session's end, e.g. "System 1 over 63 cycle(s): 3 model decision(s)
 * (median 2.1 s), 60 continued without the model, 0 binding router decision(s)". Null when
 * no model was configured (the rule router decided everything).
 */
export function describeSystem1Stats(s: System1Stats): string | null {
  if (s.model + s.continued + s.binding === 0) return null;
  const m = median(s.modelMs);
  return (
    `System 1 over ${s.decisions} cycle(s): ${s.model} model decision(s)` +
    (m === null ? '' : ` (median ${(m / 1000).toFixed(1)} s)`) +
    `, ${s.continued} continued without the model, ${s.binding} binding router decision(s)`
  );
}

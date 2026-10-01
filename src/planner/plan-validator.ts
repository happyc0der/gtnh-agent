import { isCodeOnlyActionType } from '../domain/actions.ts';
import { isQuestBookActionType } from '../domain/quest-book.ts';
import type { SafetyViolation } from '../domain/safety.ts';
import { evaluateStaticSpec, type SafetyContext } from '../safety/safety-policy.ts';
import { errorMessage } from '../util/json.ts';
import { GATHER } from './gather.ts';
import {
  PlanSchema,
  PlannerResponseSchema,
  type Plan,
  type PlannerResponse,
} from './plan-schema.ts';

export interface PlanValidation {
  ok: boolean;
  plan: Plan | null;
  schemaIssues: string[];
  stepViolations: Array<{ step: number; violations: SafetyViolation[] }>;
}

/**
 * Validates a plan before any of it may run:
 *  1. strict schema (allowlisted action specs only, bounded args, no extra fields),
 *  2. configured step limit,
 *  3. static safety checks on EVERY step (protected items, approved food/fuel,
 *     boundary, known safe locations);
 *  4. no quest-book clicks (SUBMIT_QUEST, CHECK_QUEST_BOX, CLAIM_QUEST_REWARD): the play loop
 *     makes those itself, deterministically, from the server's quest book;
 *  5. no code-only steps (DIG_DOWN: the night pit's, proposed only by code's blueprint).
 * A GATHER step has no static checks beyond its schema (a block on DIG_BLOCK's allowlist,
 * a count of 1 to 256): it names no position or item to check. Every DIG_BLOCK and MOVE_TO
 * it expands into is validated like any other action when it runs.
 * The step that is about to execute is additionally checked against live state by
 * the executor (evaluateAction) at execution time.
 */
export function validatePlan(raw: unknown, ctx: SafetyContext, maxSteps: number): PlanValidation {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      plan: null,
      schemaIssues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      stepViolations: [],
    };
  }
  const plan = parsed.data;
  const schemaIssues: string[] = [];
  if (plan.steps.length > maxSteps) {
    schemaIssues.push(`plan has ${plan.steps.length} steps; the limit is ${maxSteps}`);
  }
  for (const s of plan.steps) {
    if (isQuestBookActionType(s.action.type)) {
      schemaIssues.push(
        `step ${s.step}: ${s.action.type} is a quest-book click; the play loop makes those, not plans`,
      );
    }
    if (isCodeOnlyActionType(s.action.type)) {
      schemaIssues.push(
        `step ${s.step}: ${s.action.type} is the night pit's own step; only code's blueprint proposes it, never a plan`,
      );
    }
  }
  const stepViolations = plan.steps
    .map((s) => ({
      step: s.step,
      violations: s.action.type === GATHER ? [] : evaluateStaticSpec(s.action, ctx),
    }))
    .filter((s) => s.violations.length > 0);

  return {
    ok: schemaIssues.length === 0 && stepViolations.length === 0,
    plan,
    schemaIssues,
    stepViolations,
  };
}

/** Plan steps that name something only the current view shows: a position or a creature. */
const NAMES_THE_VIEW: ReadonlySet<string> = new Set([
  'MOVE_TO',
  'DIG_BLOCK',
  'PLACE_BLOCK',
  'INTERACT_BLOCK',
  'SMELT',
  'TAKE_OUTPUT',
  'ATTACK_ENTITY',
]);

/**
 * Drops the steps of an accepted plan that were planned from a view the plan itself
 * replaces, so they cannot run stale (a planner's plan is made from ONE observation):
 *  - every step after the first EXPLORE: it walks up to 96 blocks into new ground, so a
 *    position or a creature from before is no longer where the plan thinks (seen live: a
 *    dig target 7.3 blocks away after two EXPLOREs, refused as stale);
 *  - after a GATHER, which walks from block to block, the first step that names a position
 *    or a creature, and everything after it. Steps that name none (crafting what it
 *    gathered, another GATHER, a container or a named location) stay.
 * The next plan starts from what the agent sees then. `note` says what was dropped (null
 * when nothing was), e.g. "dropped steps 2-3 after the EXPLORE at step 1"; the plan's
 * explanation says it too.
 */
export function trimStaleSteps(plan: Plan): { plan: Plan; note: string | null } {
  let keep = plan.steps.length;
  let after = '';
  let gatherStep: number | null = null;
  for (const [i, s] of plan.steps.entries()) {
    if (s.action.type === 'EXPLORE') {
      keep = i + 1;
      after = `the EXPLORE at step ${s.step}`;
      break;
    }
    if (gatherStep !== null && NAMES_THE_VIEW.has(s.action.type)) {
      keep = i;
      after = `the GATHER at step ${gatherStep}`;
      break;
    }
    if (s.action.type === GATHER) gatherStep ??= s.step;
  }
  if (keep >= plan.steps.length) return { plan, note: null };
  const dropped =
    keep + 1 === plan.steps.length ? `step ${keep + 1}` : `steps ${keep + 1}-${plan.steps.length}`;
  const note = `dropped ${dropped} after ${after}`;
  const why = `(Code ${note}: planned from the view before it, they would run stale; the next plan starts from what the agent sees then.)`;
  return {
    plan: {
      ...plan,
      steps: plan.steps.slice(0, keep),
      explanation: `${plan.explanation.slice(0, 1000 - why.length - 1)} ${why}`,
    },
    note,
  };
}

/**
 * Parses raw planner text (e.g. a future local LLM's JSON output). Anything that is
 * not valid JSON matching PlannerResponseSchema becomes an explicit escalation;
 * there is no "best effort" repair.
 */
export function parsePlannerOutput(text: string): PlannerResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return invalidOutput(`not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = PlannerResponseSchema.safeParse(json);
  if (!parsed.success) {
    return invalidOutput(
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

function invalidOutput(detail: string): PlannerResponse {
  return {
    kind: 'escalation',
    escalation: {
      reason: 'INVALID_OUTPUT',
      message: `Planner output rejected: ${detail}`.slice(0, 500),
      questionForUser: 'The planner produced invalid output. How should the agent proceed?',
    },
  };
}

import type { SafetyViolation } from '../domain/safety.ts';
import { evaluateStaticSpec, type SafetyContext } from '../safety/safety-policy.ts';
import { errorMessage } from '../util/json.ts';
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
 *     boundary, known safe locations).
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
  const stepViolations = plan.steps
    .map((s) => ({ step: s.step, violations: evaluateStaticSpec(s.action, ctx) }))
    .filter((s) => s.violations.length > 0);

  return {
    ok: schemaIssues.length === 0 && stepViolations.length === 0,
    plan,
    schemaIssues,
    stepViolations,
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

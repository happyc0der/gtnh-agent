import { z } from 'zod';
import { ActionSpecSchema, toSpec, type Action, type ActionSpec } from '../../domain/actions.ts';
import type { ShelterStep } from '../../domain/night-shelter.ts';
import type { ExecutionOutcome } from '../../executor/action-executor.ts';
import { TASK_STEPS_PREFIX } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { stableStringify } from '../../util/json.ts';

/**
 * A code-made blueprint for a task: actions code chose, run in order as known safe steps,
 * never through the planner. Today the night shelter (the pit's digs down and its roof, or
 * the box) and the way out of it in the morning (src/app/play/night.ts). Kept in agent memory
 * (`task_steps:<taskId>`) with how many are done:
 *  - overlayAgentMemory makes the next step the state's knownRecipeState.nextKnownSafeStep,
 *    so System 1's rule 6 decides EXECUTE_KNOWN_SAFE_STEP and the proposer runs it (origin
 *    deterministic-router). Should a model decide REQUEST_PLANNER instead, the agent loop
 *    still runs the next step rather than ask the planner;
 *  - each step is an ordinary action: schema, safety policy (which checks DIG_DOWN against
 *    exactly this next step), preconditions, execution and verification;
 *  - a verified step advances the blueprint; the last one completes the task, so a session
 *    on it ends ("the task is completed"). A step that does not succeed leaves it: the
 *    cycle fails, the session ends, and play plans again from what it then sees.
 */

const KnownStepsSchema = z.strictObject({
  steps: z
    .array(z.strictObject({ spec: ActionSpecSchema, text: z.string().min(1).max(300) }))
    .min(1)
    .max(32),
  /** Verified steps so far; the next one is steps[done]. */
  done: z.int().min(0).max(32),
});
type KnownSteps = z.infer<typeof KnownStepsSchema>;

const keyOf = (taskId: string): string => `${TASK_STEPS_PREFIX}${taskId}`;

function load(repos: Repositories, taskId: string): KnownSteps | null {
  const raw = repos.memory.getValue(keyOf(taskId));
  if (raw === null) return null;
  try {
    const parsed = KnownStepsSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.done < parsed.data.steps.length ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stores a task's blueprint (none done yet), replacing any earlier one; null clears it. */
export function setKnownSteps(
  repos: Repositories,
  taskId: string,
  steps: readonly ShelterStep[] | null,
): void {
  const record =
    steps === null || steps.length === 0
      ? null
      : KnownStepsSchema.parse({
          steps: steps.slice(0, 32).map((s) => ({ spec: s.spec, text: s.text.slice(0, 300) })),
          done: 0,
        });
  repos.memory.setValue(keyOf(taskId), record === null ? null : JSON.stringify(record));
}

/** The task's next blueprint step, or null when it has none (or all are done). */
export function nextKnownStep(
  repos: Repositories,
  taskId: string,
): { spec: ActionSpec; text: string; index: number; total: number } | null {
  const k = load(repos, taskId);
  const step = k === null ? undefined : k.steps[k.done];
  if (k === null || step === undefined) return null;
  return { spec: step.spec, text: step.text, index: k.done, total: k.steps.length };
}

/**
 * After an action ran for `taskId`: if it was the blueprint's next step, a verified one
 * advances it (the last completes the task, with a journal line). Returns whether it was the
 * blueprint's step.
 */
export function knownStepAfterAction(
  repos: Repositories,
  taskId: string,
  action: Action,
  outcome: ExecutionOutcome,
): boolean {
  const k = load(repos, taskId);
  const step = k === null ? undefined : k.steps[k.done];
  if (k === null || step === undefined) return false;
  if (stableStringify(step.spec) !== stableStringify(toSpec(action))) return false;
  if (outcome.status !== 'succeeded') {
    repos.memory.appendJournal(
      taskId,
      `code's step ${k.done + 1}/${k.steps.length} (${step.text}) ${outcome.status}`.slice(0, 300),
    );
    return true;
  }
  const done = k.done + 1;
  if (done < k.steps.length) {
    repos.memory.setValue(keyOf(taskId), JSON.stringify({ ...k, done }));
    return true;
  }
  repos.transaction(() => {
    repos.memory.setValue(keyOf(taskId), null);
    repos.memory.appendJournal(taskId, `code's ${k.steps.length} step(s) done`);
    repos.tasks.setStatus(taskId, 'completed');
  });
  return true;
}

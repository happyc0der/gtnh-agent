import {
  ClientActionResultSchema,
  failed,
  type ClientActionResult,
  type MinecraftClient,
} from '../bot/minecraft-client.ts';
import { ActionIdSchema, ActionSchema, toSpec, type Action } from '../domain/actions.ts';
import type { Position } from '../domain/common.ts';
import { GameStateSchema, type GameState } from '../domain/game-state.ts';
import { mintValidatedAction } from '../domain/validated-action.ts';
import {
  actionFingerprint,
  evaluateAction,
  type FailureHistory,
  type SafetyContext,
} from '../safety/safety-policy.ts';
import type { Clock } from '../util/clock.ts';
import type { IdGenerator } from '../util/ids.ts';
import { errorMessage } from '../util/json.ts';
import type { ActionLog, ValidationReport } from './action-log.ts';
import { verifyPostcondition, type VerificationResult } from './action-verifier.ts';
import { checkPreconditions } from './preconditions.ts';

export type ExecutionStatus = 'rejected' | 'failed' | 'verification_failed' | 'succeeded';

export interface ExecutionOutcome {
  actionId: string;
  actionType: string;
  status: ExecutionStatus;
  validation: ValidationReport;
  execution: ClientActionResult | null;
  verification: VerificationResult | null;
  stateAfter: GameState | null;
}

export interface ExecutorDeps {
  client: MinecraftClient;
  log: ActionLog;
  history: FailureHistory;
  clock: Clock;
  newId: IdGenerator;
}

/** Schema + safety policy + preconditions, combined. Pure; no I/O. */
export function validateCandidate(
  candidate: unknown,
  state: GameState,
  ctx: SafetyContext,
  history: FailureHistory,
): { report: ValidationReport; action: Action | null; resolvedTarget: Position | null } {
  const safety = evaluateAction(candidate, state, ctx, history);
  const parsed = ActionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      report: {
        ok: false,
        violations: safety.violations,
        preconditionFailures: [],
        requiresUserPause: true,
      },
      action: null,
      resolvedTarget: null,
    };
  }
  const pre = checkPreconditions(parsed.data, state, ctx);
  return {
    report: {
      ok: safety.allowed && pre.ok,
      violations: safety.violations,
      preconditionFailures: pre.failures,
      requiresUserPause: safety.requiresUserPause,
    },
    action: parsed.data,
    resolvedTarget: pre.resolvedTarget,
  };
}

/**
 * The single controlled path from a proposed action to the game:
 *   validate (schema, safety, preconditions) -> persist -> execute -> observe -> verify -> persist.
 * Nothing else in the codebase calls MinecraftClient.perform().
 */
export class ActionExecutor {
  readonly #deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
  }

  async execute(
    candidate: unknown,
    stateBefore: GameState,
    ctx: SafetyContext,
    cycleId: string,
  ): Promise<ExecutionOutcome> {
    const { client, log, history, clock, newId } = this.#deps;
    const { report, action, resolvedTarget } = validateCandidate(
      candidate,
      stateBefore,
      ctx,
      history,
    );

    // 1-2. Persist the proposal and its validation outcome, whatever it was.
    const raw = (candidate ?? {}) as Record<string, unknown>;
    const actionId =
      action?.actionId ?? ActionIdSchema.safeParse(raw['actionId']).data ?? newId('rejected');
    const actionType =
      action?.type ?? (typeof raw['type'] === 'string' ? raw['type'].slice(0, 64) : 'UNKNOWN');
    log.recordProposal({
      cycleId,
      actionId,
      taskId: action?.taskId ?? null,
      actionType,
      origin: action?.origin ?? 'unknown',
      fingerprint: action ? actionFingerprint(toSpec(action)) : 'invalid',
      reason: action?.reason ?? '(invalid action)',
      action: candidate,
      validation: report,
    });

    if (!report.ok || action === null) {
      return {
        actionId,
        actionType,
        status: 'rejected',
        validation: report,
        execution: null,
        verification: null,
        stateAfter: null,
      };
    }

    // 3. Execute through the client, with a token only this executor can mint.
    let execution: ClientActionResult;
    try {
      const token = mintValidatedAction(action, resolvedTarget, clock.now(), ctx.protectedItems);
      execution = ClientActionResultSchema.parse(await client.perform(token));
    } catch (error) {
      execution = failed(`client error: ${errorMessage(error)}`, 'ERROR');
    }
    log.recordExecution(cycleId, actionId, execution);

    // 4. Observe and verify the postcondition.
    let stateAfter: GameState | null;
    try {
      stateAfter = GameStateSchema.parse(await client.observe());
    } catch {
      stateAfter = null;
    }
    const verification = verifyPostcondition({
      action,
      before: stateBefore,
      after: stateAfter,
      execution,
      ctx,
    });

    const status: ExecutionStatus = !execution.ok
      ? 'failed'
      : verification.verified
        ? 'succeeded'
        : 'verification_failed';
    log.recordOutcome(cycleId, actionId, status, verification);
    return {
      actionId,
      actionType,
      status,
      validation: report,
      execution,
      verification,
      stateAfter,
    };
  }
}

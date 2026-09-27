import type { ClientActionResult } from '../bot/minecraft-client.ts';
import type { SafetyViolation } from '../domain/safety.ts';
import type { ActionStatus, Repositories } from '../persistence/repositories.ts';
import type { VerificationResult } from './action-verifier.ts';

export interface ValidationReport {
  ok: boolean;
  violations: SafetyViolation[];
  preconditionFailures: string[];
  requiresUserPause: boolean;
}

export interface ProposalRecord {
  cycleId: string;
  actionId: string;
  taskId: string | null;
  actionType: string;
  origin: string;
  fingerprint: string;
  reason: string;
  /** The action as proposed (possibly invalid, if it was rejected by schema validation). */
  action: unknown;
  validation: ValidationReport;
}

/**
 * Audit trail for the executor. Every proposal, validation result, execution result
 * and verification result is persisted; each write is a single transaction.
 */
export interface ActionLog {
  recordProposal(record: ProposalRecord): void;
  recordExecution(cycleId: string, actionId: string, result: ClientActionResult): void;
  recordOutcome(
    cycleId: string,
    actionId: string,
    status: Extract<ActionStatus, 'succeeded' | 'failed' | 'verification_failed'>,
    verification: VerificationResult | null,
  ): void;
}

export class SqliteActionLog implements ActionLog {
  readonly #repos: Repositories;

  constructor(repos: Repositories) {
    this.#repos = repos;
  }

  recordProposal(r: ProposalRecord): void {
    const status: ActionStatus = r.validation.ok ? 'proposed' : 'rejected';
    this.#repos.transaction(() => {
      this.#repos.actions.insert({
        actionId: r.actionId,
        cycleId: r.cycleId,
        taskId: r.taskId,
        actionType: r.actionType,
        origin: r.origin,
        fingerprint: r.fingerprint,
        reason: r.reason,
        action: r.action,
        status,
        validation: r.validation,
      });
      this.#repos.events.append(
        r.cycleId,
        'PROPOSAL',
        { actionType: r.actionType, origin: r.origin },
        r.actionId,
      );
      this.#repos.events.append(r.cycleId, 'VALIDATION', r.validation, r.actionId);
      if (r.validation.violations.length > 0) {
        this.#repos.violations.insertMany(r.cycleId, r.actionId, r.validation.violations);
      }
    });
  }

  recordExecution(cycleId: string, actionId: string, result: ClientActionResult): void {
    this.#repos.transaction(() => {
      this.#repos.actions.update(actionId, { status: 'executing', execution: result });
      this.#repos.events.append(cycleId, 'EXECUTION', result, actionId);
    });
  }

  recordOutcome(
    cycleId: string,
    actionId: string,
    status: 'succeeded' | 'failed' | 'verification_failed',
    verification: VerificationResult | null,
  ): void {
    this.#repos.transaction(() => {
      this.#repos.actions.update(actionId, { status, verification });
      this.#repos.events.append(cycleId, 'VERIFICATION', { status, verification }, actionId);
    });
  }
}

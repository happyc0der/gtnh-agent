import { DecisionResultSchema, type DecisionResult } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import { errorMessage } from '../util/json.ts';
import { routeDecision, SAFETY_REASON_CODES } from './deterministic-router.ts';
import type { RouterContext } from './state-queries.ts';

/**
 * Source of bounded System 1 decisions. Today: the deterministic router and a mock.
 * Later: possibly a small local classifier model. Every provider returns one of the
 * eight Decision values and nothing else; it never produces actions directly.
 */
export interface DecisionProvider {
  readonly name: string;
  decide(state: GameState, ctx: RouterContext): Promise<DecisionResult>;
}

export class DeterministicDecisionProvider implements DecisionProvider {
  readonly name = 'deterministic-router';

  decide(state: GameState, ctx: RouterContext): Promise<DecisionResult> {
    return Promise.resolve(routeDecision(state, ctx));
  }
}

/**
 * Wraps any provider (e.g. a future model) so that safety is decided by code:
 *  - if the deterministic router makes a safety-driven decision, that decision wins;
 *  - the inner provider's output is schema-validated; invalid output or an exception
 *    becomes PAUSE_AND_ASK_USER.
 */
export class SafetyFirstDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly #inner: DecisionProvider;

  constructor(inner: DecisionProvider) {
    this.#inner = inner;
    this.name = `safety-first(${inner.name})`;
  }

  async decide(state: GameState, ctx: RouterContext): Promise<DecisionResult> {
    const deterministic = routeDecision(state, ctx);
    if (deterministic.reasonCodes.some((c) => SAFETY_REASON_CODES.has(c))) {
      return { ...deterministic, provider: this.name };
    }

    let raw: unknown;
    try {
      raw = await this.#inner.decide(state, ctx);
    } catch (error) {
      return this.#pause(`provider threw: ${errorMessage(error)}`);
    }
    const parsed = DecisionResultSchema.safeParse(raw);
    if (!parsed.success) return this.#pause('provider returned an invalid decision');
    return parsed.data;
  }

  #pause(detail: string): DecisionResult {
    return {
      decision: 'PAUSE_AND_ASK_USER',
      confidence: 1,
      reasonCodes: ['PROVIDER_OUTPUT_INVALID'],
      factsUsed: { detail },
      requiresHumanConfirmation: true,
      provider: this.name,
    };
  }
}

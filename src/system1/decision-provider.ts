import { DecisionResultSchema, type DecisionResult } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import { errorMessage } from '../util/json.ts';
import { routeDecision, SAFETY_REASON_CODES } from './deterministic-router.ts';
import type { RouterContext } from './state-queries.ts';

/**
 * Source of bounded System 1 decisions: the deterministic router, a mock, or (opt-in) a
 * local model (src/llm/ollama-decision-provider.ts), which is always wrapped in
 * SafetyFirstDecisionProvider. Every provider returns one of the eight Decision values and
 * nothing else; it never produces actions directly.
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
 * Router decisions no other provider may overrule:
 *  - safety-driven ones (unreliable state, out of bounds, dangers, vitals);
 *  - every pause: a paused or blocked task, no task, a switched-off machine, or a full
 *    inventory with nowhere to put things. Only a human lifts a pause.
 */
export function isBindingRouterDecision(decision: DecisionResult): boolean {
  return (
    decision.decision === 'PAUSE_AND_ASK_USER' ||
    decision.reasonCodes.some((c) => SAFETY_REASON_CODES.has(c))
  );
}

/**
 * Wraps any provider (e.g. a local model) so that safety is decided by code:
 *  - if the deterministic router's decision is binding (safety-driven, or a pause), that
 *    decision wins and the inner provider is not asked;
 *  - the inner provider's output is schema-validated; invalid output or an exception
 *    becomes PAUSE_AND_ASK_USER.
 */
export class SafetyFirstDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly #inner: DecisionProvider;

  constructor(inner: DecisionProvider) {
    this.#inner = inner;
    this.name = `safety-first(${inner.name})`.slice(0, 64);
  }

  async decide(state: GameState, ctx: RouterContext): Promise<DecisionResult> {
    const deterministic = routeDecision(state, ctx);
    if (isBindingRouterDecision(deterministic)) {
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

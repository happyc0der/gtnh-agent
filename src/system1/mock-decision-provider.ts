import type { Decision, DecisionResult } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import type { DecisionProvider } from './decision-provider.ts';
import type { RouterContext } from './state-queries.ts';

/**
 * Returns scripted decisions in order (the last one repeats). For tests and for
 * exercising SafetyFirstDecisionProvider without any model.
 */
export class MockDecisionProvider implements DecisionProvider {
  readonly name = 'mock-decision-provider';
  readonly #script: readonly DecisionResult[];
  #index = 0;
  readonly calls: GameState[] = [];

  constructor(script: readonly DecisionResult[]) {
    if (script.length === 0) throw new Error('MockDecisionProvider needs at least one decision');
    this.#script = script;
  }

  static always(decision: Decision, confidence = 0.7): MockDecisionProvider {
    return new MockDecisionProvider([
      {
        decision,
        confidence,
        reasonCodes: ['MOCK_DECISION'],
        factsUsed: {},
        requiresHumanConfirmation: decision === 'PAUSE_AND_ASK_USER',
        provider: 'mock-decision-provider',
      },
    ]);
  }

  decide(state: GameState, _ctx: RouterContext): Promise<DecisionResult> {
    this.calls.push(state);
    const next = this.#script[Math.min(this.#index, this.#script.length - 1)] as DecisionResult;
    this.#index += 1;
    return Promise.resolve(next);
  }
}

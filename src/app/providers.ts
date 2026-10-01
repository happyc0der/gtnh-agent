import type { AgentConfig } from '../config/env.ts';
import { OllamaClient, type OllamaClientDeps } from '../llm/ollama-client.ts';
import { OllamaDecisionProvider } from '../llm/ollama-decision-provider.ts';
import { OllamaPlannerProvider } from '../llm/ollama-planner-provider.ts';
import { MockPlannerProvider, type PlannerFixture } from '../planner/mock-planner-provider.ts';
import type { PlannerProvider } from '../planner/planner-provider.ts';
import {
  DeterministicDecisionProvider,
  type DecisionProvider,
} from '../system1/decision-provider.ts';
import { ModelCadenceProvider } from '../system1/model-cadence.ts';

export interface Providers {
  decisionProvider: DecisionProvider;
  planner: PlannerProvider | null;
}

export interface ProviderOptions {
  /** Plans the mock planner serves (mock scenarios). The live agent has none. */
  plannerFixtures?: readonly PlannerFixture[];
  /** Model-client dependencies: tests serve recorded replies through a fake fetch. */
  llm?: OllamaClientDeps;
}

/**
 * The one place that turns configuration into System 1 and System 2 providers. Defaults
 * (`decisions.provider: deterministic`, `planner.provider: mock`) keep the rule router and
 * the fixture planner. A model decision provider is ALWAYS wrapped in
 * SafetyFirstDecisionProvider (ModelCadenceProvider is one), so the router's safety
 * decisions and pauses win and invalid model output pauses; it is asked at its cadence
 * (`decisions.modelCadence`: at decision points by default). Nothing here contacts a model:
 * requests start only when a cycle asks.
 */
export function createProviders(config: AgentConfig, options: ProviderOptions = {}): Providers {
  let client: OllamaClient | null = null;
  const llm = (): OllamaClient => (client ??= new OllamaClient(config.llm, options.llm));

  const decisionProvider: DecisionProvider =
    config.decisions.provider === 'ollama'
      ? new ModelCadenceProvider(
          new OllamaDecisionProvider(llm(), config.llm.decisionModel),
          config.decisions.modelCadence,
        )
      : new DeterministicDecisionProvider();

  let planner: PlannerProvider | null;
  switch (config.planner.provider) {
    case 'mock':
      planner = new MockPlannerProvider(options.plannerFixtures ?? []);
      break;
    case 'ollama':
      planner = new OllamaPlannerProvider(llm(), config.llm.plannerModel);
      break;
    case 'none':
      planner = null;
      break;
  }
  return { decisionProvider, planner };
}

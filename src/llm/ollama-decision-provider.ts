import { z } from 'zod';
import type { ActionType } from '../domain/actions.ts';
import {
  DecisionSchema,
  ReasonCodeSchema,
  type Decision,
  type DecisionResult,
  type ReasonCode,
} from '../domain/decisions.ts';
import { gettingFood } from '../domain/food.ts';
import type { GameState, MachineStatus } from '../domain/game-state.ts';
import type { TaskStatus } from '../domain/tasks.ts';
import { distance } from '../domain/geometry.ts';
import { assessDangers, assessStateReliability } from '../safety/safety-policy.ts';
import type { DecisionProvider } from '../system1/decision-provider.ts';
import { assessDefense } from '../system1/defend.ts';
import {
  availableApprovedFood,
  canRetreat,
  findStorage,
  generatorNeedingFuel,
  homeLocation,
  inventoryFillFraction,
  playerPosition,
  selectDepositCandidate,
  type RouterContext,
} from '../system1/state-queries.ts';
import type { OllamaClient } from './ollama-client.ts';

/** A reply is about 120 tokens (mostly the checks); the cap only stops a runaway reply. */
export const DECISION_MAX_OUTPUT_TOKENS = 256;

/**
 * What the model sees: facts computed by code from the observation, as numbers, booleans,
 * enums and ids only, in the order the rules use them. Comparisons against the configured
 * thresholds are done here (models are unreliable at arithmetic). No free text from the
 * world (names, chat, signs) reaches the prompt.
 */
export interface DecisionSummary {
  /** Why the observation is unreliable (empty when it is fine). */
  stateProblems: string[];
  /** Dangers the safety policy sees (empty when there are none). */
  dangers: string[];
  /**
   * Hostiles are the only danger and fighting back is the answer (src/system1/defend.ts:
   * combat enabled, a safe moment, and either cornered by a quick kill or nowhere to retreat).
   */
  defend: boolean;
  home: 'unknown' | 'here' | 'away';
  health: number | null;
  lowHealth: boolean;
  /** Enough food for natural healing (minHungerToHeal): resting brings health back. */
  canHeal: boolean;
  hunger: number | null;
  hungry: boolean;
  starving: boolean;
  approvedFoodCarried: boolean;
  /**
   * The task is the play loop's food task, by day (src/domain/food.ts gettingFood): too
   * little food is the task then, not a reason to retreat or pause.
   */
  gettingFood: boolean;
  inventoryFill: number | null;
  inventoryNearlyFull: boolean;
  dumpContainerKnown: boolean;
  somethingToDeposit: boolean;
  generatorNeedsFuel: boolean;
  task: TaskStatus | 'none';
  requiredMachines: Array<{ id: string; status: MachineStatus }>;
  knownNextStep: ActionType | null;
  lastAction: { type: ActionType; result: string } | null;
}

export function summarizeForDecision(state: GameState, ctx: RouterContext): DecisionSummary {
  const { config } = ctx.safety;
  const position = playerPosition(state);
  const home = homeLocation(ctx);
  const dump = findStorage(state, ctx.routing.dumpContainerId);
  const fill = inventoryFillFraction(state);
  const health = state.player.health.known ? state.player.health.value : null;
  const hunger = state.player.hunger.known ? state.player.hunger.value : null;
  const recipe = state.knownRecipeState;
  const dangers = unique(assessDangers(state, ctx.safety).map((v) => v.code));
  const onlyHostiles = dangers.length > 0 && dangers.every((c) => c === 'HOSTILES_NEARBY');
  return {
    stateProblems: unique(assessStateReliability(state, ctx.safety).map((v) => v.code)),
    dangers,
    defend:
      onlyHostiles &&
      assessDefense(state, ctx, { possible: canRetreat(state, ctx) }).kind === 'defend',
    home:
      home === null || position === null
        ? 'unknown'
        : distance(position, home.position) <= config.interactionReach
          ? 'here'
          : 'away',
    health,
    lowHealth: health !== null && health < config.minHealth,
    canHeal: hunger !== null && hunger >= config.minHungerToHeal,
    hunger,
    hungry: hunger !== null && hunger < config.hungerEatThreshold,
    starving: hunger !== null && hunger < config.minHunger,
    approvedFoodCarried: availableApprovedFood(state, ctx) !== null,
    gettingFood: gettingFood(state),
    inventoryFill: fill === null ? null : Number(fill.toFixed(2)),
    inventoryNearlyFull: fill !== null && fill >= config.inventoryNearlyFullFraction,
    dumpContainerKnown: dump !== null && dump.position.known,
    somethingToDeposit: selectDepositCandidate(state, ctx) !== null,
    generatorNeedsFuel: generatorNeedingFuel(state, ctx) !== null,
    task: state.currentTask?.status ?? 'none',
    requiredMachines: (recipe?.requiredMachineIds ?? []).map((id) => ({
      id,
      status: state.machines.find((m) => m.id === id)?.status ?? 'unknown',
    })),
    knownNextStep: recipe?.nextKnownSafeStep?.type ?? null,
    lastAction:
      state.lastAction === null
        ? null
        : { type: state.lastAction.actionType, result: state.lastAction.result },
  };
}

function unique(codes: string[]): string[] {
  return [...new Set(codes)];
}

export const DECISION_SYSTEM_PROMPT = `You are System 1 of a safety-first agent that plays Minecraft 1.7.10 with the GregTech: New Horizons modpack. Each cycle you get a JSON summary of the agent's situation and choose the kind of step to take next. You only choose: code turns your choice into one checked action, and the safety rules in code always win.

The rules, in order. The FIRST rule whose check is true decides; all later rules are ignored.
1. stateProblems: the stateProblems list is not empty. Decide PAUSE_AND_ASK_USER (reason STATE_UNRELIABLE).
2. outOfBounds: dangers contains OUT_OF_BOUNDS or DIMENSION_NOT_ALLOWED. Decide PAUSE_AND_ASK_USER (that code as reason).
3. danger: dangers contains HAZARD_PROXIMITY, HOSTILES_NEARBY or UNCLASSIFIED_ENTITY_NEARBY. If defend is true, decide DEFEND (reasons HOSTILES_NEARBY, HOSTILE_IN_REACH; add ALREADY_AT_SAFE_LOCATION when home is "here", NO_SAFE_LOCATION when it is "unknown"). Otherwise, if home is "away", decide RETREAT_HOME (reason HAZARD_NEARBY, HOSTILES_NEARBY or UNCLASSIFIED_ENTITY_NEARBY); otherwise PAUSE_AND_ASK_USER (add ALREADY_AT_SAFE_LOCATION or NO_SAFE_LOCATION).
4. lowHealth: lowHealth is true. If canHeal is true, decide REST (reason LOW_HEALTH); otherwise, if gettingFood is true, this rule does not decide (food is the cure: go on to the rules below); otherwise, if home is "away", RETREAT_HOME (reason LOW_HEALTH); otherwise PAUSE_AND_ASK_USER.
5. hungryWithFood: hungry is true AND approvedFoodCarried is true. Decide EAT (reason HUNGRY).
6. starvingWithoutFood: starving is true AND approvedFoodCarried is false AND gettingFood is false. Decide PAUSE_AND_ASK_USER (reasons HUNGRY, NO_APPROVED_FOOD), wherever home is: a walk home burns food and finds none there.
7. inventoryNearlyFull: inventoryNearlyFull is true. If dumpContainerKnown and somethingToDeposit are both true, decide EMPTY_INVENTORY (reason INVENTORY_NEARLY_FULL); otherwise PAUSE_AND_ASK_USER (add NO_DUMP_CONTAINER or NOTHING_DEPOSITABLE).
8. generatorNeedsFuel: generatorNeedsFuel is true. Decide REFUEL_GENERATOR (reasons GENERATOR_OUT_OF_FUEL, APPROVED_FUEL_AVAILABLE).
9. taskNotActive: task is not "active". Decide PAUSE_AND_ASK_USER (reason NO_ACTIVE_TASK).
10. machineNotReady: some required machine's status is "error", "busy", "unknown" or "unpowered". For "error" decide PAUSE_AND_ASK_USER (MACHINE_ERROR); "busy": WAIT_FOR_MACHINE (MACHINE_BUSY); "unknown": WAIT_FOR_MACHINE (MACHINE_UNKNOWN); "unpowered": REQUEST_PLANNER (MACHINE_NOT_READY).
11. knownNextStep: knownNextStep is not null. Decide EXECUTE_KNOWN_SAFE_STEP (reason KNOWN_SAFE_STEP).
12. Otherwise (an active task with no known next step): decide REQUEST_PLANNER (reason NO_KNOWN_STEP).

Reply with JSON only. Write the checks in rule order, each true or false, reading only the named fields of the summary. Stop at the first check that is true and write the decision and reasonCodes of that rule; if every check is false, rule 12 applies. Then "confidence": how sure you are, 0 to 100.
Example: {"stateProblems":false,"outOfBounds":false,"danger":false,"lowHealth":false,"hungryWithFood":true,"decision":"EAT","reasonCodes":["HUNGRY"],"confidence":95}`;

/** Reason codes a model may give: all but the ones only code gives. */
const MODEL_REASON_CODES = ReasonCodeSchema.exclude([
  'SHELTERED',
  'UNDER_ATTACK',
  'SAFETY_OVERRIDE',
  'PROVIDER_OUTPUT_INVALID',
  'MOCK_DECISION',
]);

/** One flag per rule, in rule order: the model's worked checks. */
export const RULE_CHECKS = [
  'stateProblems',
  'outOfBounds',
  'danger',
  'lowHealth',
  'hungryWithFood',
  'starvingWithoutFood',
  'inventoryNearlyFull',
  'generatorNeedsFuel',
  'taskNotActive',
  'machineNotReady',
  'knownNextStep',
] as const;

const replyTail = {
  decision: DecisionSchema,
  reasonCodes: z.array(MODEL_REASON_CODES).min(1).max(4),
  /** Percent: Ollama enforces integer ranges while decoding, but not number ranges. */
  confidence: z.int().min(0).max(100),
};
const falseUpTo = (n: number): Record<string, z.ZodLiteral<false>> =>
  Object.fromEntries(RULE_CHECKS.slice(0, n).map((c) => [c, z.literal(false)]));

/**
 * The model's reply: the rule checks in order, then the decision. Decoding follows the
 * schema, and each alternative ends its checks at the first `true`, so once the model
 * writes a check as true the next thing it may write is the decision. That makes "the first
 * rule that applies wins" part of the grammar: measured on the mock scenarios, models
 * judged each check correctly but, free to go on, let a later check (usually the known
 * next step) win.
 */
export const ModelDecisionSchema = z.union([
  ...RULE_CHECKS.map((check, i) =>
    z.strictObject({ ...falseUpTo(i), [check]: z.literal(true), ...replyTail }),
  ),
  z.strictObject({ ...falseUpTo(RULE_CHECKS.length), ...replyTail }),
]);

/** A parsed reply. The checks written are false except, possibly, the last one. */
export type ModelDecision = Partial<Record<(typeof RULE_CHECKS)[number], boolean>> & {
  decision: Decision;
  reasonCodes: ReasonCode[];
  confidence: number;
};

/** The rule that decided: the first check written as true, else 12. */
export function decidingRule(reply: ModelDecision): number {
  const index = RULE_CHECKS.findIndex((c) => reply[c] === true);
  return index === -1 ? RULE_CHECKS.length + 1 : index + 1;
}

export const DECISION_FORMAT: Record<string, unknown> = z.toJSONSchema(ModelDecisionSchema);

/**
 * System 1 through a local model. It throws on any failure (unreachable server,
 * timeout, invalid JSON, a reply outside the schema): it must only ever be used inside
 * SafetyFirstDecisionProvider, which turns that into PAUSE_AND_ASK_USER and lets the
 * deterministic router's safety decisions and pauses win without asking the model.
 */
export class OllamaDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly #client: OllamaClient;
  readonly #model: string;

  constructor(client: OllamaClient, model: string) {
    this.#client = client;
    this.#model = model;
    this.name = `ollama:${model}`.slice(0, 48);
  }

  async decide(state: GameState, ctx: RouterContext): Promise<DecisionResult> {
    const summary = summarizeForDecision(state, ctx);
    const result = await this.#client.chat({
      model: this.#model,
      system: DECISION_SYSTEM_PROMPT,
      user: JSON.stringify(summary),
      format: DECISION_FORMAT,
      maxOutputTokens: DECISION_MAX_OUTPUT_TOKENS,
    });
    if (!result.ok) {
      throw new Error(
        `decision model ${this.#model} failed (${result.failure}): ${result.message}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(result.content);
    } catch {
      throw new Error(
        `decision model ${this.#model} replied with invalid JSON${result.truncated ? ' (cut off)' : ''}`,
      );
    }
    const parsed = ModelDecisionSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `decision model ${this.#model} reply does not match the decision schema: ${JSON.stringify(json).slice(0, 200)}`,
      );
    }
    // The union is built from computed keys, so Zod cannot name them; the shape is checked.
    const reply = parsed.data as ModelDecision;
    return {
      decision: reply.decision,
      confidence: reply.confidence / 100,
      reasonCodes: [...new Set<ReasonCode>(reply.reasonCodes)],
      factsUsed: {
        model: this.#model,
        modelRule: decidingRule(reply),
        latencyMs: result.latencyMs,
        stateTimestamp: state.timestamp,
        health: summary.health,
        hunger: summary.hunger,
        inventoryFill: summary.inventoryFill,
        task: summary.task,
        knownNextStep: summary.knownNextStep,
        requiredMachines:
          summary.requiredMachines.map((m) => `${m.id}=${m.status}`).join(',') || null,
      },
      requiresHumanConfirmation: reply.decision === 'PAUSE_AND_ASK_USER',
      provider: this.name,
    };
  }
}

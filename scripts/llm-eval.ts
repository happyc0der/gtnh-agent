/**
 * Evaluates local models (Ollama) as the agent's System 1 and planner, on the MOCK scenarios
 * only: nothing here connects to Minecraft. The GPU is shared, so run `model-status` first
 * and go ahead only when it says IDLE; requests use a short keep_alive.
 *
 *  - Decisions: every mock scenario's state goes to the model (unwrapped, to measure it) and
 *    to the deterministic router. Reports agreement, invalid replies and latency, and what
 *    SafetyFirstDecisionProvider would make of each reply (the decision the agent would use).
 *  - Planner: the planner scenarios plus a few extra tasks. Reports schema-valid replies,
 *    escalations, validatePlan results and whether step 1 would pass the executor's checks.
 *
 * Usage:
 *   node scripts/llm-eval.ts [--decision-model qwen2.5:0.5b] [--planner-model qwen3:14b]
 *                            [--skip-decisions] [--skip-planner] [--record <dir>]
 * --record writes every raw /api/chat reply body to <dir> (for golden test fixtures).
 * The server URL and timeout come from the usual config (OLLAMA_URL, OLLAMA_TIMEOUT_MS).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { MOCK_CONFIG, SCENARIOS, baseWorld } from '../src/app/scenarios.ts';
import { MockMinecraftClient, type MockWorld } from '../src/bot/mock-minecraft-client.ts';
import { defaultConfig, loadConfig, type AgentConfig } from '../src/config/env.ts';
import { createAction } from '../src/domain/actions.ts';
import type { DecisionResult } from '../src/domain/decisions.ts';
import type { GameState } from '../src/domain/game-state.ts';
import { validateCandidate } from '../src/executor/action-executor.ts';
import {
  defaultFetch,
  OllamaClient,
  type ChatResult,
  type FetchLike,
} from '../src/llm/ollama-client.ts';
import { OllamaDecisionProvider } from '../src/llm/ollama-decision-provider.ts';
import { OllamaPlannerProvider } from '../src/llm/ollama-planner-provider.ts';
import type { Plan, PlannerRequest } from '../src/planner/plan-schema.ts';
import { validatePlan } from '../src/planner/plan-validator.ts';
import { buildPlannerRequest } from '../src/planner/planner-provider.ts';
import { emptyFailureHistory, type SafetyContext } from '../src/safety/safety-policy.ts';
import {
  isBindingRouterDecision,
  SafetyFirstDecisionProvider,
  type DecisionProvider,
} from '../src/system1/decision-provider.ts';
import { routeDecision } from '../src/system1/deterministic-router.ts';
import type { RouterContext } from '../src/system1/state-queries.ts';
import { manualClock } from '../src/util/clock.ts';
import { sequentialIds } from '../src/util/ids.ts';
import { errorMessage } from '../src/util/json.ts';

dotenv.config({ quiet: true });
const { values } = parseArgs({
  options: {
    'decision-model': { type: 'string' },
    'planner-model': { type: 'string' },
    'skip-decisions': { type: 'boolean', default: false },
    'skip-planner': { type: 'boolean', default: false },
    record: { type: 'string' },
  },
});

const loaded = loadConfig().config;
/** The mock world's own configuration, with the model server settings from yours. */
const config: AgentConfig = defaultConfig({ ...MOCK_CONFIG, planner: loaded.planner });
const llm = {
  ...loaded.llm,
  decisionModel: values['decision-model'] ?? loaded.llm.decisionModel,
  plannerModel: values['planner-model'] ?? loaded.llm.plannerModel,
};

// ---------------------------------------------------------------------------
// Recording: every reply body, and the last call's result (for latency).
// ---------------------------------------------------------------------------

let currentCase = 'none';
let lastCall: ChatResult | null = null;
const recordDir = values.record;
const recordingFetch: FetchLike = async (url, init) => {
  const response = await defaultFetch(url, init);
  const text = await response.text();
  if (recordDir !== undefined) {
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, `${currentCase}.json`), `${text}\n`);
  }
  return { ok: response.ok, status: response.status, text: () => Promise.resolve(text) };
};
const client = new OllamaClient(llm, {
  fetch: recordingFetch,
  onCall: (_request, result) => {
    lastCall = result;
  },
});

const T0 = '2026-01-01T12:00:00.000Z';

function observe(world: MockWorld, setup?: (c: MockMinecraftClient) => void): GameState {
  const mc = new MockMinecraftClient(world, manualClock(T0));
  setup?.(mc);
  return mc.snapshot();
}

function safetyContext(): SafetyContext {
  return {
    config: config.safety,
    protectedItems: new Set(config.safety.protectedItems),
    locations: new Map(Object.entries(config.locations)),
    now: new Date(T0),
  };
}

const routerCtx = (): RouterContext => ({ safety: safetyContext(), routing: config.routing });

function stats(ms: number[]): string {
  if (ms.length === 0) return 'n/a';
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `mean ${mean.toFixed(0)} ms, median ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${s[s.length - 1]} ms`;
}

const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${n}/${d} (${((100 * n) / d).toFixed(0)}%)`;
const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_');

// ---------------------------------------------------------------------------
// System 1
// ---------------------------------------------------------------------------

async function evaluateDecisions(): Promise<void> {
  const model = new OllamaDecisionProvider(client, llm.decisionModel);
  process.stdout.write(`\n## Decisions: ${llm.decisionModel} vs the deterministic router\n\n`);
  process.stdout.write(
    '| scenario | router | model (raw) | agrees | with safety-first wrapper | ms |\n|---|---|---|---|---|---|\n',
  );
  let valid = 0;
  let agree = 0;
  let consulted = 0;
  let consultedAgree = 0;
  let effectiveAgree = 0;
  const latencies: number[] = [];
  let first = true;
  let coldMs: number | null = null;
  for (const scenario of SCENARIOS) {
    const state = observe(scenario.world(), (c) => scenario.setup?.(c));
    const ctx = routerCtx();
    const router = routeDecision(state, ctx);
    currentCase = slug(`decision-${llm.decisionModel}-${scenario.name}`);
    lastCall = null;
    let raw: DecisionResult | Error;
    try {
      raw = await model.decide(state, ctx);
      valid += 1;
    } catch (error) {
      raw = error instanceof Error ? error : new Error(errorMessage(error));
    }
    const call = lastCall as ChatResult | null;
    const ms = call?.latencyMs ?? 0;
    if (first) coldMs = ms;
    else latencies.push(ms);
    first = false;

    // What the agent would use: the wrapper, fed this same reply (no second model call).
    const replay: DecisionProvider = {
      name: model.name,
      decide: () => (raw instanceof Error ? Promise.reject(raw) : Promise.resolve(raw)),
    };
    const effective = await new SafetyFirstDecisionProvider(replay).decide(state, ctx);
    const rawDecision =
      raw instanceof Error ? `INVALID (${raw.message.slice(0, 80)})` : raw.decision;
    const rawAgrees = !(raw instanceof Error) && raw.decision === router.decision;
    if (rawAgrees) agree += 1;
    if (!isBindingRouterDecision(router)) {
      consulted += 1;
      if (rawAgrees) consultedAgree += 1;
    }
    if (effective.decision === router.decision) effectiveAgree += 1;
    process.stdout.write(
      `| ${scenario.name} | ${router.decision} | ${rawDecision} | ${rawAgrees ? 'yes' : 'NO'} | ${effective.decision}${isBindingRouterDecision(router) ? ' (router)' : ''} | ${ms} |\n`,
    );
  }
  const n = SCENARIOS.length;
  process.stdout.write(
    [
      '',
      `- valid replies: ${pct(valid, n)}`,
      `- raw agreement with the router: ${pct(agree, n)}`,
      `- agreement where the wrapper asks the model (router not binding): ${pct(consultedAgree, consulted)}`,
      `- agreement of the decision the agent would use: ${pct(effectiveAgree, n)}`,
      `- latency: first call (may load the model) ${coldMs ?? 'n/a'} ms; the rest ${stats(latencies)}`,
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

interface PlannerCase {
  name: string;
  world: MockWorld;
}

function variant(name: string, goal: string, mutate: (w: MockWorld) => void): PlannerCase {
  const w = baseWorld(`task-eval-${name}`);
  if (w.task !== null) {
    w.task.goal = goal;
    w.task.subgoal = null;
  }
  if (w.recipe !== null) w.recipe.nextKnownSafeStep = null;
  mutate(w);
  return { name, world: w };
}

function plannerCases(): PlannerCase[] {
  const fromScenarios = SCENARIOS.filter((s) => s.plannerFixtures !== undefined).map((s) => ({
    name: s.name,
    world: s.world(),
  }));
  return [
    ...fromScenarios,
    variant('fetch-cobblestone', 'Take 64 cobblestone out of the main chest', () => undefined),
    variant('store-gravel', 'Put the gravel into the main chest', (w) => {
      w.inventory.items['minecraft:gravel'] = 32;
    }),
    variant('inspect-far-macerator', 'Go and check on the macerator', (w) => {
      w.player.position = { x: 20, y: 64, z: 3 };
    }),
    variant('craft-pickaxe', 'Craft an iron pickaxe', () => undefined),
    variant('store-diamond', 'Put the diamond into the main chest', () => undefined),
  ];
}

/**
 * What validatePlan cannot see (it has no state): does every step name an object of the
 * right kind from the request, and items the player carries? The executor would refuse
 * such a step when it came up, after the earlier steps had run.
 */
function idProblems(plan: Plan, request: PlannerRequest): string[] {
  const { state, safetyConstraints } = request;
  const storage = new Set(state.storage.map((s) => s.id));
  const machines = new Set(state.machines.map((m) => m.id));
  const generators = new Set(state.generators.map((g) => g.id));
  const carried = new Set(state.inventoryTop.map((i) => i.item));
  const problems: string[] = [];
  for (const { step, action: a } of plan.steps) {
    const bad = (what: string): void => void problems.push(`step ${step}: ${what}`);
    switch (a.type) {
      case 'OPEN_CONTAINER':
      case 'WITHDRAW_ITEM':
        if (!storage.has(a.args.containerId)) bad(`${a.args.containerId} is not storage`);
        break;
      case 'DEPOSIT_ITEM':
        if (!storage.has(a.args.containerId)) bad(`${a.args.containerId} is not storage`);
        if (!carried.has(a.args.item)) bad(`${a.args.item} is not carried`);
        break;
      case 'EAT_FOOD':
        if (!carried.has(a.args.item)) bad(`${a.args.item} is not carried`);
        break;
      case 'INSPECT_MACHINE':
        if (!machines.has(a.args.machineId)) bad(`${a.args.machineId} is not a machine`);
        break;
      case 'REFUEL_KNOWN_GENERATOR':
        if (!generators.has(a.args.generatorId)) bad(`${a.args.generatorId} is not a generator`);
        if (!carried.has(a.args.fuelItem)) bad(`${a.args.fuelItem} is not carried`);
        break;
      case 'RETURN_TO_SAFE_LOCATION':
        if (!safetyConstraints.safeLocations.includes(a.args.locationName))
          bad(`${a.args.locationName} is not a safe location`);
        break;
      case 'OBSERVE_STATE':
      case 'MOVE_TO':
      case 'WAIT':
      case 'PAUSE_AND_ASK_USER':
        break;
    }
  }
  return problems;
}

async function evaluatePlanner(): Promise<void> {
  const planner = new OllamaPlannerProvider(client, llm.plannerModel);
  const maxSteps = config.planner.maxPlanSteps;
  process.stdout.write(`\n## Planner: ${llm.plannerModel}\n\n`);
  process.stdout.write(
    '| case | reply | validatePlan | ids | step 1 now | ms | prompt tokens | details |\n|---|---|---|---|---|---|---|---|\n',
  );
  const cases = plannerCases();
  let schemaValid = 0;
  let plans = 0;
  let plansValid = 0;
  let idsOk = 0;
  let step1Ok = 0;
  const escalations = new Map<string, number>();
  const latencies: number[] = [];
  const newId = sequentialIds();
  for (const c of cases) {
    const state = observe(c.world);
    const safety = safetyContext();
    const request = buildPlannerRequest({
      state,
      safety,
      maxPlanSteps: maxSteps,
      recentActions: [],
      recentFailures: [],
    });
    currentCase = slug(`planner-${llm.plannerModel}-${c.name}`);
    lastCall = null;
    const response = await planner.plan(request);
    const call = lastCall as ChatResult | null;
    const ms = call?.latencyMs ?? 0;
    latencies.push(ms);
    const tokens = call?.ok === true ? String(call.promptTokens ?? '?') : '-';
    if (response.kind === 'escalation') {
      const reason = response.escalation.reason;
      escalations.set(reason, (escalations.get(reason) ?? 0) + 1);
      if (reason !== 'INVALID_OUTPUT' && call?.ok === true) schemaValid += 1;
      process.stdout.write(
        `| ${c.name} | escalation ${reason} | - | - | - | ${ms} | ${tokens} | ${response.escalation.message.slice(0, 140).replace(/\|/g, '/')} |\n`,
      );
      continue;
    }
    schemaValid += 1;
    plans += 1;
    const validation = validatePlan(response.plan, safety, maxSteps);
    if (validation.ok) plansValid += 1;
    const wrongIds = idProblems(response.plan, request);
    if (wrongIds.length === 0) idsOk += 1;
    const issues = [
      ...validation.schemaIssues,
      ...validation.stepViolations.flatMap((s) =>
        s.violations.map((v) => `step ${s.step}: ${v.code}`),
      ),
    ];
    const first = response.plan.steps[0];
    let step1 = '-';
    if (first !== undefined) {
      const action = createAction(
        {
          spec: first.action,
          reason: 'eval',
          origin: 'planner',
          taskId: request.task?.taskId ?? null,
        },
        { newId, now: () => new Date(T0) },
      );
      const { report } = validateCandidate(action, state, safety, emptyFailureHistory);
      if (report.ok) step1Ok += 1;
      step1 = report.ok
        ? 'ok'
        : [...report.violations.map((v) => v.code), ...report.preconditionFailures].join('; ');
    }
    const steps = response.plan.steps
      .map((s) => {
        const a = s.action;
        const detail =
          'item' in a.args
            ? `${a.args.item}`
            : 'machineId' in a.args
              ? a.args.machineId
              : 'containerId' in a.args
                ? a.args.containerId
                : 'target' in a.args
                  ? `${a.args.target.x},${a.args.target.y},${a.args.target.z}`
                  : '';
        return `${a.type}${detail ? `(${detail})` : ''}`;
      })
      .join(' > ');
    process.stdout.write(
      `| ${c.name} | plan, ${response.plan.steps.length} step(s)${response.plan.requiresUserApproval ? ', approval' : ''} | ${validation.ok ? 'ok' : issues.join('; ').slice(0, 120)} | ${wrongIds.length === 0 ? 'ok' : wrongIds.join('; ').slice(0, 100)} | ${step1.slice(0, 100)} | ${ms} | ${tokens} | ${steps.slice(0, 160)} |\n`,
    );
  }
  const n = cases.length;
  process.stdout.write(
    [
      '',
      `- schema-valid replies (a plan, or a deliberate escalation): ${pct(schemaValid, n)}`,
      `- plans: ${plans}; passing validatePlan: ${pct(plansValid, plans)}; every step names a known object of the right kind: ${pct(idsOk, plans)}; step 1 passes the executor's checks now: ${pct(step1Ok, plans)}`,
      `- escalations: ${[...escalations.entries()].map(([r, k]) => `${r} ${k}`).join(', ') || 'none'}`,
      `- latency: ${stats(latencies)}`,
      '',
    ].join('\n'),
  );
}

process.stdout.write(
  `Ollama ${llm.baseUrl}; decisions ${llm.decisionModel}; planner ${llm.plannerModel}; timeout ${llm.timeoutMs} ms; keep_alive ${llm.keepAlive}\n`,
);
if (!values['skip-decisions']) await evaluateDecisions();
if (!values['skip-planner']) await evaluatePlanner();

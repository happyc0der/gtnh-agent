/**
 * Read-only preview of what the configured planner would plan right now. Connects with the
 * agent's own client (it sends no actions), observes, fills in the agent's memory (the
 * current task), builds exactly the planner request a cycle would, asks the planner, and
 * prints its reply and whether the plan passes validation. Nothing is stored or executed.
 *
 * Usage: node scripts/plan-preview.ts [--quest] [--db <path>] [--seconds 3]
 * Needs the live settings from README "Private GTNH test server" (.env) and the planner
 * settings (AGENT_PLANNER=ollama ...).
 */
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { buildSafetyContext, overlayAgentMemory } from '../src/app/agent-loop.ts';
import { liveAbilities } from '../src/app/play.ts';
import { createProviders } from '../src/app/providers.ts';
import { adoptGoal, updateQuests } from '../src/app/quest-commands.ts';
import { Gtnh1710Client } from '../src/bot/gtnh1710/gtnh-client.ts';
import { loadConfig } from '../src/config/env.ts';
import { openDatabase } from '../src/persistence/database.ts';
import { createRepositories } from '../src/persistence/repositories.ts';
import { buildPlannerRequest } from '../src/planner/planner-provider.ts';
import { validatePlan } from '../src/planner/plan-validator.ts';
import { systemClock } from '../src/util/clock.ts';

dotenv.config({ quiet: true });
const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    seconds: { type: 'string', default: '3' },
    // Record satisfied quests and make the next quest the current task first, as play does.
    quest: { type: 'boolean', default: false },
  },
});
const { config } = loadConfig();
const { planner } = createProviders(config);
if (planner === null) throw new Error('no planner is configured (AGENT_PLANNER)');
const db = openDatabase(values.db ?? config.database.path);
const repos = createRepositories(db, systemClock);
const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
const out = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
try {
  await client.connect();
  await new Promise((r) => setTimeout(r, Math.max(0, Number(values.seconds) || 0) * 1000));
  const observed = await client.observe();
  if (values.quest && observed.inventory.known) {
    const tables = Object.keys(config.minecraft.crafting.tables).length > 0;
    const update = updateQuests(repos, observed.inventory.value.items, liveAbilities(tables));
    if (update.next !== null) adoptGoal(repos, update.next);
    out({ questsCompleted: update.added.map((q) => q.name), next: update.next?.text ?? null });
  }
  const state = overlayAgentMemory(observed, repos, config);
  const ctx = buildSafetyContext(config, repos, new Date());
  const request = buildPlannerRequest({
    state,
    safety: ctx,
    maxPlanSteps: config.planner.maxPlanSteps,
    recentActions: [],
    recentFailures: [],
  });
  out({
    planner: planner.name,
    task: request.task,
    position: request.state.position,
    inventory: request.state.inventoryTop,
    diggable: request.state.diggableBlocks.slice(0, 8),
    diggableListed: request.state.diggableBlocks.length,
    unknown: request.state.unknownFields,
  });
  const started = Date.now();
  const response = await planner.plan(request);
  out({ seconds: (Date.now() - started) / 1000, response });
  if (response.kind === 'plan') {
    const v = validatePlan(response.plan, ctx, config.planner.maxPlanSteps);
    out({
      valid: v.ok,
      schemaIssues: v.schemaIssues,
      stepViolations: v.stepViolations.map(
        (s) => `step ${s.step}: ${s.violations.map((x) => x.code).join(', ')}`,
      ),
    });
  }
} finally {
  await client.disconnect();
  db.close();
}

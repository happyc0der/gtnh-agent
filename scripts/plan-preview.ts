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
import { buildSafetyContext, overlayAgentMemory } from '../src/app/loop/agent-memory.ts';
import { observeWithQuestBook } from '../src/app/play/live-play.ts';
import { liveAbilities } from '../src/app/play/play.ts';
import { createProviders } from '../src/app/providers.ts';
import { adoptGoal, freeSlotsOf, updateQuests } from '../src/app/play/quest-progress.ts';
import { Gtnh1710Client } from '../src/bot/gtnh1710/gtnh-client.ts';
import { loadConfig } from '../src/config/env.ts';
import { AGE0_QUESTS } from '../src/goals/age0-quests.ts';
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
    // Read the server's quest book and make the next quest the current task first, as play does.
    quest: { type: 'boolean', default: false },
  },
});
const { config } = loadConfig();
const { planner } = createProviders(config);
if (planner === null) throw new Error('no planner is configured (AGENT_PLANNER)');
const db = openDatabase(values.db ?? config.database.path);
const repos = createRepositories(db, systemClock);
const client = new Gtnh1710Client({
  config: config.minecraft,
  clock: systemClock,
  questScope: AGE0_QUESTS.map((q) => q.id),
});
const out = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
try {
  await client.connect();
  await new Promise((r) => setTimeout(r, Math.max(0, Number(values.seconds) || 0) * 1000));
  const observed = await observeWithQuestBook(client);
  if (values.quest && observed.inventory.known && observed.questBook.known) {
    const update = updateQuests(
      repos,
      observed.questBook.value,
      { items: observed.inventory.value.items, freeSlots: freeSlotsOf(observed) },
      liveAbilities({
        configured: Object.keys(config.minecraft.crafting.tables).length > 0,
        placing: config.minecraft.placing.enabled,
      }),
    );
    if (update.next !== null) adoptGoal(repos, update.next);
    out({
      questsCompleted: update.added.map((q) => q.name),
      dueClicks: update.clicks.map((c) => c.reason),
      next: update.next?.text ?? null,
      remaining: update.next?.subgoal ?? null,
    });
  } else if (values.quest) {
    out({ quest: 'not adopted: the inventory or the server quest book is unknown' });
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

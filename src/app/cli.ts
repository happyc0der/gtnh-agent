import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { loadConfig } from '../config/env.ts';
import { TaskStatusSchema } from '../domain/tasks.ts';
import { IN_MEMORY, openDatabase } from '../persistence/database.ts';
import { createRepositories } from '../persistence/repositories.ts';
import { plannerResponseJsonSchema } from '../planner/plan-schema.ts';
import { systemClock } from '../util/clock.ts';
import { errorMessage } from '../util/json.ts';
import { syncConfigToDatabase, type CycleResult } from './agent-loop.ts';
import {
  movementStatus,
  parseBlockPosition,
  runLiveChest,
  runLiveCycle,
  runLiveDig,
  runLiveSession,
  runLiveMove,
  setMovementHalted,
  summarizeObservation,
  watchLive,
  withLiveClient,
} from './live-agent.ts';
import { runMockScenario } from './mock-agent.ts';
import { approvePlan, rejectPlan, showPlans } from './plan-commands.ts';
import { checkLimits, DEFAULT_SESSION_LIMITS } from './live-session.ts';
import { runLivePlay } from './live-play.ts';
import {
  checkPlayLimits,
  DEFAULT_PLAY_LIMITS,
  describePlayEvent,
  liveAbilities,
  type PlayLimits,
} from './play.ts';
import { createProviders } from './providers.ts';
import { describeQuests, updateQuests } from './quest-commands.ts';
import { addTask, completeTask, listTasks } from './task-commands.ts';
import { findScenario, SCENARIOS } from './scenarios.ts';

const USAGE = `gtnh-agent (single cycle, no autonomy; the live client only observes unless walking,
chests or digging are explicitly enabled)

Usage:
  node src/app/cli.ts once [--scenario <name>] [--db <path> | --memory] [--full]
      Run ONE observe/decide/validate/execute/verify cycle against the mock world.
  node src/app/cli.ts once --live [--db <path> | --memory] [--full] [--verbose]
      Run ONE cycle against the configured private GTNH test server (read-only).
  node src/app/cli.ts observe --live [--radius N] [--verbose]
      Connect, print what the agent can observe (and a map of the movement fence), disconnect.
      --radius widens the diagnostic entity (and, above 32, hazard) lists; the agent's own
      scans stay at 16 m (entities) and 32 m (hazards).
  node src/app/cli.ts watch --live [--seconds 60] [--every 5]
      Stay connected (read-only) and print what the agent sees every few seconds: to compare
      with what you see in-game. The bot stands still and is visible to other players.
  node src/app/cli.ts move --live --to <x,y,z | location> [--tolerance N] [--dry-run] [--db <path>]
      WALK the player (needs MC_ENABLE_MOVEMENT=true and a fence). One action, validated,
      executed and verified like the agent's own; Ctrl+C stops it. --dry-run only plans it
      and draws the path on a map of the fence.
  node src/app/cli.ts chest --live --container <id> [--withdraw <item> | --deposit <item>] [--count N]
      Open a configured vanilla chest (needs MC_ENABLE_CONTAINERS=true) and optionally move
      exactly N items, as checked user actions; prints the chest and inventory afterwards.
  node src/app/cli.ts dig --live --at <x,y,z> [--db <path>]
      BREAK one allowlisted block (logs, leaves, dirt, grass, sand, gravel, clay) inside the
      fence with an empty hand (needs MC_ENABLE_DIGGING=true and a fence), as a checked user
      action; prints the diggable blocks and the inventory afterwards. Ctrl+C stops it.
  node src/app/cli.ts run --live [--max-cycles N] [--max-minutes M] [--db <path>] [--verbose]
      BOUNDED auto-run of the current task on one connection: ordinary cycles back to back,
      stopping when the task is done or anything needs you (a pause, rejection, failure,
      approval, a non-task decision), at the limits (default 20 cycles / 10 minutes), the
      stop file (pnpm cli halt) or Ctrl+C.
  node src/app/cli.ts play --live [--minutes 30] [--max-cycles 20] [--db <path>] [--verbose]
      AUTONOMOUS PLAY through the Age 0 quest book: the agent picks its next quest, the
      configured decision maker and planner (AGENT_DECISIONS / AGENT_PLANNER, e.g. ollama)
      choose what to do, and every action is validated, executed and verified as always.
      Stops when no doable quest is left, when anything needs you, after 3 sessions without
      progress on a quest, at the time limit, the stop file (pnpm cli halt) or Ctrl+C.
  node src/app/cli.ts quests [--live] [--db <path>]
      The agent's Age 0 quest book (GTNH "Tier 0 Stone Age"): progress, completed quests
      and the next goal. --live reads the inventory first and records the quests it now
      satisfies (the agent's own bookkeeping; the server's quest book is not touched).
  node src/app/cli.ts halt [--reason <text>] / unhalt / movement
      Create / remove the stop file (nothing walks, uses chests or digs while it exists) /
      show movement and digging settings.
  node src/app/cli.ts scenarios            List mock scenarios.
  node src/app/cli.ts history [--limit N] [--db <path>]
                                           Show recent logged actions.
  node src/app/cli.ts task-resume --task <id> [--db <path>]
                                           Mark a paused/blocked task active again.
  node src/app/cli.ts task-add --task <id> --goal <text> [--needs item=count,...] [--plan <plan.json>] [--machines <ids>] [--db <path>]
                                           Add a task and make it the live agent's current task,
                                           with an optional plan you wrote (validated like a
                                           planner's). Each once --live then runs one step.
                                           --machines gt:x.y.z,...: wait while one is busy,
                                           pause if one is switched off.
  node src/app/cli.ts task-complete --task <id> / task-list [--db <path>]
  node src/app/cli.ts plan-show [--task <id>] [--db <path>]
                                           Show a task's latest plan, or every open plan.
  node src/app/cli.ts plan-approve --task <id> [--plan <n>] [--db <path>]
                                           Approve the plan waiting for approval (and resume
                                           the task it paused). Nothing runs until the next
                                           cycle, which executes one validated step.
  node src/app/cli.ts plan-reject --task <id> [--plan <n>] [--reason <text>] [--db <path>]
                                           Reject the task's open plan.
  node src/app/cli.ts plan-schema          Print the planner output JSON Schema.
  node src/app/cli.ts config               Print the validated configuration.
`;

/** "minecraft:chest=1,minecraft:torch=8" -> { 'minecraft:chest': 1, 'minecraft:torch': 8 }. */
function parseNeeds(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(',')) {
    const [item, count] = part.trim().split('=');
    const n = Number(count);
    if (item === undefined || item === '' || !Number.isInteger(n) || n < 1) {
      throw new Error(`--needs takes item=count pairs, e.g. minecraft:chest=1 (got "${part}")`);
    }
    out[item] = (out[item] ?? 0) + n;
  }
  return out;
}

function compact(scenario: string, dbPath: string, r: CycleResult): Record<string, unknown> {
  const o = r.outcome;
  return {
    cycleId: r.cycleId,
    scenario,
    status: r.status,
    needsUserAttention: r.needsUserAttention,
    decision: r.decision && {
      decision: r.decision.decision,
      confidence: r.decision.confidence,
      reasonCodes: r.decision.reasonCodes,
      requiresHumanConfirmation: r.decision.requiresHumanConfirmation,
      provider: r.decision.provider,
    },
    planner: r.planner,
    action: r.action,
    validation: o && {
      ok: o.validation.ok,
      violations: o.validation.violations.map((v) => `${v.code}(${v.severity}): ${v.message}`),
      preconditionFailures: o.validation.preconditionFailures,
    },
    execution: o?.execution ? `${o.execution.code}: ${o.execution.message}` : null,
    verification: o?.verification
      ? {
          verified: o.verification.verified,
          checks: o.verification.checks.map(
            (c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`,
          ),
        }
      : null,
    stateViolations: r.stateViolations.map((v) => `${v.code}: ${v.message}`),
    summary: r.summary,
    db: dbPath === IN_MEMORY ? 'in-memory (discarded)' : dbPath,
    stateSnapshotId: r.stateSnapshotId,
  };
}

async function main(argv: string[]): Promise<number> {
  dotenv.config({ quiet: true });
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scenario: { type: 'string', default: 'nominal' },
      db: { type: 'string' },
      memory: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      limit: { type: 'string', default: '10' },
      task: { type: 'string' },
      plan: { type: 'string' },
      goal: { type: 'string' },
      machines: { type: 'string' },
      needs: { type: 'string' },
      reason: { type: 'string' },
      to: { type: 'string' },
      at: { type: 'string' },
      container: { type: 'string' },
      withdraw: { type: 'string' },
      deposit: { type: 'string' },
      count: { type: 'string', default: '1' },
      seconds: { type: 'string', default: '60' },
      every: { type: 'string', default: '5' },
      'max-cycles': { type: 'string', default: String(DEFAULT_SESSION_LIMITS.maxCycles) },
      'max-minutes': { type: 'string', default: String(DEFAULT_SESSION_LIMITS.maxMinutes) },
      minutes: { type: 'string', default: String(DEFAULT_PLAY_LIMITS.maxMinutes) },
      tolerance: { type: 'string', default: '0.5' },
      'dry-run': { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      radius: { type: 'string', default: '16' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  const { config, configFile } = loadConfig();
  const dbPath = values.memory ? IN_MEMORY : (values.db ?? config.database.path);
  const print = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };

  const log = values.verbose
    ? (line: string): void => {
        process.stderr.write(`[gtnh1710] ${line}\n`);
      }
    : undefined;

  switch (command) {
    case 'observe': {
      if (!values.live) {
        process.stderr.write(
          'observe connects to the configured test server; pass --live to confirm.\n',
        );
        return 1;
      }
      const radius = Math.max(1, Math.min(128, Number(values.radius) || 16));
      const { summary, map } = await withLiveClient(
        config,
        async (client) => ({
          summary: {
            ...summarizeObservation(
              await client.observe(),
              client.info(),
              client.world.nearbyEntities(radius),
              radius > 32 ? client.world.diagnosticHazardScan(radius) : null,
              client.world.trackedMachines(),
            ),
            movement: movementStatus(config),
          },
          map: client.previewWalk(null)?.map ?? [],
        }),
        log,
      );
      print(summary);
      if (map.length > 0) process.stdout.write(`\n${map.join('\n')}\n`);
      return 0;
    }
    case 'once': {
      if (values.live) {
        const { result, info } = await runLiveCycle(config, dbPath, log);
        print(values.full ? { result, connection: info } : compact('live', dbPath, result));
        return result.status === 'error' ? 1 : 0;
      }
      const scenario = findScenario(values.scenario);
      if (scenario === undefined) {
        process.stderr.write(
          `Unknown scenario "${values.scenario}". Run: node src/app/cli.ts scenarios\n`,
        );
        return 1;
      }
      // The mock world keeps its own config; only the provider choice comes from yours.
      const { result, db } = await runMockScenario(scenario, {
        dbPath,
        config: { planner: config.planner, decisions: config.decisions, llm: config.llm },
      });
      db.close();
      print(values.full ? result : compact(scenario.name, dbPath, result));
      return result.status === 'error' ? 1 : 0;
    }
    case 'move': {
      if (!values.live) {
        process.stderr.write('move walks on the configured test server; pass --live to confirm.\n');
        return 1;
      }
      if (values.to === undefined) {
        process.stderr.write('move requires --to <x,y,z | location name>\n');
        return 1;
      }
      const tolerance = Number(values.tolerance);
      if (!Number.isFinite(tolerance)) {
        process.stderr.write('--tolerance must be a number\n');
        return 1;
      }
      const out = await runLiveMove(config, dbPath, values.to, {
        tolerance,
        dryRun: values['dry-run'],
        ...(log ? { log } : {}),
      });
      print(
        out.result === null
          ? { dryRun: true, plan: out.plan }
          : values.full
            ? { result: out.result, connection: out.info }
            : compact('live-move', dbPath, out.result),
      );
      const maps = [
        ...(out.mapBefore.length > 0 ? ['', 'Before (planned path):', ...out.mapBefore] : []),
        ...(out.mapAfter.length > 0 ? ['', 'After:', ...out.mapAfter] : []),
      ];
      if (maps.length > 0) process.stdout.write(`${maps.join('\n')}\n`);
      if (out.result === null) return out.plan?.ok === true ? 0 : 1;
      return out.result.status === 'succeeded' ? 0 : 1;
    }
    case 'watch': {
      if (!values.live) {
        process.stderr.write(
          'watch connects to the configured test server; pass --live to confirm.\n',
        );
        return 1;
      }
      const seconds = Math.max(1, Math.min(3600, Number(values.seconds) || 60));
      const every = Math.max(1, Math.min(60, Number(values.every) || 5));
      await watchLive(config, seconds, every, (line) => process.stdout.write(`${line}\n`), log);
      return 0;
    }
    case 'play': {
      if (!values.live) {
        process.stderr.write('play acts on the configured test server; pass --live to confirm.\n');
        return 1;
      }
      const limits: PlayLimits = {
        ...DEFAULT_PLAY_LIMITS,
        maxMinutes: Number(values.minutes),
        session: { ...DEFAULT_PLAY_LIMITS.session, maxCycles: Number(values['max-cycles']) },
      };
      const invalid = checkPlayLimits(limits);
      if (invalid !== null) {
        process.stderr.write(`${invalid}\n`);
        return 1;
      }
      const providers = createProviders(config);
      process.stderr.write(
        `playing: decisions by ${providers.decisionProvider.name}, plans by ` +
          `${providers.planner?.name ?? 'nobody'}; stop with pnpm cli halt or Ctrl+C\n`,
      );
      // Through the nights: play stops before the dark (no shelter yet), the agent is offline
      // until sunrise, then plays on, all within the time limit. Ctrl+C or the stop file end it.
      const started = Date.now();
      const deadline = started + limits.maxMinutes * 60_000;
      const stopFile = resolve(config.minecraft.movement.stopFile);
      let interrupted = false;
      const onInterrupt = (): void => void (interrupted = true);
      process.on('SIGINT', onInterrupt);
      try {
        for (;;) {
          const minutesLeft = (deadline - Date.now()) / 60_000;
          const out = await runLivePlay(
            config,
            dbPath,
            {
              limits: { ...limits, maxMinutes: Math.max(1, Math.min(480, minutesLeft)) },
              ...providers,
              abilities: liveAbilities(Object.keys(config.minecraft.crafting.tables).length > 0),
              onEvent: (e) => process.stderr.write(`${describePlayEvent(e)}\n`),
            },
            log,
          );
          const summary = {
            stopReason: out.stopReason,
            sessions: out.sessions,
            questsCompleted: out.questsCompleted,
            progress: out.progress,
            minutes: Number(((Date.now() - started) / 60_000).toFixed(1)),
          };
          const sleepMs = out.night === null ? 0 : (out.night.minutesUntilDay + 0.25) * 60_000;
          if (out.night === null || Date.now() + sleepMs >= deadline) {
            print(summary);
            return 0;
          }
          process.stderr.write(
            `night: offline for ${(sleepMs / 60_000).toFixed(1)} min until sunrise, then playing on\n`,
          );
          const wakeAt = Date.now() + sleepMs;
          while (Date.now() < wakeAt) {
            if (interrupted || existsSync(stopFile)) {
              print({ ...summary, stopReason: 'stopped while waiting for sunrise' });
              return 0;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } finally {
        process.removeListener('SIGINT', onInterrupt);
      }
    }
    case 'run': {
      if (!values.live) {
        process.stderr.write('run acts on the configured test server; pass --live to confirm.\n');
        return 1;
      }
      const limits = {
        maxCycles: Number(values['max-cycles']),
        maxMinutes: Number(values['max-minutes']),
        pauseMs: DEFAULT_SESSION_LIMITS.pauseMs,
      };
      const invalid = checkLimits(limits);
      if (invalid !== null) {
        process.stderr.write(`${invalid}\n`);
        return 1;
      }
      const out = await runLiveSession(
        config,
        dbPath,
        limits,
        (r, i) => process.stderr.write(`[cycle ${i}] ${r.summary}\n`),
        log,
      );
      print({
        stopReason: out.stopReason,
        task: { taskId: out.taskId, status: out.taskStatus },
        cycles: out.cycles.map((c) => c.summary),
        seconds: Number((out.elapsedMs / 1000).toFixed(1)),
      });
      return out.taskStatus === 'completed' ? 0 : 1;
    }
    case 'chest': {
      if (!values.live) {
        process.stderr.write('chest uses the configured test server; pass --live to confirm.\n');
        return 1;
      }
      if (values.container === undefined) {
        process.stderr.write('chest requires --container <id>\n');
        return 1;
      }
      if (values.withdraw !== undefined && values.deposit !== undefined) {
        process.stderr.write('use either --withdraw or --deposit, not both\n');
        return 1;
      }
      const quantity = Number(values.count);
      if (!Number.isInteger(quantity) || quantity < 1) {
        process.stderr.write('--count must be a positive whole number\n');
        return 1;
      }
      const item = values.withdraw ?? values.deposit;
      const out = await runLiveChest(
        config,
        dbPath,
        values.container,
        item === undefined
          ? null
          : { direction: values.withdraw !== undefined ? 'withdraw' : 'deposit', item, quantity },
        log,
      );
      print({
        actions: out.results.map((r) => (values.full ? r : compact('live-chest', dbPath, r))),
        chest: out.chest,
        inventory: out.inventory,
      });
      return out.results.every((r) => r.status === 'succeeded') ? 0 : 1;
    }
    case 'dig': {
      if (!values.live) {
        process.stderr.write('dig breaks a block on the test server; pass --live to confirm.\n');
        return 1;
      }
      const at = values.at === undefined ? null : parseBlockPosition(values.at);
      if (at === null) {
        process.stderr.write(
          'dig requires --at <x,y,z> (whole-block coordinates; use --at=-8,200,-11 for negatives)\n',
        );
        return 1;
      }
      const out = await runLiveDig(config, dbPath, at, log);
      print({
        action: values.full
          ? { result: out.result, connection: out.info }
          : compact('live-dig', dbPath, out.result),
        diggable: out.diggable,
        inventory: out.inventory,
      });
      return out.result.status === 'succeeded' ? 0 : 1;
    }
    case 'halt':
      print(setMovementHalted(config, true, values.reason));
      return 0;
    case 'unhalt':
      print(setMovementHalted(config, false));
      return 0;
    case 'movement':
      print(movementStatus(config));
      return 0;
    case 'scenarios':
      for (const s of SCENARIOS) {
        process.stdout.write(
          `${s.name.padEnd(24)} ${s.expect.decision} -> ${s.expect.actionType} -> ${s.expect.status}\n${''.padEnd(25)}${s.description}\n`,
        );
      }
      return 0;
    case 'history': {
      const db = openDatabase(dbPath);
      const repos = createRepositories(db, systemClock);
      const limit = Math.max(1, Math.min(200, Number(values.limit) || 10));
      print(
        repos.actions.recent(limit).map((a) => ({
          at: a.createdAt,
          actionId: a.actionId,
          taskId: a.taskId,
          type: a.actionType,
          origin: a.origin,
          status: a.status,
          reason: a.reason,
        })),
      );
      db.close();
      return 0;
    }
    case 'task-resume': {
      if (values.task === undefined) {
        process.stderr.write('task-resume requires --task <id>\n');
        return 1;
      }
      const db = openDatabase(dbPath);
      const repos = createRepositories(db, systemClock);
      const task = repos.tasks.get(values.task);
      if (task === null) {
        process.stderr.write(`No task ${values.task}\n`);
        db.close();
        return 1;
      }
      repos.tasks.setStatus(task.id, TaskStatusSchema.parse('active'));
      print({ task: task.id, previousStatus: task.status, status: 'active' });
      db.close();
      return 0;
    }
    case 'quests': {
      const db = openDatabase(dbPath);
      try {
        const repos = createRepositories(db, systemClock);
        if (!values.live) {
          const latest = repos.snapshots.latest('gtnh1710');
          print(
            describeQuests(repos, latest?.inventory.known ? latest.inventory.value.items : null),
          );
          return 0;
        }
        const state = await withLiveClient(config, (client) => client.observe(), log);
        if (!state.inventory.known) {
          process.stderr.write(`the inventory is unknown: ${state.inventory.reason}
`);
          return 1;
        }
        const inventory = state.inventory.value.items;
        const update = updateQuests(repos, inventory);
        print({
          ...describeQuests(repos, inventory),
          newlyCompleted: update.added.map((q) => q.name),
        });
        return 0;
      } finally {
        db.close();
      }
    }
    case 'task-add':
    case 'task-complete':
    case 'task-list': {
      if (command !== 'task-list' && values.task === undefined) {
        process.stderr.write(`${command} requires --task <id>\n`);
        return 1;
      }
      if (command === 'task-add' && values.goal === undefined) {
        process.stderr.write('task-add requires --goal <text>\n');
        return 1;
      }
      let planJson: unknown = undefined;
      if (command === 'task-add' && values.plan !== undefined) {
        try {
          planJson = JSON.parse(readFileSync(values.plan, 'utf8'));
        } catch (error) {
          process.stderr.write(`cannot read plan ${values.plan}: ${errorMessage(error)}\n`);
          return 1;
        }
      }
      const db = openDatabase(dbPath);
      try {
        const repos = createRepositories(db, systemClock);
        syncConfigToDatabase(config, repos);
        const taskId = values.task ?? '';
        const result =
          command === 'task-add'
            ? addTask(repos, config, {
                taskId,
                goal: values.goal ?? '',
                plan: planJson,
                now: new Date(),
                machines: (values.machines ?? '')
                  .split(',')
                  .map((m) => m.trim())
                  .filter((m) => m.length > 0),
                ...(values.needs === undefined ? {} : { requirements: parseNeeds(values.needs) }),
              })
            : command === 'task-complete'
              ? completeTask(repos, taskId)
              : listTasks(repos);
        if (!result.ok) {
          process.stderr.write(`${result.error}
`);
          return 1;
        }
        print(result.value);
        return 0;
      } finally {
        db.close();
      }
    }
    case 'plan-show':
    case 'plan-approve':
    case 'plan-reject': {
      if (command !== 'plan-show' && values.task === undefined) {
        process.stderr.write(`${command} requires --task <id>\n`);
        return 1;
      }
      const planId = values.plan === undefined ? undefined : Number(values.plan);
      if (planId !== undefined && !Number.isSafeInteger(planId)) {
        process.stderr.write('--plan must be a plan number\n');
        return 1;
      }
      const db = openDatabase(dbPath);
      try {
        const repos = createRepositories(db, systemClock);
        const taskId = values.task;
        const result =
          taskId === undefined || command === 'plan-show'
            ? showPlans(repos, taskId)
            : command === 'plan-approve'
              ? approvePlan(repos, taskId, planId)
              : rejectPlan(repos, taskId, planId, values.reason);
        if (!result.ok) {
          process.stderr.write(`${result.error}\n`);
          return 1;
        }
        print(result.value);
        return 0;
      } finally {
        db.close();
      }
    }
    case 'plan-schema':
      print(plannerResponseJsonSchema());
      return 0;
    case 'config':
      print({ configFile, config });
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);

import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { loadConfig } from '../config/env.ts';
import { TaskStatusSchema } from '../domain/tasks.ts';
import { IN_MEMORY, openDatabase } from '../persistence/database.ts';
import { createRepositories } from '../persistence/repositories.ts';
import { plannerResponseJsonSchema } from '../planner/plan-schema.ts';
import { systemClock } from '../util/clock.ts';
import { errorMessage } from '../util/json.ts';
import type { CycleResult } from './agent-loop.ts';
import { runMockScenario } from './mock-agent.ts';
import { findScenario, SCENARIOS } from './scenarios.ts';

const USAGE = `gtnh-agent (milestone 1: mock only, single cycle, no autonomy)

Usage:
  node src/app/cli.ts once [--scenario <name>] [--db <path> | --memory] [--full]
      Run ONE observe/decide/validate/execute/verify cycle against the mock world.
  node src/app/cli.ts scenarios            List mock scenarios.
  node src/app/cli.ts history [--limit N] [--db <path>]
                                           Show recent logged actions.
  node src/app/cli.ts task-resume --task <id> [--db <path>]
                                           Mark a paused/blocked task active again.
  node src/app/cli.ts plan-schema          Print the planner output JSON Schema.
  node src/app/cli.ts config               Print the validated configuration.
`;

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

  switch (command) {
    case 'once': {
      const scenario = findScenario(values.scenario);
      if (scenario === undefined) {
        process.stderr.write(
          `Unknown scenario "${values.scenario}". Run: node src/app/cli.ts scenarios\n`,
        );
        return 1;
      }
      const { result, db } = await runMockScenario(scenario, { dbPath });
      db.close();
      print(values.full ? result : compact(scenario.name, dbPath, result));
      return result.status === 'error' ? 1 : 0;
    }
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

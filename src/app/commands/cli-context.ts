import { parseArgs } from 'node:util';
import type { AgentConfig, LoadedConfig } from '../../config/env.ts';
import { IN_MEMORY } from '../../persistence/database.ts';
import type { CycleResult } from '../loop/agent-loop.ts';
import { DEFAULT_SESSION_LIMITS } from '../loop/live-session.ts';
import { DEFAULT_PLAY_LIMITS } from '../play/play.ts';

/**
 * What the CLI's commands share (src/app/cli.ts dispatches them; cli-live.ts, cli-runs.ts and
 * cli-records.ts handle them): the command line, the context a command runs in, and how a
 * cycle's result is printed.
 */

/** The command line: the command (the first positional) and the options of every command. */
export function parseCommandLine(argv: string[]) {
  return parseArgs({
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
      item: { type: 'string' },
      toward: { type: 'string' },
      distance: { type: 'string', default: '64' },
      entity: { type: 'string' },
      container: { type: 'string' },
      withdraw: { type: 'string' },
      deposit: { type: 'string' },
      smelt: { type: 'string' },
      fuel: { type: 'string' },
      'fuel-count': { type: 'string', default: '0' },
      take: { type: 'string' },
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
}

/** The options as parsed (every command's; each command reads its own). */
export type CliValues = ReturnType<typeof parseCommandLine>['values'];

/** What a command runs with. */
export interface Cli {
  /** The command as typed: the first positional argument. */
  command: string;
  values: CliValues;
  config: AgentConfig;
  configFile: LoadedConfig['configFile'];
  /** The database: in memory (--memory), --db, or the configured one. */
  dbPath: string;
  /** Prints a value as indented JSON on stdout. */
  print: (value: unknown) => void;
  /** With --verbose: the live client's log lines, on stderr. */
  log: ((line: string) => void) | undefined;
}

/** "minecraft:chest=1,minecraft:torch=8" -> { 'minecraft:chest': 1, 'minecraft:torch': 8 }. */
export function parseNeeds(text: string): Record<string, number> {
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

/** A cycle's result as a command prints it without --full. */
export function compact(scenario: string, dbPath: string, r: CycleResult): Record<string, unknown> {
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

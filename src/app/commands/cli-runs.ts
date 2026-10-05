import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DecisionResult } from '../../domain/decisions.ts';
import { openDatabase } from '../../persistence/database.ts';
import { OWNER_PAUSED_KEY } from '../../persistence/memory-repository.ts';
import { createRepositories } from '../../persistence/repositories.ts';
import {
  describeSystem1Stats,
  mergeSystem1Stats,
  NO_SYSTEM1_STATS,
} from '../../system1/model-cadence.ts';
import { systemClock } from '../../util/clock.ts';
import { errorMessage } from '../../util/json.ts';
import { checkLimits, DEFAULT_SESSION_LIMITS } from '../loop/live-session.ts';
import { runMockScenario } from '../mock/mock-agent.ts';
import { findScenario, SCENARIOS } from '../mock/scenarios.ts';
import { cancelActionRecords } from '../play/commands.ts';
import { runLivePlay } from '../play/live-play.ts';
import { describePlayEvent } from '../play/narration.ts';
import { untilSunrise } from '../play/night.ts';
import {
  checkPlayLimits,
  DEFAULT_PLAY_LIMITS,
  liveAbilities,
  type PlayLimits,
  MAX_MOB_WAITS,
  MOB_LONG_WAIT_MS,
  MOB_WAIT_MS,
} from '../play/play.ts';
import { createCommandTranslator, createProviders } from '../providers.ts';
import { compact, parseNeeds, type Cli } from './cli-context.ts';
import { runLiveCycle, runLiveSession } from './live-commands.ts';

/**
 * The CLI's runs of the agent (src/app/cli.ts): one cycle against a mock scenario or the test
 * server (once), the mock scenarios, a bounded run of the current task (run), and autonomous
 * play (play).
 */

/** A cycle's System 1 line, as play prints it: the provider shows whether the model decided. */
function system1Line(d: DecisionResult): string {
  return `SYSTEM 1 (${d.provider}): ${d.decision} [${d.reasonCodes.join(', ')}] confidence ${d.confidence}`;
}

/** `once`: ONE cycle against a mock scenario, or with --live against the test server. */
export async function onceCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
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

/** `scenarios`: the mock scenarios, with what each expects. */
export function scenariosCommand(): number {
  for (const s of SCENARIOS) {
    process.stdout.write(
      `${s.name.padEnd(24)} ${s.expect.decision} -> ${s.expect.actionType} -> ${s.expect.status}\n${''.padEnd(25)}${s.description}\n`,
    );
  }
  return 0;
}

/**
 * `play --live`: autonomous play, through the nights: play stops before the dark (or for a
 * mob near home), the agent stays offline until sunrise (or a little), then plays on.
 */
export async function playCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
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
  const needs = values.needs === undefined ? null : parseNeeds(values.needs);
  const freeGoal =
    needs === null
      ? null
      : {
          taskId: `goal-${Object.entries(needs)
            .map(([item, n]) => `${item}-${n}`)
            .join('-')}`.slice(0, 64),
          name: `get ${Object.entries(needs)
            .map(([item, n]) => `${n} ${item}`)
            .join(', ')}`,
          requirements: needs,
        };
  const providers = createProviders(config);
  const translator = createCommandTranslator(config);
  const listen = values.listen;
  const asked =
    config.decisions.provider !== 'ollama'
      ? ''
      : config.decisions.modelCadence === 'every-cycle'
        ? ' every cycle'
        : ' at decision points';
  process.stderr.write(
    `playing: decisions by ${providers.decisionProvider.name}${asked}, plans by ` +
      `${providers.planner?.name ?? 'nobody'}; stop with pnpm cli halt or Ctrl+C\n`,
  );
  const owners = config.minecraft.owners;
  if (owners.length > 0) {
    process.stderr.write(
      `commands: from ${owners.join(', ')} (a whisper, or !command in chat; pnpm cli command ` +
        `"<text>"), ${translator === null ? 'structured form only (!help)' : `natural language by ${translator.name}`}` +
        `${listen ? '; listening: online for commands until the time limit' : ''}\n`,
    );
  } else if (listen) {
    process.stderr.write('--listen: no owner is configured (MC_OWNERS), so no command can come\n');
  }
  // A fresh play: an owner's pause (or stop) from before is over; quests off stays.
  const db = openDatabase(dbPath);
  try {
    createRepositories(db, systemClock).memory.setValue(OWNER_PAUSED_KEY, null);
  } finally {
    db.close();
  }
  /** How System 1 decided, over every session of this play. */
  let system1 = NO_SYSTEM1_STATS;
  // Through the nights: play stops before the dark (no shelter yet), the agent is offline
  // until sunrise, then plays on, all within the time limit. Ctrl+C or the stop file end it.
  const started = Date.now();
  const deadline = started + limits.maxMinutes * 60_000;
  const stopFile = resolve(config.minecraft.movement.stopFile);
  let interrupted = false;
  const onInterrupt = (): void => void (interrupted = true);
  process.on('SIGINT', onInterrupt);
  /**
   * The operator stopped play (Ctrl+C, the stop file) while no play runs (an offline wait, a
   * reconnect): the owners' commands end with it, as play's leave() ends them (they cannot be
   * told: the bot is offline; the command's reply says so).
   */
  const endCommandsIfOperatorStopped = (): void => {
    if (!interrupted && !existsSync(stopFile)) return;
    const db = openDatabase(dbPath);
    try {
      cancelActionRecords(createRepositories(db, systemClock), 'Stopped: my operator stopped play');
    } finally {
      db.close();
    }
  };
  /** Waits `ms`, or less: why it stopped waiting early (Ctrl+C, the stop file, the limit). */
  const waitUnlessStopped = async (ms: number): Promise<string | null> => {
    const wakeAt = Date.now() + ms;
    while (Date.now() < wakeAt) {
      if (interrupted) return 'interrupted (Ctrl+C)';
      if (existsSync(stopFile)) return `the stop file ${stopFile} exists`;
      if (Date.now() >= deadline) return `reached the limit of ${limits.maxMinutes} minutes`;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, wakeAt - Date.now()))));
    }
    return null;
  };
  /** runLivePlay ends in a row that stopped for a mob near home (see mobPause). */
  let mobWaits = 0;
  /** With --listen: connection attempts in a row that failed. */
  let failedConnects = 0;
  try {
    for (;;) {
      const minutesLeft = (deadline - Date.now()) / 60_000;
      let out: Awaited<ReturnType<typeof runLivePlay>>;
      try {
        out = await runLivePlay(
          config,
          dbPath,
          {
            limits: {
              ...limits,
              maxMinutes: Math.max(1, Math.min(480, Math.round(minutesLeft * 10) / 10)),
            },
            ...providers,
            abilities: liveAbilities({
              configured: Object.keys(config.minecraft.crafting.tables).length > 0,
              placing: config.minecraft.placing.enabled,
            }),
            ...(freeGoal === null ? {} : { goal: freeGoal }),
            listen,
            translator,
            onEvent: (e) => {
              if (e.kind === 'session-end' && e.system1 !== undefined) {
                system1 = mergeSystem1Stats(system1, e.system1);
              }
              process.stderr.write(`${describePlayEvent(e)}\n`);
            },
          },
          log,
        );
      } catch (error) {
        // Staying reachable: a server restart, a kick or the network is waited out.
        if (!listen) throw error;
        const wait = reconnectDelay(failedConnects);
        failedConnects += 1;
        process.stderr.write(
          `listen: could not connect (attempt ${failedConnects}): ${errorMessage(error)}; ` +
            `trying again in ${wait / 1000} s\n`,
        );
        const stop = await waitUnlessStopped(wait);
        if (stop !== null) {
          endCommandsIfOperatorStopped();
          print({ stopReason: `${stop} (while reconnecting)`, minutes: minutesSince(started) });
          return 0;
        }
        continue;
      }
      failedConnects = 0;
      if (listen && out.info.closedReason !== null) {
        const wait = reconnectDelay(0);
        failedConnects = 1;
        process.stderr.write(
          `listen: the connection was lost (${out.info.closedReason}); reconnecting in ${wait / 1000} s\n`,
        );
        const stop = await waitUnlessStopped(wait);
        if (stop === null) continue;
        endCommandsIfOperatorStopped();
        print({ stopReason: `${stop} (while reconnecting)`, minutes: minutesSince(started) });
        return 0;
      }
      // Online for commands until the time limit: a long follow may use up one play's
      // sessions; another play (a new connection) goes on.
      if (
        listen &&
        out.stopReason === `reached the limit of ${limits.maxSessions} sessions` &&
        Date.now() < deadline
      ) {
        process.stderr.write(`listen: ${out.stopReason}; playing on in a new session count\n`);
        continue;
      }
      const decided = describeSystem1Stats(system1);
      const summary = {
        stopReason: out.stopReason,
        sessions: out.sessions,
        questsCompleted: out.questsCompleted,
        progress: out.progress,
        minutes: Number(((Date.now() - started) / 60_000).toFixed(1)),
        ...(decided === null ? {} : { system1: decided }),
      };
      // A mob that came after the bot had played on a while is a new one: its waits count
      // from one (else one mob that stayed made every later mob wait 5 minutes offline).
      mobWaits =
        out.mobNearby === null ? 0 : out.elapsedMs >= NEW_MOB_EPISODE_MS ? 1 : mobWaits + 1;
      // Until the next sunrise: also from a day that night will end soon (seen live: with
      // no shelter possible two minutes before dusk, it slept 15 s and came back, again
      // and again, until the evening).
      // A mob that stays: listening, the bot waits longer each time rather than leaving the
      // owner a bot that quit (MOB_LONG_WAIT_MS); otherwise play stops and says so.
      const sleepMs =
        out.night !== null
          ? (untilSunrise(out.night) + 0.25) * 60_000
          : out.mobNearby !== null && mobWaits <= MAX_MOB_WAITS
            ? MOB_WAIT_MS
            : out.mobNearby !== null && listen
              ? MOB_LONG_WAIT_MS
              : 0;
      if (sleepMs === 0 || Date.now() + sleepMs >= deadline) {
        print(
          out.mobNearby !== null && mobWaits > MAX_MOB_WAITS
            ? {
                ...summary,
                stopReason: `${out.stopReason}; it stayed for ${MAX_MOB_WAITS} waits`,
              }
            : summary,
        );
        return 0;
      }
      process.stderr.write(
        out.night !== null
          ? `night: offline for ${(sleepMs / 60_000).toFixed(1)} min until sunrise, then playing on (${out.stopReason.slice(0, 600)})\n`
          : `mob: offline for ${sleepMs / 1000} s for it to leave (${mobWaits <= MAX_MOB_WAITS ? `${mobWaits}/${MAX_MOB_WAITS}` : `wait ${mobWaits}: it stays near`}), then playing on\n`,
      );
      if ((await waitUnlessStopped(sleepMs)) !== null) {
        endCommandsIfOperatorStopped();
        print({
          ...summary,
          stopReason: `stopped while waiting ${out.night !== null ? 'for sunrise' : 'for the mob to leave'}`,
        });
        return 0;
      }
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

/** A play that ran this long before a mob ended it began a new mob episode (cli play). */
const NEW_MOB_EPISODE_MS = 2 * 60_000;

/**
 * With --listen, how long to wait before reconnecting after `attempt` failed attempts in a
 * row: 5 s, 15 s, 60 s, then every 2 minutes.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000, 120_000];

export function reconnectDelay(attempt: number): number {
  return RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 120_000;
}

const minutesSince = (started: number): number =>
  Number(((Date.now() - started) / 60_000).toFixed(1));

/** `run --live`: a BOUNDED run of the current task's cycles on one connection. */
export async function runCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
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
    (r, i) => {
      if (r.decision !== null) process.stderr.write(`[cycle ${i}] ${system1Line(r.decision)}\n`);
      process.stderr.write(`[cycle ${i}] ${r.summary}\n`);
    },
    log,
  );
  const decided = out.system1 === undefined ? null : describeSystem1Stats(out.system1);
  if (decided !== null) process.stderr.write(`${decided}\n`);
  print({
    stopReason: out.stopReason,
    task: { taskId: out.taskId, status: out.taskStatus },
    cycles: out.cycles.map((c) => c.summary),
    seconds: Number((out.elapsedMs / 1000).toFixed(1)),
    ...(decided === null ? {} : { system1: decided }),
  });
  return out.taskStatus === 'completed' ? 0 : 1;
}

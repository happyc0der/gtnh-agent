import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { nextKnownStep, setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import type { SessionResult, SessionStopKind } from '../../../src/app/loop/live-session.ts';
import {
  chatItemName,
  clip,
  NOT_UNDERSTOOD,
  type CommandDeps,
} from '../../../src/app/play/commands.ts';
import type { FoodStatus } from '../../../src/app/play/food.ts';
import { describePlayEvent } from '../../../src/app/play/narration.ts';
import type { TravelStep, TravelTarget } from '../../../src/app/play/owner-travel.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type FreeGoal,
  type PlayDeps,
  type PlayEvent,
  type PlayLimits,
  type TunnelRequest,
} from '../../../src/app/play/play.ts';
import type { TunnelPlan } from '../../../src/bot/gtnh1710/tunnel.ts';
import type { Position } from '../../../src/domain/common.ts';
import { FOOD_TASK_ID } from '../../../src/domain/food.ts';
import { worldTime, type WorldTime } from '../../../src/domain/game-state.ts';
import type { HeardCommand, OwnerCommand } from '../../../src/domain/owner-commands.ts';
import type { CommandTranslation } from '../../../src/llm/ollama-command-provider.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY, QUESTS_OFF_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

/**
 * The command round over a simulated world: chat comes from `heard`, replies go to
 * `replies`, travel steps move the bot at once (the fake session runs a task's known step as
 * the executor would, and stands in for a goal's planner with `gain`).
 */
interface Sim {
  position: Position;
  owner: Position | null;
  inventory: Record<string, number>;
  heard: HeardCommand[];
  replies: string[];
  /** Items each cycle of a session without a known step (a goal's) gains. */
  gain: Record<string, number>;
  /** After every cycle (its number across sessions). */
  afterCycle?: (n: number) => void;
  cycles: number;
  /** The task each session ran under, in order. */
  sessions: string[];
  /** Known steps run, e.g. "MOVE_TO 9.5 0.5" or "WAIT". */
  steps: string[];
  cleared: number;
  /** The fake planner refuses every step. */
  blocked: boolean;
  time: WorldTime | null;
  food: FoodStatus | null;
  clock: { t: number };
  /** Sleeps so far; `onSleep` may change the world meanwhile. */
  onSleep?: (n: number) => void;
  sleeps: number;
}

const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const DIRT: FreeGoal = {
  taskId: 'goal-dirt',
  name: 'get 10 minecraft:dirt',
  requirements: { 'minecraft:dirt': 10 },
};
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 5,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};
const noStop = { stopRequested: () => null };
const open = (): Repositories => createRepositories(openDatabase(IN_MEMORY), systemClock);

function newSim(over: Partial<Sim> = {}): Sim {
  return {
    position: { x: 0.5, y: 64, z: 0.5 },
    owner: { x: 10.5, y: 64, z: 0.5 },
    inventory: {},
    heard: [],
    replies: [],
    gain: {},
    cycles: 0,
    sessions: [],
    steps: [],
    cleared: 0,
    blocked: false,
    time: null,
    food: null,
    clock: { t: 0 },
    sleeps: 0,
    ...over,
  };
}

/** Straight to the target: one walk (to a block before a player), or there already. */
function fakeStep(sim: Sim, t: TravelTarget): TravelStep {
  const g = t.point;
  const d = Math.hypot(g.x - sim.position.x, g.z - sim.position.z);
  const distance = Number(d.toFixed(1));
  if (t.kind === 'near' ? d <= t.within : d <= 1.5) return { kind: 'arrived', distance };
  if (sim.blocked) return { kind: 'refused', reason: 'no walk gets nearer to there' };
  const to = { x: t.kind === 'near' ? g.x - 1 : g.x, y: g.y ?? 64, z: g.z };
  return {
    kind: 'step',
    spec: { type: 'MOVE_TO', args: { target: to, tolerance: 1 } },
    text: `walk to ${to.x} ${to.z}`,
    distance,
  };
}

function commandDeps(
  sim: Sim,
  over: { translate?: (text: string) => Promise<CommandTranslation> } = {},
): CommandDeps {
  return {
    take: () => sim.heard.splice(0),
    waiting: () => sim.heard.length > 0,
    reply: (to, text) => void sim.replies.push(`${to}: ${text}`),
    clearInterrupt: () => void (sim.cleared += 1),
    ...over,
    view: () => ({
      position: { ...sim.position },
      dimension: 'overworld',
      health: 20,
      food: sim.food?.hunger ?? 20,
      inventory: { ...sim.inventory },
      playerAt: (name) => (name === OWNER && sim.owner !== null ? { ...sim.owner } : null),
    }),
    step: (t) => fakeStep(sim, t),
    owners: [OWNER],
    homeName: 'home',
    configLocations: new Map([
      [
        'pen',
        {
          dimension: 'overworld',
          position: { x: -5, y: 200, z: -8 },
          kind: 'safe' as const,
          note: null,
        },
      ],
    ]),
    boundary: {
      min: { x: -256, y: 0, z: -256 },
      max: { x: 256, y: 255, z: 256 },
      allowedDimensions: ['overworld'],
    },
  };
}

/** A session as runSession runs one: cycles until the task ends, a limit, or a stop. */
function fakeSession(repos: Repositories, sim: Sim): PlayDeps['session'] {
  return (limits, hooks) => {
    const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
    sim.sessions.push(taskId ?? 'none');
    const cycles: SessionResult['cycles'] = [];
    const end = (stopKind: SessionStopKind, stopReason: string): Promise<SessionResult> =>
      Promise.resolve({
        cycles,
        stopReason,
        stopKind,
        taskId,
        taskStatus: taskId === null ? null : (repos.tasks.get(taskId)?.status ?? null),
        elapsedMs: 1,
      });
    for (;;) {
      sim.clock.t += 1_000;
      const status = taskId === null ? null : (repos.tasks.get(taskId)?.status ?? null);
      if (taskId === null || status === null) return end('no-task', 'there is no current task');
      if (status === 'completed') return end('task-finished', 'the task is completed');
      if (status !== 'active') return end('task-halted', `the task is ${status}`);
      if (cycles.length >= limits.maxCycles) {
        return end('limit', `reached the limit of ${limits.maxCycles} cycles`);
      }
      const stop = hooks.stopRequested();
      if (stop !== null) return end('stop-requested', stop);
      const step = nextKnownStep(repos, taskId);
      let summary: string;
      if (step !== null) {
        const s = step.spec;
        if (s.type === 'MOVE_TO') {
          sim.position = { ...s.args.target };
          sim.steps.push(`MOVE_TO ${s.args.target.x} ${s.args.target.z}`);
        } else sim.steps.push(s.type);
        // Verified: the blueprint's last step completes the task (known-steps.ts).
        setKnownSteps(repos, taskId, null);
        repos.tasks.setStatus(taskId, 'completed');
        summary = `EXECUTE_KNOWN_SAFE_STEP -> ${s.type} -> succeeded`;
      } else {
        for (const [item, n] of Object.entries(sim.gain)) {
          sim.inventory[item] = (sim.inventory[item] ?? 0) + n;
        }
        if (taskId === FOOD_TASK_ID && sim.food !== null) sim.food = { ...sim.food, carried: 10 };
        summary = 'REQUEST_PLANNER -> DIG_BLOCK -> succeeded';
      }
      cycles.push({ cycleId: `c${sim.cycles}`, summary });
      const result = { summary, status: 'succeeded', decision: null, outcome: null };
      hooks.onCycle(result as unknown as CycleResult, cycles.length);
      sim.cycles += 1;
      sim.afterCycle?.(sim.cycles);
    }
  };
}

function deps(
  repos: Repositories,
  sim: Sim,
  over: Partial<PlayDeps> & { translate?: (text: string) => Promise<CommandTranslation> } = {},
): PlayDeps {
  const { translate, ...rest } = over;
  return {
    repos,
    now: () => sim.clock.t,
    inventory: () => Promise.resolve({ ...sim.inventory }),
    session: fakeSession(repos, sim),
    sleep: (ms) => {
      sim.clock.t += ms;
      sim.sleeps += 1;
      sim.onSleep?.(sim.sleeps);
      return Promise.resolve();
    },
    commands: commandDeps(sim, translate === undefined ? {} : { translate }),
    ...rest,
  };
}

const said = (sim: Sim): string[] => sim.replies.map((r) => r.replace(`${OWNER}: `, ''));

describe("owners' commands in play", () => {
  it('run before the goal, as code-made steps, and are answered in whispers', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!come')], gain: { 'minecraft:dirt': 5 } });
    const events: PlayEvent[] = [];
    const result = await runPlay(deps(repos, sim, { goal: DIRT }), LIMITS, {
      ...noStop,
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe('the goal "get 10 minecraft:dirt" is reached');
    expect(said(sim)).toEqual(['OK: coming to you', 'Done: here, 1 block from you']);
    // The command's session came first, then the goal's.
    expect(sim.sessions).toEqual(['command-1', 'goal-dirt']);
    expect(sim.steps).toEqual(['MOVE_TO 9.5 0.5']);
    expect(repos.commands.get(1)).toMatchObject({
      source: 'chat',
      sender: OWNER,
      status: 'done',
      reply: 'Done: here, 1 block from you',
    });
    expect(repos.tasks.get('command-1')?.status).toBe('completed');
    // An owner's stop is cleared at every round: an interrupt never outlasts its session.
    expect(sim.cleared).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => describePlayEvent(e))).toContain(
      'COMMAND #1 (DankAxon): heard (whisper): !come',
    );
  });

  it('a new command ends the session running at its next cycle; the goal goes on after it', async () => {
    const repos = open();
    const sim = newSim({ gain: { 'minecraft:dirt': 2 } });
    sim.afterCycle = (n) => {
      if (n === 1) sim.heard.push(whisper('!status'));
    };
    await runPlay(deps(repos, sim, { goal: DIRT }), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'at 0 64 0, health 20/20, food 20/20; working on: get 10 minecraft:dirt; carrying 2 dirt',
    ]);
    // The first session ended after one cycle; the goal went on and was reached.
    expect(sim.sessions).toEqual(['goal-dirt', 'goal-dirt', 'goal-dirt']);
    expect(sim.inventory['minecraft:dirt']).toBe(14);
    expect(repos.memory.journal('goal-dirt').map((j) => j.text)).toContain(
      'interrupted: an owner gave a new command',
    );
  });

  it('a command queued from the command line is taken between cycles, as one from chat', async () => {
    const repos = open();
    const sim = newSim({ gain: { 'minecraft:dirt': 2 } });
    sim.afterCycle = (n) => {
      if (n === 1) {
        repos.commands.add({
          source: 'cli',
          sender: OWNER,
          rawText: '!come',
          command: { verb: 'come' },
        });
      }
    };
    await runPlay(deps(repos, sim, { goal: DIRT }), LIMITS, noStop);
    expect(sim.sessions.slice(0, 2)).toEqual(['goal-dirt', 'command-1']);
    expect(said(sim)).toEqual(['OK: coming to you', 'Done: here, 1 block from you']);
    expect(repos.commands.get(1)?.status).toBe('done');
  });

  it('follow re-plans every cycle: a walk toward the owner, a wait near it, until it is lost', async () => {
    const repos = open();
    const sim = newSim({ owner: { x: 5.5, y: 64, z: 0.5 }, heard: [whisper('follow me')] });
    sim.afterCycle = (n) => {
      if (n === 2) sim.owner = { x: 15.5, y: 64, z: 0.5 };
      if (n === 4) sim.owner = null; // logged off, or out of sight
    };
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(sim.steps).toEqual(['MOVE_TO 4.5 0.5', 'WAIT', 'WAIT', 'MOVE_TO 14.5 0.5', 'WAIT']);
    expect(said(sim)).toEqual(['OK: following you', 'Failed: I cannot see you from here']);
    expect(repos.commands.get(1)?.status).toBe('failed');
  });

  it('stop cancels the command and idles (--listen keeps the bot online); resume plays on', async () => {
    const repos = open();
    const sim = newSim({
      owner: { x: 2.5, y: 64, z: 0.5 },
      heard: [whisper('!follow')],
      gain: { 'minecraft:dirt': 5 },
    });
    sim.afterCycle = (n) => {
      if (n === 1) sim.heard.push(whisper('!stop'));
    };
    sim.onSleep = (n) => {
      if (n === 3) sim.heard.push(whisper('!resume'));
    };
    const events: PlayEvent[] = [];
    const result = await runPlay(deps(repos, sim, { goal: DIRT, listen: true }), LIMITS, {
      ...noStop,
      onEvent: (e) => events.push(e),
    });
    expect(said(sim)).toEqual([
      'OK: following you',
      'OK: stopped (follow you). I wait for !resume or a new command',
      'OK: resuming my own play',
    ]);
    expect(repos.commands.get(1)).toMatchObject({
      status: 'cancelled',
      reply: 'Stopped by DankAxon',
    });
    // Paused, it waited for commands; resumed, the goal went on; with --listen play then
    // waits for commands until the time limit instead of ending.
    expect(events.map((e) => describePlayEvent(e))).toContain(
      'idle: paused: DankAxon said stop; waiting for commands',
    );
    expect(sim.sessions[0]).toBe('command-1');
    expect(sim.sessions).toContain('goal-dirt');
    expect(result.stopReason).toBe('reached the limit of 5 minutes');
  });

  it('without --listen, a stop (or pause) ends play once nothing is left to do', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!stop')], gain: { 'minecraft:dirt': 5 } });
    const result = await runPlay(deps(repos, sim, { goal: DIRT }), LIMITS, noStop);
    expect(result.stopReason).toBe(
      'paused: DankAxon said stop: nothing else to do (cli play --listen stays online for commands)',
    );
    expect(sim.sessions).toEqual([]);
    expect(said(sim)).toEqual(['OK: stopped. I wait for !resume or a new command']);
  });

  it('quests off is kept until quests on', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!quests off')], gain: { 'minecraft:dirt': 5 } });
    const off = await runPlay(deps(repos, sim, { goal: DIRT }), LIMITS, noStop);
    expect(off.stopReason).toMatch(/^quests are off: DankAxon said quests off: nothing else/);
    expect(repos.memory.getValue(QUESTS_OFF_KEY)).not.toBeNull();
    // A new play keeps it; quests on ends it.
    const again = await runPlay(deps(repos, newSim(), { goal: DIRT }), LIMITS, noStop);
    expect(again.stopReason).toMatch(/^quests are off/);
    const on = newSim({ heard: [whisper('!quests on')], gain: { 'minecraft:dirt': 5 } });
    const result = await runPlay(deps(repos, on, { goal: DIRT }), LIMITS, noStop);
    expect(said(on)).toEqual(['OK: quests on']);
    expect(result.stopReason).toBe('the goal "get 10 minecraft:dirt" is reached');
  });

  it('get pursues a goal of items like --needs, says halfway, and is done when they are held', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!get 6 logs')], gain: { 'minecraft:log': 1 } });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: getting minecraft:log until I have 6 (I have 0)',
      'Halfway: 3/6 minecraft:log',
      'Done: I have 6 minecraft:log',
    ]);
    expect(sim.sessions).toEqual(['command-1', 'command-1']);
    expect(repos.memory.taskRequirements('command-1')).toEqual({ 'minecraft:log': 6 });
    expect(repos.memory.taskAnyKind('command-1')).toEqual(['minecraft:log']);
    expect(repos.tasks.get('command-1')?.status).toBe('completed');
    expect(repos.memory.journal('command-1').at(-1)?.text).toBe(
      'GOAL "get minecraft:log until I have 6 (owner command #1 from DankAxon)" reached',
    );
  });

  it('a name without a damage value counts every kind: birch logs are logs', async () => {
    // "get 16 logs" in a birch forest counted oak only, and would have felled it all.
    const sim = newSim({
      heard: [whisper('!get 6 logs')],
      inventory: { 'minecraft:log@2': 4, 'minecraft:log': 2 },
    });
    await runPlay(deps(open(), sim), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: getting minecraft:log until I have 6 (I have 6)',
      'Done: I have 6 minecraft:log',
    ]);
    expect(sim.sessions).toEqual([]);
  });

  it('a name with a damage value counts that kind only', async () => {
    const repos = open();
    const sim = newSim({
      heard: [whisper('!get 2 minecraft:log@2')],
      inventory: { 'minecraft:log': 6 },
      gain: { 'minecraft:log@2': 1 },
    });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim)[0]).toBe('OK: getting minecraft:log@2 until I have 2 (I have 0)');
    expect(said(sim).at(-1)).toBe('Done: I have 3 minecraft:log@2');
    expect(repos.memory.taskAnyKind('command-1')).toEqual([]);
  });

  it('halfway counts from what was held when the command began', async () => {
    // Seen live: "get me 14 dirt" holding 12 said "Halfway: 12/14" before digging anything.
    const repos = open();
    const sim = newSim({
      heard: [whisper('!get 16 dirt')],
      inventory: { 'minecraft:dirt': 12 },
      gain: { 'minecraft:dirt': 1 },
    });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: getting minecraft:dirt until I have 16 (I have 12)',
      // The fake gains 3 a session: 15 is past halfway from 12; 12 itself never was.
      'Halfway: 15/16 minecraft:dirt',
      'Done: I have 18 minecraft:dirt',
    ]);
  });

  it('work on the way counts as progress: a session that gets logs for a pickaxe is no stall', async () => {
    // Seen live 2026-10-04: logs, flint and planks got, sessions counted as none, the
    // pickaxe command failed.
    const sim = newSim({
      heard: [whisper('!get 1 minecraft:wooden_pickaxe')],
      gain: { 'minecraft:log': 1 },
    });
    await runPlay(deps(open(), sim), LIMITS, noStop);
    expect(sim.sessions.length).toBeGreaterThan(3);
    expect(said(sim).some((l) => l.includes('no progress'))).toBe(false);
  });

  it('sessions that end with a retreat from a mob are interruptions, not stalls', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!mine 4 sand')] });
    const base = deps(repos, sim);
    let sessions = 0;
    await runPlay(
      {
        ...base,
        session: (_limits, hooks) => {
          sessions += 1;
          hooks.onCycle(
            {
              summary: 'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> succeeded',
              status: 'succeeded',
              decision: {
                decision: 'RETREAT_HOME',
                confidence: 0.95,
                reasonCodes: ['HOSTILES_NEARBY'],
                factsUsed: {},
                requiresHumanConfirmation: false,
                provider: 'test',
              },
              outcome: null,
            } as unknown as CycleResult,
            1,
          );
          sim.clock.t += 60_000;
          return Promise.resolve({
            cycles: [
              {
                cycleId: `c${sessions}`,
                summary: 'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> succeeded',
              },
            ],
            stopReason: 'stopped after a non-task decision',
            stopKind: 'non-task-decision',
            taskId: repos.memory.getValue(CURRENT_TASK_KEY),
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      LIMITS,
      noStop,
    );
    expect(sessions).toBeGreaterThan(3);
    expect(said(sim).some((l) => l.includes('no progress'))).toBe(false);
  });

  it('a goal that makes no progress fails after maxStuckSessions sessions', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!mine 4 sand')] });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim).at(-1)).toMatch(/^Failed: no progress in 3 sessions/);
    expect(sim.sessions).toHaveLength(3);
  });

  it('a GregTech ore asked for above its veins: says where they lie and how to dig to them', async () => {
    const sim = newSim({ heard: [whisper('!mine 16 copper ore')] });
    await runPlay(deps(open(), sim), LIMITS, noStop);
    expect(said(sim)[0]).toBe(
      'OK: mining gregtech:gt.blockores until I have 16 gregtech:gt.metaitem.03@5035 (I have 0); ' +
        'its veins lie at y 5-60, I am at y 64: "!tunnel <direction> 4 down" digs down to them, ' +
        'then "!tunnel <direction> 40" looks along',
    );
  });

  it('refuses what it may not do, saying why: outside the boundary, a non-owner, no home', async () => {
    const repos = open();
    const sim = newSim({
      heard: [whisper('!goto 300 64 0'), whisper('!follow Mallory'), whisper('!home')],
    });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'Failed: 300 64 0 is outside my safety boundary (x -256..256, z -256..256)',
      'Failed: I follow only my owners (DankAxon)',
      'Failed: I have no home yet: say !sethome where it should be',
    ]);
    expect(sim.sessions).toEqual([]);
  });

  it('a travel step that cannot be planned is retried, then fails with why', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!goto 40 64 0')], blocked: true });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim)).toEqual(['OK: going to 40 64 0', 'Failed: no walk gets nearer to there']);
    expect(sim.sleeps).toBe(2); // a moment before each retry
  });

  it('natural language goes to the translator; the structured form never does', async () => {
    const repos = open();
    const asked: string[] = [];
    const translate = (text: string): Promise<CommandTranslation> => {
      asked.push(text);
      return Promise.resolve(
        text.includes('wood')
          ? { ok: true, command: { verb: 'get', count: 2, item: 'minecraft:log' }, latencyMs: 5 }
          : { ok: false, reason: 'the model found no command' },
      );
    };
    const sim = newSim({
      heard: [
        whisper('could you bring me some wood'),
        whisper('sing a song'),
        whisper('!dance'),
        whisper('!goto 10'),
      ],
      gain: { 'minecraft:log': 2 },
    });
    await runPlay(deps(repos, sim, { translate }), LIMITS, noStop);
    expect(asked).toEqual(['could you bring me some wood', 'sing a song']);
    expect(said(sim)).toEqual([
      NOT_UNDERSTOOD, // !dance: a typo in the structured form is answered at once
      'usage: !goto <x> <y> <z>, !goto <x> <z> or !goto <waypoint>',
      'OK: getting minecraft:log until I have 2 (I have 0)',
      NOT_UNDERSTOOD, // sing a song
      'Done: I have 6 minecraft:log', // a session of 3 cycles, 2 logs each
    ]);
    expect(repos.commands.get(1)?.command).toEqual({
      verb: 'get',
      count: 2,
      item: 'minecraft:log',
    } satisfies OwnerCommand);
    // Without a translator, natural language is not understood either.
    const plain = newSim({ heard: [whisper('could you bring me some wood')] });
    await runPlay(deps(open(), plain), LIMITS, noStop);
    expect(said(plain)).toEqual([NOT_UNDERSTOOD]);
  });

  it('waypoints: saved where the bot stands, listed, travelled to, deleted; home is safe', async () => {
    const repos = open();
    const sim = newSim({
      heard: [
        whisper('!waypoint base'),
        whisper('!sethome'),
        whisper('!waypoints'),
        whisper('!waypoint pen'),
        whisper('!waypoint delete home'),
        whisper('!goto nowhere'),
      ],
    });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: waypoint base is at 0 64 0',
      'OK: home is at 0 64 0',
      'Waypoints: base (0 64 0), home (0 64 0), pen (-5 200 -8)',
      'Failed: pen is set in agent.config.json (locations): change it there',
      'Failed: home is where I retreat to: move it with !sethome, it is never deleted',
      'Failed: I know no waypoint nowhere: say !waypoints',
    ]);
    expect(repos.locations.all().get('home')).toMatchObject({
      kind: 'safe',
      note: 'set by DankAxon',
    });
    expect(repos.locations.all().get('base')).toMatchObject({ kind: 'other' });

    const away = newSim({
      position: { x: 30.5, y: 64, z: 0.5 },
      heard: [whisper('!goto base')],
    });
    await runPlay(deps(repos, away), LIMITS, noStop);
    expect(said(away)).toEqual(['OK: going to base (0.5 64 0.5)', 'Done: at base']);
    expect(away.steps).toEqual(['MOVE_TO 0.5 0.5']);

    const forget = newSim({ heard: [whisper('!wp delete base'), whisper('!wps')] });
    await runPlay(deps(repos, forget), LIMITS, noStop);
    expect(said(forget)).toEqual([
      'OK: waypoint base deleted',
      'Waypoints: home (0 64 0), pen (-5 200 -8)',
    ]);
  });

  it('explores toward a direction, from where it began: a point fixed then (Baritone #explore)', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!explore north 50')] });
    await runPlay(deps(repos, sim), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: exploring north toward 1 -49',
      'Done: explored 50 blocks north',
    ]);
    expect(sim.steps).toEqual(['MOVE_TO 1 -49']);
    // Toward the boundary: no farther than the room left that way; with too little, it fails.
    const near = newSim({
      position: { x: 0.5, y: 64, z: -230.5 },
      heard: [whisper('!explore n 100')],
    });
    await runPlay(deps(open(), near), LIMITS, noStop);
    expect(said(near)[0]).toBe('OK: exploring north toward 1 -255');
    const edge = newSim({
      position: { x: 0.5, y: 64, z: -250.5 },
      heard: [whisper('!explore north 100')],
    });
    await runPlay(deps(open(), edge), LIMITS, noStop);
    expect(said(edge)).toEqual(['Failed: my safety boundary is 5 blocks north of here']);
    expect(edge.steps).toEqual([]);
  });

  it('at night the shelter keeps priority: commands are answered, travel waits for the morning', async () => {
    const repos = open();
    const night = worldTime(18_000, true);
    const sim = newSim({ heard: [whisper('!come'), whisper('!status')], time: night });
    sim.onSleep = () => {
      sim.time = worldTime(1_000, true); // the night passes in the shelter
    };
    const sheltered = {
      kind: 'pit' as const,
      sheltered: true,
      steps: [],
      needs: {},
      problem: null,
      walled: false,
      exit: [],
    };
    await runPlay(
      deps(repos, sim, {
        time: () => Promise.resolve(sim.time),
        shelter: () => Promise.resolve(sheltered),
      }),
      LIMITS,
      noStop,
    );
    expect(said(sim)).toEqual([
      'It is night: I stay in my shelter until morning, then I come to you',
      'at 0 64 0, health 20/20, food 20/20; sheltered for the night (morning in about 5 min)',
      'OK: coming to you',
      'Done: here, 1 block from you',
    ]);
    expect(sim.sessions).toEqual(['command-1']);
  });

  it('in the morning, sealed in with hostiles near: commands are answered, travel waits for them to go', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!come'), whisper('!status')] });
    let walled = true;
    sim.onSleep = () => {
      walled = false; // the zombie burnt; and in the test, the shelter is gone with it
    };
    await runPlay(
      deps(repos, sim, {
        time: () => Promise.resolve(worldTime(1_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit' as const,
            sheltered: walled,
            steps: [],
            needs: {},
            problem: null,
            walled,
            exit: [],
            hostiles: walled ? '1 hostile(s), nearest at 4.0 blocks' : null,
          }),
      }),
      LIMITS,
      noStop,
    );
    expect(said(sim)).toEqual([
      'Hostiles are near my shelter: I stay inside until they go, then I come to you',
      'at 0 64 0, health 20/20, food 20/20; staying in my shelter until the hostiles near it go (1 hostile(s), nearest at 4.0 blocks)',
      'OK: coming to you',
      'Done: here, 1 block from you',
    ]);
    expect(sim.sessions).toEqual(['command-1']);
  });

  it('digs a tunnel: code plans it a few cells at a time from where it began, to its length', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!tunnel east 3')] });
    const requests: TunnelRequest[] = [];
    // The cells ahead already open: each plan is one step into the next cell.
    const tunnel = (req: TunnelRequest): Promise<TunnelPlan> => {
      requests.push(req);
      const done = Math.floor(sim.position.x) - req.start.x;
      if (done >= req.length) {
        return Promise.resolve({ ok: true, done: req.length, steps: [], problem: null });
      }
      const x = req.start.x + done + 1;
      return Promise.resolve({
        ok: true,
        done,
        steps: [
          {
            spec: {
              type: 'MOVE_TO',
              args: {
                target: { x: x + 0.5, y: req.start.y, z: req.start.z + 0.5 },
                tolerance: 0.5,
              },
            },
            text: `step into (${x}, ${req.start.y}, ${req.start.z})`,
          },
        ],
        problem: null,
      });
    };
    await runPlay(deps(repos, sim, { tunnel }), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: digging a tunnel 3 blocks east from 0 64 0',
      'Done: dug a tunnel 3 blocks east',
    ]);
    expect(requests.every((r) => r.start.x === 0 && r.start.z === 0)).toBe(true);
    expect(sim.steps).toEqual(['MOVE_TO 1.5 0.5', 'MOVE_TO 2.5 0.5', 'MOVE_TO 3.5 0.5']);
    expect(repos.tasks.get('command-1')?.status).toBe('completed');

    // One it may not dig: it says why, and how far it got.
    const blocked = newSim({ heard: [whisper('!tunnel west')] });
    await runPlay(
      deps(open(), blocked, {
        tunnel: () =>
          Promise.resolve({
            ok: true,
            done: 0,
            steps: [],
            problem:
              'the tunnel stops before (-1, 64, 0): the floor at (-1, 63, 0) is open (a cave or a drop ahead)',
          }),
      }),
      LIMITS,
      noStop,
    );
    expect(said(blocked)).toEqual([
      'OK: digging a tunnel 16 blocks west from 0 64 0',
      'Failed: the tunnel stops before (-1, 64, 0): the floor at (-1, 63, 0) is open (a cave or a drop ahead) (0 of 16 blocks dug)',
    ]);
  });

  it('idle with a mob near home: play waits offline for it to leave (it stood there once and died)', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!pause')] });
    const base = deps(repos, sim, { listen: true });
    const result = await runPlay(
      {
        ...base,
        commands: {
          ...(base.commands as CommandDeps),
          standby: () =>
            Promise.resolve({ kind: 'mob', reasons: 'HOSTILES_NEARBY, ALREADY_AT_SAFE_LOCATION' }),
        },
      },
      LIMITS,
      noStop,
    );
    expect(result.mobNearby).toBe('HOSTILES_NEARBY, ALREADY_AT_SAFE_LOCATION');
    expect(result.stopReason).toMatch(
      /^a mob is near the player .*: waiting offline for it to leave$/,
    );
  });

  it('a food bar nearly empty keeps priority: the food trip first, then the command', async () => {
    const repos = open();
    const sim = newSim({
      heard: [whisper('!come')],
      food: { hunger: 3, carried: 0, eatBelow: 14, starveBelow: 6 },
    });
    await runPlay(
      deps(repos, sim, {
        food: { now: () => Promise.resolve(sim.food), of: () => sim.food },
      }),
      LIMITS,
      noStop,
    );
    expect(said(sim)).toEqual([
      'OK: coming to you',
      'My food bar is nearly empty (food 3/20): I get food first, then I come to you',
      'Done: here, 1 block from you',
    ]);
    expect(sim.sessions).toEqual([FOOD_TASK_ID, 'command-1']);
  });
});

describe('item names in chat', () => {
  it('drops the namespace, the item prefix and the damage value, and splits the words', () => {
    expect(chatItemName('minecraft:dirt')).toBe('dirt');
    expect(chatItemName('minecraft:log@2')).toBe('log');
    expect(chatItemName('dreamcraft:item.CoinForestry')).toBe('coin forestry');
    expect(chatItemName('minecraft:wooden_pickaxe')).toBe('wooden pickaxe');
  });
});

describe('status text', () => {
  it('cuts a long goal at a word, with "..."', () => {
    const goal =
      'Get food: hungry (food 12/20) with nothing to eat. Gather 10 hunger points of approved food';
    expect(clip(goal, 80)).toBe(
      'Get food: hungry (food 12/20) with nothing to eat. Gather 10 hunger points...',
    );
    expect(clip('get 10 minecraft:dirt', 80)).toBe('get 10 minecraft:dirt');
  });
});

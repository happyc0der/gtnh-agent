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

/** A fake tunnel planner: the cells ahead open, one step a plan, stairs one down a cell. */
function stripTunnel(
  sim: Sim,
  requests: TunnelRequest[],
): (req: TunnelRequest) => Promise<TunnelPlan> {
  const STEP = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
  return (req) => {
    requests.push(req);
    const [dx, dz] = STEP[req.direction];
    const done =
      (Math.floor(sim.position.x) - req.start.x) * dx +
      (Math.floor(sim.position.z) - req.start.z) * dz;
    if (done >= req.length) {
      return Promise.resolve({ ok: true, done: req.length, steps: [], problem: null });
    }
    const target = {
      x: req.start.x + dx * (done + 1) + 0.5,
      y: req.start.y - (req.slope === 'down' ? done + 1 : 0),
      z: req.start.z + dz * (done + 1) + 0.5,
    };
    return Promise.resolve({
      ok: true,
      done,
      steps: [{ spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } }, text: 'step on' }],
      problem: null,
    });
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

  it("a travel command that fails says why, in the walk's own words", async () => {
    // Seen live: "Failed: stopped after: EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed".
    const sim = newSim({ heard: [whisper('!goto 20 64 0')] });
    const base = deps(open(), sim);
    const why = 'walk stopped after 7 of 88 steps: hostile entity minecraft:Zombie 9.7 blocks away';
    await runPlay(
      {
        ...base,
        session: (_limits, hooks) => {
          hooks.onCycle(
            {
              summary: 'EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed',
              status: 'failed',
              decision: null,
              outcome: { execution: { ok: false, code: 'FAILED', message: why, data: {} } },
            } as unknown as CycleResult,
            1,
          );
          return Promise.resolve({
            cycles: [{ cycleId: 'c1', summary: 'EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed' }],
            stopReason: 'stopped after: EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed',
            stopKind: 'cycle-failed',
            taskId: 'command-1',
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      LIMITS,
      noStop,
    );
    expect(said(sim).at(-1)).toBe(`Failed: ${why}`);
  });

  it('come and follow fail at once when the player is not seen, before any OK', async () => {
    const sim = newSim({ owner: null, heard: [whisper('!come'), whisper('!follow')] });
    await runPlay(deps(open(), sim), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'Failed: I cannot see you from here',
      'Failed: I cannot see you from here',
    ]);
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

  it('a get that cannot be done at all fails at once, saying why', async () => {
    const sim = newSim({ heard: [whisper('!mine 16 sand'), whisper('!get 4 minecraft:me')] });
    const base = deps(open(), sim);
    const asked: string[] = [];
    await runPlay(
      {
        ...base,
        commands: {
          ...(base.commands as CommandDeps),
          goalProblem: (item, count, anyKind) => {
            asked.push(`${count} ${item} ${anyKind}`);
            return item === 'minecraft:me' ? 'no recipe or source known' : null;
          },
        },
      },
      LIMITS,
      noStop,
    );
    expect(asked).toEqual(['16 minecraft:sand true', '4 minecraft:me true']);
    expect(said(sim)).toContain('Failed: I cannot get minecraft:me: no recipe or source known');
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
      'usage: !goto <x> <y> <z>, !goto <x> <z>, !goto <waypoint> or !goto <block> (e.g. !goto chest)',
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

  it('finds blocks in view, and goes to the nearest: a waypoint name first (Baritone #find, #goto <block>)', async () => {
    const repos = open();
    const sim = newSim({
      heard: [whisper('!find chest'), whisper('!find sand'), whisper('!goto chest')],
    });
    const base = deps(repos, sim);
    const chests = [
      { position: { x: 6, y: 64, z: 0 }, distance: 5.6 },
      { position: { x: -9, y: 64, z: 2 }, distance: 9.7 },
    ];
    await runPlay(
      {
        ...base,
        commands: {
          ...(base.commands as CommandDeps),
          findBlock: (names) => (names.includes('minecraft:chest') ? chests : []),
        },
      },
      LIMITS,
      noStop,
    );
    expect(said(sim)).toEqual([
      'minecraft:chest: the nearest at 6 64 0, 6 blocks away; also -9 64 2 (10)',
      'I see no minecraft:sand near here, and remember none',
      'OK: going to the minecraft:chest at 6 64 0',
      'Done: at chest',
    ]);
    expect(sim.steps).toEqual(['MOVE_TO 5.5 0.5']);
    // After play restarts (a wait offline for a mob, a reconnect), the run that held the
    // block is gone but the command is not: the block is found again.
    const later = newSim({ heard: [whisper('!goto chest')] });
    const laterRepos = open();
    const laterBase = deps(laterRepos, later);
    const withChests = {
      ...laterBase,
      commands: { ...(laterBase.commands as CommandDeps), findBlock: () => chests },
    };
    await runPlay(withChests, LIMITS, {
      stopRequested: () => (later.replies.length > 0 ? 'a restart' : null),
    });
    expect(said(later)).toEqual(['OK: going to the minecraft:chest at 6 64 0']);
    await runPlay(withChests, LIMITS, noStop);
    expect(said(later)).toEqual(['OK: going to the minecraft:chest at 6 64 0', 'Done: at chest']);
    // A GregTech ore by its material: only exposed ones show what they are.
    const ores = newSim({ heard: [whisper('!find copper ore'), whisper('!find tin ore')] });
    const oresBase = deps(open(), ores);
    await runPlay(
      {
        ...oresBase,
        commands: {
          ...(oresBase.commands as CommandDeps),
          gtOres: () => [{ position: { x: 3, y: 60, z: 0 }, ore: 35 }],
        },
      },
      LIMITS,
      noStop,
    );
    expect(said(ores)).toEqual([
      'copper ore: the nearest at 3 60 0, 5 blocks away',
      'I see no tin ore near here (an ore shows its kind only once a face of it is open: !mine digs for it)',
    ]);
    // A word for a block, not its name: "!goto lake" is water.
    const lake = newSim({ heard: [whisper('!goto lake')] });
    const lakeBase = deps(open(), lake);
    const asked: string[][] = [];
    await runPlay(
      {
        ...lakeBase,
        commands: {
          ...(lakeBase.commands as CommandDeps),
          findBlock: (names) => {
            asked.push([...names]);
            return [{ position: { x: 3, y: 63, z: 0 }, distance: 2.6 }];
          },
        },
      },
      LIMITS,
      noStop,
    );
    expect(asked[0]).toEqual(['minecraft:water', 'minecraft:flowing_water']);
    expect(said(lake)[0]).toBe('OK: going to the minecraft:water at 3 63 0');
    // With no such block in view or remembered, and no waypoint of that name: it says so.
    const none = newSim({ heard: [whisper('!goto anvil')] });
    const noneBase = deps(open(), none);
    await runPlay(
      {
        ...noneBase,
        commands: { ...(noneBase.commands as CommandDeps), findBlock: () => [] },
      },
      LIMITS,
      noStop,
    );
    expect(said(none)).toEqual([
      'Failed: I know no waypoint anvil, and I see no anvil near here: say !waypoints',
    ]);
  });

  it('goes up to the surface: a cell found as it begins, then a walk there (Baritone #surface)', async () => {
    const sim = newSim({ heard: [whisper('!surface')], position: { x: 0.5, y: 50, z: 0.5 } });
    let looked = 0;
    const base = deps(open(), sim);
    await runPlay(
      {
        ...base,
        commands: {
          ...(base.commands as CommandDeps),
          surface: () => {
            looked += 1;
            return { point: { x: 3.5, y: 64, z: 0.5 }, here: false };
          },
        },
      },
      LIMITS,
      noStop,
    );
    expect(said(sim)).toEqual(['OK: going up to open sky at 3 64 0', 'Done: under open sky']);
    expect(sim.steps).toEqual(['MOVE_TO 3.5 0.5']);
    expect(looked).toBe(1); // fixed when it began
    // Under open sky already: it says so.
    const there = newSim({ heard: [whisper('!surface')], position: { x: 3.5, y: 64, z: 0.5 } });
    const thereBase = deps(open(), there);
    await runPlay(
      {
        ...thereBase,
        commands: {
          ...(thereBase.commands as CommandDeps),
          surface: () => ({ point: { x: 3.5, y: 64, z: 0.5 }, here: true }),
        },
      },
      LIMITS,
      noStop,
    );
    expect(said(there)).toEqual(['OK: under open sky already', 'Done: under open sky']);
    const none = newSim({ heard: [whisper('!top')] });
    await runPlay(deps(open(), none), LIMITS, noStop);
    expect(said(none)).toEqual(['Failed: I cannot look for the surface here']);
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

  it('walled in with no way out code can plan: an owner command goes first (it may be the way out)', async () => {
    // Seen live 2026-10-04: at the bottom of a shaft it dug, play ended every round before
    // the command round, a busy loop at 100% CPU, and "!surface" waited forever.
    const repos = open();
    const sim = newSim({ heard: [whisper('!come')] });
    await runPlay(
      deps(repos, sim, {
        time: () => Promise.resolve(worldTime(1_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit' as const,
            sheltered: false,
            steps: [],
            needs: {},
            problem: 'no open ground beyond the wall',
            walled: true,
            exit: [],
          }),
      }),
      LIMITS,
      noStop,
    );
    expect(said(sim)).toEqual(['OK: coming to you', 'Done: here, 1 block from you']);
    // A command given at night waits for the morning: seen, still queued, it goes first too.
    const night = newSim({ heard: [whisper('!come')], time: worldTime(18_000, true) });
    night.onSleep = () => {
      night.time = worldTime(1_000, true);
    };
    await runPlay(
      deps(open(), night, {
        time: () => Promise.resolve(night.time ?? worldTime(1_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit' as const,
            sheltered: (night.time?.phase ?? 'day') === 'night',
            steps: [],
            needs: {},
            problem: 'no open ground beyond the wall',
            walled: true,
            exit: [],
          }),
      }),
      LIMITS,
      noStop,
    );
    expect(said(night)).toEqual([
      'It is night: I stay in my shelter until morning, then I come to you',
      'OK: coming to you',
      'Done: here, 1 block from you',
    ]);
  });

  it('strip-mines for a GregTech ore none of which is in view: stairs down to its veins, then a tunnel', async () => {
    const repos = open();
    const sim = newSim({
      heard: [whisper('!mine 2 copper ore')],
      gain: { 'gregtech:gt.metaitem.03@5035': 1 },
    });
    const requests: TunnelRequest[] = [];
    const STEP = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
    const tunnel = (req: TunnelRequest): Promise<TunnelPlan> => {
      requests.push(req);
      const [dx, dz] = STEP[req.direction];
      const fx = Math.floor(sim.position.x);
      const fz = Math.floor(sim.position.z);
      const done = (fx - req.start.x) * dx + (fz - req.start.z) * dz;
      if (done >= req.length) {
        return Promise.resolve({ ok: true, done: req.length, steps: [], problem: null });
      }
      const down = req.slope === 'down' ? done + 1 : 0;
      const target = {
        x: req.start.x + dx * (done + 1) + 0.5,
        y: req.start.y - down,
        z: req.start.z + dz * (done + 1) + 0.5,
      };
      return Promise.resolve({
        ok: true,
        done,
        steps: [
          {
            spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } },
            text: `step into the next cell`,
          },
        ],
        problem: null,
      });
    };
    // A copper ore shows in the wall once the tunnel is 3 cells past the stairs.
    const base = deps(repos, sim, { tunnel });
    const commands: CommandDeps = {
      ...(base.commands as CommandDeps),
      gtOres: () =>
        sim.position.y <= 58 && Math.abs(sim.position.z) >= 9
          ? [{ position: { x: 1, y: 58, z: Math.floor(sim.position.z) }, ore: 35 }]
          : [],
    };
    await runPlay({ ...base, commands }, LIMITS, noStop);
    expect(said(sim)[0]).toBe(
      'OK: mining gregtech:gt.blockores until I have 2 gregtech:gt.metaitem.03@5035 (I have 0)',
    );
    // Copper's veins lie at y 5-60: 58 is the highest of them under the feet (64).
    expect(said(sim)[1]).toBe(
      'No copper ore in view: I dig stairs down to y 58, then tunnels north until some shows',
    );
    expect(requests[0]).toMatchObject({ direction: 'north', slope: 'down', length: 6 });
    expect(requests.some((r) => r.slope === 'level' && r.start.y === 58)).toBe(true);
    // The fake gains one a cycle: the second cycle's GATHER of the ore in view makes 3.
    expect(said(sim).at(-1)).toMatch(/^Done: I have [23] gregtech:gt.metaitem.03@5035$/);
  });

  it('a restart of play resumes the strip mine where it was: the same level, its cells counted', async () => {
    // An independent review found a restart chose a level 6 deeper and began the count again.
    const repos = open();
    const sim = newSim({ heard: [whisper('!mine 2 copper ore')] });
    const requests: TunnelRequest[] = [];
    const base = deps(repos, sim, { tunnel: stripTunnel(sim, requests) });
    const play = { ...base, commands: { ...(base.commands as CommandDeps), gtOres: () => [] } };
    await runPlay(play, LIMITS, {
      stopRequested: () => (requests.length >= 3 ? 'a restart' : null),
    });
    const before = requests.length;
    await runPlay(play, LIMITS, {
      stopRequested: () => (requests.length >= before + 3 ? 'stop' : null),
    });
    expect(requests.length).toBeGreaterThan(before);
    expect(said(sim).filter((l) => l.startsWith('No copper ore in view'))).toHaveLength(1);
    expect(requests.every((r) => r.slope === 'down' && r.start.y === 64 && r.length === 6)).toBe(
      true,
    );
  });

  it('an ore in view is not passed over when its session is cut short', async () => {
    // The review: an owner's !status ended the session with no cycle, and the ore in view was
    // given up for a new strip mine.
    const repos = open();
    const sim = newSim({
      heard: [whisper('!mine 2 copper ore')],
      gain: { 'gregtech:gt.metaitem.03@5035': 1 },
    });
    const requests: TunnelRequest[] = [];
    const base = deps(repos, sim, { tunnel: stripTunnel(sim, requests) });
    let sessions = 0;
    await runPlay(
      {
        ...base,
        commands: {
          ...(base.commands as CommandDeps),
          gtOres: () => [{ position: { x: 1, y: 64, z: 0 }, ore: 35 }],
        },
        session: (limits, hooks) => {
          sessions += 1;
          if (sessions > 1) return base.session(limits, hooks);
          return Promise.resolve({
            cycles: [],
            stopReason: 'cut short',
            stopKind: 'non-task-decision',
            taskId: 'command-1',
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      LIMITS,
      noStop,
    );
    expect(requests).toEqual([]);
    expect(said(sim).at(-1)).toMatch(/^Done: I have [23] gregtech:gt.metaitem.03@5035$/);
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

    // A retreat from a mob that fails (no way home) interrupts it; it goes on after (seen live:
    // a stairs command failed with 0 blocks dug).
    const fled = newSim({ heard: [whisper('!tunnel east 2')] });
    const fledTunnel = (req: TunnelRequest): Promise<TunnelPlan> => {
      const done = Math.floor(fled.position.x) - req.start.x;
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
    const fledBase = deps(open(), fled, { tunnel: fledTunnel });
    let retreated = false;
    await runPlay(
      {
        ...fledBase,
        session: (limits, hooks) => {
          if (retreated) return fledBase.session(limits, hooks);
          retreated = true;
          hooks.onCycle(
            {
              summary: 'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> failed',
              status: 'failed',
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
          return Promise.resolve({
            cycles: [
              { cycleId: 'c1', summary: 'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> failed' },
            ],
            stopReason: 'stopped after: RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> failed',
            stopKind: 'cycle-failed',
            taskId: 'command-1',
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      LIMITS,
      noStop,
    );
    expect(retreated).toBe(true);
    expect(said(fled).at(-1)).toBe('Done: dug a tunnel 2 blocks east');
    expect(fled.steps).toEqual(['MOVE_TO 1.5 0.5', 'MOVE_TO 2.5 0.5']);

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

  it('digs stairs down the way it picks when the owner names none ("dig down"), or says why none', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!tunnel down 2')] });
    const tried: string[] = [];
    const tunnel = (req: TunnelRequest): Promise<TunnelPlan> => {
      tried.push(req.direction);
      if (req.direction === 'north') {
        return Promise.resolve({ ok: true, done: 0, steps: [], problem: 'lava ahead' });
      }
      if (req.direction !== 'east') return Promise.resolve({ ok: false, reason: 'not this way' });
      const done = Math.floor(sim.position.x) - req.start.x;
      if (done >= req.length) {
        return Promise.resolve({ ok: true, done: req.length, steps: [], problem: null });
      }
      const x = req.start.x + done + 1;
      const target = { x: x + 0.5, y: req.start.y - done - 1, z: req.start.z + 0.5 };
      return Promise.resolve({
        ok: true,
        done,
        steps: [{ spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } }, text: 'step' }],
        problem: null,
      });
    };
    await runPlay(deps(repos, sim, { tunnel }), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: digging stairs 2 blocks down from 0 64 0',
      'I dig stairs 2 blocks down, going east',
      'Done: dug stairs 2 blocks down, going east',
    ]);
    // North first (no room known), then east; east from then on, never asked again.
    expect(tried.slice(0, 2)).toEqual(['north', 'east']);
    expect(tried.slice(2).every((d) => d === 'east')).toBe(true);

    const walled = newSim({ heard: [whisper('!tunnel')] });
    await runPlay(
      deps(open(), walled, {
        tunnel: (req) =>
          Promise.resolve({ ok: true, done: 0, steps: [], problem: `${req.direction} is lava` }),
      }),
      LIMITS,
      noStop,
    );
    expect(said(walled).at(-1)).toBe(
      'Failed: no way may be dug (north: north is lava; east: east is lava; south: south is lava; west: west is lava)',
    );
  });

  it('tries a dig step a hostile stopped again; three in a row fail it, in the walk’s own words', async () => {
    // Seen live 2026-10-04: a Mirage Enderman 4 blocks off stopped the stairs' first step, and
    // the command failed at once with "MOVE_TO -> failed".
    const walkStopped =
      'walk stopped after 5 of 11 steps: hostile entity SpecialMobs.MirageEnderman 4.0 blocks away';
    const run = async (failures: number): Promise<Sim> => {
      const sim = newSim({ heard: [whisper('!tunnel east 2')] });
      const tunnel = (req: TunnelRequest): Promise<TunnelPlan> => {
        const done = Math.floor(sim.position.x) - req.start.x;
        if (done >= req.length) {
          return Promise.resolve({ ok: true, done: req.length, steps: [], problem: null });
        }
        const x = req.start.x + done + 1;
        const target = { x: x + 0.5, y: req.start.y, z: req.start.z + 0.5 };
        return Promise.resolve({
          ok: true,
          done,
          steps: [{ spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } }, text: 'step' }],
          problem: null,
        });
      };
      const base = deps(open(), sim, { tunnel });
      let failed = 0;
      await runPlay(
        {
          ...base,
          session: (limits, hooks) => {
            if (failed >= failures) return base.session(limits, hooks);
            failed += 1;
            hooks.onCycle(
              {
                summary: 'EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed',
                status: 'failed',
                decision: {
                  decision: 'EXECUTE_KNOWN_SAFE_STEP',
                  confidence: 0.95,
                  reasonCodes: ['KNOWN_SAFE_STEP'],
                  factsUsed: {},
                  requiresHumanConfirmation: false,
                  provider: 'test',
                },
                outcome: { execution: { ok: false, message: walkStopped }, stateAfter: null },
              } as unknown as CycleResult,
              1,
            );
            return Promise.resolve({
              cycles: [{ cycleId: 'c1', summary: 'EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed' }],
              stopReason: 'stopped after: EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> failed',
              stopKind: 'cycle-failed',
              taskId: 'command-1',
              taskStatus: 'active',
              elapsedMs: 1,
            });
          },
        },
        LIMITS,
        noStop,
      );
      return sim;
    };
    const once = await run(1);
    expect(said(once).at(-1)).toBe('Done: dug a tunnel 2 blocks east');
    const thrice = await run(3);
    expect(said(thrice).at(-1)).toBe(`Failed: ${walkStopped} (0 of 2 blocks dug)`);
  });

  it('turns where the way it picked is blocked, from where it got to, for the rest of the length', async () => {
    const repos = open();
    const sim = newSim({ heard: [whisper('!tunnel down 3')] });
    const STEPS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
    const requests: TunnelRequest[] = [];
    // From where it starts: north is lava at once, east has sand over its second cell, south
    // and west may not be dug. From the end of east's first cell, north is clear.
    const cellsOpen = (req: TunnelRequest): number | null => {
      const fromStart = req.start.x === 0 && req.start.z === 0;
      if (req.direction === 'east' && fromStart) return 1;
      if (req.direction === 'north') return fromStart ? 0 : Infinity;
      return null;
    };
    const tunnel = (req: TunnelRequest): Promise<TunnelPlan> => {
      requests.push(req);
      const open = cellsOpen(req);
      if (open === null) return Promise.resolve({ ok: false, reason: 'not this way' });
      const [dx, dz] = STEPS[req.direction];
      const p = sim.position;
      const done = Math.max(
        0,
        (Math.floor(p.x) - req.start.x) * dx + (Math.floor(p.z) - req.start.z) * dz,
      );
      if (done >= req.length) {
        return Promise.resolve({ ok: true, done: req.length, steps: [], problem: null });
      }
      const blocked = done >= open ? 'sand above would fall into the hole' : null;
      if (blocked !== null) return Promise.resolve({ ok: true, done, steps: [], problem: blocked });
      const k = done + 1;
      const target = {
        x: req.start.x + k * dx + 0.5,
        y: req.start.y - k,
        z: req.start.z + k * dz + 0.5,
      };
      return Promise.resolve({
        ok: true,
        done,
        steps: [{ spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } }, text: 'step' }],
        problem: k >= open ? 'sand above would fall into the hole' : null,
      });
    };
    await runPlay(deps(repos, sim, { tunnel }), LIMITS, noStop);
    expect(said(sim)).toEqual([
      'OK: digging stairs 3 blocks down from 0 64 0',
      'I dig stairs 3 blocks down, going east',
      'sand above would fall into the hole: I turn north (1 of 3 blocks dug)',
      'Done: dug stairs 3 blocks down',
    ]);
    expect(sim.steps).toEqual(['MOVE_TO 1.5 0.5', 'MOVE_TO 1.5 -0.5', 'MOVE_TO 1.5 -1.5']);
    // The second leg: from where the first ended, the 2 blocks left, never east or west again.
    const second = requests.filter((r) => r.start.x === 1);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((r) => r.direction === 'north' || r.direction === 'south')).toBe(true);
    expect(second.every((r) => r.length === 2 && r.start.y === 63)).toBe(true);
    expect(repos.tasks.get('command-1')?.status).toBe('completed');

    // The way it turned to, blocked before a cell was dug (the world changed): it never goes
    // back along the leg before (west), and with no other way it says why.
    const later = newSim({ heard: [whisper('!tunnel down 3')] });
    const asked: TunnelRequest[] = [];
    let northPicked = false;
    const changing = (req: TunnelRequest): Promise<TunnelPlan> => {
      asked.push(req);
      const turned = req.start.x === 1;
      if (turned && req.direction === 'north' && northPicked) {
        return Promise.resolve({ ok: true, done: 0, steps: [], problem: 'gravel fell in' });
      }
      if (turned && req.direction === 'north') northPicked = true;
      if (turned && req.direction === 'east') {
        return Promise.resolve({ ok: true, done: 0, steps: [], problem: 'still sand' });
      }
      return tunnelOf(later, req);
    };
    const tunnelOf = (s: Sim, req: TunnelRequest): Promise<TunnelPlan> => {
      const open = cellsOpen(req);
      if (open === null) return Promise.resolve({ ok: false, reason: 'not this way' });
      const [dx, dz] = STEPS[req.direction];
      const done = Math.max(
        0,
        (Math.floor(s.position.x) - req.start.x) * dx +
          (Math.floor(s.position.z) - req.start.z) * dz,
      );
      if (done >= open) {
        return Promise.resolve({ ok: true, done, steps: [], problem: 'sand overhead' });
      }
      const k = done + 1;
      const target = {
        x: req.start.x + k * dx + 0.5,
        y: req.start.y - k,
        z: req.start.z + k * dz + 0.5,
      };
      return Promise.resolve({
        ok: true,
        done,
        steps: [{ spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } }, text: 'step' }],
        problem: k >= open ? 'sand overhead' : null,
      });
    };
    await runPlay(deps(open(), later, { tunnel: changing }), LIMITS, noStop);
    expect(said(later).slice(-2)).toEqual([
      'sand overhead: I turn north (1 of 3 blocks dug)',
      'Failed: gravel fell in (1 of 3 blocks dug)',
    ]);
    expect(asked.some((r) => r.start.x === 1 && r.direction === 'west')).toBe(false);
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

  it('idle, a retreat from a mob that cannot run is waited out offline, not retried', async () => {
    // Seen live: 37 refused retreats in a row from a pit the morning had opened.
    const repos = open();
    const sim = newSim({ heard: [whisper('!pause')] });
    const base = deps(repos, sim, { listen: true });
    let sessions = 0;
    const result = await runPlay(
      {
        ...base,
        commands: {
          ...(base.commands as CommandDeps),
          standby: () =>
            Promise.resolve({ kind: 'reflex', text: 'RETREAT_HOME [HOSTILES_NEARBY]' }),
        },
        session: (_limits, hooks) => {
          sessions += 1;
          hooks.onCycle(
            {
              summary: 'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> rejected [REPEATED_FAILURE]',
              status: 'rejected',
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
          return Promise.resolve({
            cycles: [
              { cycleId: 'c1', summary: 'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> rejected' },
            ],
            stopReason:
              'stopped after: RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> rejected [REPEATED_FAILURE]',
            stopKind: 'cycle-failed',
            taskId: 'owner-standby',
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      LIMITS,
      noStop,
    );
    expect(sessions).toBe(1);
    expect(result.mobNearby).toBe('HOSTILES_NEARBY');
  });

  it('idle, a retreat refused as a repeated failure (a pause) is waited out offline too', async () => {
    const sim = newSim({ heard: [whisper('!pause')] });
    const base = deps(open(), sim, { listen: true });
    let sessions = 0;
    const result = await runPlay(
      {
        ...base,
        commands: {
          ...(base.commands as CommandDeps),
          standby: () =>
            Promise.resolve({ kind: 'reflex', text: 'RETREAT_HOME [HOSTILES_NEARBY]' }),
        },
        session: (_limits, hooks) => {
          sessions += 1;
          hooks.onCycle(
            {
              summary: 'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> rejected [REPEATED_FAILURE]',
              status: 'rejected',
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
          return Promise.resolve({
            cycles: [{ cycleId: 'c1', summary: 'rejected' }],
            stopReason: 'needs attention',
            stopKind: 'needs-attention',
            taskId: 'owner-standby',
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      LIMITS,
      noStop,
    );
    expect(sessions).toBe(1);
    expect(result.mobNearby).toBe('HOSTILES_NEARBY');
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

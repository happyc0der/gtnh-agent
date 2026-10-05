import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep } from '../../../src/app/play/owner-travel.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayEvent,
  type PlayLimits,
} from '../../../src/app/play/play.ts';
import { worldTime } from '../../../src/domain/game-state.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY, NIGHT_SHELTER_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 25, 2026-10-05: the morning refund path (System 1's SHELTERED pause during the way out) now sets
// play.sheltered = { mobs, since: mobWaitSince }. Is it cleared, capped, and is !status right?
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 60,
  maxSessions: 1000,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

function setup(clearAfterMs: number) {
  const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
  repos.memory.setValue(NIGHT_SHELTER_KEY, new Date(0).toISOString());
  const heard: HeardCommand[] = [];
  const replies: string[] = [];
  const events: PlayEvent[] = [];
  const clock = { t: 1_000_000 };
  const start = clock.t;
  let out = false;
  let sessions = 0;
  let stop: string | null = null;
  const roof: ShelterStep = {
    spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
    text: 'dig the roof',
  };
  const commands: CommandDeps = {
    take: () => heard.splice(0),
    waiting: () => heard.length > 0,
    reply: (_to, text) => void replies.push(text),
    clearInterrupt: () => undefined,
    view: () => ({
      position: { x: 0.5, y: 61, z: 0.5 },
      dimension: 'overworld',
      health: 20,
      food: 20,
      inventory: {},
      playerAt: () => null,
    }),
    step: (): TravelStep => ({ kind: 'refused', reason: 'x' }),
    owners: [OWNER],
    homeName: 'home',
    configLocations: new Map(),
    boundary: {
      min: { x: -256, y: 0, z: -256 },
      max: { x: 256, y: 255, z: 256 },
      allowedDimensions: ['overworld'],
    },
  };
  const session: PlayDeps['session'] = (_limits, hooks) => {
    sessions += 1;
    const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
    if (sessions === 2) heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
    if (clock.t - start >= clearAfterMs) {
      // The mob is gone: the way out completes.
      out = true;
      return Promise.resolve({
        cycles: [{ cycleId: 'c', summary: 'dug out' }],
        stopReason: 'task finished',
        stopKind: 'task-finished',
        taskId,
        taskStatus: 'completed',
        elapsedMs: 1,
      } satisfies SessionResult);
    }
    const summary = 'PAUSE_AND_ASK_USER -> PAUSE_AND_ASK_USER -> paused';
    hooks.onCycle(
      {
        summary,
        status: 'paused',
        decision: {
          decision: 'PAUSE_AND_ASK_USER',
          reasonCodes: ['HOSTILES_NEARBY', 'SHELTERED'],
          confidence: 1,
          factsUsed: {},
          requiresHumanConfirmation: true,
          provider: 'test',
        },
        outcome: null,
      } as unknown as CycleResult,
      1,
    );
    clock.t += 2_000;
    return Promise.resolve({
      cycles: [{ cycleId: 'c', summary }],
      stopReason: `needs attention after: ${summary}`,
      stopKind: 'needs-attention',
      taskId,
      taskStatus: 'paused',
      elapsedMs: 1,
    } satisfies SessionResult);
  };
  let afterOut = 0;
  const deps: PlayDeps = {
    repos,
    now: () => clock.t,
    inventory: () => Promise.resolve({}),
    time: () => Promise.resolve(worldTime(1_000, true)), // morning
    shelter: () => {
      if (out) {
        afterOut += 1;
        if (afterOut === 1) heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
        if (afterOut >= 3) stop = 'test over';
      }
      return Promise.resolve({
        kind: 'pit',
        sheltered: !out,
        steps: [],
        needs: {},
        problem: null,
        walled: !out,
        exit: out ? [] : [roof],
        sealed: !out,
        hostiles: null, // the shelter's look sees none; System 1 sees one
      });
    },
    session,
    sleep: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
    commands,
    listen: true,
  };
  return {
    deps,
    replies,
    events,
    clock,
    start,
    sessions: () => sessions,
    hooks: { stopRequested: () => stop, onEvent: (e: PlayEvent) => void events.push(e) },
  };
}

describe('morning refund path', () => {
  it('a hostile that stays: offline after MOB_SHELTER_MAX_MS, !status says why meanwhile', async () => {
    const s = setup(Number.POSITIVE_INFINITY);
    const result = await runPlay(s.deps, LIMITS, s.hooks);
    const nights = s.events
      .filter((e) => e.kind === 'night')
      .map((e) => (e as { message: string }).message);
    expect(result.mobNearby).not.toBeNull();
    // One line as the wait ends at most, not one each pass (review 25: 43 in one wait).
    expect(nights.filter((m) => m.includes('no hostile near any more')).length).toBeLessThanOrEqual(
      1,
    );
    expect(s.replies.find((r) => r.startsWith('at '))).toMatch(
      /staying in my shelter until the hostiles/,
    );
  });

  it('the hostile goes: out, and !status no longer says it stays in its shelter', async () => {
    const s = setup(60_000);
    await runPlay(s.deps, LIMITS, s.hooks);
    const statuses = s.replies.filter((r) => r.startsWith('at '));
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatch(/staying in my shelter until the hostiles/);
    expect(statuses[1]).not.toMatch(/staying in my shelter|sheltered/);
  });
});

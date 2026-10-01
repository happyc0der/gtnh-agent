import { describe, expect, it } from 'vitest';
import { runSingleCycle, syncConfigToDatabase } from '../../src/app/agent-loop.ts';
import { MOCK_CONFIG } from '../../src/app/scenarios.ts';
import {
  readTrail,
  recordTrail,
  TRAIL_KEY,
  TRAIL_LOCATION,
  trailRetreat,
} from '../../src/app/trail.ts';
import { defaultConfig } from '../../src/config/env.ts';
import { NIGHT_SHELTER_TASK_ID } from '../../src/domain/night-shelter.ts';
import { actionFingerprint } from '../../src/safety/safety-policy.ts';
import { DeterministicDecisionProvider } from '../../src/system1/decision-provider.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { makeState, makeWorld, memoryRepos, safetyCtx, testClock } from '../fixtures/index.ts';

const point = (x: number, z: number) => ({ dimension: 'overworld', position: { x, y: 64, z } });
const standing = (x: number, z: number) => ({ x, y: 64, z });

describe('the trail', () => {
  it('records where the player stood out of danger, a point every 4 blocks, newest last', () => {
    const repos = memoryRepos(testClock());
    const ctx = safetyCtx();
    const walk = (x: number, mutate: Parameters<typeof makeState>[0] = () => undefined) =>
      recordTrail(
        repos.memory,
        makeState((w) => {
          w.player.position = standing(x, 1);
          mutate(w);
        }),
        ctx,
      );
    walk(1);
    walk(3); // 2 blocks on: not yet
    walk(6);
    walk(20, (w) => void (w.hostiles = [standing(22, 1)])); // in danger: not recorded
    walk(30, (w) => {
      if (w.task !== null) w.task.taskId = NIGHT_SHELTER_TASK_ID; // a night pit: never
    });
    expect(readTrail(repos.memory).map((p) => p.position.x)).toEqual([1, 6]);
  });

  it('retreats to the newest point back the way the player came, away from the mob', () => {
    const ctx = safetyCtx();
    // The player walked east to (1, 64, 1); a mob is 7 blocks further east.
    const trail = [point(-40, 1), point(-24, 1), point(-12, 1), point(-4, 1)];
    const east = makeState((w) => void (w.hostiles = [standing(8, 1)]));
    // (-4) is too near to be worth the walk; (-12) is 13 blocks back and 20 from the mob.
    expect(trailRetreat(trail, east, ctx)).toMatchObject({
      kind: 'safe',
      position: { x: -12, y: 64, z: 1 },
    });
    // A mob back west, on the trail: going back would walk toward it.
    const west = makeState((w) => void (w.hostiles = [standing(-6, 1)]));
    expect(trailRetreat(trail, west, ctx)).toBeNull();
    // Nothing threatens the player: nothing to retreat from.
    expect(trailRetreat(trail, makeState(), ctx)).toBeNull();
  });

  it('a cycle with a mob near walks back along the trail, not all the way home', async () => {
    const clock = testClock();
    // Home is (0, 64, 0), 60 blocks back; the mob is 7 blocks ahead.
    const { client, world } = makeWorld((w) => {
      w.player.position = standing(60, 1);
      w.hostiles = [standing(67, 1)];
    }, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = defaultConfig(MOCK_CONFIG);
    syncConfigToDatabase(config, repos);
    repos.memory.setValue(TRAIL_KEY, JSON.stringify([point(20, 1), point(48, 1), point(56, 1)]));
    const result = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: null,
      clock,
      newId: sequentialIds(),
    });
    expect(result.decision?.decision).toBe('RETREAT_HOME');
    expect(result.action).toMatchObject({
      type: 'RETURN_TO_SAFE_LOCATION',
      args: { locationName: TRAIL_LOCATION },
    });
    expect(result.status).toBe('succeeded');
    expect(world.player.position).toMatchObject({ x: 48, z: 1 });
  });

  it('goes home instead once two retreats along the trail failed from the same block', async () => {
    const clock = testClock();
    const { client } = makeWorld((w) => {
      w.player.position = standing(60, 1);
      w.hostiles = [standing(67, 1)];
    }, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = defaultConfig(MOCK_CONFIG);
    syncConfigToDatabase(config, repos);
    repos.memory.setValue(TRAIL_KEY, JSON.stringify([point(20, 1), point(48, 1)]));
    const state = await client.observe();
    const fingerprint = actionFingerprint(
      { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: TRAIL_LOCATION } },
      state.player.position.known ? state.player.position.value : null,
    );
    for (const id of ['old-1', 'old-2']) {
      repos.actions.insert({
        actionId: id,
        cycleId: null,
        taskId: state.currentTask?.taskId ?? null,
        actionType: 'RETURN_TO_SAFE_LOCATION',
        origin: 'deterministic-router',
        fingerprint,
        reason: 'an earlier retreat',
        action: {},
        status: 'failed',
        validation: { ok: true },
      });
    }
    const result = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: null,
      clock,
      newId: sequentialIds(),
    });
    expect(result.action).toMatchObject({
      type: 'RETURN_TO_SAFE_LOCATION',
      args: { locationName: 'home' },
    });
  });
});

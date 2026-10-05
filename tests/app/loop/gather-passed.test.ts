import { describe, expect, it } from 'vitest';
import {
  GATHER_PASSED_FOR_MS,
  gatherTurn,
  type GatherRef,
} from '../../../src/app/loop/gather-step.ts';
import { GATHER_MAX_MS, type GatherStep } from '../../../src/planner/gather.ts';
import { makeState, memoryRepos, safetyCtx, T0 } from '../../fixtures/index.ts';

// A GATHER's places passed over outlast its step: a checkpoint or a new plan used to forget
// them, and the next step went back to places dug out already (an independent review,
// 2026-10-05: the "get me 4 logs" ping-pong, once per checkpoint).
const LOGS: GatherStep = { type: 'GATHER', args: { block: 'minecraft:log', count: 8 } };
const A = { x: 1, y: 64, z: 1 }; // the bot stands here: its trees were dug
const B = { x: 60, y: 64, z: 1 }; // 59 blocks east: dug too
const ref = (planId: number): GatherRef => ({
  taskId: 'command-1',
  planId,
  stepIndex: 0,
  gather: LOGS,
});
const standing = (p: { x: number; z: number }) =>
  makeState((w) => {
    w.player.position = { x: p.x + 0.5, y: 64, z: p.z + 0.5 };
    w.resourceBlocks = [];
  });
const placesFrom = (p: { x: number; z: number }) =>
  [A, B]
    .map((q) => ({ ...q, distance: Math.hypot(q.x - p.x, q.z - p.z) }))
    .sort((a, b) => a.distance - b.distance);

describe("a GATHER's places passed over, across its task's plans", () => {
  it('a new plan does not go back to a place the last step passed over', () => {
    const repos = memoryRepos();
    const ctx = safetyCtx(undefined, new Date(T0));
    // Plan 1 at A: A passed (stood by, none in view), on to B.
    expect(gatherTurn(repos, ref(1), standing(A), ctx, placesFrom(A))).toMatchObject({
      kind: 'act',
      travel: true,
      target: B,
    });
    // At B: B passed too, nothing left: the step ends.
    expect(gatherTurn(repos, ref(1), standing(B), ctx, placesFrom(B))).toMatchObject({
      kind: 'end',
      end: 'no-target',
    });
    // Plan 2: not back to A, 59 blocks off.
    expect(gatherTurn(repos, ref(2), standing(B), ctx, placesFrom(B))).toMatchObject({
      kind: 'end',
      end: 'no-target',
    });
  });

  it('a checkpoint does not forget them either; after GATHER_PASSED_FOR_MS they may be tried again', () => {
    const repos = memoryRepos();
    const t0 = new Date(T0);
    expect(
      gatherTurn(repos, ref(1), standing(A), safetyCtx(undefined, t0), placesFrom(A)),
    ).toMatchObject({ kind: 'act', travel: true, target: B });
    const late = new Date(t0.getTime() + GATHER_MAX_MS);
    expect(
      gatherTurn(repos, ref(1), standing(B), safetyCtx(undefined, late), placesFrom(B)),
    ).toMatchObject({ kind: 'end', end: 'bound' });
    // Plan 2 at B: A passed over (the task remembers), B stood by: nothing left.
    expect(
      gatherTurn(repos, ref(2), standing(B), safetyCtx(undefined, late), placesFrom(B)),
    ).toMatchObject({ kind: 'end', end: 'no-target' });
    // Much later (trees may have grown again): A is a place to go once more.
    const later = new Date(late.getTime() + GATHER_PASSED_FOR_MS + 1_000);
    expect(
      gatherTurn(repos, ref(3), standing(B), safetyCtx(undefined, later), placesFrom(B)),
    ).toMatchObject({ kind: 'act', travel: true, target: A });
  });
});

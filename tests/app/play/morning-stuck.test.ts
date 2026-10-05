import { describe, expect, it } from 'vitest';
import { liveShelter } from '../../../src/app/play/live-play.ts';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import type { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import {
  OUT_FREE_DISTANCE,
  OUT_FREE_WALK,
  planNightPit,
  planShelterExit,
  walledIn,
  type PitOptions,
} from '../../../src/bot/gtnh1710/night-pit.ts';
import { walksAway } from '../../../src/bot/gtnh1710/terrain.ts';
import type { Fence, Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { NIGHT_PIT_KEY, NIGHT_SHELTER_KEY } from '../../../src/persistence/memory-repository.ts';
import { makeState, memoryRepos, testConfig } from '../../fixtures/index.ts';

// The morning's way out stopped short (seen live 2026-10-05): a drop's walk broke the staircase
// block the next known DIG_BLOCK would dig, and left the player on the first step, out of the
// pit's column with one side open. That read as out (an independent review, 2026-10-05): the
// way out closed while no walk that breaks nothing could leave.
const ID = { air: 0, stone: 1, grass: 2, dirt: 3 } as const;
const NAMES = new Map<number, string>([
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.dirt, 'minecraft:dirt'],
]);
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
function land(changes: Map<string, number>): WalkWorld {
  return {
    blockAt(x, y, z) {
      const o = changes.get(key(x, y, z));
      if (o !== undefined) return o;
      if (y === 63) return ID.grass;
      if (y >= 60 && y < 63) return ID.dirt;
      return y < 60 ? ID.stone : ID.air;
    },
    blockName: (id) => (id === 0 ? undefined : NAMES.get(id)),
    hazardCode: (id) => (id === 0 || NAMES.has(id) ? BLOCK_CODE.safe : BLOCK_CODE.unknown),
  };
}
const FENCE: Fence = { min: { x: -20, y: 40, z: -20 }, max: { x: 20, y: 90, z: 20 } };
const OPTS: PitOptions = { area: { fence: FENCE, maxHeightAboveFence: 4 }, maxPathLength: 64 };

describe('the morning way out stopped short on its first step', () => {
  it('is not out yet: the rest of the staircase is planned, and the pit kept', async () => {
    const changes = new Map<string, number>();
    const pit = planNightPit(
      land(changes),
      { x: 0.5, y: 64, z: 0.5 },
      { 'minecraft:dirt': 4 },
      OPTS,
    );
    if (!pit.ok) throw new Error(pit.reason);
    const site = pit.site; // {x: 0, z: 0, groundY: 63}
    // The night: the pit dug, the roof in place.
    for (const s of pit.steps) {
      if (s.spec.type === 'DIG_DOWN') {
        const p = s.spec.args.position;
        changes.set(key(p.x, p.y, p.z), ID.air);
      }
      if (s.spec.type === 'PLACE_BLOCK') {
        const p = s.spec.args.position;
        changes.set(key(p.x, p.y, p.z), ID.dirt);
      }
    }
    const bottom: Vec3 = { x: 0.5, y: site.groundY - 2, z: 0.5 };
    const exit = planShelterExit(land(changes), bottom, OPTS, site.groundY);
    if (!exit.ok) throw new Error(exit.reason);
    const digs = exit.steps.flatMap((s) =>
      s.spec.type === 'DIG_BLOCK' ? [s.spec.args.position] : [],
    );
    expect(digs.length).toBeGreaterThanOrEqual(4); // the roof, step 1 (upper, lower), step 2...
    // The morning: the roof and step 1's upper block dug; the drop's walk breaks step 1's lower
    // block (the next known step: then refused NOT_DIGGABLE) and stands the player on it.
    const [roof, upper, lower] = digs as [Vec3, Vec3, Vec3];
    for (const p of [roof, upper, lower]) changes.set(key(p.x, p.y, p.z), ID.air);
    const feet: Vec3 = { x: lower.x + 0.5, y: lower.y, z: lower.z + 0.5 };
    const world = land(changes);
    expect(feet.y).toBe(site.groundY - 1); // a block below the ground layer, two below its top
    expect(walledIn(world, feet)).toBe(false); // the pit's side is open
    // No retreat, flee or drop walk (they break nothing) gets out of there...
    expect(walksAway(world, FENCE, feet, OUT_FREE_DISTANCE, OUT_FREE_WALK)).toBe(false);
    // ...and the rest of the staircase could still be planned from where it stands.
    expect(planShelterExit(world, feet, OPTS, site.groundY).ok).toBe(true);

    // liveShelter('morning') and morningRound, as live play runs them.
    const repos = memoryRepos();
    repos.memory.setValue(NIGHT_SHELTER_KEY, '2026-10-05T04:00:00.000Z');
    repos.memory.setValue(NIGHT_PIT_KEY, JSON.stringify(site));
    repos.tasks.ensure({ id: 'leave-shelter', goal: 'g', subgoal: 's', status: 'active' });
    const state = makeState((w) => {
      w.player.position = { ...feet };
    });
    const client = {
      observe: () => Promise.resolve(state),
      world: { walkWorld: () => world, ownPosition: feet },
      currentFence: () => FENCE,
      walkOptions: () => null,
    } as unknown as Gtnh1710Client;
    const shelter = liveShelter(client, testConfig(), repos);
    const status = await shelter('morning');
    expect(status?.walled).toBe(true);
    expect(status?.exit.length).toBeGreaterThan(0);
    expect(repos.memory.getValue(NIGHT_PIT_KEY)).not.toBeNull();
  });
});

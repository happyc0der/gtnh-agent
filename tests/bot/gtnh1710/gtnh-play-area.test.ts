import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  explore,
  explorerHarness,
  FEET_Y,
  moveTo,
  perform,
  positionOf,
  SPAWN,
} from './explore-world.ts';

const harness = explorerHarness();
beforeEach(harness.setup);
afterEach(harness.cleanup);

// Walks take real time (4 blocks a second), and the test files run side by side.
describe('the play area follows the player (movement mode follow)', { timeout: 30_000 }, () => {
  it('walks only inside the window around the player, which moves with it', async () => {
    const { client } = await harness.start();
    // 11 blocks north: outside the 16-block window centred on the player.
    const far = await perform(client, moveTo(SPAWN.x, 9.5));
    expect(far).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(far.message).toMatch(/outside the movement fence/);
    // Halfway first; then the same target is inside the new window.
    expect(await perform(client, moveTo(SPAWN.x, 14.5))).toMatchObject({ ok: true });
    expect(await perform(client, moveTo(SPAWN.x, 9.5))).toMatchObject({ ok: true });
    expect(await positionOf(client)).toEqual({ x: SPAWN.x, y: FEET_Y, z: 9.5 });
  });

  it('never leaves the exploration boundary: the window is clipped to it', async () => {
    const { client } = await harness.start();
    expect(await perform(client, moveTo(24.5, SPAWN.z))).toMatchObject({ ok: true });
    // The window around x 24 would reach x 17, but x 20 is the boundary's edge.
    const r = await perform(client, moveTo(19.5, SPAWN.z));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/outside the movement fence/);
    expect(await perform(client, moveTo(20.5, SPAWN.z))).toMatchObject({ ok: true });
  });

  it('a fixed fence works exactly as before, and EXPLORE is refused with it', async () => {
    const { client } = await harness.start({
      movement: {
        mode: 'fixed',
        fence: { min: { x: 26, y: FEET_Y, z: 16 }, max: { x: 35, y: FEET_Y + 2, z: 25 } },
      },
    });
    expect(await perform(client, explore('south', 16))).toMatchObject({
      ok: false,
      code: 'REFUSED',
      message: expect.stringMatching(/does not follow the player/) as string,
    });
    expect(await perform(client, moveTo(33.5, 23.5))).toMatchObject({ ok: true });
    // Inside the follow window's reach, but outside the fixed fence.
    expect((await perform(client, moveTo(36.5, 23.5))).message).toMatch(
      /outside the movement fence/,
    );
  });

  it('without the exploration boundary, the follow mode walks nowhere', async () => {
    const { client, server } = await harness.start({ boundary: false });
    expect((await perform(client, moveTo(31.5, 21.5))).message).toMatch(
      /needs the exploration boundary/,
    );
    expect(server.walkSteps()).toHaveLength(0);
  });
});

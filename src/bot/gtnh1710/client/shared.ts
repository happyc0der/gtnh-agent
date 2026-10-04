import { failed, type ClientActionResult } from '../../minecraft-client.ts';
import type { Vec3 } from '../walking.ts';

/**
 * Constants and helpers that several parts of the client use (the modules in this folder, which
 * gtnh-client.ts's Gtnh1710Client puts together).
 */

/** Walking sends one position per tick. */
export const WALK_TICK_MS = 50;
/** After the last step, ticks to wait for a server correction before calling a walk done. */
export const SETTLE_TICKS = 5;
/** How long to wait for a chest or crafting table window, and for the server's verdict on one click. */
export const WINDOW_OPEN_TIMEOUT_MS = 3_000;
export const CLICK_TIMEOUT_MS = 3_000;
/** How long the drop may take to reach the inventory: a 10-tick pickup delay, plus falling. */
export const DROP_WAIT_MS = 2_000;
/**
 * Reported with every presence and walking packet. The walker only ever stands or walks on
 * a full block (never jumps or falls), so the player is always on the ground.
 */
export const ON_GROUND = true;

/**
 * A walk's stop for a hostile, in walkInterruption's words (movement-actions.ts). Such a stop
 * is marked (data.threat) in the walk's result: the way was not at fault, and the policy's
 * repeated-failure count leaves it out (persistence/repositories.ts NOT_THREAT).
 */
export const THREAT_STOP = /\b(?:hostile|unclassified) entity \S+ [\d.]+ blocks away\b/;

/** "2 x minecraft:sand, 1 x minecraft:flint" (at most 200 characters). */
export function describeGain(gained: ReadonlyArray<[string, number]>): string {
  return gained
    .map(([item, n]) => `${n} x ${item}`)
    .join(', ')
    .slice(0, 200);
}

/** Yaw and pitch (degrees, Minecraft's convention) from the eyes to a point. */
export function lookAt(eyes: Vec3, point: Vec3): { yaw: number; pitch: number } {
  const dx = point.x - eyes.x;
  const dy = point.y - eyes.y;
  const dz = point.z - eyes.z;
  return {
    yaw: (Math.atan2(-dx, dz) * 180) / Math.PI,
    pitch: (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A failure whose message fits a client result (at most 500 characters). */
export function craftFailed(
  message: string,
  code: 'FAILED' | 'REFUSED' | 'ERROR',
  data: ClientActionResult['data'],
): ClientActionResult {
  return failed(message.length > 500 ? `${message.slice(0, 497)}...` : message, code, data);
}

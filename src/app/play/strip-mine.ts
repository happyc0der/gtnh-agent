import type { BlockPosition } from '../../domain/common.ts';
import type { TunnelDirection, TunnelSlope } from '../../domain/owner-commands.ts';

/**
 * Strip mining, for an owner's `!mine` of a GregTech ore with none of it in view (the idea of
 * Baritone's legitMine, written anew: no code was taken from Baritone, LGPL-3.0): stairs down
 * to a height where veins of its material lie, then straight tunnels one wide and two high,
 * turning where a tunnel may not go on, until an ore of that material shows in the walls.
 * GregTech tells a client an ore's material once a face of it is open, so the tunnel is how
 * the bot looks: no x-ray. Pure: the legs to dig; commands.ts runs each as a tunnel
 * (tunnel.ts planTunnel) and digs what shows with GATHER.
 */

/** Cells one straight leg of the strip mine digs before it is planned again from there. */
export const STRIP_LEG = 32;
/** Cells of tunnel (stairs included) a strip mine digs, at most, before it gives up. */
export const STRIP_MAX = 256;
/** Turns in a row with no cell dug between them, at most: then every way is blocked. */
/** A strip mine tunnels at least this far below the feet it starts from: under the ground. */
export const STRIP_BELOW = 6;
export const STRIP_MAX_TURNS = 4;

/** A vein of GregTech ore, as far as the strip mine cares: its heights and its weight. */
export interface VeinRange {
  minY: number;
  maxY: number;
  weight: number;
}

/** One straight run of the strip mine: stairs down, or a level tunnel. */
export interface StripLeg {
  /** The feet block the leg starts from (where the player stood). */
  start: BlockPosition;
  direction: TunnelDirection;
  slope: TunnelSlope;
  /** Cells it digs. */
  length: number;
}

export interface StripState {
  /** The feet height it tunnels at. */
  level: number;
  leg: StripLeg;
  /** Cells dug by the legs before this one. */
  dug: number;
  /** Turns in a row with no cell dug between them. */
  turns: number;
}

/**
 * The feet height to tunnel at: within the most veins of the material, by their weight (a
 * vein's weight is how often GregTech picks it), at least STRIP_BELOW under the feet (in the
 * ground, not along its top) and no lower than `lowest` (the safety boundary); of equal ones
 * the highest (the least digging down). Null when no vein lies in that range.
 */
export function stripLevel(
  veins: readonly VeinRange[],
  feetY: number,
  lowest: number,
): number | null {
  let best: { y: number; score: number } | null = null;
  for (let y = feetY - STRIP_BELOW; y >= lowest; y--) {
    let score = 0;
    for (const v of veins) if (y >= v.minY && y <= v.maxY) score += Math.max(1, v.weight);
    if (score > 0 && (best === null || score > best.score)) best = { y, score };
  }
  return best?.y ?? null;
}

/** The first leg from the feet: stairs down to the level, or a level tunnel there. */
export function firstLeg(feet: BlockPosition, level: number, direction: TunnelDirection): StripLeg {
  return feet.y > level
    ? { start: { ...feet }, direction, slope: 'down', length: feet.y - level }
    : { start: { ...feet }, direction, slope: 'level', length: STRIP_LEG };
}

const CLOCKWISE: Readonly<Record<TunnelDirection, TunnelDirection>> = {
  north: 'east',
  east: 'south',
  south: 'west',
  west: 'north',
};

/**
 * The strip mine after a leg: `done` cells of it dug, and the feet where they are now. A leg
 * dug to its end goes on the same way (stairs that reached the level become a level tunnel);
 * a leg that could go no further turns clockwise from the feet (stairs again while above the
 * level). Turns in a row count only while no cell was dug since the last one.
 */
export function nextLeg(
  state: StripState,
  feet: BlockPosition,
  done: number,
  blocked: boolean,
): StripState {
  const dug = state.dug + Math.max(0, done);
  const direction = blocked ? CLOCKWISE[state.leg.direction] : state.leg.direction;
  return {
    level: state.level,
    leg: firstLeg(feet, state.level, direction),
    dug,
    turns: blocked ? (done > 0 ? 1 : state.turns + 1) : 0,
  };
}

/**
 * The way to start digging: of north, south, east and west, the one with the most room left
 * to the safety boundary (world memory's summary `room`); north when none is known.
 */
export function stripDirection(room: (d: TunnelDirection) => number | undefined): TunnelDirection {
  return waysByRoom(room)[0] ?? 'north';
}

/**
 * North, east, south and west, the most room left to the safety boundary first (world
 * memory's summary `room`), those with none known last: the order a tunnel whose owner named
 * no way tries them in.
 */
export function waysByRoom(room: (d: TunnelDirection) => number | undefined): TunnelDirection[] {
  const ways = ['north', 'east', 'south', 'west'] as const;
  const known = ways.filter((d) => room(d) !== undefined);
  // A stable sort: ties keep the order above.
  known.sort((a, b) => (room(b) as number) - (room(a) as number));
  return [...known, ...ways.filter((d) => room(d) === undefined)];
}

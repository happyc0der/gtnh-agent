import type { ExploreToward } from '../../../domain/actions.ts';
import type { Position } from '../../../domain/common.ts';
import { mergeSeen, type SeenChunk } from '../../../domain/world-memory.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import { ARRIVED, chooseHop, exploreGoal } from '../explore.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { fenceHolds } from '../play-area.ts';
import { reachableFeet } from '../terrain.ts';
import type { WorldModel } from '../world-model.ts';
import { describeSightings } from '../world-survey.ts';
import type { ClientCore } from './core.ts';

/** EXPLORE's own limits, on top of maxDistance: hops, time, and the wait for chunks per hop. */
const MAX_EXPLORE_HOPS = 12;
const MAX_EXPLORE_MS = 180_000;
const EXPLORE_ENTITIES_WAIT_MS = 5_000;
/** A hop shorter than this is not worth walking (blocks). */
const MIN_HOP_LENGTH = 2;
/**
 * A far retreat in mode 'follow' (the safety policy bounds its straight-line distance with
 * maxRetreatDistance): blocks walked, hops and time at most, and how close the hops bring it
 * before the last walk onto the safe location.
 */
const MAX_RETREAT_WALK = 768;
const MAX_RETREAT_HOPS = 48;
const MAX_RETREAT_MS = 360_000;
const RETREAT_ARRIVE = 6;
/** A flee (#flee) walks at most this far, to a spot at least FLEE_MIN_GAIN farther from the threats. */
const FLEE_MAX_PATH = 32;
const FLEE_MIN_GAIN = 6;
/** Blocks from the threats a block of walking is worth when choosing where to flee. */
const FLEE_WALK_WEIGHT = 0.1;

/** Where a walk in hops got to, and why it stopped (`safe`: nothing went wrong). */
interface Trip {
  walked: number;
  hops: number;
  stop: { why: string; safe: boolean };
  seen: Map<string, SeenChunk>;
}

/**
 * Travelling in hops (EXPLORE, and far retreats in mode 'follow'): explore.ts picks each hop,
 * and every hop is an ordinary checked walk (movement-actions.ts walkTo). A retreat that cannot
 * get on to its safe location flees from the threats near instead.
 */
export class TravelActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why it is too dark to be out exploring (evening, night, or the time unknown), or null. */
  #darkness(): string | null {
    const t = this.#world.worldTimeAt(this.#opts.clock.now());
    if (t === null) return 'the time of day is unknown (no time update from the server yet)';
    return t.phase === 'evening' || t.phase === 'night'
      ? `it is ${t.phase}: the agent explores only in daylight`
      : null;
  }

  /**
   * Walks toward `goal` in hops. Each hop goes to the spot inside the current play area that a
   * walk reaches and that is closest to the goal (explore.ts), as an ordinary checked walk
   * (movement-actions.ts walkTo: every step re-checked; threats stop it when
   * `stopForThreats`). With threats watched, it first waits until the chunks and entities
   * around each new spot have arrived. After each hop it surveys what it sees (world memory).
   * It stops within `arrive` blocks of the goal, after `maxDistance` blocks walked, when no hop
   * gets closer (water, cliffs), when two hops in a row gain less than a block (stuck), at
   * `maxHops` or `maxMs`, when it gets dark (`daylightOnly`), or on anything that stops a walk
   * (`safe` false).
   */
  async #hops(
    goal: { x: number; z: number },
    opts: {
      maxDistance: number;
      arrive: number;
      stopForThreats: boolean;
      daylightOnly: boolean;
      maxHops: number;
      maxMs: number;
      /** What arriving is called in the result ("reached the target"). */
      arrived: string;
    },
  ): Promise<Trip> {
    const clock = this.#opts.clock;
    const startedAt = clock.now().getTime();
    const seen = new Map<string, SeenChunk>();
    const look = (): void => {
      for (const s of this.#core.observation.survey(true)) {
        const key = `${s.chunkX},${s.chunkZ}`;
        const before = seen.get(key);
        seen.set(key, before === undefined ? s : mergeSeen(before, s));
      }
    };
    const tried = new Set<string>();
    let walked = 0;
    let hops = 0;
    let stalls = 0;
    const done = (why: string, safe: boolean): Trip => ({
      walked,
      hops,
      stop: { why, safe },
      seen,
    });
    look();
    for (;;) {
      const here = this.#world.ownPosition;
      if (here === null) return done('the player position became unknown', false);
      const left = Math.hypot(goal.x - here.x, goal.z - here.z);
      const budget = opts.maxDistance - walked;
      if (left < opts.arrive) return done(opts.arrived, true);
      if (budget < MIN_HOP_LENGTH) {
        return done(`walked the whole maxDistance (${opts.maxDistance} blocks)`, true);
      }
      if (hops >= opts.maxHops) return done(`made the most hops allowed (${opts.maxHops})`, true);
      if (clock.now().getTime() - startedAt >= opts.maxMs) {
        return done(`took the longest allowed (${opts.maxMs / 1000} s)`, true);
      }
      const blocked = this.#core.movement.movementBlocker();
      if (blocked !== null) return done(blocked, false);
      if (opts.daylightOnly) {
        const dark = this.#darkness();
        if (dark !== null) return done(dark, true);
      }
      if (opts.stopForThreats) {
        // A new spot: its chunks and the entities in them must have arrived before a hop.
        await this.#core.waitFor(
          () => this.#world.entitiesReady(clock.now()),
          EXPLORE_ENTITIES_WAIT_MS,
        );
        if (!this.#world.entitiesReady(clock.now())) {
          return done('the entities around the player are not fully known', false);
        }
      }
      const fence = this.#core.fence().fence;
      const world = this.#world.walkWorld();
      if (fence === null || world === null) {
        return done('the play area or the block data is unknown', false);
      }
      const maxLength = Math.min(this.#opts.config.movement.maxPathLength, budget);
      const choice = chooseHop(world, fence, here, goal, maxLength, tried);
      if (!choice.ok) {
        // When a hop as long as the walker allows would get closer, what was left of
        // maxDistance was too short, not the way: no dead end (seen live: nearly every EXPLORE
        // ended "no way further" a few blocks short of 64, each remembered as a dead end).
        const full = this.#opts.config.movement.maxPathLength;
        if (maxLength < full && chooseHop(world, fence, here, goal, full, tried).ok) {
          return done(
            `walked nearly the whole maxDistance (${walked.toFixed(1)} of ${opts.maxDistance} blocks)`,
            true,
          );
        }
        return done(`no way further: ${choice.reason}`, true);
      }
      let walk: ClientActionResult | null = null;
      for (const c of choice.candidates) {
        const r = await this.#core.movement.walkTo(c.target, {
          stopForThreats: opts.stopForThreats,
        });
        // REFUSED with no blocker: the walker would not plan this one (nothing was sent).
        if (r.ok || r.code !== 'REFUSED' || this.#core.movement.movementBlocker() !== null) {
          walk = r;
          break;
        }
        tried.add(`${Math.floor(c.target.x)},${c.target.y},${Math.floor(c.target.z)}`);
      }
      if (walk === null) return done('the walker planned none of the next hops', true);
      if (walk.code === 'REFUSED') return done(walk.message, false);
      hops += 1;
      const after = this.#world.ownPosition ?? here;
      walked += walk.ok
        ? Number(walk.data['distance'])
        : Math.hypot(after.x - here.x, after.z - here.z) + Math.abs(after.y - here.y);
      look();
      if (!walk.ok) return done(walk.message, false);
      stalls = left - Math.hypot(goal.x - after.x, goal.z - after.z) < 1 ? stalls + 1 : 0;
      if (stalls >= 2) return done('stuck: two hops in a row got less than 1 block closer', true);
    }
  }

  /**
   * EXPLORE: walk toward a compass direction or a point, over terrain, in hops (#hops), at most
   * `maxDistance` blocks walked, in daylight only; threats stop it, like MOVE_TO. It stops at
   * the goal (pulled in to the exploration boundary) or earlier (see #hops); FAILED on anything
   * that stops a walk, or with less than a block of progress.
   */
  async explore(args: { toward: ExploreToward; maxDistance: number }): Promise<ClientActionResult> {
    const m = this.#opts.config.movement;
    const refuse = (reason: string, code: 'REFUSED' | 'NOT_IMPLEMENTED' = 'REFUSED') =>
      failed(`not exploring: ${reason}`.slice(0, 500), code);
    const blocker = this.#core.movement.movementBlocker();
    if (blocker !== null) return refuse(blocker, m.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED');
    if (m.mode !== 'follow') {
      return refuse(
        "the play area does not follow the player (EXPLORE needs movement mode 'follow', MC_MOVEMENT_MODE=follow)",
      );
    }
    if (this.#core.walking || this.#core.exploring) return refuse('a walk is already in progress');
    const dark = this.#darkness();
    if (dark !== null) return refuse(dark);
    const start = this.#world.ownPosition;
    const boundary = this.#opts.explorationBoundary ?? null;
    if (start === null || boundary === null) return refuse('position or boundary unknown');

    const goal = exploreGoal(start, args.toward, args.maxDistance, boundary);
    let trip: Trip;
    this.#core.exploring = true;
    try {
      trip = await this.#hops(goal, {
        maxDistance: args.maxDistance,
        arrive: ARRIVED,
        stopForThreats: true,
        daylightOnly: true,
        maxHops: MAX_EXPLORE_HOPS,
        maxMs: MAX_EXPLORE_MS,
        arrived: goal.clipped
          ? 'reached the edge of the exploration boundary'
          : typeof args.toward === 'string'
            ? `went ${args.maxDistance} blocks ${args.toward}`
            : 'reached the target',
      });
    } finally {
      this.#core.exploring = false;
    }

    const end = this.#world.ownPosition ?? start;
    const progress =
      Math.hypot(goal.x - start.x, goal.z - start.z) - Math.hypot(goal.x - end.x, goal.z - end.z);
    const heading =
      typeof args.toward === 'string'
        ? args.toward.replace('_', '-')
        : `(${args.toward.x}, ${args.toward.z})`;
    const { why, safe } = trip.stop;
    const data = {
      walked: Number(trip.walked.toFixed(2)),
      hops: trip.hops,
      progress: Number(progress.toFixed(2)),
      x: end.x,
      y: end.y,
      z: end.z,
      stoppedBecause: why.slice(0, 200),
      chunksSeen: trip.seen.size,
    };
    if (trip.hops === 0) return failed(`not exploring: ${why}`.slice(0, 500), 'REFUSED', data);
    const message =
      `explored ${trip.walked.toFixed(1)} blocks toward ${heading} in ${trip.hops} hop(s), ` +
      `${progress.toFixed(1)} closer, now at (${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}); ` +
      `stopped: ${why}. Saw ${describeSightings([...trip.seen.values()])}`;
    this.#core.log(message);
    if (!safe) return failed(message.slice(0, 500), 'FAILED', data);
    if (progress < 1) {
      return failed(`less than 1 block closer: ${message}`.slice(0, 500), 'FAILED', data);
    }
    return ok(message.slice(0, 500), data);
  }

  /**
   * RETURN_TO_SAFE_LOCATION: a walk that threats do not stop (it is how the agent gets away
   * from them). In mode 'follow', a safe location outside the current play area is reached in
   * hops first (#hops: threats still do not stop it, and it is an escape, so any time of day),
   * then by a last walk onto it. Everything else is the plain walk, as before.
   */
  async retreat(target: Readonly<Position> | null): Promise<ClientActionResult> {
    const fence = this.#core.fence().fence;
    const follow =
      target !== null && fence !== null && this.#opts.config.movement.mode === 'follow';
    const far = follow && !fenceHolds(fence, target);
    if (
      !far ||
      this.#core.movement.movementBlocker() !== null ||
      this.#core.walking ||
      this.#core.exploring
    ) {
      const walk = await this.#core.movement.walkTo(target, { stopForThreats: false });
      // A path longer than one walk may take is walked in hops too, like a far location (seen
      // live: 49 blocks around a slope with the limit at 32, refused twice, play stopped).
      const tooLong = /the path is [\d.]+ blocks long|inside the fence within \d+ blocks/;
      if (walk.ok || !follow || !tooLong.test(walk.message)) return walk;
    }
    let trip: Trip;
    this.#core.exploring = true;
    try {
      trip = await this.#hops(
        { x: target.x, z: target.z },
        {
          maxDistance: MAX_RETREAT_WALK,
          arrive: RETREAT_ARRIVE,
          stopForThreats: false,
          daylightOnly: false,
          maxHops: MAX_RETREAT_HOPS,
          maxMs: MAX_RETREAT_MS,
          arrived: 'near the safe location',
        },
      );
    } finally {
      this.#core.exploring = false;
    }
    const sofar = `${trip.walked.toFixed(1)} blocks in ${trip.hops} hop(s)`;
    if (!trip.stop.safe) {
      return failed(`retreat stopped after ${sofar}: ${trip.stop.why}`.slice(0, 500), 'FAILED', {
        walked: Number(trip.walked.toFixed(2)),
        hops: trip.hops,
      });
    }
    const last = await this.#core.movement.walkTo(target, { stopForThreats: false });
    const data = { ...last.data, walked: Number(trip.walked.toFixed(2)), hops: trip.hops };
    const message = `retreated ${sofar} (${trip.stop.why}), then: ${last.message}`.slice(0, 500);
    if (last.ok) return ok(message, data);
    // No way on to the safe location from here, and a threat near: away from it instead.
    const fled = await this.#flee();
    if (fled !== null) return failed(`${message}; ${fled}`.slice(0, 500), 'FAILED', data);
    return failed(message, last.code === 'OK' ? 'FAILED' : last.code, data);
  }

  /**
   * Flees from the threats near (hostile, not a calm spider, or unidentified) when a retreat
   * cannot get on to its safe location: to the reachable spot (a walk of at most
   * FLEE_MAX_PATH within the play area) farthest from the nearest of them, and farther than
   * the player is now, as an escape walk (threats do not stop it). Seen live: a fishing
   * zombie 2.3 blocks off and a husk 11, the trail too close to them, home 90 blocks back
   * over a cliff: the retreat home failed four times on the spot, and play stopped. Says
   * where it went, or null when there was no threat near or nowhere farther from them.
   */
  async #flee(): Promise<string | null> {
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const fence = this.#core.fence().fence;
    if (
      world === null ||
      feet === null ||
      fence === null ||
      this.#core.movement.movementBlocker() !== null
    ) {
      return null;
    }
    const threats = this.#world
      .nearbyEntities(this.#opts.config.movement.threatRadius, this.#opts.clock.now())
      .filter((e) => (e.category === 'hostile' && !e.calm) || e.category === 'unclassified');
    if (threats.length === 0) return null;
    const away = (x: number, z: number): number =>
      Math.min(...threats.map((e) => Math.hypot(e.position.x - x, e.position.z - z)));
    const now = away(feet.x, feet.z);
    let best: { x: number; y: number; z: number; score: number } | null = null;
    for (const n of reachableFeet(world, fence, feet, FLEE_MAX_PATH).values()) {
      const far = away(n.x + 0.5, n.z + 0.5);
      if (far < now + FLEE_MIN_GAIN) continue;
      // Farthest from them first; of two about as far, the shorter walk.
      const score = far - FLEE_WALK_WEIGHT * n.length;
      if (best === null || score > best.score) best = { x: n.x + 0.5, y: n.y, z: n.z + 0.5, score };
    }
    if (best === null) return null;
    const spot = { x: best.x, y: best.y, z: best.z };
    const walk = await this.#core.movement.walkTo(spot, { stopForThreats: false });
    const where = `(${spot.x}, ${spot.y}, ${spot.z})`;
    return walk.ok
      ? `fled instead to ${where}, ${away(spot.x, spot.z).toFixed(1)} blocks from the nearest threat (it was ${now.toFixed(1)})`
      : `fleeing to ${where} failed: ${walk.message}`;
  }
}

import type { ExploreToward } from '../../../domain/actions.ts';
import { hostileTactic } from '../../../domain/combat.ts';
import type { Position } from '../../../domain/common.ts';
import { mergeSeen, type SeenChunk } from '../../../domain/world-memory.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import { ARRIVED, exploreGoal } from '../explore.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { goalAny, goalAway, goalNear, goalXZ, type Goal } from '../pathing/goals.ts';
import { OVER_BUDGET } from './path-actions.ts';
import { ENTITY_SCAN_RADIUS, type WorldModel } from '../world-model.ts';
import { describeSightings } from '../world-survey.ts';
import type { ClientCore } from './core.ts';
import { THREAT_STOP } from './shared.ts';

/** EXPLORE's own limits, on top of maxDistance: segments, time, and the wait for chunks per segment. */
const MAX_EXPLORE_HOPS = 12;
const MAX_EXPLORE_MS = 180_000;
const EXPLORE_ENTITIES_WAIT_MS = 5_000;
/** Less than this (blocks) left of maxDistance: the walk has spent it. */
const MIN_HOP_LENGTH = 2;
/**
 * A retreat in mode 'follow' (the safety policy bounds its straight-line distance with
 * maxRetreatDistance): blocks walked, segments and time at most.
 */
const MAX_RETREAT_WALK = 768;
const MAX_RETREAT_HOPS = 48;
const MAX_RETREAT_MS = 360_000;
/** A retreat ends on the safe location's block: its centre within this of the location. */
const RETREAT_NEAR = 0.75;
/** A flee (#flee) walks at most this far, to a spot at least FLEE_MIN_GAIN farther from the threats. */
const FLEE_MAX_PATH = 32;
const FLEE_MIN_GAIN = 6;

/** Where a trip of segments got to, and why it stopped (`safe`: nothing went wrong). */
interface Trip {
  walked: number;
  hops: number;
  /** The goal was reached. */
  arrived: boolean;
  stop: { why: string; safe: boolean };
  seen: Map<string, SeenChunk>;
}

/**
 * Travelling beyond one walk (EXPLORE, retreats in mode 'follow', fleeing) on the pathfinder:
 * each segment is planned with planPath toward a goal (goalXZ for EXPLORE, goalNear for a
 * retreat, goalAway for a flee) inside the play area of the moment, as the best partial path
 * when the goal lies beyond it, and walked as any walk is (path-actions.ts: every step
 * checked); then the play area has moved with the player, new chunks have come, and the next
 * segment is planned from there. The long-distance idea of Baritone (a path to the best node
 * toward a goal beyond the loaded area, then planning again as chunks arrive), written anew.
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
   * Walks toward `goal` in segments (see the class comment), each an ordinary walk on the
   * pathfinder with the trip's own options. With threats watched, it first waits until the
   * chunks and entities around each new spot have arrived. After each segment it surveys what
   * it sees (world memory). It stops at the goal, after `maxDistance` blocks walked, when no
   * walk gets farther (water, cliffs it may not climb or bridge), when two segments in a row
   * gain less than a block toward `point` (stuck), at `maxHops` or `maxMs`, when it gets dark
   * (`daylightOnly`), or on anything that stops a walk (`safe` false).
   */
  async #segments(
    goal: Goal,
    point: { x: number; z: number },
    opts: {
      what: string;
      maxDistance: number;
      stopForThreats: boolean;
      daylightOnly: boolean;
      /** Break and place on the way, as the walk policy allows. */
      work: boolean;
      maxHops: number;
      maxMs: number;
      protectedItems: ReadonlySet<string>;
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
    let walked = 0;
    let hops = 0;
    let stalls = 0;
    const done = (why: string, safe: boolean, arrived = false): Trip => ({
      walked,
      hops,
      arrived,
      stop: { why, safe },
      seen,
    });
    look();
    for (;;) {
      const here = this.#world.ownPosition;
      if (here === null) return done('the player position became unknown', false);
      const budget = opts.maxDistance - walked;
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
        // A new spot: its chunks and the entities in them must have arrived before a walk.
        await this.#core.waitFor(
          () => this.#world.entitiesReady(clock.now()),
          EXPLORE_ENTITIES_WAIT_MS,
        );
        if (!this.#world.entitiesReady(clock.now())) {
          return done('the entities around the player are not fully known', false);
        }
      }
      const left = Math.hypot(point.x - here.x, point.z - here.z);
      const walk = await this.#core.paths.walk({
        goal,
        what: opts.what,
        stopForThreats: opts.stopForThreats,
        work: opts.work,
        partial: true,
        maxLength: budget,
        protectedItems: opts.protectedItems,
      });
      if (walk.code === 'REFUSED') {
        const why = walk.message.replace(/^not walking: /, '');
        if (this.#core.movement.movementBlocker() !== null) return done(why, false);
        // What is left of maxDistance is shorter than the next movement: the walk is spent,
        // not the way (seen live: "no way further" a few blocks short, remembered as a dead
        // end each time).
        if (why.startsWith(OVER_BUDGET)) {
          return done(
            `walked nearly the whole maxDistance (${walked.toFixed(1)} of ${opts.maxDistance} blocks)`,
            true,
          );
        }
        // Nothing to walk: the goal lies behind water, a cliff or a wall the walk policy does not
        // get past, or no spot 5 blocks or more away gets closer.
        return done(`no way further: ${why}`, true);
      }
      hops += 1;
      const after = this.#world.ownPosition ?? here;
      walked += walk.ok
        ? Number(walk.data['distance'])
        : Math.hypot(after.x - here.x, after.z - here.z) + Math.abs(after.y - here.y);
      look();
      if (!walk.ok) return done(walk.message, false);
      if (walk.data['reached'] === true) return done(opts.arrived, true, true);
      stalls = left - Math.hypot(point.x - after.x, point.z - after.z) < 1 ? stalls + 1 : 0;
      if (stalls >= 2) return done('stuck: two hops in a row got less than 1 block closer', true);
    }
  }

  /**
   * EXPLORE: walk toward a compass direction or a point, over terrain, in segments
   * (#segments, goalXZ toward the point or a far point in the direction, pulled in to the
   * exploration boundary), at most `maxDistance` blocks walked, in daylight only; threats stop
   * it, like MOVE_TO, and it breaks and places on its way as the walk policy allows. It stops
   * at the goal or earlier (see #segments); FAILED on anything that stops a walk, or with less
   * than a block of progress.
   */
  async explore(
    args: { toward: ExploreToward; maxDistance: number },
    protectedItems: ReadonlySet<string> = new Set(),
  ): Promise<ClientActionResult> {
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

    const target = exploreGoal(start, args.toward, args.maxDistance, boundary);
    let trip: Trip;
    this.#core.exploring = true;
    try {
      trip = await this.#segments(
        // At any height, the columns within ARRIVED of the point (goalXZ's, near it).
        columnsNear(target, ARRIVED),
        target,
        {
          what: `(${target.x.toFixed(1)}, ${target.z.toFixed(1)})`,
          maxDistance: args.maxDistance,
          stopForThreats: true,
          daylightOnly: true,
          work: true,
          maxHops: MAX_EXPLORE_HOPS,
          maxMs: MAX_EXPLORE_MS,
          protectedItems,
          arrived: target.clipped
            ? 'reached the edge of the exploration boundary'
            : typeof args.toward === 'string'
              ? `went ${args.maxDistance} blocks ${args.toward}`
              : 'reached the target',
        },
      );
    } finally {
      this.#core.exploring = false;
    }

    const end = this.#world.ownPosition ?? start;
    const progress =
      Math.hypot(target.x - start.x, target.z - start.z) -
      Math.hypot(target.x - end.x, target.z - end.z);
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
      ...(THREAT_STOP.test(why) ? { threat: true } : {}),
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
   * RETURN_TO_SAFE_LOCATION: walks that threats do not stop (it is how the agent gets away
   * from them), at any time of day, breaking and placing nothing (a dig or a placement stops
   * for a threat). In mode 'follow' it travels in segments (#segments, goalNear the location),
   * as far as the location is, and ends on its block; when it cannot get on and a threat is
   * near, it flees from the threats instead. Otherwise (a fixed fence) the plain walk.
   */
  async retreat(target: Readonly<Position> | null): Promise<ClientActionResult> {
    const follow = target !== null && this.#opts.config.movement.mode === 'follow';
    if (
      !follow ||
      this.#core.movement.movementBlocker() !== null ||
      this.#core.walking ||
      this.#core.exploring
    ) {
      return this.#core.movement.walkTo(target, { stopForThreats: false });
    }
    let trip: Trip;
    this.#core.exploring = true;
    try {
      trip = await this.#segments(goalNear(target, RETREAT_NEAR), target, {
        what: 'the safe location',
        maxDistance: MAX_RETREAT_WALK,
        stopForThreats: false,
        daylightOnly: false,
        work: false,
        maxHops: MAX_RETREAT_HOPS,
        maxMs: MAX_RETREAT_MS,
        protectedItems: new Set(),
        arrived: 'at the safe location',
      });
    } finally {
      this.#core.exploring = false;
    }
    const sofar = `${trip.walked.toFixed(1)} blocks in ${trip.hops} hop(s)`;
    const end = this.#world.ownPosition;
    const data = {
      walked: Number(trip.walked.toFixed(2)),
      hops: trip.hops,
      ...(end === null ? {} : { x: end.x, y: end.y, z: end.z }),
    };
    if (trip.arrived) return ok(`retreated ${sofar}: ${trip.stop.why}`.slice(0, 500), data);
    const message = `retreat stopped after ${sofar}: ${trip.stop.why}`;
    if (!trip.stop.safe) return failed(message.slice(0, 500), 'FAILED', data);
    // No way on to the safe location from here, and a threat near: away from it instead.
    const fled = await this.#flee();
    return failed((fled === null ? message : `${message}; ${fled}`).slice(0, 500), 'FAILED', data);
  }

  /**
   * Flees from the threats near (hostile, not a calm spider, or unidentified) when a retreat
   * cannot get on to its safe location: a walk on the pathfinder to goalAway (at least
   * FLEE_MIN_GAIN farther from every one of them than the nearest is now), or as far toward
   * it as the play area allows, at most FLEE_MAX_PATH blocks, as an escape (threats do not
   * stop it, and it breaks and places nothing). Seen live: a fishing zombie 2.3 blocks off and
   * a husk 11, the trail too close to them, home 90 blocks back over a cliff: the retreat home
   * failed four times on the spot, and play stopped. Says where it went, or why it could not
   * flee; null when there was no threat near.
   */
  async #flee(): Promise<string | null> {
    const feet = this.#world.ownPosition;
    if (feet === null) return null;
    // Why not, said: seen live, a retreat failed with a skeleton 6 blocks off and no word of
    // a flee.
    const blocker = this.#core.movement.movementBlocker();
    if (blocker !== null) return `no flee: ${blocker}`;
    // The threats System 1 retreats from (safety-policy.ts assessDangers): those within the
    // threat radius, and a ranged one (a skeleton) anywhere in the entity scan. Seen live
    // 2026-10-04: a sniper skeleton on a hill 10.3 blocks off made every retreat fail on the
    // spot, its pit sealed and home far, and the flee found nothing within 10 to flee from.
    const radius = this.#opts.config.movement.threatRadius;
    const threats = this.#world
      .nearbyEntities(ENTITY_SCAN_RADIUS, this.#opts.clock.now())
      .filter(
        (e) =>
          ((e.category === 'hostile' && !e.calm) || e.category === 'unclassified') &&
          (e.distance <= radius ||
            (e.category === 'hostile' && hostileTactic(e.name) === 'ranged')),
      );
    if (threats.length === 0) return null;
    const away = (x: number, z: number): number =>
      Math.min(...threats.map((e) => Math.hypot(e.position.x - x, e.position.z - z)));
    const now = away(feet.x, feet.z);
    const walk = await this.#core.paths.walk({
      goal: goalAway(
        threats.map((e) => ({ x: e.position.x, z: e.position.z })),
        now + FLEE_MIN_GAIN,
      ),
      what: 'a spot away from the threats',
      stopForThreats: false,
      work: false,
      partial: true,
      maxLength: FLEE_MAX_PATH,
      protectedItems: new Set(),
    });
    const end = this.#world.ownPosition ?? feet;
    const where = `(${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)})`;
    if (walk.code === 'REFUSED') return `no flee: ${walk.message}`;
    return walk.ok
      ? `fled instead to ${where}, ${away(end.x, end.z).toFixed(1)} blocks from the nearest threat (it was ${now.toFixed(1)})`
      : `fleeing failed at ${where}: ${walk.message}`;
  }
}

/**
 * The feet in any column whose centre is within `radius` (across) of the point, at any height:
 * goalXZ for each (EXPLORE heads for a place on the map, not a height). At least the point's
 * own column.
 */
function columnsNear(point: { x: number; z: number }, radius: number): Goal {
  const own = goalXZ(Math.floor(point.x), Math.floor(point.z));
  const goals: Goal[] = [own];
  const r = Math.ceil(radius);
  for (let x = Math.floor(point.x) - r; x <= Math.floor(point.x) + r; x++) {
    for (let z = Math.floor(point.z) - r; z <= Math.floor(point.z) + r; z++) {
      if (x === Math.floor(point.x) && z === Math.floor(point.z)) continue;
      if (Math.hypot(x + 0.5 - point.x, z + 0.5 - point.z) <= radius) goals.push(goalXZ(x, z));
    }
  }
  return goals.length === 1 ? own : goalAny(...goals);
}

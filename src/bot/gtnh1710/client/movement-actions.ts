import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Position } from '../../../domain/common.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { outbound } from '../packets.ts';
import { CLIMB_DOWN_PER_TICK } from '../pathing/costs.ts';
import { surfacing, type PathStep } from '../pathing/execute.ts';
import { goalBlock } from '../pathing/goals.ts';
import { fenceHolds } from '../play-area.ts';
import {
  checkSupport,
  edgeLanding,
  fallDistances,
  landingHazard,
  eyesInWater,
  MAX_SAFE_FALL,
  onBlock,
  onLadder,
  restingY,
} from '../terrain.ts';
import {
  planWalk,
  renderWalkMap,
  segmentProblem,
  stepsAlong,
  yawTowards,
  type Fence,
  type Vec3,
  type WalkPlan,
  type WalkWorld,
} from '../walking.ts';
import type { WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { delay, ON_GROUND, SETTLE_TICKS, THREAT_STOP, WALK_TICK_MS } from './shared.ts';

/** Vanilla clients send one "player" packet per tick (20 per second). */
const IDLE_TICK_MS = 50;
/** Idle ticks between two checks that something still holds the player up (gravity). */
const SUPPORT_CHECK_TICKS = 10;
/** A threat this close stops a walk whichever way it goes (walkInterruption). */
const CLOSE_THREAT_RADIUS = 6;

/** The block a walk to `target` ends in: its feet block. */
const blockOf = (target: Readonly<Position>): { x: number; y: number; z: number } => ({
  x: Math.floor(target.x),
  y: Math.floor(target.y + 1e-6),
  z: Math.floor(target.z),
});

/**
 * Walking: MOVE_TO's checked walk (on one level in the flat pen; over terrain on the
 * pathfinder, path-actions.ts, where it may break and place on its way), previews of a walk,
 * and what keeps a standing player present and on the ground: idle ticks and gravity.
 */
export class MovementActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;
  #idleTimer: NodeJS.Timeout | null = null;
  /** Idle ticks sent (for the support check every SUPPORT_CHECK_TICKS). */
  #idleTicks = 0;
  /** The last "in the air" problem logged, so it is logged once, not every check. */
  #floatingNote: string | null = null;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /**
   * Plans a walk without moving (for previews and dry runs), with a text map of the fence.
   * Works whether or not movement is enabled; null when no fence is configured. With `work`
   * it plans as MOVE_TO does (breaking and placing on its way as the walk policy allows).
   */
  previewWalk(
    target: Position | null,
    work = false,
  ): { plan: WalkPlan | null; map: string[] } | null {
    const m = this.#opts.config.movement;
    const fence = this.#core.fence().fence;
    if (fence === null) return null;
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return { plan: { ok: false, reason: 'block data or position unknown' }, map: [] };
    }
    if (fence.min.y !== fence.max.y) {
      // Terrain fences: plan only (the text map shows a single level).
      if (target === null) return { plan: null, map: [] };
      if (!fenceHolds(fence, target)) {
        return { plan: { ok: false, reason: 'the target is outside the movement fence' }, map: [] };
      }
      const b = blockOf(target);
      const planned = this.#core.paths.plan(world, fence, from, {
        goal: goalBlock(b.x, b.y, b.z),
        what: 'the target',
        stopForThreats: true,
        work,
        partial: false,
        protectedItems: new Set(),
      });
      const waypoints = planned.ok
        ? planned.movements.map((mv) => ({ x: mv.to.x + 0.5, y: mv.to.y, z: mv.to.z + 0.5 }))
        : [];
      return {
        plan: planned.ok
          ? { ok: true, waypoints: [from, ...waypoints], length: planned.length }
          : planned,
        map: [],
      };
    }
    const plan = target === null ? null : planWalk(world, fence, from, target, m.maxPathLength);
    const entities = this.#world.nearbyEntities(64, this.#opts.clock.now()).map((e) => ({
      id: e.entityId,
      threat: (e.category === 'hostile' && !e.calm) || e.category === 'unclassified',
    }));
    const positions = new Map(this.#world.trackedEntities().map((e) => [e.entityId, e]));
    const map = renderWalkMap(world, fence, {
      player: from,
      target,
      path: plan?.ok === true ? plan.waypoints : [],
      entities: entities.flatMap((e) => {
        const p = positions.get(e.id);
        return p === undefined ? [] : [{ x: p.x, z: p.z, threat: e.threat }];
      }),
    });
    return { plan, map };
  }

  /** Why walking cannot start or continue now, or null. */
  movementBlocker(): string | null {
    const m = this.#opts.config.movement;
    if (!m.enabled) return 'movement is disabled (MC_ENABLE_MOVEMENT)';
    const area = this.#core.fence();
    if (area.fence === null) return area.problem;
    if (!this.#opts.config.presenceTicks) return 'walking needs presence ticks (MC_PRESENCE_TICKS)';
    if (this.#core.haltReason !== null) return `halted: ${this.#core.haltReason}`;
    if (existsSync(resolvePath(m.stopFile))) return `the stop file ${m.stopFile} exists`;
    if (this.#core.usingContainer) return 'a chest or crafting operation is running';
    if (this.#core.fighting) return 'the player is fighting';
    if (this.#core.digging) return 'the player is digging';
    if (this.#core.placing) return 'the player is placing a block';
    if (this.#core.eating) return 'the player is eating';
    // Walking away closes an open window server-side, which drops the cursor and a table's grid.
    if (this.#world.openWindow?.cursor != null || this.#core.crafting.leftovers() !== null) {
      return 'items are on the cursor or in a crafting grid';
    }
    return null;
  }

  /**
   * MOVE_TO's walk (and the walks a retreat or the fetching of a drop make): to the block of
   * `target`. Over terrain (a fence with a height range, or the play area) it walks on the
   * pathfinder (path-actions.ts), breaking and placing on its way as the walk policy allows
   * when `work` is set; on a fence of one level, the flat pen walker, as before.
   */
  async walkTo(
    target: Readonly<Position> | null,
    options: {
      stopForThreats: boolean;
      /** MOVE_TO: over terrain, break and place on the way as the walk policy allows. */
      work?: boolean;
      /** Never held for a break (the validated action's protected items). */
      protectedItems?: ReadonlySet<string>;
    },
  ): Promise<ClientActionResult> {
    const m = this.#opts.config.movement;
    const blocker = this.movementBlocker();
    const fence = this.#core.fence().fence;
    if (blocker !== null || fence === null) {
      return failed(`not walking: ${blocker}`, m.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED');
    }
    if (target === null) return failed('not walking: no resolved target', 'ERROR');
    if (this.#core.walking) return failed('not walking: a walk is already in progress', 'REFUSED');
    if (fence.min.y !== fence.max.y) {
      if (!fenceHolds(fence, target)) {
        return failed('not walking: the target is outside the movement fence', 'REFUSED');
      }
      const b = blockOf(target);
      return this.#core.paths.walk({
        goal: goalBlock(b.x, b.y, b.z),
        what: 'the target',
        stopForThreats: options.stopForThreats,
        work: options.work === true,
        partial: false,
        protectedItems: options.protectedItems ?? new Set(),
      });
    }
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return failed('not walking: block data or position unknown', 'REFUSED');
    }
    // A fence on one level walks the flat pen way.
    const plan = planWalk(world, fence, from, target, m.maxPathLength);
    if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');
    const steps = stepsAlong(plan.waypoints);
    const length = plan.length;
    this.#core.log(
      `walking ${length.toFixed(2)} blocks in ${steps.length} steps (${plan.waypoints.length - 1} stretch(es))`,
    );
    const guard = {
      placementsAtStart: this.#core.confirmedPositions,
      // An escape (threats do not stop it) keeps going when hurt from afar (seen live: a retreat
      // from a skeleton stopped at its first arrow, and the next walk led back into range), but
      // not with a creature close enough to strike (walkInterruption).
      healthAtStart: this.#world.health,
      stopForThreats: options.stopForThreats,
    };
    let at: Vec3 = from;
    let taken = 0;
    const stopped = (reason: string): ClientActionResult => {
      const where = this.#world.ownPosition ?? at;
      this.#core.log(`walk stopped after ${taken}/${steps.length} steps: ${reason}`);
      return failed(
        `walk stopped after ${taken} of ${steps.length} steps: ${reason}`.slice(0, 500),
        'FAILED',
        {
          stepsTaken: taken,
          stepsPlanned: steps.length,
          x: where.x,
          y: where.y,
          z: where.z,
          ...(THREAT_STOP.test(reason) ? { threat: true } : {}),
        },
      );
    };

    this.#core.walking = true;
    this.stopIdle();
    try {
      for (const next of steps) {
        const reason = this.#stepProblem(fence, at, next, guard);
        if (reason !== null) return stopped(reason);
        const facing =
          Math.hypot(next.x - at.x, next.z - at.z) > 1e-9
            ? yawTowards(at, next)
            : this.#core.lastYaw;
        this.#core.lastYaw = facing;
        this.#core.send(
          outbound.playerMove({ x: next.x, feetY: next.y, z: next.z, yaw: facing, pitch: 0 }, true),
        );
        this.#world.setOwnPosition(next);
        at = next;
        taken += 1;
        await delay(WALK_TICK_MS);
      }
      // A correction (S08) or a kick arrives within a few ticks of a move the server rejects.
      for (let i = 0; i < SETTLE_TICKS; i++) {
        if (this.#core.phase !== 'play') return stopped('the connection closed');
        if (this.#core.confirmedPositions !== guard.placementsAtStart) {
          return stopped('the server corrected the final position');
        }
        this.#core.send(outbound.playerIdle(ON_GROUND));
        await delay(WALK_TICK_MS);
      }
      if (this.#core.phase !== 'play') return stopped('the connection closed');
      if (this.#core.confirmedPositions !== guard.placementsAtStart) {
        return stopped('the server corrected the final position');
      }
      return ok(`walked ${length.toFixed(2)} blocks in ${steps.length} steps`, {
        steps: steps.length,
        distance: Number(length.toFixed(3)),
        x: at.x,
        y: at.y,
        z: at.z,
      });
    } finally {
      this.#core.walking = false;
      if (this.#core.phase === 'play') this.startIdle();
    }
  }

  /** Why the flat walker's next step must not be taken, or null; checked just before it. */
  #stepProblem(
    fence: Fence,
    from: Vec3,
    to: Vec3,
    guard: { placementsAtStart: number; healthAtStart: number | null; stopForThreats: boolean },
  ): string | null {
    const interrupted = this.walkInterruption(guard, { from, to });
    if (interrupted !== null) return interrupted;
    const world = this.#world.walkWorld();
    if (world === null) return 'the block data became unknown';
    const problem = segmentProblem(world, fence, from, to);
    return problem === null ? null : `the way ahead is not clear: ${problem}`;
  }

  /**
   * Why a walk must stop now, whatever the way ahead, or null; checked before every step and
   * every block it breaks on its way: the connection, anything that blocks walking (the stop
   * file, halt()...), a server correction or a health drop since it started, and with
   * `stopForThreats` a hostile (not a calm spider) or unidentified entity within threatRadius.
   */
  walkInterruption(
    guard: {
      placementsAtStart: number;
      healthAtStart: number | null;
      stopForThreats: boolean;
    },
    step?: { from: Vec3; to: Vec3 },
  ): string | null {
    if (this.#core.phase !== 'play') return 'the connection closed';
    const blocker = this.movementBlocker();
    if (blocker !== null) return blocker;
    if (this.#core.confirmedPositions !== guard.placementsAtStart) return this.#core.corrected();
    const health = this.#world.health;
    if (
      !this.#core.starving() &&
      guard.healthAtStart !== null &&
      health !== null &&
      health < guard.healthAtStart
    ) {
      if (guard.stopForThreats) return `health dropped from ${guard.healthAtStart} to ${health}`;
      // An escape (threats do not stop it) goes on when hurt from afar, out of a skeleton's
      // range, but not with a creature close enough to strike: it fails, and play waits the mob
      // out offline (seen live 2026-10-04: a Special Mobs Mother Spider bit the bot to death
      // on its retreat; an independent review found the retreat would have run on for minutes).
      const striker = this.#world
        .nearbyEntities(this.#opts.config.movement.threatRadius, this.#opts.clock.now())
        .find(
          (e) =>
            e.kind !== 'object' &&
            ((e.category === 'hostile' && !e.calm) || e.category === 'unclassified'),
        );
      if (striker !== undefined) {
        return `health dropped from ${guard.healthAtStart} to ${health} with ${striker.category} entity ${striker.name} ${striker.distance.toFixed(1)} blocks away`;
      }
    }
    if (guard.stopForThreats) {
      const now = this.#opts.clock.now();
      if (!this.#world.entitiesReady(now)) {
        return 'the entities around the player are not fully known';
      }
      const radius = this.#opts.config.movement.threatRadius;
      // A step that takes the player away from a threat that is not close goes on: a person
      // walks on away from a creeper nine blocks behind (seen live: a concussion creeper
      // standing 10 blocks from the way to the gravel stopped every walk there, even the
      // walks away from it). Close, or a step toward it, stops the walk.
      const away = (e: { position: { x: number; z: number } }): boolean =>
        step !== undefined &&
        Math.hypot(e.position.x - step.to.x, e.position.z - step.to.z) >
          Math.hypot(e.position.x - step.from.x, e.position.z - step.from.z);
      const threat = this.#world
        .nearbyEntities(radius, now)
        .find(
          (e) =>
            ((e.category === 'hostile' && !e.calm) || e.category === 'unclassified') &&
            (e.distance <= CLOSE_THREAT_RADIUS || !away(e)),
        );
      if (threat !== undefined) {
        return `${threat.category} entity ${threat.name} ${threat.distance.toFixed(1)} blocks away`;
      }
    }
    return null;
  }

  startIdle(): void {
    if (this.#idleTimer !== null || this.#core.walking) return;
    this.#idleTimer = setInterval(() => {
      this.#core.send(outbound.playerIdle(ON_GROUND));
      this.#idleTicks += 1;
      if (this.#idleTicks % SUPPORT_CHECK_TICKS === 0) void this.keepSupported();
    }, IDLE_TICK_MS);
  }

  /**
   * Gravity, which this client does not otherwise simulate. When nothing holds the player up
   * (a walk stopped between a jump's or a drop's steps, the ground fell away, or the server
   * put it in the air at login), it falls onto the block below as a game client would: the
   * server kicks a player that floats for 4 seconds ("Flying is not enabled on this server").
   * Only when walking is allowed and nothing else runs, only within the fence, and only a fall
   * of at most MAX_SAFE_FALL blocks (no damage) onto a spot with no hazard next to it;
   * otherwise it logs why and stays (a kick is harmless, a bad fall is not).
   */
  async keepSupported(): Promise<void> {
    if (this.#core.phase !== 'play' || this.#core.walking || this.#core.exploring) return;
    if (this.#core.digging || this.#core.placing || this.#core.fighting || this.#core.questBookBusy)
      return;
    if (this.movementBlocker() !== null) return;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const fence = this.#core.fence().fence;
    if (world === null || feet === null || fence === null) return;
    if (onLadder(world, feet)) {
      // Held by a ladder: at a block's level it hangs on (a walk from there climbs). Between
      // levels (a correction mid-climb, a login there), it climbs down to the level below as
      // a client holding on slides, 0.15 a tick, within the cells its body is in already (an
      // independent review, 2026-10-04: walks refused to start there, and nothing brought it
      // down).
      const level = Math.floor(feet.y + 1e-9);
      if (feet.y - level > 1e-6) await this.#slideDown(world, feet, level);
      // Held there with the head under water (a login there): say so, it would drown.
      const why = eyesInWater(world, feet) ? 'on a ladder under water' : null;
      if (why !== null && this.#floatingNote !== why) {
        this.#core.log(`at (${feet.x}, ${feet.y.toFixed(2)}, ${feet.z}): ${why}`);
      }
      this.#floatingNote = why;
      return;
    }
    // Under calm water, or over it with nothing else underfoot (a stop, a correction, a login
    // there): up into its top block as a swimming client comes up, or onto one-deep water's
    // floor. Afloat there a walk can start; under it the player would drown (an independent
    // review, 2026-10-04), and idle gravity would set it on the water as on a floor.
    const swim = surfacing(world, feet);
    const end = swim?.at(-1);
    if (swim !== null && end !== undefined && fenceHolds(fence, end.pos)) {
      await this.#sendSteps(swim, 'swam up');
      return;
    }
    if (eyesInWater(world, feet)) {
      const why =
        swim !== null
          ? 'under water, and the way up leaves the fence'
          : 'under water, and no safe way up is known';
      if (this.#floatingNote !== why) {
        this.#floatingNote = why;
        this.#core.log(`at (${feet.x}, ${feet.y.toFixed(2)}, ${feet.z}): ${why}`);
      }
      return;
    }
    const support = checkSupport(world, feet);
    if (support.kind === 'unknown') return;
    // Held up for the server, the feet may still hang a little above the ground, or just past
    // an edge over nothing: they come down onto it, as in a game client (restingY, edgeLanding).
    const resting =
      support.kind === 'supported' ? (restingY(world, feet) ?? edgeLanding(world, feet)) : null;
    if (support.kind === 'supported' && resting === null) {
      this.#floatingNote = null;
      return;
    }
    const note = (why: string): void => {
      if (this.#floatingNote === why) return;
      this.#floatingNote = why;
      this.#core.log(
        `in the air at (${feet.x}, ${feet.y.toFixed(2)}, ${feet.z}) and not falling: ${why}`,
      );
    };
    const landY = support.kind === 'floating' ? support.landY : resting;
    if (landY === null || feet.y - landY > MAX_SAFE_FALL) {
      note(`no floor within ${MAX_SAFE_FALL} blocks below`);
      return;
    }
    const landing = { x: feet.x, y: landY, z: feet.z };
    if (!fenceHolds(fence, landing)) {
      note('the floor below is outside the fence');
      return;
    }
    const hazard = landingHazard(world, Math.floor(feet.x), landY, Math.floor(feet.z));
    if (hazard !== null) {
      note(`the floor below is ${hazard}`);
      return;
    }
    // Falling is a walk of its own: nothing else may start meanwhile.
    this.#core.walking = true;
    this.stopIdle();
    const placements = this.#core.confirmedPositions;
    try {
      const fallen = fallDistances(feet.y - landY);
      for (const [i, d] of fallen.entries()) {
        // The server put the player somewhere (a correction), or the connection closed.
        if (this.#core.phase !== 'play' || this.#core.confirmedPositions !== placements) return;
        const pos = { x: feet.x, y: i === fallen.length - 1 ? landY : feet.y - d, z: feet.z };
        this.#core.send(
          outbound.playerMove(
            { x: pos.x, feetY: pos.y, z: pos.z, yaw: this.#core.lastYaw, pitch: 0 },
            i === fallen.length - 1,
          ),
        );
        this.#world.setOwnPosition(pos);
        await delay(WALK_TICK_MS);
      }
      this.#floatingNote = null;
      this.#core.log(`fell ${(feet.y - landY).toFixed(2)} blocks onto the ground at y=${landY}`);
    } finally {
      this.#core.walking = false;
      if (this.#core.phase === 'play') this.startIdle();
    }
  }

  /** Sends idle steps (a walk of its own), stopping at a correction or a closed connection. */
  async #sendSteps(steps: readonly PathStep[], what: string): Promise<void> {
    this.#core.walking = true;
    this.stopIdle();
    const placements = this.#core.confirmedPositions;
    const from = this.#world.ownPosition;
    try {
      for (const step of steps) {
        if (this.#core.phase !== 'play' || this.#core.confirmedPositions !== placements) return;
        this.#core.send(
          outbound.playerMove(
            { x: step.pos.x, feetY: step.pos.y, z: step.pos.z, yaw: this.#core.lastYaw, pitch: 0 },
            step.onGround,
          ),
        );
        this.#world.setOwnPosition(step.pos);
        await delay(WALK_TICK_MS);
      }
      const end = steps.at(-1)?.pos;
      if (from !== null && end !== undefined) {
        this.#core.log(`${what} from y=${from.y.toFixed(2)} to y=${end.y.toFixed(2)}`);
      }
    } finally {
      this.#core.walking = false;
      if (this.#core.phase === 'play') this.startIdle();
    }
  }

  /** Down a ladder from `feet` to `level` (a whole y in the same block), 0.15 a tick. */
  async #slideDown(world: WalkWorld, feet: Vec3, level: number): Promise<void> {
    // A walk of its own: nothing else may start meanwhile.
    this.#core.walking = true;
    this.stopIdle();
    const placements = this.#core.confirmedPositions;
    try {
      let y = feet.y;
      while (y > level) {
        // The server put the player somewhere (a correction), or the connection closed.
        if (this.#core.phase !== 'play' || this.#core.confirmedPositions !== placements) return;
        y = Math.max(level, y - CLIMB_DOWN_PER_TICK);
        const pos = { x: feet.x, y, z: feet.z };
        const ground = y === level && onBlock(world, pos);
        this.#core.send(
          outbound.playerMove(
            { x: pos.x, feetY: pos.y, z: pos.z, yaw: this.#core.lastYaw, pitch: 0 },
            ground,
          ),
        );
        this.#world.setOwnPosition(pos);
        await delay(WALK_TICK_MS);
      }
      this.#core.log(`climbed down ${(feet.y - level).toFixed(2)} on a ladder, to y=${level}`);
    } finally {
      this.#core.walking = false;
      if (this.#core.phase === 'play') this.startIdle();
    }
  }

  stopIdle(): void {
    if (this.#idleTimer !== null) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
  }
}

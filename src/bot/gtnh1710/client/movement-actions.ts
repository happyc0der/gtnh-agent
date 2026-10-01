import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { BlockPosition, Position } from '../../../domain/common.ts';
import { TICK_MS } from '../../../domain/dig-time.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import { checkWalkBreak, walkBreaks, type DigArea, type DigCheck } from '../digging.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { outbound } from '../packets.ts';
import { passProblem } from '../passable.ts';
import { fenceHolds } from '../play-area.ts';
import {
  bodyProblem,
  checkSupport,
  fallDistances,
  landingHazard,
  MAX_SAFE_FALL,
  planTerrainWalk,
  restingY,
  terrainSteps,
  type TerrainStep,
  type WalkBreaks,
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
import { delay, describeGain, ON_GROUND, SETTLE_TICKS, WALK_TICK_MS } from './shared.ts';

/** Vanilla clients send one "player" packet per tick (20 per second). */
const IDLE_TICK_MS = 50;
/** Idle ticks between two checks that something still holds the player up (gravity). */
const SUPPORT_CHECK_TICKS = 10;
/**
 * After a walk broke leaves on its way: how long after the last break it waits before it
 * reports (the drop's 10-tick pickup delay, plus 5), so what they drop now and then (a
 * sapling, an apple) reaches the inventory during the walk, not during the next action,
 * whose own drop and inventory checks it would confuse.
 */
const BREAK_DROP_WAIT_MS = 15 * TICK_MS;
/** A threat this close stops a walk whichever way it goes (#walkInterruption). */
const CLOSE_THREAT_RADIUS = 6;

/** What a walk broke: "2 leaves on the way: (1, 64, 0), (1, 65, 0)". */
function describeBroken(cells: readonly BlockPosition[]): string {
  const n = cells.length;
  return (
    `${n === 1 ? 'a leaf block' : `${n} leaves`} on the way: ` +
    cells.map((c) => `(${c.x}, ${c.y}, ${c.z})`).join(', ')
  );
}

/**
 * Walking: MOVE_TO's checked walk (on one level, or over terrain, where it may break leaves in
 * its way), previews of a walk, and what keeps a standing player present and on the ground:
 * idle ticks and gravity.
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
   * Works whether or not movement is enabled; null when no fence is configured. With
   * `breakLeaves` it plans as MOVE_TO does (walkBreaks).
   */
  previewWalk(
    target: Position | null,
    breakLeaves = false,
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
      const breaks = breakLeaves ? this.walkBreaks(fence) : undefined;
      const t =
        target === null
          ? null
          : planTerrainWalk(world, fence, from, target, m.maxPathLength, breaks);
      return {
        plan:
          t === null
            ? null
            : t.ok
              ? { ok: true, waypoints: [from, ...t.moves.map((x) => x.to)], length: t.length }
              : t,
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
   * The leaves a terrain walk may break on its way (digging.ts walkBreaks), or undefined:
   * only with digging enabled (and presence ticks, which digging needs), on a fence with a
   * height range, and with an empty hotbar slot to break them with (no allowlisted tool is
   * faster on leaves, so the hand is empty; without one every break would be refused).
   * observation.ts #withWorkAreas offers stand spots with it and MOVE_TO plans with it, so a
   * stand spot a walk reaches by breaking leaves is one a MOVE_TO plans to the same way.
   */
  walkBreaks(fence: Fence): WalkBreaks | undefined {
    const cfg = this.#opts.config;
    if (!cfg.digging.enabled || !cfg.presenceTicks || fence.min.y === fence.max.y) {
      return undefined;
    }
    if (this.#core.inventory.emptyHotbarSlot() === null) return undefined;
    return walkBreaks(
      { fence, maxHeightAboveFence: cfg.digging.maxHeightAboveFence },
      this.#opts.explorationBoundary ?? null,
    );
  }

  async walkTo(
    target: Readonly<Position> | null,
    options: {
      stopForThreats: boolean;
      /** MOVE_TO: over terrain, with digging enabled, break leaves in the way (walkBreaks). */
      breakLeaves?: boolean;
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
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return failed('not walking: block data or position unknown', 'REFUSED');
    }
    // A fence on one level walks the flat pen way; a fence with a height range walks terrain.
    const terrain = fence.min.y !== fence.max.y;
    // The steps, move by move, each with what to break before it (terrain walks only).
    let moves: Array<{ breaks: readonly BlockPosition[]; steps: TerrainStep[] }>;
    let length: number;
    if (terrain) {
      const breaks = options.breakLeaves === true ? this.walkBreaks(fence) : undefined;
      const plan = planTerrainWalk(world, fence, from, target, m.maxPathLength, breaks);
      if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');
      let end = from;
      moves = plan.moves.map((move) => {
        const steps = terrainSteps(end, [move]);
        end = move.to;
        return { breaks: move.breaks ?? [], steps };
      });
      length = plan.length;
      const kinds = plan.moves.map((x) => x.kind);
      const toBreak = moves.reduce((n, mv) => n + mv.breaks.length, 0);
      this.#core.log(
        `walking ${length.toFixed(2)} blocks over terrain in ${moves.reduce((n, mv) => n + mv.steps.length, 0)} steps ` +
          `(${kinds.filter((k) => k === 'step-up').length} up, ${kinds.filter((k) => k === 'drop').length} down)` +
          (toBreak > 0 ? `, breaking ${toBreak} block(s) on the way` : ''),
      );
    } else {
      const plan = planWalk(world, fence, from, target, m.maxPathLength);
      if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');
      const steps = stepsAlong(plan.waypoints).map((pos) => ({ pos, onGround: true }));
      moves = [{ breaks: [], steps }];
      length = plan.length;
      this.#core.log(
        `walking ${length.toFixed(2)} blocks in ${steps.length} steps (${plan.waypoints.length - 1} stretch(es))`,
      );
    }
    const steps = moves.flatMap((mv) => mv.steps);
    const guard = {
      placementsAtStart: this.#core.confirmedPositions,
      // An escape (threats do not stop it) keeps going when hit, too (seen live: a retreat
      // from a skeleton stopped at its first arrow, and the next walk led back into range).
      healthAtStart: options.stopForThreats ? this.#world.health : null,
      stopForThreats: options.stopForThreats,
      terrain,
    };
    // What it broke on its way, when it broke the last one, and the inventory before the
    // walk: what the leaves dropped (a sapling, an apple) is reported with the walk.
    const broken: BlockPosition[] = [];
    let lastBreakAt: number | null = null;
    const itemsBefore = moves.some((mv) => mv.breaks.length > 0)
      ? this.#world.inventoryItems()
      : null;
    let at: Vec3 = from;
    let taken = 0;
    const stopped = (reason: string): ClientActionResult => {
      const where = this.#world.ownPosition ?? at;
      this.#core.log(`walk stopped after ${taken}/${steps.length} steps: ${reason}`);
      return failed(
        (
          `walk stopped after ${taken} of ${steps.length} steps: ${reason}` +
          (broken.length === 0 ? '' : `; it broke ${describeBroken(broken)}`)
        ).slice(0, 500),
        'FAILED',
        {
          stepsTaken: taken,
          stepsPlanned: steps.length,
          x: where.x,
          y: where.y,
          z: where.z,
          ...(broken.length === 0 ? {} : { broken: broken.length }),
        },
      );
    };

    this.#core.walking = true;
    this.stopIdle();
    try {
      for (const move of moves) {
        if (move.breaks.length > 0) {
          const before = broken.length;
          const problem = await this.#breakOnTheWay(
            move.breaks,
            fence,
            guard,
            options.protectedItems ?? new Set(),
            broken,
          );
          if (broken.length > before) lastBreakAt = this.#opts.clock.now().getTime();
          if (problem !== null) return stopped(problem);
        }
        for (const step of move.steps) {
          const next = step.pos;
          const reason = this.#stepProblem(world, fence, at, next, guard);
          if (reason !== null) return stopped(reason);
          const facing =
            Math.hypot(next.x - at.x, next.z - at.z) > 1e-9
              ? yawTowards(at, next)
              : this.#core.lastYaw;
          this.#core.lastYaw = facing;
          this.#core.send(
            outbound.playerMove(
              { x: next.x, feetY: next.y, z: next.z, yaw: facing, pitch: 0 },
              step.onGround,
            ),
          );
          this.#world.setOwnPosition(next);
          at = next;
          taken += 1;
          await delay(WALK_TICK_MS);
        }
      }
      // A correction (S08) or a kick arrives within a few ticks of a move the server rejects.
      // After breaks it also stays until what they dropped could be picked up.
      const until = lastBreakAt === null ? 0 : lastBreakAt + BREAK_DROP_WAIT_MS;
      for (let i = 0; i < SETTLE_TICKS || this.#opts.clock.now().getTime() < until; i++) {
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
      const gained =
        itemsBefore === null || broken.length === 0
          ? []
          : this.#core.dig.gainSince(itemsBefore, null);
      const drops = describeGain(gained);
      return ok(
        (
          `walked ${length.toFixed(2)} blocks in ${steps.length} steps` +
          (broken.length === 0 ? '' : `; broke ${describeBroken(broken)}`) +
          (gained.length === 0 ? '' : `; picked up ${drops}`)
        ).slice(0, 500),
        {
          steps: steps.length,
          distance: Number(length.toFixed(3)),
          x: at.x,
          y: at.y,
          z: at.z,
          ...(broken.length === 0 ? {} : { broken: broken.length, drops }),
        },
      );
    } finally {
      this.#core.walking = false;
      if (this.#core.phase === 'play') this.startIdle();
    }
  }

  /**
   * Breaks what a terrain walk's next move needs out of its way (planned by planTerrainWalk
   * with walkBreaks: leaves only), standing where the walk has got to, exactly as DIG_BLOCK
   * digs (dig-actions.ts digChecked): checkWalkBreak (checkDig's rules, leaves only, inside
   * the safety boundary) on the blocks the server sent just before each dig and every tick
   * while digging, with the walk's own guard; the dig time; C07 start and finish; success
   * only on the server's change to air with no re-send. The walk's checks come first
   * (#walkInterruption: the stop file, halt(), a correction, health, threats), and presence
   * ticks go on while the player stands and digs. A cell that is open already (a leaf
   * decayed) is passed over. Null when the way is open, else why the walk must stop;
   * `broken` collects what it broke.
   */
  async #breakOnTheWay(
    cells: readonly BlockPosition[],
    fence: Fence,
    guard: { placementsAtStart: number; healthAtStart: number | null; stopForThreats: boolean },
    protectedItems: ReadonlySet<string>,
    broken: BlockPosition[],
  ): Promise<string | null> {
    const cfg = this.#opts.config;
    const area: DigArea = { fence, maxHeightAboveFence: cfg.digging.maxHeightAboveFence };
    const boundary = this.#opts.explorationBoundary ?? null;
    for (const cell of cells) {
      const where = `(${cell.x}, ${cell.y}, ${cell.z})`;
      if (!cfg.digging.enabled) return 'digging is disabled (MC_ENABLE_DIGGING)';
      const interrupted = this.#walkInterruption(guard);
      if (interrupted !== null) return interrupted;
      const world = this.#world.walkWorld();
      if (world === null) return 'the block data became unknown';
      if (passProblem(world, cell.x, cell.y, cell.z) === null) continue;
      this.#core.digging = true;
      // The player stands while it digs: presence ticks go on, as for any dig.
      const presence = setInterval(
        () => this.#core.send(outbound.playerIdle(ON_GROUND)),
        IDLE_TICK_MS,
      );
      try {
        const rule = (w: WalkWorld, feet: Vec3): DigCheck =>
          checkWalkBreak(w, area, feet, cell, boundary);
        const dug = await this.#core.dig.digChecked(cell, rule, protectedItems, 'digging', guard);
        if (!dug.ok) {
          // A leaf that decayed while it was dug (its log was just chopped) is out of the way
          // all the same (seen live: "the server sent the block again while digging (id 0)").
          const now = this.#world.walkWorld();
          if (now !== null && passProblem(now, cell.x, cell.y, cell.z) === null) continue;
          return `breaking ${where} out of the way failed: ${dug.result.message}`;
        }
        broken.push({ x: cell.x, y: cell.y, z: cell.z });
        this.#core.log(`broke the ${dug.check.block} at ${where} out of the way`);
      } finally {
        clearInterval(presence);
        this.#core.digging = false;
      }
    }
    return null;
  }

  /** Why the next step must not be taken, or null. Checked immediately before every step. */
  #stepProblem(
    world: NonNullable<ReturnType<WorldModel['walkWorld']>>,
    fence: Fence,
    from: Vec3,
    to: Vec3,
    guard: {
      placementsAtStart: number;
      healthAtStart: number | null;
      stopForThreats: boolean;
      terrain: boolean;
    },
  ): string | null {
    const interrupted = this.#walkInterruption(guard, { from, to });
    if (interrupted !== null) return interrupted;
    // Terrain steps change height (steps up, drops), so check the body where it will be,
    // at that height; the flat walker checks the whole swept stretch.
    const problem = guard.terrain
      ? bodyProblem(world, fence, to)
      : segmentProblem(world, fence, from, to);
    return problem === null ? null : `the way ahead is not clear: ${problem}`;
  }

  /**
   * Why a walk must stop now, whatever the way ahead, or null; checked before every step and
   * every block it breaks on its way: the connection, anything that blocks walking (the stop
   * file, halt()...), a server correction or a health drop since it started, and with
   * `stopForThreats` a hostile (not a calm spider) or unidentified entity within threatRadius.
   */
  #walkInterruption(
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
      return `health dropped from ${guard.healthAtStart} to ${health}`;
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
    const support = checkSupport(world, feet);
    if (support.kind === 'unknown') return;
    // Held up for the server, the feet may still hang a little above the ground: they come
    // to rest on it, as in a game client (restingY).
    const resting = support.kind === 'supported' ? restingY(world, feet) : null;
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
    try {
      const fallen = fallDistances(feet.y - landY);
      for (const [i, d] of fallen.entries()) {
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

  stopIdle(): void {
    if (this.#idleTimer !== null) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
  }
}

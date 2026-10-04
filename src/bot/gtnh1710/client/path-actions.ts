import type { BlockPosition } from '../../../domain/common.ts';
import { TICK_MS } from '../../../domain/dig-time.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import { eyesOf, type DigArea } from '../digging.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { outbound } from '../packets.ts';
import { passProblem } from '../passable.ts';
import {
  checkPathBreak,
  checkPathPlace,
  chooseThrowaway,
  walkPolicy,
  type PolicyContext,
  type WalkPolicy,
} from '../path-policy.ts';
import { WALK_ONE_BLOCK } from '../pathing/costs.ts';
import {
  planExecution,
  type ExecutionPlan,
  type PathStep,
  type StepPlace,
} from '../pathing/execute.ts';
import { describeGoal, type Goal } from '../pathing/goals.ts';
import type { Movement } from '../pathing/movements.ts';
import { floodPath, planPath, type PathFlood, type PathResult } from '../pathing/search.ts';
import { stepProblem, validatePlan } from '../pathing/validate.ts';
import type { PlaceArea } from '../placing.ts';
import type { Fence, Vec3, WalkWorld } from '../walking.ts';
import type { BlockWatch, WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { delay, describeGain, lookAt, ON_GROUND, SETTLE_TICKS, WALK_TICK_MS } from './shared.ts';

/**
 * Walking on the pathfinder (pathing/): every walk over terrain (a fence with a height range,
 * or the play area of movement mode 'follow') is planned with planPath under the walk policy
 * (path-policy.ts: what may be broken and placed, parkour, sprinting, wading), made into
 * per-tick steps (planExecution), checked once more against the game's physics and the
 * server's checks (validatePlan), and then carried out here, segment by segment:
 *  - the segment's breaks first, standing still, upper blocks first: each dug as DIG_BLOCK
 *    digs (dig-actions.ts digChecked: the best tool carried, the dig time, every tick
 *    re-checked, success only on the server's change to air), with checkPathBreak's rules
 *    from where the player stands;
 *  - then each step as a C06 with the step's own onGround, one per tick, every step checked
 *    just before it is sent: the walk's checks (the stop file, halt(), a correction, health,
 *    threats) and the cells the body passes (pathing/validate.ts stepProblem, on the blocks as
 *    they are now). Once a step leaves the ground the steps go on to the landing without a
 *    pause: a jump cannot be held in mid-air. So every cell of the flight is checked before
 *    the take-off, and in the air only a correction or a lost connection stops it;
 *  - a block placed during the segment (a pillar, a bridge): the throwaway block held, C08
 *    against the plan's block and face with its cursor right after the step it follows,
 *    checked first with checkPathPlace; the server's block change must have come before the
 *    first step that stands on it, else a pillar sends its fallback (the same jump coming
 *    back down where it began) and the walk stops, and a bridge waits for it, standing, a
 *    second at most.
 * A break or placement refused or not confirmed ends the walk with why; the caller plans
 * again. The plan is made once, on the blocks the server sent when the walk starts.
 */

/** A walk planned on the pathfinder, before it is walked. */
interface Planned {
  readonly found: PathResult;
  readonly movements: readonly Movement[];
  readonly exec: Extract<ExecutionPlan, { ok: true }>;
  readonly policy: WalkPolicy;
  /** Blocks walked: across, plus up or down (as terrain.ts measures a walk). */
  readonly length: number;
  /** The walk ends at the goal (not a partial path, nor cut short). */
  readonly reached: boolean;
}

/** What a walk on the pathfinder is asked to do. */
export interface PathWalk {
  readonly goal: Goal;
  /** What it walks to, in words for messages ("the target", "home"). */
  readonly what: string;
  /** A hostile or unidentified entity near stops it (MOVE_TO, EXPLORE; not an escape). */
  readonly stopForThreats: boolean;
  /** Break and place on the way, as the walk policy allows (MOVE_TO, EXPLORE). */
  readonly work: boolean;
  /** Walk the best partial path when the goal is out of reach inside the play area. */
  readonly partial: boolean;
  /** Blocks walked at most: the path is cut there. */
  readonly maxLength?: number;
  /** Planned ticks of walking at most: the path is cut there (a follow step). */
  readonly maxTicks?: number;
  /** Never held for a dig (the validated action's protected items). */
  readonly protectedItems: ReadonlySet<string>;
}

/** How a refusal starts when the blocks left to walk are fewer than the next movement takes. */
export const OVER_BUDGET = 'fewer blocks are left to walk';

/** Nodes and time a walk's search may take (it runs between packets). */
const WALK_MAX_NODES = 60_000;
const WALK_MAX_MS = 500;
/** The same for the flood behind the stand spots, every observation. */
const FLOOD_MAX_NODES = 40_000;
const FLOOD_MAX_MS = 250;
/** Sprinting only on walks at least this long (blocks, straight), with food above this. */
export const SPRINT_MIN_DISTANCE = 16;
export const SPRINT_MIN_FOOD = 10;
/** A bridge's block: how long the walk stands at the edge waiting for the server's change. */
const BRIDGE_CONFIRM_TICKS = 20;
/**
 * After a walk broke blocks on its way: how long after the last break it waits before it
 * reports (the drop's 10-tick pickup delay, plus 5), so what they drop reaches the inventory
 * during the walk, not during the next action, whose own drop and inventory checks it would
 * confuse.
 */
const BREAK_DROP_WAIT_MS = 15 * TICK_MS;
/** Idle ticks while the player stands and digs. */
const IDLE_TICK_MS = 50;

const fmt = (c: { x: number; y: number; z: number }): string => `(${c.x}, ${c.y}, ${c.z})`;
const cellKey = (c: { x: number; y: number; z: number }): string => `${c.x},${c.y},${c.z}`;
const centre = (c: { x: number; y: number; z: number }): Vec3 => ({
  x: c.x + 0.5,
  y: c.y,
  z: c.z + 0.5,
});

/** Blocks walked by `movements` from `from`: the centring, then across plus up or down. */
export function pathLength(from: Vec3, start: Vec3 | null, movements: readonly Movement[]): number {
  let at = start === null ? from : centre(start);
  let length = Math.hypot(at.x - from.x, at.z - from.z);
  for (const m of movements) {
    const to = centre(m.to);
    length += Math.hypot(to.x - at.x, to.z - at.z) + Math.abs(to.y - at.y);
    at = to;
  }
  return length;
}

/** "2 leaves", "1 dirt and 2 leaves": what a walk broke, by kind. */
function describeKinds(blocks: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b, (counts.get(b) ?? 0) + 1);
  return [...counts]
    .map(([b, n]) => {
      const short = b.replace(/^minecraft:/, '');
      return /leaves/.test(short) ? `${n} ${n === 1 ? 'leaf block' : 'leaves'}` : `${n} ${short}`;
    })
    .join(' and ');
}

/** What a walk broke: "2 leaves on the way: (1, 64, 0), (1, 65, 0)". */
function describeBroken(broken: ReadonlyArray<{ cell: BlockPosition; block: string }>): string {
  const kinds = describeKinds(broken.map((b) => b.block));
  return `${kinds} on the way: ${broken.map((b) => fmt(b.cell)).join(', ')}`;
}

/** A click of a walk's placement, and what the server answered. */
interface Click {
  readonly place: StepPlace;
  readonly clicked: BlockWatch;
  readonly cell: BlockWatch;
  readonly sentClicked: number;
  readonly sentCell: number;
  readonly blockId: number;
}

export class PathActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;
  /** The protected items the last validated walk carried: the stand spots' flood uses them. */
  #lastProtected: ReadonlySet<string> = new Set();

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Other players the client sees (never the bot itself), where they stand. */
  #players(): Vec3[] {
    return this.#world
      .trackedEntities()
      .filter((e) => e.kind === 'player' && e.diedAt == null)
      .map((e) => ({ x: e.x, y: e.y, z: e.z }));
  }

  /** The policy's view of the world now: the boundary, and the other players. */
  #context(): PolicyContext {
    return { boundary: this.#opts.explorationBoundary ?? null, players: this.#players() };
  }

  /** Sprinting on this walk: allowed, the food bar high, and the goal far enough. */
  #sprintFor(goal: Goal, from: Vec3): boolean {
    if (!this.#opts.config.movement.path.allowSprint) return false;
    const food = this.#world.food;
    return (
      food !== null && food > SPRINT_MIN_FOOD && goalDistance(goal, from) >= SPRINT_MIN_DISTANCE
    );
  }

  /**
   * The walk policy for a walk now (path-policy.ts): what it may break and place, with the
   * tools and throwaway blocks the player carries, and the other players where they stand.
   * `work` false (an escape, the walk to a drop) breaks and places nothing.
   */
  policy(
    world: WalkWorld,
    fence: Fence,
    request: { work: boolean; protectedItems: ReadonlySet<string>; sprint: boolean },
  ): WalkPolicy {
    const cfg = this.#opts.config;
    const items = this.#world.inventoryItems();
    const terrain = fence.min.y !== fence.max.y;
    return walkPolicy({
      world,
      ...this.#context(),
      settings: cfg.movement.path,
      breaking: request.work && terrain && cfg.digging.enabled && cfg.presenceTicks,
      placing: request.work && terrain && cfg.placing.enabled && cfg.presenceTicks,
      digHeight: cfg.digging.maxHeightAboveFence,
      digTicks: (block, meta) => this.#core.dig.digTicksFor(block, meta, request.protectedItems),
      throwaway:
        items === null
          ? null
          : chooseThrowaway(items, request.protectedItems, cfg.movement.path.throwawayReserve),
      sprint: request.sprint,
    });
  }

  /**
   * Every feet block a walk with MOVE_TO's policy reaches from where the player stands, and
   * what each costs (pathing/search.ts floodPath), within about twice maxPathLength blocks of
   * walking: where GATHER's stand spots are looked for (observation.ts). Null when the
   * position or the blocks are not known.
   */
  reachable(fence: Fence): PathFlood | null {
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null || fence.min.y === fence.max.y) return null;
    const policy = this.policy(world, fence, {
      work: true,
      protectedItems: this.#lastProtected,
      sprint: false,
    });
    return floodPath(world, fence, feet, {
      ...policy.options,
      maxCost: this.#opts.config.movement.maxPathLength * WALK_ONE_BLOCK * 2,
      maxNodes: FLOOD_MAX_NODES,
      maxTimeMs: FLOOD_MAX_MS,
    });
  }

  /**
   * Plans a walk (without moving): the path, its steps, checked by the step validator. A
   * refusal says why there is no walk.
   */
  plan(
    world: WalkWorld,
    fence: Fence,
    from: Vec3,
    request: PathWalk,
  ): ({ ok: true } & Planned) | { ok: false; reason: string } {
    const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
    const policy = this.policy(world, fence, {
      work: request.work,
      protectedItems: request.protectedItems,
      sprint: this.#sprintFor(request.goal, from),
    });
    const found = planPath(world, fence, from, request.goal, {
      ...policy.options,
      maxNodes: WALK_MAX_NODES,
      maxTimeMs: WALK_MAX_MS,
    });
    if (found.status === 'none' || (found.status === 'partial' && !request.partial)) {
      return refuse(
        `there is no walkable path to ${request.what} inside the fence (${found.reason})`,
      );
    }
    let movements = [...found.movements];
    const start = found.start;
    if (request.maxLength !== undefined) {
      const budget = request.maxLength;
      while (movements.length > 0 && pathLength(from, start, movements) > budget + 1e-6) {
        movements.pop();
      }
      if (movements.length === 0 && found.movements.length > 0) {
        return refuse(
          `${OVER_BUDGET} (${budget.toFixed(1)}) than the next movement toward ${request.what} takes`,
        );
      }
    }
    if (request.maxTicks !== undefined) {
      let ticks = 0;
      const kept: Movement[] = [];
      for (const m of movements) {
        if (kept.length > 0 && ticks + m.cost > request.maxTicks) break;
        ticks += m.cost;
        kept.push(m);
      }
      movements = kept;
    }
    let exec = planExecution(world, fence, from, movements, { water: policy.water });
    if (!exec.ok && request.partial && exec.movement > 0) {
      // Walk the part before the movement that cannot be driven; the next plan goes on.
      movements = movements.slice(0, exec.movement);
      exec = planExecution(world, fence, from, movements, { water: policy.water });
    }
    if (!exec.ok) return refuse(`the path to ${request.what} cannot be walked: ${exec.reason}`);
    const valid = validatePlan(world, fence, from, exec, { water: policy.water });
    if (!valid.ok) {
      return refuse(
        `the planned steps break a rule (movement ${valid.segment}, step ${valid.step + 1}): ${valid.reason}`,
      );
    }
    return {
      ok: true,
      found,
      movements,
      exec,
      policy,
      length: pathLength(from, start, movements),
      reached: found.status === 'reached' && movements.length === found.movements.length,
    };
  }

  /**
   * Walks to `request.goal` on the pathfinder (see the file comment). OK when it walked its
   * whole plan (`data.reached`: at the goal; else a partial path's end); FAILED when something
   * stopped it on the way; REFUSED when it could not start (nothing was sent).
   */
  async walk(request: PathWalk): Promise<ClientActionResult> {
    const m = this.#opts.config.movement;
    const blocker = this.#core.movement.movementBlocker();
    const area = this.#core.fence();
    const fence = area.fence;
    if (blocker !== null || fence === null) {
      return failed(
        `not walking: ${blocker ?? area.problem}`,
        m.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED',
      );
    }
    if (this.#core.walking) return failed('not walking: a walk is already in progress', 'REFUSED');
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return failed('not walking: block data or position unknown', 'REFUSED');
    }
    if (request.work) this.#lastProtected = request.protectedItems;
    const planned = this.plan(world, fence, from, request);
    if (!planned.ok) return failed(`not walking: ${planned.reason}`.slice(0, 500), 'REFUSED');
    return this.#execute(planned, fence, from, request);
  }

  async #execute(
    planned: Planned,
    fence: Fence,
    from: Vec3,
    request: PathWalk,
  ): Promise<ClientActionResult> {
    const cfg = this.#opts.config;
    const { exec, policy, movements } = planned;
    const total = exec.segments.reduce((n, s) => n + s.steps.length, 0);
    const kinds = movements.map((mv) => mv.kind);
    const count = (k: string): number => kinds.filter((x) => x === k).length;
    const toBreak = exec.segments.reduce((n, s) => n + s.breaks.length, 0);
    const toPlace = exec.segments.reduce((n, s) => n + s.places.length, 0);
    this.#core.log(
      `walking ${planned.length.toFixed(2)} blocks to ${request.what} in ${total} steps ` +
        `(${count('ascend') + count('pillar')} up, ${count('descend') + count('fall')} down` +
        (count('parkour') > 0 ? `, ${count('parkour')} jump(s)` : '') +
        `)${toBreak > 0 ? `, breaking ${toBreak} block(s)` : ''}${toPlace > 0 ? `, placing ${toPlace} block(s)` : ''}` +
        `${planned.reached ? '' : ' (part of the way)'}; ${policy.summary}`,
    );
    const guard = {
      placementsAtStart: this.#core.confirmedPositions,
      // An escape (threats do not stop it) keeps going when hit, too (seen live: a retreat
      // from a skeleton stopped at its first arrow, and the next walk led back into range).
      healthAtStart: request.stopForThreats ? this.#world.health : null,
      stopForThreats: request.stopForThreats,
    };
    const digArea: DigArea = { fence, maxHeightAboveFence: cfg.digging.maxHeightAboveFence };
    const placeArea: PlaceArea = { fence, maxHeightAboveFence: cfg.placing.maxHeightAboveFence };
    const broken: Array<{ cell: BlockPosition; block: string }> = [];
    const placed: BlockPosition[] = [];
    const ownPlaced = new Set<string>();
    const clicks = new Map<StepPlace, Click>();
    let lastBreakAt: number | null = null;
    const itemsBefore = toBreak > 0 ? this.#world.inventoryItems() : null;
    let at: Vec3 = from;
    let taken = 0;
    let sprinted = 0;
    /**
     * Sprinting as the server sees it (C0B START/STOP_SPRINTING): on while the steps sprint,
     * off before every dig and placement, at the end, and whenever the walk stops.
     */
    let sprinting = false;
    const self = this.#world.selfEntityId;
    const setSprint = (on: boolean): void => {
      if (on === sprinting || self === null || this.#core.phase !== 'play') return;
      this.#core.send(outbound.entityAction(self, on ? 'start-sprinting' : 'stop-sprinting'));
      sprinting = on;
    };
    const stopped = (reason: string): ClientActionResult => {
      const where = this.#world.ownPosition ?? at;
      this.#core.log(`walk stopped after ${taken}/${total} steps: ${reason}`);
      return failed(
        (
          `walk stopped after ${taken} of ${total} steps: ${reason}` +
          (broken.length === 0 ? '' : `; it broke ${describeBroken(broken)}`) +
          (placed.length === 0 ? '' : `; it placed ${placed.length} block(s)`)
        ).slice(0, 500),
        'FAILED',
        {
          stepsTaken: taken,
          stepsPlanned: total,
          x: where.x,
          y: where.y,
          z: where.z,
          ...(broken.length === 0 ? {} : { broken: broken.length }),
          ...(placed.length === 0 ? {} : { placed: placed.length }),
        },
      );
    };
    /** Sends one step (C06), looking where `look` says (or along the move). */
    const send = (step: PathStep, look: Vec3 | null): void => {
      const next = step.pos;
      let yaw = this.#core.lastYaw;
      let pitch = 0;
      if (look !== null) {
        const l = lookAt(eyesOf(next), look);
        yaw = l.yaw;
        pitch = l.pitch;
      } else if (Math.hypot(next.x - at.x, next.z - at.z) > 1e-9) {
        yaw = lookAt(at, { x: next.x, y: at.y, z: next.z }).yaw;
      }
      this.#core.lastYaw = yaw;
      setSprint(step.sprint);
      if (step.sprint) sprinted += 1;
      this.#core.send(
        outbound.playerMove({ x: next.x, feetY: next.y, z: next.z, yaw, pitch }, step.onGround),
      );
      this.#world.setOwnPosition(next);
      at = next;
      taken += 1;
    };
    /** Why the walk must stop even in mid-air: the connection, or a server correction. */
    const hardStop = (): string | null => {
      if (this.#core.phase !== 'play') return 'the connection closed';
      if (this.#core.confirmedPositions !== guard.placementsAtStart) return this.#core.corrected();
      return null;
    };
    /** Sends steps without a pause (a fallback in mid-air): only a hard stop ends them. */
    const sendRun = async (steps: readonly PathStep[]): Promise<string | null> => {
      for (const step of steps) {
        const hard = hardStop();
        if (hard !== null) return hard;
        send(step, null);
        await delay(WALK_TICK_MS);
      }
      return null;
    };

    // The throwaway block in hand before the first step (moving a stack into the hotbar takes
    // window clicks: none while the player moves).
    let holding: number | null = null;
    const placeBlock = exec.segments.flatMap((s) => s.places)[0]?.block ?? null;
    if (placeBlock !== null) {
      const held = await this.#core.place.holdBlockItem(placeBlock);
      if (!held.ok)
        return failed(`not walking: holding ${placeBlock} to place: ${held.reason}`, 'REFUSED');
      holding = held.slot;
    }

    this.#core.walking = true;
    this.#core.movement.stopIdle();
    try {
      for (const seg of exec.segments) {
        if (seg.breaks.length > 0) {
          setSprint(false);
          const before = broken.length;
          const problem = await this.#breakAll(
            seg.breaks.map((b) => b.cell),
            digArea,
            guard,
            request.protectedItems,
            broken,
          );
          if (broken.length > before) lastBreakAt = this.#opts.clock.now().getTime();
          if (problem !== null) return stopped(problem);
        }
        if (seg.places.length > 0 && placeBlock !== null) {
          setSprint(false);
          // Breaks hold another slot; and a stack placed to its end leaves the slot empty.
          const slot = await this.#holdAgain(holding, placeBlock);
          if (typeof slot === 'string') return stopped(slot);
          holding = slot;
        }
        let airborne = false;
        for (let i = 0; i < seg.steps.length; i++) {
          const step = seg.steps[i] as PathStep;
          // A block placed in this segment must be there before the step that stands on it.
          for (const p of seg.places) {
            if (p.neededBy !== i) continue;
            const click = clicks.get(p);
            let verdict = click === undefined ? 'not clicked' : this.#verdict(click);
            if (verdict === 'pending' && !airborne) {
              // A bridge: the player stands at the edge; it waits for the server a moment.
              verdict = await this.#awaitVerdict(click as Click, guard);
            }
            if (verdict !== 'placed') {
              const why = `the block placed at ${fmt(p.cell)} was not there in time (${verdict})`;
              if (seg.fallback !== null && seg.fallback.fromStep === i) {
                const hard = await sendRun(seg.fallback.steps);
                return stopped(hard ?? `${why}: came back down where the jump began`);
              }
              return stopped(why);
            }
            placed.push({ ...p.cell });
            ownPlaced.add(cellKey(p.cell));
          }
          const hard = hardStop();
          if (hard !== null) return stopped(hard);
          if (!airborne) {
            const soft = this.#core.movement.walkInterruption(guard, { from: at, to: step.pos });
            if (soft !== null) return stopped(soft);
            // This step, and when it leaves the ground every step to the landing: no pause in
            // the air.
            const why = this.#flightProblem(fence, at, seg.steps, i, policy.water);
            if (why !== null) return stopped(`the way ahead is not clear: ${why}`);
            // Sprinting only while the food bar stays above 10 (HungerOverhaul: it costs food).
            const food = this.#world.food;
            if (step.sprint && (food === null || food <= SPRINT_MIN_FOOD)) {
              return stopped(
                `the food bar is at ${food ?? 'an unknown level'}: no sprinting with food at ${SPRINT_MIN_FOOD} or less`,
              );
            }
          }
          const placing = seg.places.filter((p) => p.afterStep === i);
          const point =
            placing[0] === undefined
              ? null
              : {
                  x: placing[0].against.x + placing[0].cursor.x / 16,
                  y: placing[0].against.y + placing[0].cursor.y / 16,
                  z: placing[0].against.z + placing[0].cursor.z / 16,
                };
          send(step, point);
          airborne = !step.onGround;
          if (placing.length > 0) setSprint(false);
          for (const p of placing) {
            const why = this.#placeProblem(p, placeArea, guard, ownPlaced);
            if (why !== null) {
              if (airborne && seg.fallback !== null) {
                const hard = await sendRun(seg.fallback.steps.slice(0));
                return stopped(hard ?? `not placing at ${fmt(p.cell)}: ${why}`);
              }
              return stopped(`not placing at ${fmt(p.cell)}: ${why}`);
            }
            const click = this.#click(p, holding as number);
            if (typeof click === 'string') return stopped(click);
            clicks.set(p, click);
          }
          await delay(WALK_TICK_MS);
        }
      }
      setSprint(false);
      // A correction (S08) or a kick arrives within a few ticks of a move the server rejects.
      // After breaks it also stays until what they dropped could be picked up.
      const until = lastBreakAt === null ? 0 : lastBreakAt + BREAK_DROP_WAIT_MS;
      for (let i = 0; i < SETTLE_TICKS || this.#opts.clock.now().getTime() < until; i++) {
        const hard = hardStop();
        if (hard !== null)
          return stopped(
            hard === 'the connection closed' ? hard : 'the server corrected the final position',
          );
        this.#core.send(outbound.playerIdle(ON_GROUND));
        await delay(WALK_TICK_MS);
      }
      const hard = hardStop();
      if (hard !== null) {
        return stopped(
          hard === 'the connection closed' ? hard : 'the server corrected the final position',
        );
      }
      const gained =
        itemsBefore === null || broken.length === 0
          ? []
          : this.#core.dig.gainSince(itemsBefore, null);
      const drops = describeGain(gained);
      const length = planned.length;
      return ok(
        (
          `walked ${length.toFixed(2)} blocks in ${taken} steps` +
          (planned.reached ? '' : ` toward ${request.what}`) +
          (broken.length === 0 ? '' : `; broke ${describeBroken(broken)}`) +
          (placed.length === 0
            ? ''
            : `; placed ${placed.length} block(s): ${placed.map(fmt).join(', ')}`) +
          (gained.length === 0 ? '' : `; picked up ${drops}`) +
          (sprinted === 0 ? '' : `; sprinted ${sprinted} of the steps`)
        ).slice(0, 500),
        {
          steps: taken,
          distance: Number(length.toFixed(3)),
          x: at.x,
          y: at.y,
          z: at.z,
          reached: planned.reached,
          ...(sprinted === 0 ? {} : { sprinted }),
          ...(broken.length === 0 ? {} : { broken: broken.length, drops }),
          ...(placed.length === 0 ? {} : { placed: placed.length }),
        },
      );
    } finally {
      setSprint(false);
      for (const c of clicks.values()) {
        this.#world.unwatch(c.clicked);
        this.#world.unwatch(c.cell);
      }
      this.#core.walking = false;
      if (this.#core.phase === 'play') this.#core.movement.startIdle();
    }
  }

  /**
   * Why step `i` (from `at`), and when it leaves the ground every step until the landing,
   * would take the body where it must not be, on the blocks as they are now, or null.
   */
  #flightProblem(
    fence: Fence,
    at: Vec3,
    steps: readonly PathStep[],
    i: number,
    water: boolean,
  ): string | null {
    const world = this.#world.walkWorld();
    if (world === null) return 'the block data became unknown';
    let prev = at;
    for (let k = i; k < steps.length; k++) {
      const step = steps[k] as PathStep;
      const why = stepProblem(world, fence, prev, step.pos, water);
      if (why !== null) return why;
      if (step.onGround) break;
      prev = step.pos;
    }
    return null;
  }

  /**
   * Breaks what the next movement needs out of its way, standing where the walk has got to,
   * exactly as DIG_BLOCK digs (dig-actions.ts digChecked), with checkPathBreak's rules on the
   * blocks the server sent just before each dig and every tick while digging, and the walk's
   * own guard; the walk's checks come first (the stop file, halt(), a correction, health,
   * threats), and presence ticks go on while the player stands and digs. A cell that is open
   * already (a leaf decayed) is passed over. Null when the way is open, else why the walk must
   * stop; `broken` collects what it broke.
   */
  async #breakAll(
    cells: readonly BlockPosition[],
    area: DigArea,
    guard: { placementsAtStart: number; healthAtStart: number | null; stopForThreats: boolean },
    protectedItems: ReadonlySet<string>,
    broken: Array<{ cell: BlockPosition; block: string }>,
  ): Promise<string | null> {
    const cfg = this.#opts.config;
    for (const cell of cells) {
      const where = fmt(cell);
      if (!cfg.digging.enabled) return 'digging is disabled (MC_ENABLE_DIGGING)';
      const interrupted = this.#core.movement.walkInterruption(guard);
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
        const rule = (w: WalkWorld, feet: Vec3) =>
          checkPathBreak(w, area, feet, cell, this.#context());
        const dug = await this.#core.dig.digChecked(cell, rule, protectedItems, 'digging', guard);
        if (!dug.ok) {
          // A leaf that decayed while it was dug (its log was just chopped) is out of the way
          // all the same (seen live: "the server sent the block again while digging (id 0)").
          const now = this.#world.walkWorld();
          if (now !== null && passProblem(now, cell.x, cell.y, cell.z) === null) continue;
          return `breaking ${where} out of the way failed: ${dug.result.message}`;
        }
        broken.push({ cell: { x: cell.x, y: cell.y, z: cell.z }, block: dug.check.block });
        this.#core.log(`broke the ${dug.check.block} at ${where} out of the way`);
      } finally {
        clearInterval(presence);
        this.#core.digging = false;
      }
    }
    return null;
  }

  /**
   * The hotbar slot holding `block` again for the next placement (a dig selected another
   * slot; the stack may have run out), or why there is none.
   */
  async #holdAgain(slot: number | null, block: string): Promise<number | string> {
    const registry = this.#world.registry;
    const s = slot === null ? null : (this.#world.playerStorage()?.[27 + slot] ?? null);
    const name = s === null ? undefined : (registry?.items.get(s.id) ?? registry?.blocks.get(s.id));
    if (
      slot !== null &&
      s !== null &&
      name === block &&
      s.damage === 0 &&
      !s.hasNbt &&
      s.count > 0
    ) {
      if (this.#world.heldSlot !== slot) {
        this.#core.send(outbound.selectHotbarSlot(slot));
        this.#world.setHeldSlot(slot);
      }
      return slot;
    }
    const held = await this.#core.place.holdBlockItem(block);
    return held.ok ? held.slot : `holding ${block} to place: ${held.reason}`;
  }

  /** Why the placement `p` must not be clicked now (checkPathPlace, and the walk's guard), or null. */
  #placeProblem(
    p: StepPlace,
    area: PlaceArea,
    guard: { placementsAtStart: number; healthAtStart: number | null; stopForThreats: boolean },
    ownPlaced: ReadonlySet<string>,
  ): string | null {
    if (!this.#opts.config.placing.enabled) return 'placing is disabled (MC_ENABLE_PLACING)';
    // Placing is never an escape: a threat stops it, whatever the walk.
    const interrupted = this.#core.dig.interruption(guard) ?? this.#core.movement.movementBlocker();
    if (interrupted !== null) return interrupted;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) return 'block data or position unknown';
    const entities = this.#world
      .trackedEntities()
      .filter((e) => e.item === undefined)
      .map(({ x, y, z }) => ({ x, y, z }));
    return checkPathPlace(world, area, feet, p, { ...this.#context(), entities, ownPlaced });
  }

  /**
   * C08 against the plan's block and face, with its cursor and the held stack exactly as held,
   * and the arm swung; the clicked block and the cell are watched for the server's answer. A
   * string says why it could not be sent.
   */
  #click(p: StepPlace, slot: number): Click | string {
    const registry = this.#world.registry;
    const blockId =
      registry === null ? null : ([...registry.blocks].find(([, n]) => n === p.block)?.[0] ?? null);
    const held = this.#world.playerStorage()?.[27 + slot] ?? null;
    if (blockId === null || held === null || held.hasNbt || this.#world.heldSlot !== slot) {
      return `not placing at ${fmt(p.cell)}: ${p.block} is not held`;
    }
    const clicked = this.#world.watchBlock(p.against.x, p.against.y, p.against.z);
    const cell = this.#world.watchBlock(p.cell.x, p.cell.y, p.cell.z);
    const sentClicked = clicked.updates.length;
    const sentCell = cell.updates.length;
    // The cell's change is the agent's own: never a player's build.
    this.#world.expectOwnPlacement(p.cell, this.#opts.clock.now());
    this.#core.send(
      outbound.placeBlock(
        p.against.x,
        p.against.y,
        p.against.z,
        p.face,
        held,
        p.cursor,
        this.#core.decoding.itemStackSizeVarInt,
      ),
    );
    const self = this.#world.selfEntityId;
    if (self !== null) this.#core.send(outbound.swingArm(self));
    this.#core.log(
      `placing ${p.block} at ${fmt(p.cell)} against ${fmt(p.against)}, face ${p.face}`,
    );
    return { place: p, clicked, cell, sentClicked, sentCell, blockId };
  }

  /**
   * What the server answered a click: the cell's updates after its answer for the clicked
   * block (as place-actions.ts reads it): 'placed' when the first is the block (and none since
   * says otherwise), 'refused' when it is not, 'pending' with no answer yet.
   */
  #verdict(c: Click): 'placed' | 'refused' | 'pending' {
    const ack = c.clicked.order[c.sentClicked];
    if (ack === undefined) return 'pending';
    const answers = c.cell.updates.filter(
      (_, i) => i >= c.sentCell && (c.cell.order[i] ?? 0) > ack,
    );
    if (answers.length === 0) return 'pending';
    return answers.every((id) => id === c.blockId) ? 'placed' : 'refused';
  }

  /**
   * Waits, standing (idle ticks), for the server's answer to a bridge's click, a second at
   * most: 'placed', 'refused', 'pending', or why the walk must stop meanwhile.
   */
  async #awaitVerdict(
    c: Click,
    guard: { placementsAtStart: number; healthAtStart: number | null; stopForThreats: boolean },
  ): Promise<string> {
    for (let t = 0; t < BRIDGE_CONFIRM_TICKS; t++) {
      const v = this.#verdict(c);
      if (v !== 'pending') return v;
      const why = this.#core.movement.walkInterruption(guard);
      if (why !== null) return why;
      this.#core.send(outbound.playerIdle(ON_GROUND));
      await delay(WALK_TICK_MS);
    }
    return this.#verdict(c);
  }
}

/** How far (blocks, straight) the goal is from `from`, as far as the goal says. */
export function goalDistance(goal: Goal, from: Vec3): number {
  switch (goal.kind) {
    case 'block':
      return Math.hypot(goal.x + 0.5 - from.x, goal.y - from.y, goal.z + 0.5 - from.z);
    case 'near':
      return Math.max(
        0,
        Math.hypot(goal.x - from.x, goal.y - from.y, goal.z - from.z) - goal.radius,
      );
    case 'xz':
      return Math.hypot(goal.x + 0.5 - from.x, goal.z + 0.5 - from.z);
    case 'get-to-block':
      return Math.max(
        0,
        Math.hypot(goal.x + 0.5 - from.x, goal.y + 0.5 - from.y, goal.z + 0.5 - from.z) -
          goal.reach,
      );
    case 'y':
      return Math.abs(goal.y - from.y);
    case 'any':
      return Math.min(...goal.goals.map((g) => goalDistance(g, from)));
    case 'away': {
      let need = 0;
      for (const p of goal.from)
        need = Math.max(need, goal.distance - Math.hypot(from.x - p.x, from.z - p.z));
      return need;
    }
  }
}

/** The goal in words, for messages. */
export { describeGoal };

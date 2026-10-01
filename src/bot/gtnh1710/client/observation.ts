import type { GameState } from '../../../domain/game-state.ts';
import { parseObservedStorageId } from '../../../domain/interactions.ts';
import { known } from '../../../domain/known.ts';
import type { SeenChunk } from '../../../domain/world-memory.ts';
import { errorMessage } from '../../../util/json.ts';
import { standSpotFor, underFeetOf, type DigArea } from '../digging.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { interactAreaProblem, interactStandSpot } from '../interact.ts';
import { placeAreaProblem, type PlaceArea } from '../placing.ts';
import { reachableFeet } from '../terrain.ts';
import { parseObservedTableId, type WorldModel } from '../world-model.ts';
import { SurveyTracker } from '../world-survey.ts';
import type { ClientCore } from './core.ts';

/** The server sends at least a time update every second; within this window the state is current. */
const FRESHNESS_WINDOW_MS = 3_000;

/**
 * What observe() reports: the world model's GameState, with the interactable blocks the agent
 * may use and the work areas (stand spots to dig from, cells to place in) fitted to the fence
 * of the moment, and the surveys of what the player sees, for world memory (world-survey.ts).
 */
export class Observation {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;
  /** What the player has seen around it, for world memory (world-survey.ts). */
  readonly #surveys = new SurveyTracker();

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  async observe(): Promise<GameState> {
    if (this.#core.phase !== 'play') {
      throw new Error(
        this.#core.closedReason === null
          ? 'not connected'
          : `connection lost: ${this.#core.closedReason}`,
      );
    }
    // A player the server put in the air lands first (#keepSupported), so what is observed,
    // the night pit's "standing on a block" above all, sees it on the ground. Seen live: saved
    // mid-jump at logout, the player joined 0.42 above the sand, and the session went offline
    // for the night ("no pit: the player is not standing on a block").
    await this.#core.movement.keepSupported();
    if (this.#core.phase !== 'play') {
      throw new Error(`connection lost: ${this.#core.closedReason ?? 'closed'}`);
    }
    const now = this.#opts.clock.now();
    const last = this.#world.lastPacketAt;
    // While packets keep arriving the model is current; if the server goes quiet the
    // timestamp stops advancing, so the safety policy's staleness check fires.
    const asOf = last !== null && now.getTime() - last.getTime() > FRESHNESS_WINDOW_MS ? last : now;
    this.survey(false);
    return this.#withInteractables(this.#withWorkAreas(this.#world.toGameState(asOf)));
  }

  /**
   * Keeps only the interactable blocks (and found crafting tables) the agent may use inside
   * the fence of the moment (#fence()), and adds where to stand to use each (interact.ts).
   */
  #withInteractables(state: GameState): GameState {
    if (!state.interactables.known) return state;
    const fence = this.#core.fence().fence;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
    const blocks = state.interactables.value.blocks
      .filter((b) => interactAreaProblem(fence, b.position) === null)
      .map((b) =>
        fence === null || world === null || feet === null
          ? b
          : { ...b, standAt: interactStandSpot(world, fence, b.position, feet) },
      );
    const kept = new Set(blocks.map((b) => key(b.position)));
    return {
      ...state,
      interactables: { known: true, value: { ...state.interactables.value, blocks } },
      craftingTables: state.craftingTables.filter((t) => {
        const observed = parseObservedTableId(t.id);
        return observed === null || kept.has(key(observed));
      }),
      storage: state.storage.filter((s) => {
        const observed = parseObservedStorageId(s.id);
        return observed === null || kept.has(key(observed.position));
      }),
    };
  }

  /**
   * Surveys what the player sees around it, when due (world-survey.ts: on entering another
   * chunk, every 30 s, or `force`). A survey problem is logged, never thrown: observing and
   * walking go on without it.
   */
  survey(force: boolean): SeenChunk[] {
    const feet = this.#world.ownPosition;
    if (feet === null) return [];
    try {
      return this.#surveys.update(this.#world, feet, this.#opts.clock.now(), force);
    } catch (error) {
      this.#core.log(`world survey failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /** What the player has seen since the last call, per chunk (for world memory). */
  takeSeenChunks(): SeenChunk[] {
    return this.#surveys.drain();
  }

  /**
   * Fits the nearby blocks to the fence. Digging enabled: adds, for the listed diggable
   * blocks, where the player can stand to dig each (digging.ts standSpotFor), so a planner
   * can walk there and dig. Placing enabled: keeps only the placeable cells inside the area
   * placing may change. Without the fence (or with both disabled) they are left as they are.
   */
  #withWorkAreas(state: GameState): GameState {
    const cfg = this.#opts.config;
    const fence = this.#core.fence().fence;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (fence === null || world === null || feet === null) return state;
    if (!state.nearbyBlocks.known) return state;
    let blocks = state.nearbyBlocks.value;
    if (cfg.digging.enabled) {
      const area: DigArea = {
        fence,
        maxHeightAboveFence: cfg.digging.maxHeightAboveFence,
      };
      // Only stand spots a walk from here reaches (seen live: logs walled in by leaves,
      // cactus and foliage were offered, and every walk to them failed). Terrain fences only:
      // a one-level fence (the pen) walks by planWalk, which the flood does not model. When
      // the player cannot walk at all, blocks in reach stay diggable where it stands. A
      // walk may break leaves on its way (#walkBreaks), as a MOVE_TO there then does.
      const reachable =
        fence.min.y === fence.max.y
          ? undefined
          : reachableFeet(
              world,
              fence,
              feet,
              cfg.movement.maxPathLength,
              this.#core.movement.walkBreaks(fence),
            );
      const walkable = reachable !== undefined && reachable.size > 0 ? reachable : undefined;
      blocks = {
        ...blocks,
        resources: blocks.resources.map((r) => ({
          ...r,
          standAt: standSpotFor(world, area, r.position, feet, walkable),
        })),
        // The ground in the player's own column (DIG_DOWN, the night pit only).
        underFeet: underFeetOf(world, feet),
      };
    }
    if (cfg.placing.enabled) {
      const area: PlaceArea = {
        fence,
        maxHeightAboveFence: cfg.placing.maxHeightAboveFence,
      };
      blocks = {
        ...blocks,
        placeable: blocks.placeable.filter(
          (c) => placeAreaProblem(area, feet, c.position) === null,
        ),
      };
    }
    return { ...state, nearbyBlocks: known(blocks) };
  }
}

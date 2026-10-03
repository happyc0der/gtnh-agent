import {
  actionDrops,
  cellText,
  describeDrop,
  DROP_SETTLE_WAIT_MS,
  MAX_DROP_WALKS,
  planDropFetch,
} from '../drops.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import type { Vec3 } from '../walking.ts';
import { ENTITY_SCAN_RADIUS, type ItemEntity, type WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { describeGain, DROP_WAIT_MS } from './shared.ts';

/** An action's drops to pick up. */
export interface DropRequest {
  /** Where they appeared: the dug block's centre, or where the animal died. */
  origin: Vec3;
  /** How far from `origin` they may have appeared (drops.ts DIG_/KILL_DROP_SPAWN_RADIUS). */
  spawnRadius: number;
  /** When the action began: an item that appeared before is not one of its drops. */
  since: Date;
  /** The inventory before the action began, to tell what arrived. */
  itemsBefore: Readonly<Record<string, number>>;
  /** Gains that are no drop: the tool or weapon used (its wear changes its name). */
  notDrop: (item: string) => boolean;
}

/** What became of an action's drops. */
export interface DropOutcome {
  /** What reached the inventory since the action began (never the tool or weapon). */
  gained: Array<[string, number]>;
  /** Walks to drops. */
  walks: number;
  /** The action's drops still lying in the world. */
  left: number;
  /** What happened, for the action's result: what was picked up where, and what was left, why. */
  note: string;
}

/**
 * Picking up what a dig or a kill dropped when it did not reach the inventory by itself
 * (drops.ts has the rules): DIG_BLOCK's drop (dig-actions.ts dig) and a killed farm animal's
 * (combat-actions.ts), as a player walks over to what fell.
 */
export class DropActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /**
   * The action's drops lying in the world now (drops.ts actionDrops: the items that appeared
   * since it began, where its drops appear), or why they cannot be told (an entity update was
   * lost).
   */
  lying(req: DropRequest): ItemEntity[] | string {
    const near = this.#world.itemEntitiesNear(
      req.origin,
      ENTITY_SCAN_RADIUS,
      this.#opts.clock.now(),
    );
    if (!near.known) return near.reason;
    return actionDrops(near.value, req.origin, req.since, req.spawnRadius);
  }

  /**
   * Picks up the action's drops (lying). First each must lie still (world-model.ts: the server
   * shows where an item came to rest 20 ticks after it appeared) or be picked up, for at most
   * DROP_SETTLE_WAIT_MS; one still moving then is left. Then, nearest first: one within the
   * pickup reach is waited for (DROP_WAIT_MS); another is walked to, where drops.ts
   * planDropFetch puts the player (an ordinary checked walk inside the fence, movement-actions.ts
   * walkTo: it stops for threats and breaks nothing), at most MAX_DROP_WALKS of them, and its
   * pickup waited for. A drop with no spot to fetch it from, no way there, or past the walks
   * is left; a walk stopped on the way (a threat, a correction) ends the fetching. The note
   * says what was picked up where, and what was left there and why.
   */
  async collect(req: DropRequest): Promise<DropOutcome> {
    const clock = this.#opts.clock;
    const gainSince = (before: Readonly<Record<string, number>>): Array<[string, number]> =>
      this.#core.dig.gainSince(before, null).filter(([item]) => !req.notDrop(item));
    const gone = (id: number): boolean =>
      this.#world.itemEntity(id, req.origin, clock.now()) === null;
    const notes: string[] = [];
    let walks = 0;
    const outcome = (): DropOutcome => {
      const still = this.lying(req);
      const gained = gainSince(req.itemsBefore);
      const note =
        notes.length > 0
          ? notes.join('; ')
          : gained.length > 0
            ? `picked up ${describeGain(gained)}`
            : 'no drop reached the inventory';
      this.#core.log(`drops: ${note}`);
      return {
        gained,
        walks,
        left: typeof still === 'string' ? 0 : still.length,
        note: note.slice(0, 400),
      };
    };

    const first = this.lying(req);
    if (typeof first === 'string') {
      notes.push(`its drops cannot be told apart: ${first}`);
      return outcome();
    }
    if (first.length === 0) {
      if (gainSince(req.itemsBefore).length === 0) notes.push('no drop of it was seen');
      return outcome();
    }
    // Each comes to rest (or is picked up) first: until then, where it will lie is not known.
    await this.#core.waitFor(() => {
      const d = this.lying(req);
      return typeof d === 'string' || d.every((i) => i.settled);
    }, DROP_SETTLE_WAIT_MS);

    const tried = new Set<number>();
    for (;;) {
      if (this.#core.phase !== 'play') {
        notes.push('the connection closed');
        break;
      }
      const now = this.lying(req);
      if (typeof now === 'string') {
        notes.push(`its drops cannot be told apart: ${now}`);
        break;
      }
      const feet = this.#world.ownPosition;
      if (feet === null) {
        notes.push('the player position is not known');
        break;
      }
      const far = (i: ItemEntity): number =>
        Math.hypot(i.position.x - feet.x, i.position.y - feet.y, i.position.z - feet.z);
      const next = now.filter((i) => !tried.has(i.entityId)).sort((a, b) => far(a) - far(b))[0];
      if (next === undefined) break;
      tried.add(next.entityId);
      const what = describeDrop(next);
      if (!next.settled) {
        notes.push(`${what} did not come to rest within ${DROP_SETTLE_WAIT_MS / 1000} s`);
        continue;
      }
      const world = this.#world.walkWorld();
      const area = this.#core.fence();
      if (world === null || area.fence === null) {
        notes.push(`${what} is left there: ${area.problem ?? 'the block data is not known'}`);
        break;
      }
      const plan = planDropFetch(world, area.fence, feet, next);
      if (plan.kind === 'refused') {
        notes.push(`${what} is left there: ${plan.reason}`);
        continue;
      }
      const before = this.#world.inventoryItems() ?? req.itemsBefore;
      if (plan.kind === 'in-reach') {
        // Its pickup delay, or a tick: the server picks it up at the player's next tick.
        await this.#core.waitFor(() => gone(next.entityId), DROP_WAIT_MS);
        const got = gainSince(before);
        notes.push(
          gone(next.entityId)
            ? `picked up ${got.length > 0 ? describeGain(got) : what}`
            : `${what} lies within reach but was not picked up (is the inventory full?)`,
        );
        continue;
      }
      if (walks >= MAX_DROP_WALKS) {
        notes.push(`${what} is left there: ${MAX_DROP_WALKS} walks to drops already`);
        continue;
      }
      const where = cellText(next.position);
      this.#core.log(`walking onto ${cellText(plan.spot)} for ${what}`);
      const walked = await this.#core.movement.walkTo(plan.spot, { stopForThreats: true });
      if (!walked.ok && walked.code !== 'FAILED') {
        // Refused before a step (no way there, a blocker): nothing moved, the next may do.
        notes.push(`${what} is left there: ${walked.message}`);
        continue;
      }
      walks += 1;
      if (!walked.ok) {
        // Stopped on the way (a threat, a correction, the stop file): no more fetching.
        notes.push(`the drop lies at ${where}, but walking there stopped: ${walked.message}`);
        break;
      }
      await this.#core.waitFor(() => gone(next.entityId), DROP_WAIT_MS);
      const got = gainSince(before);
      notes.push(
        got.length > 0
          ? `walked to the drop${got.length > 1 ? 's' : ''} at ${where} and picked up ${describeGain(got)}`
          : `walked to ${cellText(plan.spot)} for ${what}, but nothing reached the inventory`,
      );
    }
    return outcome();
  }
}

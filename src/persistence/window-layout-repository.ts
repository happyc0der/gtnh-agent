import { z } from 'zod';
import type { BlockWindow } from '../domain/game-state.ts';
import type { Db } from './database.ts';

/** The most slots of a window kept as its sample (the non-empty ones, in slot order). */
export const MAX_LAYOUT_SAMPLE = 64;

const SampleSchema = z.array(
  z.strictObject({ slot: z.int(), item: z.string(), count: z.int(), role: z.string().nullable() }),
);
const PositionSchema = z.strictObject({ x: z.int(), y: z.int(), z: z.int() });

/** A window layout as learned from what the agent saw (one row per block, opener, size). */
export interface LearnedWindowLayout {
  block: string;
  /** `vanilla:<S2D type>` or `fml:<modId>:<guiId>`. */
  opener: string;
  slotCount: number;
  title: string | null;
  /** The block's interaction profile when it had one, else null (observe-only). */
  profile: string | null;
  /** The window's own slots before the player's 36, when its layout was known. */
  containerSlots: number | null;
  /** Where the player's inventory appeared to start (it matched the inventory), or null. */
  inventoryAt: number | null;
  /** The non-empty slots the last time it was seen. */
  sample: Array<{ slot: number; item: string; count: number; role: string | null }>;
  /** Where it was last seen. */
  position: { x: number; y: number; z: number };
  timesSeen: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface Row {
  block: string;
  opener: string;
  slot_count: number;
  title: string | null;
  profile: string | null;
  container_slots: number | null;
  inventory_at: number | null;
  sample_json: string;
  position_json: string;
  times_seen: number;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Agent memory of the windows blocks open (the generic, observe-only fallback for blocks
 * without a profile, and a live record for the ones with one). One row per block, opener and
 * slot count; seeing the same window again (a later observation) counts once more.
 */
export class WindowLayoutRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Records a window the agent saw. Returns true when it was new or newer than the stored one. */
  record(window: BlockWindow): boolean {
    const sample = window.slots.slice(0, MAX_LAYOUT_SAMPLE).map((s) => ({
      slot: s.slot,
      item: s.item,
      count: s.count,
      role: s.role,
    }));
    const result = this.#db
      .prepare(
        `INSERT INTO window_layouts (block, opener, slot_count, title, profile, container_slots,
           inventory_at, sample_json, position_json, times_seen, first_seen_at, last_seen_at)
         VALUES (@block, @opener, @slotCount, @title, @profile, @containerSlots, @inventoryAt,
           @sample, @position, 1, @seenAt, @seenAt)
         ON CONFLICT(block, opener, slot_count) DO UPDATE SET
           title = excluded.title, profile = excluded.profile,
           container_slots = excluded.container_slots, inventory_at = excluded.inventory_at,
           sample_json = excluded.sample_json, position_json = excluded.position_json,
           times_seen = window_layouts.times_seen + 1, last_seen_at = excluded.last_seen_at
         WHERE excluded.last_seen_at > window_layouts.last_seen_at`,
      )
      .run({
        block: window.block,
        opener: window.opener,
        slotCount: window.slotCount,
        title: window.title,
        profile: window.profile,
        containerSlots: window.containerSlots,
        inventoryAt: window.inventoryAt ?? null,
        sample: JSON.stringify(sample),
        position: JSON.stringify(window.position),
        seenAt: window.observedAt,
      });
    return result.changes > 0;
  }

  /** Every learned layout, most recently seen first. */
  list(): LearnedWindowLayout[] {
    const rows = this.#db
      .prepare('SELECT * FROM window_layouts ORDER BY last_seen_at DESC, block, opener')
      .all() as Row[];
    return rows.map((r) => ({
      block: r.block,
      opener: r.opener,
      slotCount: r.slot_count,
      title: r.title,
      profile: r.profile,
      containerSlots: r.container_slots,
      inventoryAt: r.inventory_at,
      sample: SampleSchema.parse(JSON.parse(r.sample_json)),
      position: PositionSchema.parse(JSON.parse(r.position_json)),
      timesSeen: r.times_seen,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  /** The layouts learned for one block. */
  forBlock(block: string): LearnedWindowLayout[] {
    return this.list().filter((l) => l.block === block);
  }
}

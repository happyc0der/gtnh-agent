import { z } from 'zod';

/** Minecraft world border is ±30,000,000; anything beyond is corrupt data. */
export const COORDINATE_LIMIT = 30_000_000;

/** Largest quantity a single transfer action may move (36 slots × 64). */
export const MAX_TRANSFER_QUANTITY = 36 * 64;

export const PositionSchema = z.strictObject({
  x: z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
  y: z.number().min(-2048).max(4096),
  z: z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * A block (not a point): integer coordinates of its minimum corner. The block spans
 * [x, x+1] x [y, y+1] x [z, z+1]; 1.7.10 worlds hold blocks at y 0..255.
 */
export const BlockPositionSchema = z.strictObject({
  x: z.int().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
  y: z.int().min(0).max(255),
  z: z.int().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
});
export type BlockPosition = z.infer<typeof BlockPositionSchema>;

/**
 * Namespaced item identifier, optionally with 1.7.10-style metadata:
 * `minecraft:bread`, `gregtech:gt.metaitem.01@2032`.
 *
 * The character set matches the real GTNH 2.8.4 registry (verified against all 15,025
 * names on 2026-09-30): namespaces may contain `|` (`BuildCraft|Core:engineBlock`), and
 * names may contain `|`, `'` and single inner spaces (`Natura:N Crops`). No other
 * punctuation, no leading/trailing or double spaces, no control characters.
 */
export const ItemNameSchema = z
  .string()
  .max(128)
  .regex(
    /^[A-Za-z0-9_.|-]+:[A-Za-z0-9_./|'-]+(?: [A-Za-z0-9_./|'-]+)*(?:@\d{1,5})?$/,
    'expected namespace:item[@meta]',
  );
export type ItemName = z.infer<typeof ItemNameSchema>;

/** Identifier for things the agent tracks: containers, machines, generators, tasks. */
export const EntityIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'expected 1-64 chars of [A-Za-z0-9_.:-]');

/** An entity's id on the server (a Java int), e.g. the target of ATTACK_ENTITY. */
export const EntityNumberSchema = z.int().min(-2_147_483_648).max(2_147_483_647);

export const LocationNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'expected lowercase name, 1-48 chars');

/** Normalized dimension name (the adapter maps numeric 1.7.10 dimension IDs to names). */
export const DimensionSchema = z.string().regex(/^[A-Za-z0-9_:.-]{1,64}$/);

export const TimestampSchema = z.iso.datetime();

export const ItemCountsSchema = z.record(ItemNameSchema, z.int().min(0).max(1_000_000_000));
export type ItemCounts = z.infer<typeof ItemCountsSchema>;

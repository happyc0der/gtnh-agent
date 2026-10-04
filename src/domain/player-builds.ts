import { z } from 'zod';
import { BlockPositionSchema, DimensionSchema, TimestampSchema } from './common.ts';

/**
 * Players' builds: blocks the agent saw a player put down, which it never breaks. The owner
 * plays on the server with the bot (README "Playing alongside it"), and a walk that breaks
 * what is in its way, or a GATHER of dirt and logs, must not take apart what a person built.
 *
 * The live client (src/bot/gtnh1710/world-model.ts) records a block as built by a player
 * when the server changes a cell from air (or a plant a block replaces) into a block with a
 * collision box while another player stands within PLAYER_BUILD_RADIUS of it, and the agent
 * did not place it itself; and it forgets one it sees turn back into air. They are kept in
 * agent memory per chunk (migration 009), so a restart keeps them. A falling block that
 * lands, or a tree that grows, while a player stands by counts too: the rule errs on the side
 * of leaving blocks alone.
 */

/** A player within this many blocks of a cell when it is filled makes it a player's build. */
export const PLAYER_BUILD_RADIUS = 8;

export const PlayerBuildSchema = z.strictObject({
  dimension: DimensionSchema,
  position: BlockPositionSchema,
  /** The block's registry name when it was placed. */
  block: z.string().min(1).max(128),
  seenAt: TimestampSchema,
});
export type PlayerBuild = z.infer<typeof PlayerBuildSchema>;

/** What the client saw since it was last asked: builds added, and cells that became air. */
export interface PlayerBuildChanges {
  readonly added: readonly PlayerBuild[];
  readonly removed: ReadonlyArray<{
    readonly dimension: string;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
  }>;
}

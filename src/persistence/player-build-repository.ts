import {
  PlayerBuildSchema,
  type PlayerBuild,
  type PlayerBuildChanges,
} from '../domain/player-builds.ts';
import type { Db } from './database.ts';

interface PlayerBuildRow {
  dimension: string;
  chunk_x: number;
  chunk_z: number;
  x: number;
  y: number;
  z: number;
  block: string;
  seen_at: string;
}

/** A stored row as a build, re-validated (a hand-edited row surfaces as an error). */
function toBuild(row: PlayerBuildRow): PlayerBuild {
  return PlayerBuildSchema.parse({
    dimension: row.dimension,
    position: { x: row.x, y: row.y, z: row.z },
    block: row.block,
    seenAt: row.seen_at,
  });
}

/**
 * Players' builds (migration 009, src/domain/player-builds.ts): blocks the agent saw a player
 * put down, keyed by chunk, kept across restarts. The live client reports what it saw since it
 * was last asked (added and removed); the agent loop stores it here, and gives a new
 * connection what is stored.
 */
export class PlayerBuildRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Stores builds and forgets removed cells, in one transaction; returns rows written. */
  apply(changes: PlayerBuildChanges): number {
    if (changes.added.length === 0 && changes.removed.length === 0) return 0;
    const put = this.#db.prepare(
      `INSERT INTO player_builds (dimension, chunk_x, chunk_z, x, y, z, block, seen_at)
       VALUES (@dimension, @chunkX, @chunkZ, @x, @y, @z, @block, @seenAt)
       ON CONFLICT(dimension, x, y, z) DO UPDATE SET block = excluded.block,
         seen_at = excluded.seen_at`,
    );
    const drop = this.#db.prepare(
      'DELETE FROM player_builds WHERE dimension = ? AND x = ? AND y = ? AND z = ?',
    );
    return this.#db.transaction(() => {
      let n = 0;
      for (const raw of changes.added) {
        const b = PlayerBuildSchema.parse(raw);
        const { x, y, z } = b.position;
        put.run({
          dimension: b.dimension,
          chunkX: Math.floor(x / 16),
          chunkZ: Math.floor(z / 16),
          x,
          y,
          z,
          block: b.block,
          seenAt: b.seenAt,
        });
        n += 1;
      }
      for (const r of changes.removed) {
        n += drop.run(r.dimension, r.position.x, r.position.y, r.position.z).changes;
      }
      return n;
    })();
  }

  /** Every build in the dimension (or in all), by chunk. */
  all(dimension?: string): PlayerBuild[] {
    const rows = (
      dimension === undefined
        ? this.#db.prepare('SELECT * FROM player_builds ORDER BY dimension, chunk_x, chunk_z').all()
        : this.#db
            .prepare('SELECT * FROM player_builds WHERE dimension = ? ORDER BY chunk_x, chunk_z')
            .all(dimension)
    ) as PlayerBuildRow[];
    return rows.map(toBuild);
  }

  /** The builds in one chunk. */
  inChunk(dimension: string, chunkX: number, chunkZ: number): PlayerBuild[] {
    const rows = this.#db
      .prepare('SELECT * FROM player_builds WHERE dimension = ? AND chunk_x = ? AND chunk_z = ?')
      .all(dimension, chunkX, chunkZ) as PlayerBuildRow[];
    return rows.map(toBuild);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM player_builds').get() as { n: number };
    return row.n;
  }
}

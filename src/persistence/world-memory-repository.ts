import { mergeSeen, SeenChunkSchema, type SeenChunk } from '../domain/world-memory.ts';
import type { Db } from './database.ts';

interface WorldChunkRow {
  dimension: string;
  chunk_x: number;
  chunk_z: number;
  biome_id: number | null;
  biome_name: string | null;
  biome_share: number | null;
  counts_json: string;
  examples_json: string;
  seen_at: string;
}

/** A stored row as a sighting, re-validated (a hand-edited row surfaces as an error). */
function toSeen(row: WorldChunkRow): SeenChunk {
  return SeenChunkSchema.parse({
    dimension: row.dimension,
    chunkX: row.chunk_x,
    chunkZ: row.chunk_z,
    biome:
      row.biome_id === null
        ? null
        : { id: row.biome_id, name: row.biome_name, share: row.biome_share },
    counts: JSON.parse(row.counts_json) as unknown,
    examples: JSON.parse(row.examples_json) as unknown,
    seenAt: row.seen_at,
  });
}

/**
 * World memory (migration 005): what the agent has seen, one row per chunk. A new sighting is
 * merged into the stored one (mergeSeen: the most seen of each kind, a few examples, the newer
 * biome and time), so a chunk seen from a poor spot never erases what was seen from a better one.
 */
export class WorldMemoryRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Stores sightings, each merged with what is stored; returns how many chunks were written. */
  remember(sightings: readonly SeenChunk[]): number {
    if (sightings.length === 0) return 0;
    const get = this.#db.prepare(
      'SELECT * FROM world_chunks WHERE dimension = ? AND chunk_x = ? AND chunk_z = ?',
    );
    const put = this.#db.prepare(
      `INSERT INTO world_chunks (dimension, chunk_x, chunk_z, biome_id, biome_name, biome_share,
                                 counts_json, examples_json, seen_at)
       VALUES (@dimension, @chunkX, @chunkZ, @biomeId, @biomeName, @biomeShare, @counts, @examples, @seenAt)
       ON CONFLICT(dimension, chunk_x, chunk_z) DO UPDATE SET
         biome_id = excluded.biome_id, biome_name = excluded.biome_name,
         biome_share = excluded.biome_share, counts_json = excluded.counts_json,
         examples_json = excluded.examples_json, seen_at = excluded.seen_at`,
    );
    return this.#db.transaction(() => {
      for (const raw of sightings) {
        const seen = SeenChunkSchema.parse(raw);
        const row = get.get(seen.dimension, seen.chunkX, seen.chunkZ) as WorldChunkRow | undefined;
        const merged = row === undefined ? seen : mergeSeen(toSeen(row), seen);
        put.run({
          dimension: merged.dimension,
          chunkX: merged.chunkX,
          chunkZ: merged.chunkZ,
          biomeId: merged.biome?.id ?? null,
          biomeName: merged.biome?.name ?? null,
          biomeShare: merged.biome?.share ?? null,
          counts: JSON.stringify(merged.counts),
          examples: JSON.stringify(merged.examples),
          seenAt: merged.seenAt,
        });
      }
      return sightings.length;
    })();
  }

  /** Every chunk seen in the dimension. */
  chunks(dimension: string): SeenChunk[] {
    const rows = this.#db
      .prepare('SELECT * FROM world_chunks WHERE dimension = ? ORDER BY chunk_x, chunk_z')
      .all(dimension) as WorldChunkRow[];
    return rows.map(toSeen);
  }

  get(dimension: string, chunkX: number, chunkZ: number): SeenChunk | null {
    const row = this.#db
      .prepare('SELECT * FROM world_chunks WHERE dimension = ? AND chunk_x = ? AND chunk_z = ?')
      .get(dimension, chunkX, chunkZ) as WorldChunkRow | undefined;
    return row === undefined ? null : toSeen(row);
  }

  /** How many chunks have been seen (in one dimension, or in all). */
  count(dimension?: string): number {
    const row = (
      dimension === undefined
        ? this.#db.prepare('SELECT COUNT(*) AS n FROM world_chunks').get()
        : this.#db
            .prepare('SELECT COUNT(*) AS n FROM world_chunks WHERE dimension = ?')
            .get(dimension)
    ) as { n: number };
    return row.n;
  }
}

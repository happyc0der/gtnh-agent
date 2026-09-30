/**
 * Research tool: learn which Forge entity types (modId + number) are which entities.
 *
 * Forge never sends entity names over the network, but the server saves every entity to its
 * region files with its registry name (e.g. "etfuturum.rabbit") and position. This tool keeps
 * the read-only client connected, snapshots where it sees each entity, and reads the chunks
 * the server saves. A saved entity whose nearest live entity (within 1.5 blocks, around the
 * save time) is a modded one is a vote for that type's name. Only reads files; never writes.
 *
 * Usage: node scripts/identify-entities.ts [--world ~/Projects/gtnh-test-server/agent-test]
 *        [--seconds 180]
 * Output: a table, plus data/spike/entity-names-<ts>.json (gitignored).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync, inflateSync } from 'node:zlib';
import dotenv from 'dotenv';
import { Gtnh1710Client } from '../src/bot/gtnh1710/gtnh-client.ts';
import { isCompound, readNbt } from '../src/bot/gtnh1710/nbt.ts';
import { loadConfig } from '../src/config/env.ts';
import { systemClock } from '../src/util/clock.ts';
import { errorMessage } from '../src/util/json.ts';

dotenv.config({ quiet: true });
const { values } = parseArgs({
  options: {
    world: {
      type: 'string',
      default: join(homedir(), 'Projects', 'gtnh-test-server', 'agent-test'),
    },
    seconds: { type: 'string', default: '180' },
  },
});
const regionDir = join(values.world, 'region');
const MATCH_DISTANCE = 1.5;
const TIME_WINDOW_MS = 3000;

interface Seen {
  key: string; // "modId#typeId" for modded, "vanilla" otherwise
  x: number;
  y: number;
  z: number;
}
const snapshots: Array<{ t: number; entities: Seen[] }> = [];
const chunkStamps = new Map<string, number>();
const votes = new Map<string, Map<string, number>>();
let savedSeen = 0;
let matched = 0;
let readErrors = 0;

function vote(key: string, name: string): void {
  const m = votes.get(key) ?? new Map<string, number>();
  m.set(name, (m.get(name) ?? 0) + 1);
  votes.set(key, m);
}

/** Entities from every chunk whose save timestamp changed since the last poll. */
function readChangedChunks(
  firstSnapshotAt: number,
): Array<{ savedAt: number; id: string; x: number; y: number; z: number }> {
  const out: Array<{ savedAt: number; id: string; x: number; y: number; z: number }> = [];
  for (const file of readdirSync(regionDir).filter((f) => f.endsWith('.mca'))) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(regionDir, file));
    } catch {
      continue;
    }
    for (let i = 0; i < 1024; i++) {
      const loc = buf.readUInt32BE(i * 4);
      const sectorOffset = loc >>> 8;
      if (sectorOffset === 0) continue;
      const savedAt = buf.readUInt32BE(4096 + i * 4) * 1000;
      const key = `${file}:${i}`;
      if (chunkStamps.get(key) === savedAt) continue;
      chunkStamps.set(key, savedAt);
      if (savedAt < firstSnapshotAt - 1000) continue; // saved before we were watching
      try {
        const start = sectorOffset * 4096;
        const length = buf.readUInt32BE(start);
        const compression = buf[start + 4];
        const raw = buf.subarray(start + 5, start + 4 + length);
        const nbt = readNbt(compression === 1 ? gunzipSync(raw) : inflateSync(raw)).value;
        const level = nbt['Level'];
        const entities = isCompound(level) ? level['Entities'] : undefined;
        if (!Array.isArray(entities)) continue;
        for (const e of entities) {
          if (!isCompound(e)) continue;
          const id = e['id'];
          const pos = e['Pos'];
          if (typeof id !== 'string' || !Array.isArray(pos) || pos.length !== 3) continue;
          const [x, y, z] = pos as number[];
          if (x === undefined || y === undefined || z === undefined) continue;
          out.push({ savedAt, id, x, y, z });
        }
      } catch {
        readErrors += 1; // torn read while the server writes; the next poll retries
        chunkStamps.delete(key);
      }
    }
  }
  return out;
}

function match(saved: { savedAt: number; id: string; x: number; y: number; z: number }): void {
  savedSeen += 1;
  let best: { d: number; key: string } | null = null;
  for (const snap of snapshots) {
    if (Math.abs(snap.t - saved.savedAt) > TIME_WINDOW_MS) continue;
    for (const e of snap.entities) {
      const d = Math.hypot(e.x - saved.x, e.y - saved.y, e.z - saved.z);
      if (best === null || d < best.d) best = { d, key: e.key };
    }
  }
  if (best === null || best.d > MATCH_DISTANCE || best.key === 'vanilla') return;
  matched += 1;
  vote(best.key, saved.id);
}

async function main(): Promise<number> {
  const { config } = loadConfig();
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  await client.connect();
  const started = Date.now();
  const stopAt = started + Number(values.seconds) * 1000;
  readChangedChunks(Number.MAX_SAFE_INTEGER); // baseline: remember current stamps, vote on nothing
  try {
    while (Date.now() < stopAt) {
      snapshots.push({
        t: Date.now(),
        entities: client.world.trackedEntities().map((e) => ({
          key: e.modType ? `${e.modType.modId}#${e.modType.typeId}` : 'vanilla',
          x: e.x,
          y: e.y,
          z: e.z,
        })),
      });
      while (snapshots.length > 0 && (snapshots[0]?.t ?? 0) < Date.now() - 20_000)
        snapshots.shift();
      if (snapshots.length % 4 === 0) for (const saved of readChangedChunks(started)) match(saved);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await client.disconnect();
  }

  const table = [...votes]
    .map(([key, names]) => {
      const sorted = [...names].sort((a, b) => b[1] - a[1]);
      const total = sorted.reduce((s, [, n]) => s + n, 0);
      const [top, topVotes] = sorted[0] ?? ['?', 0];
      return {
        key,
        name: top,
        votes: topVotes,
        total,
        agreement: Number((topVotes / total).toFixed(2)),
        others: sorted.slice(1, 3),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  console.log(
    `saved entities read: ${savedSeen}, matched to modded entities: ${matched}, torn reads: ${readErrors}`,
  );
  for (const r of table) {
    console.log(
      `${r.key.padEnd(22)} ${r.name.padEnd(36)} ${r.votes}/${r.total} (${r.agreement})${r.others.length ? '  also: ' + r.others.map(([n, v]) => `${n}x${v}`).join(', ') : ''}`,
    );
  }
  mkdirSync(join('data', 'spike'), { recursive: true });
  const file = join('data', 'spike', `entity-names-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify({ world: values.world, seconds: Number(values.seconds), table }, null, 2),
  );
  console.log(`Saved ${file}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  },
);

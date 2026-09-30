/**
 * Read-only entity survey against the private GTNH test server.
 *
 * Connects with the agent's own Gtnh1710Client, listens for N seconds through its
 * diagnostic tap, and tallies every entity the server announces: vanilla mobs
 * (Spawn Mob 0x0F), players (0x0C), objects (0x0E) and Forge mod entities (channel
 * "FML", EntitySpawnMessage). Used to ground mob tracking and to find modded entity
 * types that still need a hostile/passive classification.
 *
 * Usage: node scripts/entity-survey.ts [--seconds 20]
 * Needs the live settings from README "Private GTNH test server" (.env).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { Gtnh1710Client } from '../src/bot/gtnh1710/gtnh-client.ts';
import { Reader } from '../src/bot/gtnh1710/wire.ts';
import { loadConfig } from '../src/config/env.ts';
import { systemClock } from '../src/util/clock.ts';
import { errorMessage } from '../src/util/json.ts';

dotenv.config({ quiet: true });
const { values } = parseArgs({ options: { seconds: { type: 'string', default: '20' } } });
const seconds = Number(values.seconds);

interface Seen {
  kind: string;
  key: string;
  firstPos: { x: number; y: number; z: number } | null;
}

const entities = new Map<number, Seen>();
const tally = new Map<string, number>();
const fmlDiscriminators = new Map<number, number>();
const moveCounts = { rel: 0, lookRel: 0, teleport: 0, unknownIdMoves: 0 };
let destroyed = 0;
const parseErrors: string[] = [];
const bump = (key: string): void => {
  tally.set(key, (tally.get(key) ?? 0) + 1);
};
const fixed = (r: Reader) => ({ x: r.i32() / 32, y: r.i32() / 32, z: r.i32() / 32 });

function onFrame(phase: 'login' | 'play', id: number, body: Buffer): void {
  if (phase !== 'play') return;
  const r = new Reader(body);
  try {
    switch (id) {
      case 0x0c: {
        const eid = r.varInt();
        r.string(); // uuid
        const name = r.string();
        const props = r.varInt();
        for (let i = 0; i < props; i++) {
          r.string();
          r.string();
          r.string();
        }
        entities.set(eid, { kind: 'player', key: `player:${name}`, firstPos: fixed(r) });
        bump(`player:${name}`);
        return;
      }
      case 0x0e: {
        const eid = r.varInt();
        const type = r.i8();
        entities.set(eid, { kind: 'object', key: `object:${type}`, firstPos: fixed(r) });
        bump(`object:${type}`);
        return;
      }
      case 0x0f: {
        const eid = r.varInt();
        const type = r.u8();
        entities.set(eid, { kind: 'mob', key: `mob:${type}`, firstPos: fixed(r) });
        bump(`mob:${type}`);
        return;
      }
      case 0x13: {
        const n = r.i8();
        for (let i = 0; i < n; i++) entities.delete(r.i32());
        destroyed += n;
        return;
      }
      case 0x15:
      case 0x17:
      case 0x18: {
        const eid = r.i32();
        if (!entities.has(eid)) moveCounts.unknownIdMoves += 1;
        if (id === 0x15) moveCounts.rel += 1;
        else if (id === 0x17) moveCounts.lookRel += 1;
        else moveCounts.teleport += 1;
        return;
      }
      case 0x3f: {
        const channel = r.string();
        const len = r.varShort();
        if (channel !== 'FML') return;
        const data = new Reader(Buffer.from(r.bytes(len)));
        const disc = data.u8();
        fmlDiscriminators.set(disc, (fmlDiscriminators.get(disc) ?? 0) + 1);
        if (disc === 2) {
          // EntitySpawnMessage: int entityId, string modId, int modEntityTypeId, int x/y/z (1/32 blocks), ...
          const eid = data.i32();
          const modId = data.string();
          const typeId = data.i32();
          entities.set(eid, {
            kind: 'modded',
            key: `fml:${modId}#${typeId}`,
            firstPos: fixed(data),
          });
          bump(`fml:${modId}#${typeId}`);
        }
        return;
      }
      default:
        return;
    }
  } catch (error) {
    if (parseErrors.length < 20) parseErrors.push(`0x${id.toString(16)}: ${errorMessage(error)}`);
  }
}

async function main(): Promise<number> {
  const { config } = loadConfig();
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock, onFrame });
  try {
    await client.connect();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const state = await client.observe();
    const me = state.player.position.known ? state.player.position.value : null;
    const dist = (p: Seen['firstPos']): number | null =>
      me && p ? Number(Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z).toFixed(1)) : null;
    const alive = [...entities.values()].map((e) => ({ ...e, distance: dist(e.firstPos) }));
    const byKey = new Map<string, { count: number; nearest: number | null }>();
    for (const e of alive) {
      const cur = byKey.get(e.key) ?? { count: 0, nearest: null };
      cur.count += 1;
      if (e.distance !== null && (cur.nearest === null || e.distance < cur.nearest))
        cur.nearest = e.distance;
      byKey.set(e.key, cur);
    }
    const summary = {
      seconds,
      player: me,
      spawnsSeen: Object.fromEntries([...tally].sort()),
      aliveAtEnd: Object.fromEntries([...byKey].sort()),
      destroyed,
      moveCounts,
      fmlDiscriminators: Object.fromEntries(fmlDiscriminators),
      parseErrors,
    };
    mkdirSync(join('data', 'spike'), { recursive: true });
    const file = join('data', 'spike', `entity-survey-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Saved ${file}`);
    return 0;
  } finally {
    await client.disconnect();
  }
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

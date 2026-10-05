/**
 * Developer tool: saves a box of the test server's saved world as a test fixture, so a planner
 * can be tested on the terrain where it failed live (tests/bot/gtnh1710/fixtures/saved-world.ts
 * reads it). Reads the region files and level.dat's block names only; never writes the world.
 * Run `save-all` on the server first (node scripts/test-server-admin.ts rcon "save-all").
 *
 * Usage: node scripts/world-box.ts <x1> <y1> <z1> <x2> <y2> <z2> <name>
 *        [--world ~/Projects/gtnh-test-server/agent-test]
 * Output: tests/bot/gtnh1710/fixtures/<name>.json (a palette of "name:meta", and one base-36
 * palette index per cell, x fastest, then z, then y).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { isCompound, readNbt, type NbtCompound, type NbtValue } from '../src/bot/gtnh1710/nbt.ts';

const args = process.argv.slice(2);
const worldAt = args.indexOf('--world');
const dir =
  worldAt >= 0
    ? (args.splice(worldAt, 2)[1] ?? '')
    : join(homedir(), 'Projects', 'gtnh-test-server', 'agent-test');
const [x1, y1, z1, x2, y2, z2] = args.slice(0, 6).map(Number);
const name = args[6];
if ([x1, y1, z1, x2, y2, z2].some((v) => v === undefined || !Number.isInteger(v)) || !name) {
  console.error('usage: node scripts/world-box.ts x1 y1 z1 x2 y2 z2 name [--world dir]');
  process.exit(1);
}

// Block names by id, from Forge's registry in level.dat (blocks are keyed "\u0001modid:name").
const level = readNbt(gunzipSync(readFileSync(join(dir, 'level.dat')))).value;
const fml = level['FML'];
const names = new Map<number, string>();
if (isCompound(fml)) {
  for (const e of fml['ItemData'] as NbtValue[]) {
    if (!isCompound(e)) continue;
    const key = e['K'] as string;
    if (key.charCodeAt(0) === 1) names.set(e['V'] as number, key.slice(1));
  }
}

interface Column {
  ids: Map<number, Uint16Array>;
  metas: Map<number, Uint8Array>;
}
const columns = new Map<string, Column | null>();
function column(cx: number, cz: number): Column | null {
  const key = `${cx},${cz}`;
  const cached = columns.get(key);
  if (cached !== undefined) return cached;
  let buf: Buffer;
  try {
    buf = readFileSync(join(dir, 'region', `r.${cx >> 5}.${cz >> 5}.mca`));
  } catch {
    columns.set(key, null);
    return null;
  }
  const offset = buf.readUInt32BE(((cx & 31) + (cz & 31) * 32) * 4) >>> 8;
  if (offset === 0) {
    columns.set(key, null);
    return null;
  }
  const start = offset * 4096;
  const raw = buf.subarray(start + 5, start + 4 + buf.readUInt32BE(start));
  const root = readNbt(buf[start + 4] === 1 ? gunzipSync(raw) : inflateSync(raw)).value;
  const c: Column = { ids: new Map(), metas: new Map() };
  for (const s of (root['Level'] as NbtCompound)['Sections'] as NbtValue[]) {
    if (!isCompound(s)) continue;
    const y = s['Y'] as number;
    const ids = new Uint16Array(4096);
    const metas = new Uint8Array(4096);
    // NotEnoughIDs keeps 16-bit ids and metadata (Blocks16, Data16); vanilla nibbles otherwise.
    const b16 = s['Blocks16'];
    const blocks = s['Blocks'];
    const d16 = s['Data16'];
    const data = s['Data'];
    for (let q = 0; q < 4096; q++) {
      ids[q] =
        Buffer.isBuffer(b16) && b16.length === 8192
          ? b16.readUInt16BE(q * 2)
          : Buffer.isBuffer(blocks)
            ? (blocks[q] ?? 0)
            : 0;
      metas[q] =
        Buffer.isBuffer(d16) && d16.length === 8192
          ? d16.readUInt16BE(q * 2) & 15
          : Buffer.isBuffer(data)
            ? ((data[q >> 1] ?? 0) >> ((q & 1) * 4)) & 15
            : 0;
    }
    c.ids.set(y, ids);
    c.metas.set(y, metas);
  }
  columns.set(key, c);
  return c;
}

const lo = { x: Math.min(x1!, x2!), y: Math.min(y1!, y2!), z: Math.min(z1!, z2!) };
const hi = { x: Math.max(x1!, x2!), y: Math.max(y1!, y2!), z: Math.max(z1!, z2!) };
const palette: string[] = [];
const index = new Map<string, number>();
let cells = '';
for (let y = lo.y; y <= hi.y; y++) {
  for (let z = lo.z; z <= hi.z; z++) {
    for (let x = lo.x; x <= hi.x; x++) {
      const c = column(x >> 4, z >> 4);
      if (c === null) throw new Error(`the chunk of (${x}, ${z}) is not saved`);
      const q = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
      const id = c.ids.get(y >> 4)?.[q] ?? 0;
      const block = id === 0 ? 'minecraft:air' : (names.get(id) ?? `unknown#${id}`);
      const key = `${block}:${id === 0 ? 0 : (c.metas.get(y >> 4)?.[q] ?? 0)}`;
      let i = index.get(key);
      if (i === undefined) {
        i = palette.length;
        palette.push(key);
        index.set(key, i);
      }
      cells += i.toString(36);
    }
  }
}
if (palette.length > 36) throw new Error(`${palette.length} kinds of block: at most 36 fit`);
const out = join('tests', 'bot', 'gtnh1710', 'fixtures', `${name}.json`);
writeFileSync(out, `${JSON.stringify({ min: lo, max: hi, palette, cells }, null, 2)}\n`);
console.log(`${out}: ${cells.length} cells, ${palette.length} kinds of block`);

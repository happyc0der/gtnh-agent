/**
 * Operator tool for the private GTNH test server, over RCON (localhost only).
 *
 * This is NOT part of the agent. It runs server commands with full operator rights (to
 * build the movement test pen, teleport the test player, ...), so it lives outside src/,
 * the agent may never import it (lint), and the RCON password is read at run time from
 * the test server's own server.properties; it is never stored in this repository.
 *
 * GTNH's Hodgepodge runs RCON commands on the server's main thread (fixRconThreading),
 * so world edits made here are as safe as commands typed into the server console.
 *
 * Usage:
 *   node scripts/test-server-admin.ts rcon "<command>"   Run one server command.
 *   node scripts/test-server-admin.ts pen show           Pen geometry and the matching agent settings.
 *   node scripts/test-server-admin.ts pen build          Build (or reset) the glass movement pen.
 *   node scripts/test-server-admin.ts pen remove         Clear the pen and everything in it to air (its
 *                                                        chest drops what it holds).
 *   node scripts/test-server-admin.ts pen tp [--wait N] [--to=x,y,z]  Teleport the agent's player to the pen (or to x,y,z)
 *                                                        centre, waiting up to N s for it to be online.
 *   node scripts/test-server-admin.ts pen chest          Place the test chest in the pen (only if there is
 *                                                        none): 128 cobblestone, 3 diamonds (a protected
 *                                                        item) and 16 bread, three blocks south of the centre.
 *   node scripts/test-server-admin.ts pen resources      Place blocks to dig (DIG_BLOCK) in the pen, each only
 *                                                        where there is air: dirt, sand, gravel, clay and grass
 *                                                        on the west side, a two-log tree with leaves in the east.
 * Settings (.env): TEST_SERVER_DIR (the server folder), TEST_PEN_CENTER="x,y,z" (the centre
 * block at the player's feet level) and TEST_PEN_RADIUS (interior half-width, default 4).
 */
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/env.ts';
import { errorMessage } from '../src/util/json.ts';

// ---------------------------------------------------------------------------
// RCON (Source RCON protocol, as implemented by Minecraft 1.7.10)
// ---------------------------------------------------------------------------

const RCON_AUTH = 3;
const RCON_COMMAND = 2;

interface RconPacket {
  id: number;
  type: number;
  body: string;
}

function encodeRcon(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const length = 4 + 4 + payload.length + 2;
  const out = Buffer.alloc(4 + length);
  out.writeInt32LE(length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  payload.copy(out, 12);
  return out; // the two terminating NUL bytes are already zero
}

class Rcon {
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #waiting: {
    id: number;
    resolve: (p: RconPacket) => void;
    reject: (e: Error) => void;
  } | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (e) => this.#fail(e));
    socket.on('close', () => this.#fail(new Error('RCON connection closed')));
  }

  static async open(host: string, port: number, password: string): Promise<Rcon> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(port, host);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const rcon = new Rcon(socket);
    const reply = await rcon.#request(RCON_AUTH, password);
    if (reply.id === -1) {
      rcon.close();
      throw new Error('RCON login refused (wrong rcon.password?)');
    }
    return rcon;
  }

  async command(command: string): Promise<string> {
    return (await this.#request(RCON_COMMAND, command)).body;
  }

  close(): void {
    this.#socket.destroy();
  }

  #request(type: number, body: string, timeoutMs = 10_000): Promise<RconPacket> {
    if (this.#waiting !== null) return Promise.reject(new Error('one RCON request at a time'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error('RCON reply timed out')), timeoutMs);
      this.#waiting = {
        id,
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.#socket.write(encodeRcon(id, type, body));
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readInt32LE(0);
      if (this.#buffer.length < 4 + length) return;
      const packet: RconPacket = {
        id: this.#buffer.readInt32LE(4),
        type: this.#buffer.readInt32LE(8),
        body: this.#buffer.subarray(12, 4 + length - 2).toString('utf8'),
      };
      this.#buffer = this.#buffer.subarray(4 + length);
      const waiting = this.#waiting;
      // A failed login answers with id -1; other replies echo the request id.
      if (waiting !== null && (packet.id === waiting.id || packet.id === -1)) {
        this.#waiting = null;
        waiting.resolve(packet);
      }
    }
  }

  #fail(error: Error): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.reject(error);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface ServerSettings {
  host: string;
  port: number;
  password: string;
}

function readServerSettings(serverDir: string): ServerSettings {
  const props = new Map<string, string>();
  for (const line of readFileSync(join(serverDir, 'server.properties'), 'utf8').split(/\r?\n/)) {
    const m = /^([^#=]+)=(.*)$/.exec(line);
    if (m !== null) props.set((m[1] ?? '').trim(), (m[2] ?? '').trim());
  }
  if (props.get('enable-rcon') !== 'true')
    throw new Error('RCON is not enabled on the test server');
  const host = props.get('server-ip') ?? '';
  // RCON binds to server-ip; an empty value would mean every interface.
  if (host !== '127.0.0.1') {
    throw new Error(`Refusing: the test server's server-ip is "${host}", not 127.0.0.1`);
  }
  const password = props.get('rcon.password') ?? '';
  if (password.length < 16) throw new Error('rcon.password is missing or too short');
  return { host, port: Number(props.get('rcon.port') ?? '25575'), password };
}

interface Pen {
  /** Centre block at the player's feet level. */
  center: { x: number; y: number; z: number };
  /** Interior half-width: the interior is (2r+1) x (2r+1) blocks. */
  radius: number;
}

function penFromEnv(env: NodeJS.ProcessEnv): Pen {
  const raw = env['TEST_PEN_CENTER'];
  if (raw === undefined || raw.trim() === '') throw new Error('TEST_PEN_CENTER is not set (.env)');
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`TEST_PEN_CENTER must be "x,y,z" block coordinates, got "${raw}"`);
  }
  const [x, y, z] = parts as [number, number, number];
  const radius = Number(env['TEST_PEN_RADIUS'] ?? '4');
  if (!Number.isInteger(radius) || radius < 1 || radius > 12) {
    throw new Error('TEST_PEN_RADIUS must be an integer from 1 to 12');
  }
  if (y < 2 || y > 250) throw new Error('TEST_PEN_CENTER y must leave room for floor and walls');
  return { center: { x, y, z }, radius };
}

/** The setblock commands that build the pen: glass floor, 3-high glass walls, empty interior. */
function penCommands(pen: Pen): string[] {
  const { center: c, radius: r } = pen;
  const out: string[] = [];
  for (let x = c.x - r - 1; x <= c.x + r + 1; x++) {
    for (let z = c.z - r - 1; z <= c.z + r + 1; z++) {
      out.push(`setblock ${x} ${c.y - 1} ${z} minecraft:glass`);
      const wall = Math.abs(x - c.x) === r + 1 || Math.abs(z - c.z) === r + 1;
      for (let dy = 0; dy < 3; dy++) {
        // Never touch the test chest's block: replacing a chest drops its contents.
        if (x === c.x && z === c.z + 3 && dy === 0) continue;
        out.push(`setblock ${x} ${c.y + dy} ${z} minecraft:${wall ? 'glass' : 'air'}`);
      }
    }
  }
  return out;
}

/**
 * The setblock commands that clear the pen to air: its floor, walls and interior, and the
 * block above the walls. Seen 2026-10-04: built above the world spawn, the pen was where a
 * respawn could land (the highest block of a column near spawn), 100 blocks up; the bot was
 * stranded on its wall.
 */
function penRemoveCommands(pen: Pen): string[] {
  const { center: c, radius: r } = pen;
  const out: string[] = [];
  for (let y = c.y + 3; y >= c.y - 1; y--) {
    for (let x = c.x - r - 1; x <= c.x + r + 1; x++) {
      for (let z = c.z - r - 1; z <= c.z + r + 1; z++)
        out.push(`setblock ${x} ${y} ${z} minecraft:air`);
    }
  }
  return out;
}

/** Blocks above the feet level that DIG_BLOCK may reach in the pen (its default dig height). */
const PEN_DIG_HEIGHT = 4;

function penSettings(pen: Pen): Record<string, unknown> {
  const { center: c, radius: r } = pen;
  return {
    interiorCells: `x ${c.x - r}..${c.x + r}, z ${c.z - r}..${c.z + r} (feet level y=${c.y}, glass floor y=${c.y - 1})`,
    env: {
      MC_MOVEMENT_FENCE_MIN: `${c.x - r},${c.y},${c.z - r}`,
      MC_MOVEMENT_FENCE_MAX: `${c.x + r},${c.y},${c.z + r}`,
      SAFETY_BOUNDARY_MIN: `${c.x - r},${c.y},${c.z - r}`,
      // Up to the top of the highest block digging may break (the feet stay at y=c.y).
      SAFETY_BOUNDARY_MAX: `${c.x + r + 1},${c.y + PEN_DIG_HEIGHT + 1},${c.z + r + 1}`,
    },
    'agent.config.json': {
      locations: {
        home: {
          dimension: 'overworld',
          position: { x: c.x + 0.5, y: c.y, z: c.z + 0.5 },
          kind: 'safe',
          note: 'centre of the glass movement test pen',
        },
      },
    },
  };
}

/**
 * Blocks to dig in the pen: a row on the west side (dirt, sand, gravel, clay) plus a grass
 * block, and a two-log oak "tree" with leaves on top in the east (leaves metadata 4: placed,
 * so they never decay). Every block has only air and the glass floor around it, and none
 * is next to the test chest three blocks south of the centre.
 */
function penResources(
  pen: Pen,
): Array<{ x: number; y: number; z: number; block: string; meta: number }> {
  const { x, y, z } = pen.center;
  return [
    { x: x - 3, y, z: z - 3, block: 'minecraft:dirt', meta: 0 },
    { x: x - 3, y, z: z - 1, block: 'minecraft:sand', meta: 0 },
    { x: x - 3, y, z: z + 1, block: 'minecraft:gravel', meta: 0 },
    { x: x - 3, y, z: z + 3, block: 'minecraft:clay', meta: 0 },
    { x: x - 1, y, z: z - 3, block: 'minecraft:grass', meta: 0 },
    { x: x + 3, y, z: z - 3, block: 'minecraft:log', meta: 0 },
    { x: x + 3, y: y + 1, z: z - 3, block: 'minecraft:log', meta: 0 },
    { x: x + 3, y: y + 2, z: z - 3, block: 'minecraft:leaves', meta: 4 },
  ];
}

// ---------------------------------------------------------------------------

async function withRcon<T>(fn: (rcon: Rcon) => Promise<T>): Promise<T> {
  const serverDir = process.env['TEST_SERVER_DIR'];
  if (serverDir === undefined || serverDir.trim() === '') {
    throw new Error('TEST_SERVER_DIR is not set (.env)');
  }
  const s = readServerSettings(serverDir.trim());
  const rcon = await Rcon.open(s.host, s.port, s.password);
  try {
    return await fn(rcon);
  } finally {
    rcon.close();
  }
}

async function main(argv: string[]): Promise<number> {
  dotenv.config({ quiet: true });
  const print = (v: unknown): void => {
    process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
  };
  // Everything after "rcon" is the server command, passed through as-is (it often has
  // negative coordinates, which an option parser would take for flags).
  if (argv[0] === 'rcon' && argv.length > 1) {
    const line = argv.slice(1).join(' ');
    print(await withRcon((rcon) => rcon.command(line)));
    return 0;
  }
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { wait: { type: 'string', default: '0' }, to: { type: 'string' } },
  });
  const [command, sub] = positionals;
  if (command === 'pen' && sub === 'show') {
    print(penSettings(penFromEnv(process.env)));
    return 0;
  }
  if (command === 'pen' && (sub === 'build' || sub === 'remove')) {
    const pen = penFromEnv(process.env);
    const commands = sub === 'build' ? penCommands(pen) : penRemoveCommands(pen);
    const started = Date.now();
    const replies = new Map<string, number>();
    await withRcon(async (rcon) => {
      for (const c of commands) {
        const reply = (await rcon.command(c)).trim() || '(no reply)';
        replies.set(reply, (replies.get(reply) ?? 0) + 1);
      }
    });
    print({
      commands: commands.length,
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      replies: Object.fromEntries(replies),
    });
    return 0;
  }
  if (command === 'pen' && sub === 'chest') {
    const { center: c } = penFromEnv(process.env);
    const at = { x: c.x, y: c.y, z: c.z + 3 };
    // 1.7.10 item NBT uses numeric ids: cobblestone 4, diamond 264, bread 297 (vanilla ids).
    const items =
      '{Items:[{Slot:0b,id:4s,Count:64b,Damage:0s},{Slot:1b,id:4s,Count:64b,Damage:0s},' +
      '{Slot:2b,id:264s,Count:3b,Damage:0s},{Slot:3b,id:297s,Count:16b,Damage:0s}]}';
    const reply = await withRcon(async (rcon) => {
      // In 1.7.10 ANY setblock over a chest runs its break logic, which drops the contents
      // into the world (the bot would pick them up). So never replace an existing chest.
      const found = await rcon.command(`testforblock ${at.x} ${at.y} ${at.z} minecraft:chest`);
      if (/successfully/i.test(found)) {
        return `a chest is already at (${at.x}, ${at.y}, ${at.z}); left as it is (replacing it would drop its contents)`;
      }
      return rcon.command(`setblock ${at.x} ${at.y} ${at.z} minecraft:chest 2 replace ${items}`);
    });
    print({
      reply,
      'agent.config.json': {
        minecraft: {
          containers: { chests: { 'chest.pen': { name: 'Pen test chest', position: at } } },
        },
      },
      env: { MC_ENABLE_CONTAINERS: 'true' },
    });
    return 0;
  }
  if (command === 'pen' && sub === 'resources') {
    const pen = penFromEnv(process.env);
    const placed = await withRcon(async (rcon) => {
      const out: string[] = [];
      for (const b of penResources(pen)) {
        const at = `(${b.x}, ${b.y}, ${b.z})`;
        // Only into air: never replace the chest (it would drop its contents) or anything else.
        const free = await rcon.command(`testforblock ${b.x} ${b.y} ${b.z} minecraft:air`);
        if (!/successfully/i.test(free)) {
          out.push(`${at}: not air, left as it is`);
          continue;
        }
        const reply = await rcon.command(`setblock ${b.x} ${b.y} ${b.z} ${b.block} ${b.meta}`);
        out.push(`${b.block} at ${at}: ${reply.trim() || '(no reply)'}`);
      }
      return out;
    });
    const { x, y, z } = pen.center;
    print({
      placed,
      env: { MC_ENABLE_DIGGING: 'true' },
      try: [
        `pnpm cli move --live --to=${x - 1.5},${y},${z - 2.5}`,
        `pnpm cli dig --live --at=${x - 3},${y},${z - 3}`,
      ],
    });
    return 0;
  }
  if (command === 'pen' && sub === 'tp') {
    const pen = penFromEnv(process.env);
    const { username } = loadConfig().config.minecraft;
    const waitMs = Math.max(0, Number(values.wait) || 0) * 1000;
    // --to x,y,z: the player's feet position anywhere (else the pen's centre block).
    const to = typeof values.to === 'string' ? values.to.split(',').map(Number) : null;
    if (to !== null && (to.length !== 3 || !to.every(Number.isFinite))) {
      process.stderr.write('--to must be x,y,z (feet position, e.g. --to=-4.5,106,-7.5)\n');
      return 1;
    }
    const { x, y, z } = pen.center;
    return withRcon(async (rcon) => {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const online = (await rcon.command('list')).split(/[\s,:]+/).includes(username);
        if (online) break;
        if (Date.now() >= deadline) {
          process.stderr.write(`${username} is not online\n`);
          return 1;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      // 1.7.10's tp adds 0.5 to any coordinate written without a decimal point, which
      // would leave the player floating half a block above the floor: always send decimals.
      const at = (to ?? [x + 0.5, y, z + 0.5]).map((n) => n.toFixed(2)).join(' ');
      print(await rcon.command(`tp ${username} ${at}`));
      return 0;
    });
  }
  process.stderr.write(
    'Usage: node scripts/test-server-admin.ts rcon "<command>" | pen show | pen build | pen chest | pen resources | pen tp [--wait N] [--to=x,y,z]\n',
  );
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);

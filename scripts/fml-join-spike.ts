/**
 * Read-only JOIN spike: can a Node client complete the Forge 1.7.10 (FML) handshake
 * and enter a GTNH world?
 *
 * Why a raw client: mineflayer 4.39 rejects 1.7.10 outright, and minecraft-protocol's
 * vanilla 1.7 parser does not know Forge's extended plugin-message length ("varshort")
 * or NotEnoughIDs packet changes. This spike frames packets itself and parses only
 * what it needs.
 *
 * It ONLY: logs in (offline), answers keep-alives and the FML|HS handshake by echoing the
 * server's mod list, listens for ~10 s, and disconnects. It never sends movement, chat,
 * commands, clicks or block/entity interactions.
 *
 * Output: data/spike/join-<ts>.json and data/spike/registry-<ts>.json (gitignored).
 *
 * Usage: node scripts/fml-join-spike.ts [--host 127.0.0.1] [--port 25570]
 *        [--marker gtnh-agent-test] [--stay 10000] [--timeout 60000]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { checkPrivateHost } from '../src/config/network.ts';
import { errorMessage } from '../src/util/json.ts';
import { statusPing } from './status-ping.ts';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '25570' },
    marker: { type: 'string', default: 'gtnh-agent-test' },
    username: { type: 'string', default: 'gtnh_agent' },
    stay: { type: 'string', default: '10000' },
    timeout: { type: 'string', default: '60000' },
  },
});
const host = values.host;
const port = Number(values.port);
const stayMs = Number(values.stay);
const timeoutMs = Number(values.timeout);

// ---------------------------------------------------------------------------
// Wire helpers (Minecraft 1.7.x: no compression, no encryption in offline mode)
// ---------------------------------------------------------------------------

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let n = value >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return Buffer.from(bytes);
}
const mcString = (s: string): Buffer =>
  Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const i32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const frame = (id: number, body: Buffer): Buffer => {
  const payload = Buffer.concat([varint(id), body]);
  return Buffer.concat([varint(payload.length), payload]);
};

class Reader {
  readonly buf: Buffer;
  o: number;
  constructor(buf: Buffer, offset = 0) {
    this.buf = buf;
    this.o = offset;
  }
  get remaining(): number {
    return this.buf.length - this.o;
  }
  varint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (this.o >= this.buf.length) throw new RangeError('varint past end');
      const b = this.buf[this.o++] as number;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value >>> 0;
      shift += 7;
      if (shift > 35) throw new Error('varint too long');
    }
  }
  /** Forge 1.7.10 plugin-message length: 15 bits, plus one extra byte if the top bit is set. */
  varshort(): number {
    let low = this.buf.readUInt16BE(this.o);
    this.o += 2;
    let high = 0;
    if ((low & 0x8000) !== 0) {
      low &= 0x7fff;
      high = this.buf.readUInt8(this.o++);
    }
    return ((high & 0xff) << 15) | low;
  }
  string(): string {
    const len = this.varint();
    const s = this.buf.toString('utf8', this.o, this.o + len);
    this.o += len;
    return s;
  }
  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return b;
  }
  i8 = (): number => this.buf.readInt8(this.o++);
  u8 = (): number => this.buf.readUInt8(this.o++);
  i16 = (): number => ((this.o += 2), this.buf.readInt16BE(this.o - 2));
  i32 = (): number => ((this.o += 4), this.buf.readInt32BE(this.o - 4));
  f32 = (): number => ((this.o += 4), this.buf.readFloatBE(this.o - 4));
  f64 = (): number => ((this.o += 8), this.buf.readDoubleBE(this.o - 8));
  bool = (): boolean => this.u8() !== 0;
}

// ---------------------------------------------------------------------------
// Spike
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const report: Json = { startedAt: new Date().toISOString(), host, port };
const timeline: string[] = [];
const t0 = Date.now();
const note = (msg: string): void => {
  timeline.push(`+${String(Date.now() - t0).padStart(5)}ms ${msg}`);
};

interface Registry {
  blocks: Map<number, string>;
  items: Map<number, string>;
  blockSubstitutions: string[];
  itemSubstitutions: string[];
}

function parseModIdData(data: Buffer): Registry {
  const r = new Reader(data, 1);
  const reg: Registry = {
    blocks: new Map(),
    items: new Map(),
    blockSubstitutions: [],
    itemSubstitutions: [],
  };
  const count = r.varint();
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const id = r.varint();
    // FML 1.7.10 prefixes registry names: \u0001 = block, \u0002 = item.
    if (name.startsWith('\u0001')) reg.blocks.set(id, name.slice(1));
    else if (name.startsWith('\u0002')) reg.items.set(id, name.slice(1));
    else reg.items.set(id, name);
  }
  if (r.remaining > 0) {
    const nb = r.varint();
    for (let i = 0; i < nb; i++) reg.blockSubstitutions.push(r.string());
  }
  if (r.remaining > 0) {
    const ni = r.varint();
    for (let i = 0; i < ni; i++) reg.itemSubstitutions.push(r.string());
  }
  return reg;
}

interface SlotItem {
  slot: number;
  id: number;
  name: string | null;
  count: number;
  damage: number;
  hasNbt: boolean;
}

function readSlot(r: Reader, slot: number, reg: Registry | null): SlotItem | null {
  const id = r.i16();
  if (id === -1) return null;
  const count = r.i8();
  const damage = r.i16();
  const nbtLen = r.i16();
  if (nbtLen > 0) gunzipSync(r.bytes(nbtLen)); // validate, but do not keep NBT contents
  return {
    slot,
    id,
    name: reg?.items.get(id) ?? reg?.blocks.get(id) ?? null,
    count,
    damage,
    hasNbt: nbtLen > 0,
  };
}

async function main(): Promise<number> {
  const hostCheck = checkPrivateHost(host, []);
  if (!hostCheck.ok) {
    console.error(`Refusing: ${hostCheck.reason}`);
    return 1;
  }

  // Identity guard: only join the test server.
  const ping = await statusPing(host, port, 10_000);
  if (ping.kind !== 'status') {
    report['ping'] = ping;
    return save(1, `Server not ready for status ping: ${JSON.stringify(ping)}`);
  }
  const description = ping.json['description'];
  const motd = typeof description === 'string' ? description : JSON.stringify(description ?? '');
  const modinfo = ping.json['modinfo'] as
    { type?: string; modList?: Array<{ modid: string; version: string }> } | undefined;
  const serverMods = modinfo?.modList ?? [];
  report['ping'] = { motd, modinfoType: modinfo?.type, modCount: serverMods.length };
  if (
    !motd.includes(values.marker) ||
    modinfo?.type !== 'FML' ||
    !serverMods.some((m) => m.modid === 'gregtech')
  ) {
    return save(1, 'Refusing: not identified as the GTNH test server.');
  }

  const result = await joinServer(serverMods);
  Object.assign(report, result);
  return save(
    result['joined'] === true ? 0 : 1,
    result['joined'] === true ? 'JOINED the world.' : 'Did not join.',
  );
}

function joinServer(serverMods: Array<{ modid: string; version: string }>): Promise<Json> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    let state: 'login' | 'play' = 'login';
    let fml:
      | 'START'
      | 'WAITINGSERVERDATA'
      | 'WAITINGSERVERCOMPLETE'
      | 'PENDINGCOMPLETE'
      | 'COMPLETE'
      | 'DONE' = 'START';
    let buf = Buffer.alloc(0);
    let registry: Registry | null = null;
    let multipart: { channel: string; parts: number; total: number; chunks: Buffer[] } | null =
      null;
    const packetCounts = new Map<number, number>();
    const pluginChannels = new Map<string, number>();
    const chat: string[] = [];
    const out: Json = { joined: false };
    let settled = false;
    let stayTimer: NodeJS.Timeout | null = null;

    const finish = (outcome: string, extra: Json = {}): void => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      if (stayTimer) clearTimeout(stayTimer);
      note(`finish: ${outcome}`);
      socket.destroy();
      if (registry) {
        const file = join('data', 'spike', `registry-${Date.now()}.json`);
        mkdirSync(join('data', 'spike'), { recursive: true });
        writeFileSync(
          file,
          JSON.stringify(
            {
              blocks: Object.fromEntries(registry.blocks),
              items: Object.fromEntries(registry.items),
              blockSubstitutions: registry.blockSubstitutions,
              itemSubstitutions: registry.itemSubstitutions,
            },
            null,
            1,
          ),
        );
        out['registry'] = { blocks: registry.blocks.size, items: registry.items.size, file };
      }
      resolve({
        ...out,
        outcome,
        ...extra,
        fmlHandshakeState: fml,
        packetCounts: Object.fromEntries(
          [...packetCounts].map(([k, v]) => [`0x${k.toString(16).padStart(2, '0')}`, v]),
        ),
        pluginChannels: Object.fromEntries(pluginChannels),
        chat: chat.slice(0, 10),
        timeline,
      });
    };
    const overall = setTimeout(() => finish('timeout', { afterMs: timeoutMs }), timeoutMs);

    const send = (id: number, body: Buffer): void => {
      socket.write(frame(id, body));
    };
    // Client -> server plugin message (0x17): channel, short length, data.
    const sendPlugin = (channel: string, data: Buffer): void => {
      send(0x17, Buffer.concat([mcString(channel), u16(data.length), data]));
    };
    const ack = (phase: number): void => {
      sendPlugin('FML|HS', Buffer.from([0xff, phase]));
      note(`sent FML|HS HandshakeAck(${phase})`);
    };

    const onFmlHs = (data: Buffer): void => {
      const disc = data.readInt8(0);
      switch (disc) {
        case 0: {
          // ServerHello: respond with REGISTER, ClientHello and our mod list (echo of the server's).
          const protocolVersion = data.readUInt8(1);
          note(`recv ServerHello (FML protocol ${protocolVersion})`);
          sendPlugin(
            'REGISTER',
            Buffer.from(['FML|HS', 'FML', 'FML|MP', 'FML', 'FORGE'].join('\0')),
          );
          sendPlugin('FML|HS', Buffer.from([1, protocolVersion]));
          const modList = Buffer.concat([
            Buffer.from([2]),
            varint(serverMods.length),
            ...serverMods.flatMap((m) => [mcString(m.modid), mcString(m.version)]),
          ]);
          sendPlugin('FML|HS', modList);
          note(`sent ClientHello + ModList (${serverMods.length} mods)`);
          fml = 'WAITINGSERVERDATA';
          return;
        }
        case 2: {
          const r = new Reader(data, 1);
          note(`recv server ModList (${r.varint()} mods)`);
          if (fml === 'WAITINGSERVERDATA') {
            ack(2);
            fml = 'WAITINGSERVERCOMPLETE';
          }
          return;
        }
        case 3: {
          registry = parseModIdData(data);
          note(
            `recv ModIdData (${registry.blocks.size} blocks, ${registry.items.size} items, ${data.length} bytes)`,
          );
          if (fml === 'WAITINGSERVERCOMPLETE') {
            ack(3);
            fml = 'PENDINGCOMPLETE';
          }
          return;
        }
        case -1: {
          const phase = data.readInt8(1);
          note(`recv server HandshakeAck(${phase})`);
          if (fml === 'PENDINGCOMPLETE') {
            ack(4);
            fml = 'COMPLETE';
          } else if (fml === 'COMPLETE') {
            ack(5);
            fml = 'DONE';
          }
          return;
        }
        default:
          note(`recv FML|HS discriminator ${disc} (ignored)`);
      }
    };

    const onPlugin = (channel: string, data: Buffer): void => {
      pluginChannels.set(channel, (pluginChannels.get(channel) ?? 0) + 1);
      if (channel === 'FML|HS') return onFmlHs(data);
      if (channel === 'REGISTER') {
        note(`recv REGISTER (${data.toString('utf8').split('\0').length} channels)`);
        return;
      }
      if (channel === 'FML|MP') {
        // FML multipart: preamble (channel, parts, total length), then indexed parts.
        const r = new Reader(data);
        if (multipart === null) {
          multipart = { channel: r.string(), parts: r.u8(), total: r.i32(), chunks: [] };
          note(
            `recv FML|MP preamble for ${multipart.channel}: ${multipart.parts} parts, ${multipart.total} bytes`,
          );
        } else {
          r.u8(); // part index
          multipart.chunks.push(Buffer.from(r.bytes(r.remaining)));
          if (multipart.chunks.length === multipart.parts) {
            const whole = Buffer.concat(multipart.chunks).subarray(0, multipart.total);
            const ch = multipart.channel;
            multipart = null;
            onPlugin(ch, whole);
          }
        }
      }
    };

    const onLoginPacket = (id: number, r: Reader): void => {
      if (id === 0x00) return finish('kicked-during-login', { reason: r.string() });
      if (id === 0x01) return finish('server-requires-online-mode');
      if (id === 0x02) {
        const uuid = r.string();
        const name = r.string();
        note(`login success as ${name} (${uuid})`);
        out['loginUuid'] = uuid;
        state = 'play';
      }
    };

    const onPlayPacket = (id: number, r: Reader): void => {
      packetCounts.set(id, (packetCounts.get(id) ?? 0) + 1);
      switch (id) {
        case 0x00: // Keep Alive: echo
          send(0x00, i32(r.i32()));
          return;
        case 0x01: {
          const joinGame = {
            entityId: r.i32(),
            gamemode: r.u8(),
            dimension: r.i8(),
            difficulty: r.u8(),
            maxPlayers: r.u8(),
            levelType: r.string(),
          };
          note(`JOIN GAME ${JSON.stringify(joinGame)}`);
          out['joined'] = true;
          out['joinGame'] = joinGame;
          stayTimer = setTimeout(() => finish('joined-and-left'), stayMs);
          return;
        }
        case 0x02:
          if (chat.length < 10) chat.push(r.string().slice(0, 300));
          return;
        case 0x05:
          out['spawnPosition'] = { x: r.i32(), y: r.i32(), z: r.i32() };
          return;
        case 0x06:
          out['health'] = { health: r.f32(), food: r.i16(), saturation: r.f32() };
          note(`update health ${JSON.stringify(out['health'])}`);
          return;
        case 0x08:
          out['position'] = {
            x: r.f64(),
            yEyes: r.f64(),
            z: r.f64(),
            yaw: r.f32(),
            pitch: r.f32(),
            onGround: r.bool(),
          };
          note(`position ${JSON.stringify(out['position'])}`);
          return;
        case 0x30: {
          const windowId = r.u8();
          const count = r.i16();
          if (windowId !== 0) return;
          const items: SlotItem[] = [];
          for (let s = 0; s < count; s++) {
            const item = readSlot(r, s, registry);
            if (item) items.push(item);
          }
          out['inventory'] = { slots: count, items };
          note(`player inventory: ${items.length} stacks in ${count} slots`);
          return;
        }
        case 0x3f: {
          const channel = r.string();
          const len = r.varshort();
          onPlugin(channel, Buffer.from(r.bytes(len)));
          return;
        }
        case 0x40:
          return finish('kicked', { reason: r.string() });
        default:
          return;
      }
    };

    socket.on('connect', () => {
      note('tcp connected');
      // Handshake with the FML marker, then Login Start.
      send(0x00, Buffer.concat([varint(5), mcString(`${host}\0FML\0`), u16(port), varint(2)]));
      send(0x00, mcString(values.username));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        let r: Reader;
        let len: number;
        try {
          r = new Reader(buf);
          len = r.varint();
        } catch {
          return; // incomplete length prefix
        }
        if (buf.length < r.o + len) return;
        const body = buf.subarray(r.o, r.o + len);
        buf = buf.subarray(r.o + len);
        try {
          const pr = new Reader(body);
          const id = pr.varint();
          if (state === 'login') onLoginPacket(id, pr);
          else onPlayPacket(id, pr);
        } catch (error) {
          note(`parse error: ${errorMessage(error)}`);
        }
        if (settled) return;
      }
    });
    socket.on('error', (error) => finish('socket-error', { error: error.message }));
    socket.on('close', () => finish('connection-closed'));
  });
}

function save(code: number, message: string): number {
  report['finishedAt'] = new Date().toISOString();
  report['message'] = message;
  mkdirSync(join('data', 'spike'), { recursive: true });
  const file = join('data', 'spike', `join-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`${message}\nSaved ${file}`);
  return code;
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

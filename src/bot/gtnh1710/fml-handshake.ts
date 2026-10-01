import { BQ_CHANNEL } from './better-questing.ts';
import { parseModIdData, type Registry } from './registry.ts';
import { encodeString, encodeVarInt, Reader } from './wire.ts';

/**
 * Client side of the Forge 1.7.10 FML|HS handshake, as a pure state machine.
 *
 *   server ServerHello          -> client REGISTER, ClientHello, ModList
 *   server ModList              -> client Ack(2)   (WAITINGSERVERDATA)
 *   server ModIdData (registry) -> client Ack(3)   (WAITINGSERVERCOMPLETE)
 *   server Ack                  -> client Ack(4)   (PENDINGCOMPLETE)
 *   server Ack                  -> client Ack(5)   (COMPLETE)  => done
 *
 * The client's mod list is the server's own list (from the status ping), so the
 * server's version checks pass. No mod code runs on our side.
 */

export interface ModEntry {
  modid: string;
  version: string;
}

export type HandshakeStep =
  'HELLO' | 'WAITINGSERVERDATA' | 'WAITINGSERVERCOMPLETE' | 'PENDINGCOMPLETE' | 'COMPLETE' | 'DONE';

export interface HandshakeOutput {
  /** Plugin messages to send, in order. */
  send: Array<{ channel: 'REGISTER' | 'FML|HS'; data: Buffer }>;
  /** Human-readable trace line for logs. */
  note: string;
}

const CLIENT_CHANNELS = ['FML|HS', 'FML', 'FML|MP', 'FORGE'];

/**
 * Mod channels a stock client registers too, when the server runs the mod. Registering is
 * only an announcement (Forge accepts a mod channel's messages either way).
 */
const MOD_CHANNELS: ReadonlyArray<{ modid: string; channel: string }> = [
  { modid: 'betterquesting', channel: BQ_CHANNEL },
];

export class FmlClientHandshake {
  #step: HandshakeStep = 'HELLO';
  #registry: Registry | null = null;
  #serverModCount: number | null = null;
  readonly #mods: readonly ModEntry[];

  constructor(mods: readonly ModEntry[]) {
    if (mods.length === 0) throw new Error('FML handshake needs the server mod list');
    this.#mods = mods;
  }

  get step(): HandshakeStep {
    return this.#step;
  }

  get done(): boolean {
    return this.#step === 'DONE';
  }

  get registry(): Registry | null {
    return this.#registry;
  }

  get serverModCount(): number | null {
    return this.#serverModCount;
  }

  /** Feed one FML|HS payload from the server. Throws on anything out of sequence. */
  onServerMessage(data: Buffer): HandshakeOutput {
    if (data.length < 1) throw new Error('empty FML|HS message');
    const discriminator = data.readInt8(0);

    switch (this.#step) {
      case 'HELLO': {
        if (discriminator !== 0) break;
        const protocolVersion = data.readUInt8(1);
        this.#step = 'WAITINGSERVERDATA';
        const channels = [
          ...CLIENT_CHANNELS,
          ...MOD_CHANNELS.filter((c) => this.#mods.some((m) => m.modid === c.modid)).map(
            (c) => c.channel,
          ),
        ];
        return {
          note: `ServerHello (FML protocol ${protocolVersion}); sent ClientHello + ${this.#mods.length} mods`,
          send: [
            { channel: 'REGISTER', data: Buffer.from(channels.join('\0')) },
            { channel: 'FML|HS', data: Buffer.from([1, protocolVersion]) },
            { channel: 'FML|HS', data: this.#modListMessage() },
          ],
        };
      }
      case 'WAITINGSERVERDATA': {
        if (discriminator !== 2) break;
        this.#serverModCount = new Reader(data, 1).varInt();
        this.#step = 'WAITINGSERVERCOMPLETE';
        return { note: `server ModList (${this.#serverModCount} mods)`, send: [ack(2)] };
      }
      case 'WAITINGSERVERCOMPLETE': {
        if (discriminator !== 3) break;
        this.#registry = parseModIdData(data);
        this.#step = 'PENDINGCOMPLETE';
        return {
          note: `registry: ${this.#registry.items.size} items, ${this.#registry.blocks.size} blocks`,
          send: [ack(3)],
        };
      }
      case 'PENDINGCOMPLETE': {
        if (discriminator !== -1) break;
        this.#step = 'COMPLETE';
        return { note: `server ack ${data.readInt8(1)}`, send: [ack(4)] };
      }
      case 'COMPLETE': {
        if (discriminator !== -1) break;
        this.#step = 'DONE';
        return { note: `server ack ${data.readInt8(1)}; handshake complete`, send: [ack(5)] };
      }
      case 'DONE':
        return { note: `ignored FML|HS ${discriminator} after completion`, send: [] };
    }
    throw new Error(`unexpected FML|HS discriminator ${discriminator} in step ${this.#step}`);
  }

  #modListMessage(): Buffer {
    return Buffer.concat([
      Buffer.from([2]),
      encodeVarInt(this.#mods.length),
      ...this.#mods.flatMap((m) => [encodeString(m.modid), encodeString(m.version)]),
    ]);
  }
}

function ack(phase: number): { channel: 'FML|HS'; data: Buffer } {
  return { channel: 'FML|HS', data: Buffer.from([0xff, phase]) };
}

/**
 * Reassembles Forge's FML|MP multipart messages (used when a payload exceeds one
 * plugin message): a preamble (channel, part count, total length), then indexed parts.
 */
export class MultipartAssembler {
  #current: { channel: string; parts: number; total: number; chunks: Buffer[] } | null = null;

  /** Returns the reassembled message once all parts have arrived. */
  push(data: Buffer): { channel: string; data: Buffer } | null {
    const r = new Reader(data);
    if (this.#current === null) {
      this.#current = { channel: r.string(), parts: r.u8(), total: r.i32(), chunks: [] };
      return null;
    }
    r.u8(); // part index
    this.#current.chunks.push(Buffer.from(r.bytes(r.remaining)));
    if (this.#current.chunks.length < this.#current.parts) return null;
    const done = {
      channel: this.#current.channel,
      data: Buffer.concat(this.#current.chunks).subarray(0, this.#current.total),
    };
    this.#current = null;
    return done;
  }
}

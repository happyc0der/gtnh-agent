/**
 * Minimal, dependency-free Minecraft 1.7.x status ping (Server List Ping).
 * Used by the connectivity spike because minecraft-protocol's ping() falls back to
 * the legacy (pre-1.7) format for 1.7.10, which carries no Forge mod list.
 *
 * Returns the parsed status JSON, or the text of a disconnect the server sent instead.
 */
import { connect } from 'node:net';

export type StatusResult =
  | { kind: 'status'; json: Record<string, unknown> }
  | { kind: 'disconnect'; text: string }
  | { kind: 'error'; error: string };

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

function readVarint(buf: Buffer, offset: number): [number, number] | null {
  let value = 0;
  let shift = 0;
  let o = offset;
  for (;;) {
    if (o >= buf.length) return null;
    const b = buf[o++] as number;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [value, o];
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  }
}

function packet(id: number, body: Buffer): Buffer {
  const payload = Buffer.concat([varint(id), body]);
  return Buffer.concat([varint(payload.length), payload]);
}

function mcString(s: string): Buffer {
  return Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
}

/** Protocol 5 = Minecraft 1.7.6-1.7.10. */
export function statusPing(
  host: string,
  port: number,
  timeoutMs = 10_000,
  protocol = 5,
): Promise<StatusResult> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = connect(port, host);
    const done = (result: StatusResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => done({ kind: 'error', error: `timeout after ${timeoutMs} ms` }),
      timeoutMs,
    );

    socket.on('connect', () => {
      const portBytes = Buffer.alloc(2);
      portBytes.writeUInt16BE(port);
      const handshake = packet(
        0x00,
        Buffer.concat([varint(protocol), mcString(host), portBytes, varint(1)]),
      );
      socket.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const len = readVarint(buf, 0);
      if (len === null || buf.length < len[1] + len[0]) return;
      const id = readVarint(buf, len[1]);
      const strLen = id && readVarint(buf, id[1]);
      if (!id || !strLen) return done({ kind: 'error', error: 'malformed response' });
      const text = buf.subarray(strLen[1], strLen[1] + strLen[0]).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return done({ kind: 'error', error: `non-JSON response: ${text.slice(0, 200)}` });
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        done({ kind: 'status', json: parsed as Record<string, unknown> });
      } else {
        // A disconnect sent in place of a status response (e.g. Forge "still starting").
        done({
          kind: 'disconnect',
          text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
        });
      }
    });
    socket.on('error', (error) => done({ kind: 'error', error: error.message }));
    socket.on('close', () => done({ kind: 'error', error: 'connection closed before a response' }));
  });
}

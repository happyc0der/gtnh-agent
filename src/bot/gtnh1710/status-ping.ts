import { connect } from 'node:net';
import { outbound } from './packets.ts';
import { FrameDecoder } from './wire.ts';

/**
 * Minecraft 1.7.x Server List Ping. Returns Forge's mod list for FML servers
 * (minecraft-protocol's ping() falls back to the pre-1.7 format for 1.7.10, which lacks it).
 */
export type StatusResult =
  | { kind: 'status'; json: Record<string, unknown> }
  | { kind: 'disconnect'; text: string }
  | { kind: 'error'; error: string };

export interface ServerIdentity {
  motd: string;
  modinfoType: string | null;
  mods: Array<{ modid: string; version: string }>;
  versionName: string | null;
}

export function statusPing(host: string, port: number, timeoutMs = 10_000): Promise<StatusResult> {
  return new Promise((resolve) => {
    let settled = false;
    const decoder = new FrameDecoder();
    const socket = connect(port, host);
    const done = (result: StatusResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => done({ kind: 'error', error: `status ping timed out after ${timeoutMs} ms` }),
      timeoutMs,
    );

    socket.on('connect', () => {
      socket.write(
        Buffer.concat([outbound.handshake(host, port, 1).frame, outbound.statusRequest().frame]),
      );
    });
    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const text = frame.body.string();
          const parsed: unknown = JSON.parse(text);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            done({ kind: 'status', json: parsed as Record<string, unknown> });
          } else {
            // Forge answers with a disconnect (e.g. "Server is still starting!") instead of a status.
            done({
              kind: 'disconnect',
              text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
            });
          }
          return;
        }
      } catch (error) {
        done({
          kind: 'error',
          error: `bad status response: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
    socket.on('error', (error) => done({ kind: 'error', error: error.message }));
    socket.on('close', () =>
      done({ kind: 'error', error: 'connection closed before a status response' }),
    );
  });
}

function describeMotd(description: unknown): string {
  if (typeof description === 'string') return description;
  if (description !== null && typeof description === 'object') {
    const d = description as { text?: unknown; extra?: unknown[] };
    const extra = Array.isArray(d.extra) ? d.extra.map(describeMotd).join('') : '';
    return `${typeof d.text === 'string' ? d.text : ''}${extra}`;
  }
  return '';
}

export function parseIdentity(json: Record<string, unknown>): ServerIdentity {
  const modinfo = json['modinfo'] as { type?: unknown; modList?: unknown } | undefined;
  const modList = Array.isArray(modinfo?.modList) ? modinfo.modList : [];
  const mods = modList.flatMap((m: unknown) => {
    const e = m as { modid?: unknown; version?: unknown };
    return typeof e.modid === 'string' && typeof e.version === 'string'
      ? [{ modid: e.modid, version: e.version }]
      : [];
  });
  const version = json['version'] as { name?: unknown } | undefined;
  return {
    motd: describeMotd(json['description']),
    modinfoType: typeof modinfo?.type === 'string' ? modinfo.type : null,
    mods,
    versionName: typeof version?.name === 'string' ? version.name : null,
  };
}

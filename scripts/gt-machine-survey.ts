/**
 * Read-only GregTech machine survey against the private GTNH test server.
 *
 * Connects with the agent's own Gtnh1710Client, listens for N seconds through its
 * diagnostic tap, tallies every plugin channel the server uses (and GregTech packet types),
 * and prints the machines the client tracked with their flags. Used to ground machine
 * observation (docs/gtnh-compatibility.md, "Machines").
 *
 * Usage: node scripts/gt-machine-survey.ts [--seconds 10]
 * Needs the live settings from README "Private GTNH test server" (.env).
 */
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { decodeGregTechMessage, GT_CHANNEL } from '../src/bot/gtnh1710/gregtech.ts';
import { Gtnh1710Client } from '../src/bot/gtnh1710/gtnh-client.ts';
import { Reader } from '../src/bot/gtnh1710/wire.ts';
import { loadConfig } from '../src/config/env.ts';
import { systemClock } from '../src/util/clock.ts';
import { errorMessage } from '../src/util/json.ts';

dotenv.config({ quiet: true });
const { values } = parseArgs({ options: { seconds: { type: 'string', default: '10' } } });
const seconds = Math.max(1, Math.min(120, Number(values.seconds) || 10));

const channels = new Map<string, number>();
const gtTypes = new Map<string, number>();
const errors: string[] = [];
const started = Date.now();
/** Machine placements and state changes as they arrive (ores and other packet types are only counted). */
const timeline: string[] = [];
const t = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;

function onFrame(phase: 'login' | 'play', id: number, body: Buffer): void {
  if (phase !== 'play' || id !== 0x3f) return;
  try {
    const r = new Reader(body);
    const channel = r.string();
    channels.set(channel, (channels.get(channel) ?? 0) + 1);
    if (channel !== GT_CHANNEL) return;
    const data = r.bytes(r.i16());
    const m = decodeGregTechMessage(data);
    const key = m.type === 'gt-other' ? `other:${m.packetType}` : m.type;
    gtTypes.set(key, (gtTypes.get(key) ?? 0) + 1);
    if (m.type === 'gt-tile-entity' && timeline.length < 200) {
      timeline.push(
        `${t()} tile entity mID ${m.metaTileId} at (${m.x}, ${m.y}, ${m.z}) common ${m.common}`,
      );
    }
    if (m.type === 'gt-block-events') {
      for (const e of m.events) {
        if (timeline.length < 200) {
          timeline.push(
            `${t()} block event ${e.eventId} value ${e.value} at (${e.x}, ${e.y}, ${e.z}) dim ${m.dimension}`,
          );
        }
      }
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
}

const { config } = loadConfig();
const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock, onFrame });
try {
  await client.connect();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const state = await client.observe();
  process.stdout.write(
    `${JSON.stringify(
      {
        seconds,
        pluginChannels: Object.fromEntries([...channels].sort((a, b) => b[1] - a[1])),
        gregTechPackets: Object.fromEntries(gtTypes),
        timeline,
        trackedMachines: client.world.trackedMachines(),
        stateMachines: state.machines,
        errors: errors.slice(0, 10),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.disconnect();
}

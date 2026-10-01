/**
 * Read-only survey of the ground around the bot on the private GTNH test server: for each
 * column within --radius blocks, the top non-air block (the surface a player sees from
 * above), tallied, plus where the nearest exposed sand, gravel, clay, logs and water are.
 * Used to choose where the agent starts playing. Nothing is sent but the login and the
 * client's keep-alives; the bot stands still.
 *
 * Usage: node scripts/surface-survey.ts [--radius 48] [--seconds 5]
 * Needs the live settings from README "Private GTNH test server" (.env).
 */
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { Gtnh1710Client } from '../src/bot/gtnh1710/gtnh-client.ts';
import { loadConfig } from '../src/config/env.ts';
import { systemClock } from '../src/util/clock.ts';

dotenv.config({ quiet: true });
const { values } = parseArgs({
  options: {
    radius: { type: 'string', default: '48' },
    seconds: { type: 'string', default: '5' },
  },
});
const radius = Math.max(4, Math.min(96, Number(values.radius) || 48));
const seconds = Math.max(1, Math.min(60, Number(values.seconds) || 5));

const INTERESTING = [
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
  'minecraft:log',
  'minecraft:log2',
  'minecraft:water',
  'minecraft:flowing_water',
  'minecraft:lava',
  'minecraft:stone',
  'minecraft:cobblestone',
];

const { config } = loadConfig();
const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
try {
  await client.connect();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const state = await client.observe();
  const at = state.player.position.known ? state.player.position.value : null;
  const world = client.world.walkWorld();
  if (at === null || world === null) throw new Error('position or world unknown');
  const surface = new Map<string, number>();
  const nearest = new Map<string, { d: number; x: number; y: number; z: number }>();
  /** Exposed blocks anywhere in the column (a face touching air or water), for resources. */
  const exposed = new Map<string, number>();
  const name = (x: number, y: number, z: number): string | null => {
    const id = world.blockAt(x, y, z);
    return id === undefined ? null : (world.blockName(id) ?? `#${id}`);
  };
  const open = (n: string | null): boolean =>
    n === 'minecraft:air' || n === 'minecraft:water' || n === 'minecraft:flowing_water';
  const cx = Math.floor(at.x);
  const cz = Math.floor(at.z);
  let unloaded = 0;
  for (let x = cx - radius; x <= cx + radius; x++) {
    for (let z = cz - radius; z <= cz + radius; z++) {
      if (name(x, 64, z) === null) {
        unloaded++;
        continue;
      }
      let top: string | null = null;
      for (let y = 255; y >= 1; y--) {
        const n = name(x, y, z);
        if (n === null) break;
        // The pen and other test fixtures float at y>=190: look below them.
        if (top === null && n !== 'minecraft:air' && y < 190) {
          top = n;
          surface.set(n, (surface.get(n) ?? 0) + 1);
          const d = Math.hypot(x + 0.5 - at.x, z + 0.5 - at.z);
          const best = nearest.get(n);
          if (INTERESTING.includes(n) && (best === undefined || d < best.d)) {
            nearest.set(n, { d, x, y, z });
          }
        }
        if (INTERESTING.includes(n) && y < 190) {
          const faces = [
            name(x + 1, y, z),
            name(x - 1, y, z),
            name(x, y + 1, z),
            name(x, y - 1, z),
            name(x, y, z + 1),
            name(x, y, z - 1),
          ];
          if (faces.some(open)) exposed.set(n, (exposed.get(n) ?? 0) + 1);
        }
      }
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        bot: at,
        radius,
        unloadedColumns: unloaded,
        surfaceBlocks: Object.fromEntries([...surface].sort((a, b) => b[1] - a[1]).slice(0, 25)),
        nearestOnSurface: Object.fromEntries(
          [...nearest].map(([n, p]) => [n, `${p.d.toFixed(1)} m at (${p.x}, ${p.y}, ${p.z})`]),
        ),
        exposedBlocks: Object.fromEntries(exposed),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.disconnect();
}

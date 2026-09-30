/**
 * Extracts a GTNH quest line from the test server's Better Questing files into a data
 * module the agent can plan from (src/goals/age0-quests.ts): each quest's id, name, a
 * short description, prerequisites and item requirements (registry name + damage +
 * count, the same naming the agent uses for its inventory).
 *
 * Usage: node scripts/extract-quests.ts [--line Tier0StoneAge] [--out src/goals/age0-quests.ts]
 * Needs TEST_SERVER_DIR (.env). Read-only: only reads the server's config files.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const { values } = parseArgs({
  options: {
    line: { type: 'string', default: 'Tier0StoneAge' },
    out: { type: 'string', default: 'src/goals/age0-quests.ts' },
  },
});
const serverDir = process.env['TEST_SERVER_DIR'];
if (serverDir === undefined || serverDir.trim() === '')
  throw new Error('TEST_SERVER_DIR is not set');
const base = join(serverDir.trim(), 'config', 'betterquesting', 'DefaultQuests');

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const plain = (s: string): string => s.replace(/§./g, '').replace(/\s+/g, ' ').trim();
// Quest ids are 64-bit longs (newer quests use whole UUIDs): read them as exact strings.
const LONG_ID = /"(questID(?:High|Low):4)"\s*:\s*(-?\d+)/g;
const parse = (file: string): Json =>
  obj(JSON.parse(readFileSync(file, 'utf8').replace(LONG_ID, '"$1":"$2"')));
const idPart = (v: unknown): string => (typeof v === 'string' ? v : String(num(v)));
const qid = (d: Json): string => `${idPart(d['questIDHigh:4'])}:${idPart(d['questIDLow:4'])}`;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : [],
  );
}

const lineDir = readdirSync(join(base, 'QuestLines')).find((d) => d.startsWith(values.line));
if (lineDir === undefined) throw new Error(`no quest line starting with ${values.line}`);
const members = new Map<string, { x: number; y: number }>();
for (const f of walk(join(base, 'QuestLines', lineDir))) {
  const d = parse(f);
  if (d['questIDLow:4'] !== undefined) members.set(qid(d), { x: num(d['x:3']), y: num(d['y:3']) });
}

interface OutQuest {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  prerequisiteLogic: string;
  main: boolean;
  tasks: Array<{
    type: string;
    consume: boolean;
    items: Array<{ item: string; count: number; oreDict: string | null; anyDamage: boolean }>;
  }>;
  layout: { x: number; y: number };
}
const quests: OutQuest[] = [];
for (const f of walk(join(base, 'Quests'))) {
  let d: Json;
  try {
    d = parse(f);
  } catch {
    continue;
  }
  const id = qid(d);
  const layout = members.get(id);
  if (layout === undefined) continue;
  const props = obj(obj(d['properties:10'])['betterquesting:10']);
  quests.push({
    id,
    name: plain(str(props['name:8'])),
    description: plain(str(props['desc:8'])).slice(0, 300),
    prerequisites: Object.values(obj(d['preRequisites:9'])).map((p) => qid(obj(p))),
    prerequisiteLogic: str(props['questLogic:8']) || 'AND',
    main: num(props['isMain:1']) === 1,
    tasks: Object.values(obj(d['tasks:9'])).map((t0) => {
      const t = obj(t0);
      return {
        type: str(t['taskID:8']),
        consume: num(t['consume:1']) === 1,
        items: Object.values(obj(t['requiredItems:9'])).map((i0) => {
          const i = obj(i0);
          const damage = num(i['Damage:2']);
          const name = str(i['id:8']);
          return {
            item: damage === 0 || damage === 32767 ? name : `${name}@${damage}`,
            count: num(i['Count:3']) || 1,
            oreDict: str(i['OreDict:8']) || null,
            anyDamage: damage === 32767,
          };
        }),
      };
    }),
    layout,
  });
}
quests.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);

const header = `/**
 * GTNH 2.8.4 quest line "${values.line}" (${quests.length} quests), extracted from the test
 * server's Better Questing files by scripts/extract-quests.ts. Generated; do not edit by hand.
 */
import type { Quest } from './quest-goals.ts';

export const QUESTS_GTNH_VERSION = '2.8.4';

export const AGE0_QUESTS: readonly Quest[] = `;
writeFileSync(values.out, `${header}${JSON.stringify(quests, null, 2)};\n`);
process.stdout.write(`wrote ${quests.length} quests to ${values.out}\n`);

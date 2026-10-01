/**
 * Extracts the Age 0 quest goals from the test server's Better Questing data into
 * src/goals/age0-quests.ts: the "Tier 0 - Stone Age" chapter AND every quest it needs from
 * other chapters (its prerequisites, recursively: the closure).
 *
 * Source: the WORLD's quest database (<world>/betterquesting/QuestDatabase.json), which is what
 * the server actually runs: Better Questing loads DefaultQuests only into a world that has no
 * QuestDatabase.json yet (SaveLoadHandler.loadConfig). Without a world database it falls back
 * to config/betterquesting/DefaultQuests, the pack's defaults, and says so.
 *
 * For each quest: its exact 64-bit id, name, a short description, prerequisites with their
 * logic (AND/OR/XOR/...), task logic, main flag, chapter, lockedProgress, tasks (index, type,
 * consume, items as registry name + damage + count + ore dictionary name, and whether crafts
 * made before the quest unlocked count) and rewards (items, and which reward is a choice).
 *
 * Usage: node scripts/extract-quests.ts [--chapter "Tier 0 - Stone Age"] [--out src/goals/age0-quests.ts]
 * Needs TEST_SERVER_DIR (.env). Read-only: only reads the server's files.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const { values } = parseArgs({
  options: {
    chapter: { type: 'string', default: 'Tier 0 - Stone Age' },
    out: { type: 'string', default: 'src/goals/age0-quests.ts' },
  },
});
const serverDir = process.env['TEST_SERVER_DIR']?.trim();
if (serverDir === undefined || serverDir === '') throw new Error('TEST_SERVER_DIR is not set');

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const plain = (s: string): string => s.replace(/§./g, '').replace(/\s+/g, ' ').trim();
/** Better Questing's JSON lists are objects keyed "0:10", "1:10", ... in order. */
const list = (v: unknown): Json[] => Object.values(obj(v)).map(obj);
// Quest ids are 64-bit longs (newer quests use whole UUIDs): read them as exact strings.
const LONG_ID = /"((?:questID|questLineID)(?:High|Low):4)"\s*:\s*(-?\d+)/g;
const parse = (file: string): Json =>
  obj(JSON.parse(readFileSync(file, 'utf8').replace(LONG_ID, '"$1":"$2"')));
const idPart = (v: unknown): string => (typeof v === 'string' ? v : String(num(v)));
const qid = (d: Json, prefix = 'questID'): string =>
  `${idPart(d[`${prefix}High:4`])}:${idPart(d[`${prefix}Low:4`])}`;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : [],
  );
}

interface Line {
  name: string;
  /** Quest id -> layout position in this chapter. */
  members: Map<string, { x: number; y: number }>;
}

/** All quests and chapters: the world's database if there is one, else DefaultQuests. */
function load(): { source: string; build: string; quests: Map<string, Json>; lines: Line[] } {
  const props = readFileSync(join(serverDir as string, 'server.properties'), 'utf8');
  const level = /^level-name=(.*)$/m.exec(props)?.[1]?.trim() ?? 'world';
  const worldDb = join(serverDir as string, level, 'betterquesting', 'QuestDatabase.json');
  if (existsSync(worldDb)) {
    const d = parse(worldDb);
    const quests = new Map(list(d['questDatabase:9']).map((q) => [qid(q), q]));
    const lines = list(d['questLines:9']).map((l) => ({
      name: plain(str(obj(obj(l['properties:10'])['betterquesting:10'])['name:8'])),
      members: new Map(
        list(l['quests:9']).map((e) => [qid(e), { x: num(e['x:3']), y: num(e['y:3']) }]),
      ),
    }));
    return {
      source: `${level}/betterquesting/QuestDatabase.json (the world's own quest database)`,
      build: str(d['build:8']),
      quests,
      lines,
    };
  }
  const base = join(serverDir as string, 'config', 'betterquesting', 'DefaultQuests');
  const quests = new Map<string, Json>();
  for (const f of walk(join(base, 'Quests'))) {
    try {
      const q = parse(f);
      if (q['questIDLow:4'] !== undefined) quests.set(qid(q), q);
    } catch {
      // not a quest file
    }
  }
  const lines = readdirSync(join(base, 'QuestLines'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(base, 'QuestLines', e.name);
      const members = new Map<string, { x: number; y: number }>();
      let name = e.name;
      for (const f of walk(dir)) {
        const d = parse(f);
        if (d['questIDLow:4'] !== undefined) {
          members.set(qid(d), { x: num(d['x:3']), y: num(d['y:3']) });
        } else if (d['properties:10'] !== undefined) {
          name = plain(str(obj(obj(d['properties:10'])['betterquesting:10'])['name:8'])) || name;
        }
      }
      return { name, members };
    });
  return {
    source: 'config/betterquesting/DefaultQuests (no world quest database found)',
    build: '',
    quests,
    lines,
  };
}

const { source, build, quests, lines } = load();
const chapter = lines.find((l) => l.name === values.chapter);
if (chapter === undefined) throw new Error(`no chapter named "${values.chapter}"`);

// The closure: the chapter's quests and, recursively, every prerequisite.
const closure = new Set<string>();
const visit = (id: string): void => {
  if (closure.has(id)) return;
  const q = quests.get(id);
  if (q === undefined) throw new Error(`prerequisite ${id} is missing from the quest database`);
  closure.add(id);
  for (const p of list(q['preRequisites:9'])) visit(qid(p));
};
for (const id of chapter.members.keys()) visit(id);

const item = (i0: Json) => {
  const damage = num(i0['Damage:2']);
  const name = str(i0['id:8']);
  return {
    item: damage === 0 || damage === 32767 ? name : `${name}@${damage}`,
    count: num(i0['Count:3']) || 1,
    oreDict: str(i0['OreDict:8']) || null,
    anyDamage: damage === 32767,
  };
};

const out = [...closure].map((id) => {
  const d = quests.get(id) as Json;
  const props = obj(obj(d['properties:10'])['betterquesting:10']);
  const inChapter = chapter.members.has(id);
  const home = inChapter ? chapter : lines.find((l) => l.members.has(id));
  return {
    id,
    name: plain(str(props['name:8'])),
    description: plain(str(props['desc:8'])).slice(0, 300),
    prerequisites: list(d['preRequisites:9']).map((p) => qid(p)),
    prerequisiteLogic: str(props['questLogic:8']) || 'AND',
    taskLogic: str(props['taskLogic:8']) || 'AND',
    main: num(props['isMain:1']) === 1,
    inChapter,
    chapter: home?.name ?? null,
    lockedProgress: num(props['lockedProgress:1']) === 1,
    tasks: list(d['tasks:9']).map((t) => ({
      index: num(t['index:3']),
      type: str(t['taskID:8']),
      consume: num(t['consume:1']) === 1,
      items: list(t['requiredItems:9']).map(item),
      craftedBeforeCount: num(t['allowCraftedFromStatistics:1']) === 1,
    })),
    rewards: list(d['rewards:9']).map((r) => {
      const choice = str(r['rewardID:8']) === 'bq_standard:choice';
      return {
        index: num(r['index:3']),
        type: str(r['rewardID:8']),
        choice,
        items: list(choice ? r['choices:9'] : r['rewards:9']).map(item),
      };
    }),
    layout: home?.members.get(id) ?? { x: 0, y: 0 },
  };
});

// The chapter in quest-book order, then the outside quests, deepest prerequisites first.
const depth = new Map<string, number>();
const depthOf = (id: string): number => {
  const known = depth.get(id);
  if (known !== undefined) return known;
  depth.set(id, 0); // a cycle in the data stops here
  const pre = list(quests.get(id)?.['preRequisites:9']).map((p) => qid(p));
  const value = pre.length === 0 ? 0 : 1 + Math.max(...pre.map(depthOf));
  depth.set(id, value);
  return value;
};
out.sort(
  (a, b) =>
    Number(b.inChapter) - Number(a.inChapter) ||
    (a.inChapter
      ? a.layout.y - b.layout.y || a.layout.x - b.layout.x
      : depthOf(a.id) - depthOf(b.id) || a.id.localeCompare(b.id)),
);

const inChapter = out.filter((q) => q.inChapter).length;
const header = `/**
 * GTNH 2.8.4 Age 0: the "${values.chapter}" chapter (${inChapter} quests) and the
 * ${out.length - inChapter} quests it needs from other chapters (its prerequisites, recursively),
 * ${out.length} in all. Generated by scripts/extract-quests.ts from the test server's
 * ${source}${build === '' ? '' : `\n * (Better Questing ${build})`}. Do not edit by hand.
 */
import type { Quest } from './quest-goals.ts';

export const QUESTS_GTNH_VERSION = '2.8.4';

/** The benchmark chapter ("Finish Age 0" = every quest in it, as the server records them). */
export const AGE0_CHAPTER = ${JSON.stringify(values.chapter)};

export const AGE0_QUESTS: readonly Quest[] = `;
writeFileSync(values.out, `${header}${JSON.stringify(out, null, 2)};\n`);
process.stdout.write(
  `wrote ${out.length} quests (${inChapter} in "${values.chapter}", ${out.length - inChapter} outside) to ${values.out}\nsource: ${source}\n`,
);

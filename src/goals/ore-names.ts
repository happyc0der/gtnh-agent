import { loadKnowledge } from './knowledge.ts';
import { ROUTE_BOOK } from './route-book.ts';

/**
 * GregTech ores by the names a person calls them ("iron", "brown limonite"), for owner
 * commands such as `!mine 16 iron ore`: every GT ore that generates in the Overworld, from the
 * route book's ore sources (the knowledge base's veins). All of them are dug as one block,
 * gregtech:gt.blockores (the material lives in the ore's tile entity, which the observation
 * does not read), so a command names the raw ore item its digs are counted by.
 */
export interface GtOre {
  /** The block to dig: always gregtech:gt.blockores. */
  block: string;
  /** What one dig yields: the raw ore item, e.g. gregtech:gt.metaitem.03@5032 for iron. */
  item: string;
  /** The material's name as GregTech writes it ("BrownLimonite"). */
  material: string;
}

const GT_ORE_BLOCK = 'gregtech:gt.blockores';

/** "BrownLimonite" -> ["brownlimonite", "brown limonite"]. */
function spellings(material: string): string[] {
  const spaced = material.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return [...new Set([material.toLowerCase(), spaced])];
}

let byName: ReadonlyMap<string, GtOre> | null = null;

function oreTable(): ReadonlyMap<string, GtOre> {
  if (byName !== null) return byName;
  const table = new Map<string, GtOre>();
  for (const source of ROUTE_BOOK.sources) {
    if (!source.blocks.includes(GT_ORE_BLOCK)) continue;
    // A GT ore source's `where` starts "<Material> ore (gregtech:gt.blockores@<id>)".
    const material = /^(\w+) ore \(gregtech:gt\.blockores@\d+\)/.exec(source.where ?? '')?.[1];
    if (material === undefined) continue;
    const ore: GtOre = { block: GT_ORE_BLOCK, item: source.item, material };
    for (const name of spellings(material)) if (!table.has(name)) table.set(name, ore);
  }
  byName = table;
  return table;
}

/**
 * The GT ore a person means by `name` ("iron", "Brown Limonite", "copper ore", "tin ores"),
 * or null when no Overworld GT ore is called that.
 */
export function gtOreByName(name: string): GtOre | null {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/\s+ores?$/, '')
    .replace(/\s+/g, ' ');
  const table = oreTable();
  return table.get(key) ?? table.get(key.replace(/ /g, '')) ?? null;
}

/** A GT ore as its tile entity's metadata says: its material, and what a dig of it drops. */
export interface GtOreKind {
  /** The material's name as GregTech writes it ("BrownLimonite"). */
  material: string;
  /** A small ore (its drops are a mix of gems, crushed ore and dust). */
  small: boolean;
  /** What one dig drops without fortune: a vein ore its raw ore; a small ore its mix. */
  drops: string[];
}

let byId: { vein: Map<number, GtOreKind>; small: Map<number, GtOreKind> } | null = null;

/** The knowledge base's ores by material id (every dimension: the material decides). */
function oresById(): { vein: Map<number, GtOreKind>; small: Map<number, GtOreKind> } {
  if (byId !== null) return byId;
  const vein = new Map<number, GtOreKind>();
  const small = new Map<number, GtOreKind>();
  const idOf = (block: string): number => Number(block.slice(block.indexOf('@') + 1));
  try {
    const data = loadKnowledge();
    for (const v of data.veins) {
      for (const o of [v.primary, v.secondary, v.between, v.sporadic]) {
        if (o === null || o.block === null || o.drop === null) continue;
        const id = idOf(o.block);
        if (Number.isInteger(id) && !vein.has(id)) {
          vein.set(id, { material: o.material, small: false, drops: [o.drop] });
        }
      }
    }
    for (const s of data.smallOres) {
      if (s.block === null) continue;
      const id = idOf(s.block) - SMALL_ORE_META;
      const drops = s.drops.filter(([, perDig]) => perDig > 0).map(([item]) => item);
      if (Number.isInteger(id) && !small.has(id)) {
        small.set(id, { material: s.material, small: true, drops });
      }
    }
  } catch {
    // No knowledge base: no ore is known by its metadata.
  }
  byId = { vein, small };
  return byId;
}

/** TileEntityOres.mMetaData of a small ore is 16000 more than its material id (+ stone). */
const SMALL_ORE_META = 16000;

/**
 * The GT ore whose tile entity's metadata is `meta` (TileEntityOres.mMetaData, as the server
 * sends it: the material id, plus 1000 x the stone it sits in, plus 16000 for a small ore;
 * gregtech 5.09.51.482 TileEntityOres.setOreBlock), or null when the knowledge base has no
 * such ore.
 */
export function gtOreOfMeta(meta: number): GtOreKind | null {
  if (!Number.isInteger(meta) || meta < 0) return null;
  const small = meta >= SMALL_ORE_META;
  const id = meta % 1000;
  const table = oresById();
  return (small ? table.small : table.vein).get(id) ?? null;
}

/** "BrownLimonite" -> "brown limonite ore" (a small one: "small brown limonite ore"). */
export function gtOreLabel(ore: GtOreKind): string {
  const name = ore.material.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `${ore.small ? 'small ' : ''}${name} ore`;
}

/** The GT ore whose raw ore item is `item` (gregtech:gt.metaitem.03@5032: iron), or null. */
export function gtOreByItem(item: string): GtOre | null {
  for (const ore of oreTable().values()) if (ore.item === item) return ore;
  return null;
}

/**
 * The Overworld's GregTech veins that hold `material` (any of a vein's four ores): their
 * heights and weights, for a strip mine's level (src/app/play/strip-mine.ts); [] when none
 * does or there is no knowledge base.
 */
export function gtOreVeins(
  material: string,
): Array<{ minY: number; maxY: number; weight: number }> {
  try {
    return loadKnowledge()
      .veins.filter(
        (v) =>
          v.dims.includes('Overworld') &&
          [v.primary, v.secondary, v.between, v.sporadic].some(
            (o) => o !== null && o.material === material,
          ),
      )
      .map((v) => ({ minY: v.minY, maxY: v.maxY, weight: v.weight }));
  } catch {
    return [];
  }
}

/**
 * The heights at which the Overworld's GregTech veins hold `material` (any of a vein's four
 * ores: primary, secondary, between, sporadic), as one range from the lowest vein's bottom to
 * the highest's top; null when no Overworld vein holds it or there is no knowledge base.
 */
export function gtOreHeights(material: string): { minY: number; maxY: number } | null {
  let range: { minY: number; maxY: number } | null = null;
  try {
    for (const v of loadKnowledge().veins) {
      if (!v.dims.includes('Overworld')) continue;
      const ores = [v.primary, v.secondary, v.between, v.sporadic];
      if (!ores.some((o) => o !== null && o.material === material)) continue;
      range =
        range === null
          ? { minY: v.minY, maxY: v.maxY }
          : { minY: Math.min(range.minY, v.minY), maxY: Math.max(range.maxY, v.maxY) };
    }
  } catch {
    return null;
  }
  return range;
}

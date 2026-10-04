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

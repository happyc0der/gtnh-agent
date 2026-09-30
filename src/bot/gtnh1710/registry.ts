import { ItemNameSchema } from '../../domain/common.ts';
import { Reader } from './wire.ts';

/**
 * The per-world numeric ID -> registry name map that Forge 1.7.10 sends during the
 * FML handshake (FML|HS "ModIdData"). Numeric IDs differ between worlds, so this is
 * read on every login and never persisted as a constant.
 */
export interface Registry {
  blocks: ReadonlyMap<number, string>;
  items: ReadonlyMap<number, string>;
  blockSubstitutions: readonly string[];
  itemSubstitutions: readonly string[];
}

/** Parses an FML|HS ModIdData message (discriminator byte 3 included). */
export function parseModIdData(data: Buffer): Registry {
  const r = new Reader(data);
  if (r.u8() !== 3) throw new Error('not a ModIdData message');
  const blocks = new Map<number, string>();
  const items = new Map<number, string>();
  const count = r.varInt();
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const id = r.varInt();
    // FML 1.7.10 prefixes registry names: \u0001 = block, \u0002 = item.
    if (name.startsWith('\u0001')) blocks.set(id, name.slice(1));
    else if (name.startsWith('\u0002')) items.set(id, name.slice(1));
    else items.set(id, name);
  }
  const blockSubstitutions: string[] = [];
  const itemSubstitutions: string[] = [];
  if (r.remaining > 0) {
    const n = r.varInt();
    for (let i = 0; i < n; i++) blockSubstitutions.push(r.string());
  }
  if (r.remaining > 0) {
    const n = r.varInt();
    for (let i = 0; i < n; i++) itemSubstitutions.push(r.string());
  }
  return { blocks, items, blockSubstitutions, itemSubstitutions };
}

export type ItemNaming = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Stable agent-facing name for an item stack: `namespace:name`, plus `@damage` when the
 * damage value is non-zero (GT meta-items encode their sub-type in it). For tools the
 * damage is wear, so the name changes as they wear; protected-item matching on the base
 * name (`isProtected`) still covers every variant.
 *
 * Returns a failure rather than guessing when the ID is not in the registry or the
 * result would not be a valid ItemName.
 */
export function nameItemStack(registry: Registry | null, id: number, damage: number): ItemNaming {
  if (registry === null) return { ok: false, reason: 'registry not received yet' };
  const base = registry.items.get(id) ?? registry.blocks.get(id);
  if (base === undefined) return { ok: false, reason: `item id ${id} is not in the registry` };
  if (damage < 0) return { ok: false, reason: `negative damage ${damage} on ${base}` };
  const name = damage === 0 ? base : `${base}@${damage}`;
  return ItemNameSchema.safeParse(name).success
    ? { ok: true, name }
    : { ok: false, reason: `registry name ${JSON.stringify(name)} is not a valid item name` };
}

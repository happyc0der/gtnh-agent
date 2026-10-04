import { type BlockPosition } from '../../domain/common.ts';
import { summarizeExploration, type PlaceKind } from '../../domain/world-memory.ts';
import { gtOreByItem, gtOreOfMeta } from '../../goals/ore-names.ts';
import type { OwnerCommandRecord } from '../../persistence/owner-command-repository.ts';
import type { TravelTarget } from './owner-travel.ts';
import { type CommandRun, type PlayState } from './play-state.ts';

import { blocks, fmt, runOf, type CommandDeps } from './command-base.ts';

/**
 * Blocks of a kind for an owner's !find and !goto <block> (Baritone's #find and #goto
 * <block>): the nearest the bot sees (a face open to air: no x-ray), else a place world memory
 * keeps; and the GregTech ores of a material in view.
 */

/** Where a block command heads: one in view (near it), or a place world memory keeps. */
type BlockTo = CommandRun['blockTo'] & object;

/** Kinds of one block that `!find` and `!goto <block>` count as it (any log is a log). */
const SAME_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  'minecraft:log': ['minecraft:log', 'minecraft:log2'],
  'minecraft:water': ['minecraft:water', 'minecraft:flowing_water'],
};

/** World memory's kind of place for a block an owner names (world-memory.ts PLACE_KINDS). */
const REMEMBERED_AS: Readonly<Record<string, PlaceKind>> = {
  'minecraft:log': 'log',
  'minecraft:log2': 'log',
  'minecraft:dirt': 'dirt',
  'minecraft:grass': 'dirt',
  'minecraft:sand': 'sand',
  'minecraft:gravel': 'gravel',
  'minecraft:clay': 'clay',
  'minecraft:water': 'water',
  'minecraft:stone': 'stone',
  'gregtech:gt.blockores': 'ore',
};

/** How near a block `!goto <block>` stops (across, from its centre). */
const BLOCK_WITHIN = 2.5;

/**
 * Where a block command heads, fixed when it begins (so it does not switch blocks on the
 * way): the nearest such block the bot sees (a face open to air), else the nearest place
 * world memory keeps for its kind (logs, sand, water...).
 */
export function blockTarget(
  play: PlayState,
  cmd: OwnerCommandRecord,
  block: string,
): BlockTo | { problem: string } {
  const run = runOf(play, cmd.id);
  if (run.blockTo !== null) return run.blockTo;
  const found = findNear(play, block);
  if ('problem' in found) return found;
  run.blockTo = found;
  return found;
}

/** The nearest block of a kind in view, else a remembered place of it, else why none. */
function findNear(play: PlayState, block: string): BlockTo | { problem: string } {
  const commands = play.deps.commands as CommandDeps;
  if (commands.findBlock === undefined) return { problem: 'I cannot look for blocks here' };
  const seen = commands.findBlock(SAME_BLOCKS[block] ?? [block])[0];
  if (seen !== undefined) {
    return { block, position: { ...seen.position }, distance: seen.distance, seen: true };
  }
  const place = rememberedPlace(play, block);
  return place ?? { problem: `I see no ${block} near here, and remember none` };
}

/** The nearest place world memory keeps for the block's kind, or null. */
function rememberedPlace(play: PlayState, block: string): BlockTo | null {
  const kind = REMEMBERED_AS[block];
  const commands = play.deps.commands as CommandDeps;
  const view = commands.view();
  if (kind === undefined || view.position === null || view.dimension === null) return null;
  const summary = summarizeExploration({
    chunks: play.deps.repos.worldMemory.chunks(view.dimension),
    from: view.position,
    boundary: commands.boundary,
    now: new Date(play.now()),
  });
  const place = summary.places.find((p) => p.resource === kind);
  if (place === undefined) return null;
  return {
    block,
    position: { x: place.x, y: place.y, z: place.z },
    distance: place.distance,
    seen: false,
  };
}

export const blockAck = (to: BlockTo): string =>
  to.seen
    ? `going to the ${to.block} at ${fmt(to.position)}`
    : `going to where I remember ${to.block} (${fmt(to.position)}, ${blocks(Math.round(to.distance))} away)`;

/**
 * Near the block (a remembered place's too: its position is one block of the kind, and
 * standing in it would break it, seen live 2026-10-04 with a log); to its column when only
 * the chunk is known (y null).
 */
export const blockTravel = (to: BlockTo): TravelTarget =>
  to.position.y !== null
    ? {
        kind: 'near',
        point: { x: to.position.x + 0.5, y: to.position.y, z: to.position.z + 0.5 },
        within: BLOCK_WITHIN,
      }
    : { kind: 'point', point: { ...to.position } };

/**
 * What `!find <material> ore` says: the GregTech ores of that material in view. GregTech tells
 * a client an ore's material only once a face of it is open, so only those are known.
 */
export function findOreText(play: PlayState, item: string): string {
  const ore = gtOreByItem(item);
  const name =
    ore === null ? item : `${ore.material.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ore`;
  const at = (play.deps.commands as CommandDeps).view().position;
  const found = oresFor(play, item, new Set())
    .map((o) => ({
      position: o.position,
      distance:
        at === null
          ? 0
          : Math.hypot(
              o.position.x + 0.5 - at.x,
              o.position.y + 0.5 - at.y,
              o.position.z + 0.5 - at.z,
            ),
    }))
    .sort((a, b) => a.distance - b.distance);
  const [first, ...rest] = found;
  if (first === undefined) {
    return `I see no ${name} near here (an ore shows its kind only once a face of it is open: !mine digs for it)`;
  }
  const also = rest
    .slice(0, 3)
    .map((f) => `${fmt(f.position)} (${Math.round(f.distance)})`)
    .join(', ');
  return (
    `${name}: the nearest at ${fmt(first.position)}, ${blocks(Math.round(first.distance))} away` +
    (also === '' ? '' : `; also ${also}`)
  );
}

/** What `!find` says: the nearest blocks of a kind in view, else a remembered place. */
export function findText(play: PlayState, block: string): string {
  const commands = play.deps.commands as CommandDeps;
  if (commands.findBlock === undefined) return 'I cannot look for blocks here';
  const seen = commands.findBlock(SAME_BLOCKS[block] ?? [block]);
  const [first, ...rest] = seen;
  if (first !== undefined) {
    const also = rest
      .slice(0, 3)
      .map((f) => `${fmt(f.position)} (${Math.round(f.distance)})`)
      .join(', ');
    return (
      `${block}: the nearest at ${fmt(first.position)}, ${blocks(Math.round(first.distance))} away` +
      (also === '' ? '' : `; also ${also}`)
    );
  }
  const place = rememberedPlace(play, block);
  return place === null
    ? `I see no ${block} near here, and remember none`
    : `I see no ${block} near here; I remember some at ${fmt(place.position)}, ${blocks(Math.round(place.distance))} away`;
}

export const cellKey = (p: BlockPosition): string => `${p.x},${p.y},${p.z}`;

/** GregTech ores in view that drop `item` (their material known and right), not passed over. */
export function oresFor(
  play: PlayState,
  item: string,
  skipped: ReadonlySet<string>,
): Array<{ position: BlockPosition }> {
  const ores = (play.deps.commands as CommandDeps).gtOres?.() ?? [];
  return ores.filter(
    (o) =>
      o.ore !== undefined &&
      !skipped.has(cellKey(o.position)) &&
      (gtOreOfMeta(o.ore)?.drops.includes(item) ?? false),
  );
}

/** Whether a GregTech ore that may drop `item` is in view, and not passed over. */
export function oreInView(play: PlayState, item: string, skipped: ReadonlySet<string>): boolean {
  return oresFor(play, item, skipped).length > 0;
}

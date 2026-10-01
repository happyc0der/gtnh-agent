import { z } from 'zod';
import type { ActionType } from './actions.ts';

/**
 * Interaction profiles: what the agent knows about blocks it may right-click, as DATA. A
 * profile says which blocks it covers, how they open, what window they open (and its real
 * slot layout), what each slot is for, which slots the agent may put items into or take
 * items from, what happens to items left inside when the window closes, and how a result
 * is read. The live client (src/bot/gtnh1710/interact.ts) does generic window work from
 * a profile; it has no block-specific code beyond the profile.
 *
 * Every fact is versioned to the GTNH 2.8.4 server (Forge 10.13.4.1614) and comes with its
 * evidence (docs/gtnh-compatibility.md, "Interacting with blocks"). Adding a block is a data
 * change: a new entry in INTERACTION_PROFILES (see docs/architecture.md, "Interacting with
 * blocks"). Blocks without a profile can only be LOOKED at, and only when the operator
 * allowlists them (observe-only: the agent never clicks inside such a window).
 *
 * The window model (a player-inventory range after the block's own slots, plus a result
 * slot) follows prismarine-windows (MIT); every number here was checked in the 1.7.10 and
 * GTNH jars, not taken from it (its furnace properties, for one, are 1.8's, not 1.7.10's).
 */

/** The server these profiles were verified against. */
export const INTERACTION_PROFILES_VERSION = 'GTNH 2.8.4 (Minecraft 1.7.10, Forge 10.13.4.1614)';

export const PROFILE_IDS = [
  'crafting_table',
  'furnace',
  'chest',
  'trapped_chest',
  'iron_chest',
  'hungry_chest',
  'crafting_station',
] as const;
export const ProfileIdSchema = z.enum(PROFILE_IDS);
export type ProfileId = z.infer<typeof ProfileIdSchema>;

/** What a container slot is for. */
export const SLOT_ROLES = [
  'input',
  'fuel',
  'output',
  'grid',
  'result',
  'storage',
  'upgrade',
  'other',
] as const;
export type SlotRole = (typeof SLOT_ROLES)[number];

/** A run of container slots with one role. `first`..`last` are window slots, inclusive. */
export interface SlotGroup {
  readonly role: SlotRole;
  readonly first: number;
  readonly last: number;
  /** The agent may put items into these slots (the server accepts them there). */
  readonly put: boolean;
  /** The agent may take items out of these slots. */
  readonly take: boolean;
  readonly note?: string;
}

/**
 * How the server opens the window, which is also how the client recognises it:
 *  - vanilla: S2D Open Window with this inventory type and announced slot count (the
 *    crafting table announces 9 although its window has 10 container slots). `title` is
 *    the default title (a renamed block shows its own name).
 *  - fml: Forge's OpenGui message (channel "FML", discriminator 1) with this mod id and GUI
 *    id; it carries the block position, and no slot count.
 */
export type WindowOpener =
  | {
      readonly kind: 'vanilla';
      readonly inventoryType: number;
      readonly title: string;
      readonly announcedSlots: number;
    }
  | { readonly kind: 'fml'; readonly modId: string; readonly guiId: number };

/** The slots of one window. */
export interface WindowLayout {
  /** The window's own slots, before the player's 36 (27 main inventory, then 9 hotbar). */
  readonly containerSlots: number;
  /** Covers every container slot exactly once (a test checks it). */
  readonly groups: readonly SlotGroup[];
  /**
   * Slots after the player's 36, if the window can have any (a Tinkers crafting station
   * shows an adjacent chest there). They are never clicked.
   */
  readonly trailingSlots: 'none' | 'any';
}

/**
 * One way the block's window can look: how it opens and its slots. A chest opens with 27 or
 * 54 slots; an Iron Chests block opens a different GUI (and size) for each chest type.
 */
export interface WindowVariant {
  readonly opener: WindowOpener;
  readonly layout: WindowLayout;
  readonly note?: string;
}

/** A window property (S31 Window Property: u8 window, i16 property, i16 value). */
export interface WindowPropertyInfo {
  readonly id: number;
  readonly name: string;
  readonly meaning: string;
}

/**
 * A mod-specific packet a block's GUI needs beyond clicks (e.g. Tinkers' stencil table
 * choosing a pattern on channel "TConstruct"). Room for later: no profile uses one yet, and
 * the client cannot send any.
 */
export interface ModPayloadSpec {
  readonly id: string;
  readonly channel: string;
  readonly verified: false;
  readonly note: string;
}

export interface InteractionProfile {
  readonly id: ProfileId;
  readonly label: string;
  /** 1.7.10 registry names of the blocks it covers (the block at the position decides). */
  readonly blocks: readonly string[];
  /**
   * How the agent opens it: a right-click with an EMPTY hand, never sneaking (the client
   * cannot even send sneaking). `never` blocks are known but must not be opened.
   */
  readonly open:
    { readonly how: 'empty-hand-right-click' } | { readonly how: 'never'; readonly reason: string };
  readonly window: { readonly variants: readonly WindowVariant[] };
  /**
   * Every container slot is plain storage: the block is listed in GameState.storage (its
   * contents while open, and in the agent's container memory), and OPEN_CONTAINER /
   * DEPOSIT_ITEM / WITHDRAW_ITEM may use it.
   */
  readonly storage: boolean;
  /**
   * What happens to items in the container slots when the window closes or the player
   * leaves: `kept` (they belong to the block) or `dropped` into the world (a crafting
   * grid). The cursor is always dropped, so the agent never closes with a full cursor.
   */
  readonly itemsOnClose: 'kept' | 'dropped';
  /**
   * How a result is read: from an output slot (the server sends it like any slot), or only
   * through a full window sync (crafting result slots, which the server never sends alone).
   */
  readonly result:
    | { readonly how: 'none' }
    | { readonly how: 'output-slot'; readonly slot: number }
    | { readonly how: 'crafting-sync'; readonly slot: number };
  readonly properties: readonly WindowPropertyInfo[];
  /** The actions that may use blocks with this profile. */
  readonly usedBy: readonly ActionType[];
  /** Where the block's state is read from. Later profiles may need tile-entity data. */
  readonly stateSource: 'window';
  readonly modPayloads: readonly ModPayloadSpec[];
  /** Where each fact comes from (see docs/gtnh-compatibility.md). */
  readonly evidence: readonly string[];
}

/** The vanilla furnace: ticks to smelt one item (TileEntityFurnace.updateEntity). */
export const FURNACE_COOK_TICKS = 200;
export const TICKS_PER_SECOND = 20;

/** Furnace window slots (ContainerFurnace). */
export const FURNACE_SLOT = { input: 0, fuel: 1, output: 2 } as const;
/** Furnace window properties (ContainerFurnace.detectAndSendChanges -> S31). */
export const FURNACE_PROPERTY = { cookTicks: 0, burnTicksLeft: 1, fuelItemTicks: 2 } as const;

const storage = (slots: number, put = true): WindowLayout => ({
  containerSlots: slots,
  groups: [{ role: 'storage', first: 0, last: slots - 1, put, take: true }],
  trailingSlots: 'none',
});

const CRAFTING_GRID_3X3: WindowLayout = {
  containerSlots: 10,
  groups: [
    {
      role: 'result',
      first: 0,
      last: 0,
      put: false,
      take: true,
      note: 'never sent alone: read with a full window sync, taken only as the expected result',
    },
    {
      role: 'grid',
      first: 1,
      last: 9,
      put: true,
      take: true,
      note: 'column + 3 x row',
    },
  ],
  trailingSlots: 'none',
};

/**
 * Iron Chests 6.1.6 chest types: IronChestType ordinal (= the GUI id BlockIronChest opens),
 * name and size (slots, rows of `size / rows`). WOOD (11) is only an upgrade source.
 */
export const IRON_CHEST_TYPES: ReadonlyArray<{
  guiId: number;
  type: string;
  slots: number;
  put: boolean;
}> = [
  { guiId: 0, type: 'IRON', slots: 54, put: true },
  { guiId: 1, type: 'GOLD', slots: 81, put: true },
  { guiId: 2, type: 'DIAMOND', slots: 108, put: true },
  { guiId: 3, type: 'COPPER', slots: 45, put: true },
  { guiId: 4, type: 'STEEL', slots: 72, put: true },
  { guiId: 5, type: 'CRYSTAL', slots: 108, put: true },
  { guiId: 6, type: 'OBSIDIAN', slots: 108, put: true },
  // Its one slot takes only dirt (ValidatingSlot): never put into, only taken from.
  { guiId: 7, type: 'DIRTCHEST9000', slots: 1, put: false },
  { guiId: 8, type: 'NETHERITE', slots: 135, put: true },
  { guiId: 9, type: 'DARKSTEEL', slots: 135, put: true },
  { guiId: 10, type: 'SILVER', slots: 72, put: true },
];

export const INTERACTION_PROFILES: Readonly<Record<ProfileId, InteractionProfile>> = {
  crafting_table: {
    id: 'crafting_table',
    label: 'Crafting table',
    blocks: ['minecraft:crafting_table'],
    open: { how: 'empty-hand-right-click' },
    window: {
      variants: [
        {
          opener: { kind: 'vanilla', inventoryType: 1, title: 'Crafting', announcedSlots: 9 },
          layout: CRAFTING_GRID_3X3,
        },
      ],
    },
    storage: false,
    itemsOnClose: 'dropped',
    result: { how: 'crafting-sync', slot: 0 },
    properties: [],
    usedBy: ['INTERACT_BLOCK', 'CRAFT_ITEM'],
    stateSource: 'window',
    modPayloads: [],
    evidence: [
      'Block id 58 "crafting_table" is BlockWorkbench (Block.registerBlocks, server jar).',
      'EntityPlayerMP.displayGUIWorkbench sends S2D(type 1, "Crafting", 9 slots); ContainerWorkbench has result 0, grid 1-9, player 10-45 (docs: Crafting).',
      'ContainerWorkbench.onContainerClosed drops the grid and the cursor (docs: Crafting).',
    ],
  },
  furnace: {
    id: 'furnace',
    label: 'Furnace',
    blocks: ['minecraft:furnace', 'minecraft:lit_furnace'],
    open: { how: 'empty-hand-right-click' },
    window: {
      variants: [
        {
          opener: {
            kind: 'vanilla',
            inventoryType: 2,
            title: 'container.furnace',
            announcedSlots: 3,
          },
          layout: {
            containerSlots: 3,
            groups: [
              { role: 'input', first: 0, last: 0, put: true, take: true },
              {
                role: 'fuel',
                first: 1,
                last: 1,
                put: true,
                take: true,
                note: 'a plain Slot: the server accepts anything here, so the agent only puts approved fuels',
              },
              {
                role: 'output',
                first: 2,
                last: 2,
                put: false,
                take: true,
                note: 'SlotFurnace.isItemValid is false; taking gives experience',
              },
            ],
            trailingSlots: 'none',
          },
        },
      ],
    },
    storage: false,
    itemsOnClose: 'kept',
    result: { how: 'output-slot', slot: FURNACE_SLOT.output },
    properties: [
      {
        id: FURNACE_PROPERTY.cookTicks,
        name: 'cookTicks',
        meaning:
          'ticks the current item has cooked (0-199; it is done at 200; reset to 0 when the fire goes out)',
      },
      {
        id: FURNACE_PROPERTY.burnTicksLeft,
        name: 'burnTicksLeft',
        meaning: 'ticks the burning fuel item still burns',
      },
      {
        id: FURNACE_PROPERTY.fuelItemTicks,
        name: 'fuelItemTicks',
        meaning: 'total burn ticks of the fuel item burning now (a signed short on the wire)',
      },
    ],
    usedBy: ['INTERACT_BLOCK', 'SMELT', 'TAKE_OUTPUT'],
    stateSource: 'window',
    modPayloads: [],
    evidence: [
      'Block ids 61 "furnace" and 62 "lit_furnace" are BlockFurnace(false/true); updateFurnaceBlockState swaps them keeping the tile entity (server jar).',
      'BlockFurnace.onBlockActivated -> EntityPlayerMP.displayGUIFurnace: S2D(type 2, TileEntityFurnace.getInventoryName() = "container.furnace" unless renamed, 3 slots) (server jar, Forge-patched).',
      'ContainerFurnace (not patched by Forge): Slot 0 input, Slot 1 fuel, SlotFurnace 2 output, player main 3-29, hotbar 30-38; no onContainerClosed override, so the furnace keeps its items.',
      'ContainerFurnace sends S31 properties 0 furnaceCookTime, 1 furnaceBurnTime, 2 currentItemBurnTime on open and on every change.',
      'TileEntityFurnace.updateEntity: an item is done after 200 cooking ticks; fuel is taken only while something can smelt (Forge-patched; GregTech adds only pollution, no GTNH mod changes it).',
    ],
  },
  chest: {
    id: 'chest',
    label: 'Chest',
    blocks: ['minecraft:chest'],
    open: { how: 'empty-hand-right-click' },
    window: {
      variants: [27, 54].map((n) => ({
        opener: {
          kind: 'vanilla' as const,
          inventoryType: 0,
          title: n === 27 ? 'container.chest' : 'container.chestDouble',
          announcedSlots: n,
        },
        layout: storage(n),
        note: n === 27 ? 'single chest' : 'double chest',
      })),
    },
    storage: true,
    itemsOnClose: 'kept',
    result: { how: 'none' },
    properties: [],
    usedBy: ['INTERACT_BLOCK', 'OPEN_CONTAINER', 'DEPOSIT_ITEM', 'WITHDRAW_ITEM'],
    stateSource: 'window',
    modPayloads: [],
    evidence: [
      'Verified live 2026-09-30 (docs: Chests): S2D type 0, 27 or 54 slots, then the player 36.',
    ],
  },
  trapped_chest: {
    id: 'trapped_chest',
    label: 'Trapped chest',
    blocks: ['minecraft:trapped_chest'],
    open: {
      how: 'never',
      reason: 'opening a trapped chest emits a redstone signal (it can change the world around it)',
    },
    window: {
      variants: [27, 54].map((n) => ({
        opener: {
          kind: 'vanilla' as const,
          inventoryType: 0,
          title: 'container.chest',
          announcedSlots: n,
        },
        layout: storage(n),
      })),
    },
    storage: false,
    itemsOnClose: 'kept',
    result: { how: 'none' },
    properties: [],
    usedBy: [],
    stateSource: 'window',
    modPayloads: [],
    evidence: [
      'BlockChest type 1 canProvidePower; its weak power is TileEntityChest.numPlayersUsing (0-15), which opening the chest raises (server jar, Forge-patched).',
    ],
  },
  iron_chest: {
    id: 'iron_chest',
    label: 'Iron Chests chest',
    blocks: ['IronChest:BlockIronChest'],
    open: { how: 'empty-hand-right-click' },
    window: {
      variants: IRON_CHEST_TYPES.map((t) => ({
        opener: { kind: 'fml' as const, modId: 'IronChest', guiId: t.guiId },
        layout: storage(t.slots, t.put),
        note: t.type,
      })),
    },
    storage: true,
    itemsOnClose: 'kept',
    result: { how: 'none' },
    properties: [],
    usedBy: ['INTERACT_BLOCK', 'OPEN_CONTAINER', 'DEPOSIT_ITEM', 'WITHDRAW_ITEM'],
    stateSource: 'window',
    modPayloads: [],
    evidence: [
      'IronChest 6.1.6: BlockIronChest.onBlockActivated opens player.openGui(IronChest, type.ordinal(), ...) (an FML OpenGui; mod id "IronChest" in mcmod.info), unless the block above is solid underneath or an ocelot sits on it (then nothing opens).',
      'IronChestType: IRON 54, GOLD 81, DIAMOND 108, COPPER 45, STEEL 72, CRYSTAL 108, OBSIDIAN 108, DIRTCHEST9000 1, NETHERITE 135, DARKSTEEL 135, SILVER 72 slots (ordinal 0-10).',
      'ContainerIronChest.layoutContainer: the chest slots (ValidatingSlot: any item, except the dirt chest takes only dirt), then the player main 27 and hotbar 9; onContainerClosed only closes the chest (its items are kept).',
    ],
  },
  hungry_chest: {
    id: 'hungry_chest',
    label: 'Thaumcraft hungry chest',
    blocks: ['Thaumcraft:blockChestHungry'],
    open: { how: 'empty-hand-right-click' },
    window: {
      variants: [
        {
          opener: { kind: 'vanilla', inventoryType: 0, title: 'Hungry Chest', announcedSlots: 27 },
          layout: storage(27),
        },
      ],
    },
    storage: true,
    itemsOnClose: 'kept',
    result: { how: 'none' },
    properties: [],
    usedBy: ['INTERACT_BLOCK', 'OPEN_CONTAINER', 'DEPOSIT_ITEM', 'WITHDRAW_ITEM'],
    stateSource: 'window',
    modPayloads: [],
    evidence: [
      'Thaumcraft 4.2.3.5a: BlockChestHungry.onBlockActivated calls player.displayGUIChest(TileChestHungry): a vanilla S2D type 0 window (ContainerChest, items kept on close).',
      'TileChestHungry.getSizeInventory is 27 and its name "Hungry Chest". It also swallows item entities that touch it; the agent never drops items.',
    ],
  },
  crafting_station: {
    id: 'crafting_station',
    label: "Tinkers' Construct crafting station",
    blocks: ['TConstruct:CraftingStation'],
    open: { how: 'empty-hand-right-click' },
    window: {
      variants: [
        {
          opener: { kind: 'fml', modId: 'TConstruct', guiId: 11 },
          layout: { ...CRAFTING_GRID_3X3, trailingSlots: 'any' },
        },
      ],
    },
    storage: false,
    itemsOnClose: 'kept',
    result: { how: 'crafting-sync', slot: 0 },
    properties: [],
    // Looking only, for now: its grid can already hold another player's items, and an
    // adjacent chest adds slots after the player's 36. Crafting there needs both handled.
    usedBy: ['INTERACT_BLOCK'],
    stateSource: 'window',
    modPayloads: [],
    evidence: [
      'TConstruct 1.13.57-GTNH: CraftingStationBlock (Mantle InventoryBlock) opens with player.openGui(TConstruct, 11, ...) unless sneaking, i.e. an FML OpenGui message.',
      'CraftingStationContainer: SlotCraftingStation (a SlotCrafting) 0, grid 1-9 (InventoryCraftingStation, backed by the block), player main 10-36, hotbar 37-45, then the slots of an adjacent chest if there is one.',
      'InventoryCraftingStation.getStackInSlotOnClosing returns null, so closing keeps the grid in the station; only the cursor drops.',
      'In the Age 0 quest book: "A Better Crafting Table" (TConstruct:CraftingStation).',
    ],
  },
};

/** Every block a profile covers -> its profile (built once; a test keeps blocks unique). */
const BY_BLOCK: ReadonlyMap<string, InteractionProfile> = new Map(
  Object.values(INTERACTION_PROFILES).flatMap((p) => p.blocks.map((b) => [b, p] as const)),
);

/** The profile for a block (registry name), or null. */
export function profileForBlock(block: string): InteractionProfile | null {
  return BY_BLOCK.get(block) ?? null;
}

/** How a window was opened, as the client saw it. */
export type OpenedWindow =
  | { kind: 'vanilla'; inventoryType: number; announcedSlots: number }
  | { kind: 'fml'; modId: string; guiId: number };

/**
 * The variant of a profile's window that opened: the opener must match exactly, and the
 * window must have exactly the layout's container slots + the player's 36 (or more, when
 * the layout allows trailing slots). Null when the window is not one the profile knows.
 */
export function matchWindowVariant(
  profile: InteractionProfile,
  opened: OpenedWindow,
  totalSlots: number,
): WindowVariant | null {
  for (const v of profile.window.variants) {
    const o = v.opener;
    const sameOpener =
      o.kind === 'vanilla' && opened.kind === 'vanilla'
        ? o.inventoryType === opened.inventoryType && o.announcedSlots === opened.announcedSlots
        : o.kind === 'fml' && opened.kind === 'fml'
          ? o.modId === opened.modId && o.guiId === opened.guiId
          : false;
    if (!sameOpener) continue;
    const base = v.layout.containerSlots + 36;
    if (totalSlots === base || (v.layout.trailingSlots === 'any' && totalSlots > base)) return v;
  }
  return null;
}

/** The slot group a container slot belongs to, or null (not a container slot). */
export function slotGroup(layout: WindowLayout, slot: number): SlotGroup | null {
  return layout.groups.find((g) => slot >= g.first && slot <= g.last) ?? null;
}

/** Profiles whose blocks are plain item storage (listed in GameState.storage). */
export const STORAGE_PROFILES: readonly ProfileId[] = PROFILE_IDS.filter(
  (id) => INTERACTION_PROFILES[id].storage,
);

/**
 * The id of a storage block the observation found: `<profile>:<x>.<y>.<z>` (an EntityId).
 * Ids are positions, so the agent's container memory works for any storage block, across
 * connections, without configuring it.
 */
export function observedStorageId(
  profile: ProfileId,
  p: { x: number; y: number; z: number },
): string {
  return `${profile}:${p.x}.${p.y}.${p.z}`;
}

/** The profile and position in an observed storage id, or null for any other id. */
export function parseObservedStorageId(
  id: string,
): { profile: ProfileId; position: { x: number; y: number; z: number } } | null {
  const m = /^([a-z_]+):(-?\d+)\.(-?\d+)\.(-?\d+)$/.exec(id);
  if (m === null) return null;
  const profile = ProfileIdSchema.safeParse(m[1]);
  if (!profile.success || !INTERACTION_PROFILES[profile.data].storage) return null;
  return {
    profile: profile.data,
    position: { x: Number(m[2]), y: Number(m[3]), z: Number(m[4]) },
  };
}

// ---------------------------------------------------------------------------
// Observe-only blocks (no profile): the operator's allowlist
// ---------------------------------------------------------------------------

/**
 * An observe-only pattern: an exact block registry name (`EnderStorage:enderChest`) or a
 * whole mod (`appliedenergistics2:*`). Nothing else: no partial wildcards.
 */
export const ObservePatternSchema = z
  .string()
  .max(128)
  .regex(
    /^[A-Za-z0-9_.|-]+:(?:\*|[A-Za-z0-9_./|'-]+(?: [A-Za-z0-9_./|'-]+)*)$/,
    'expected namespace:block or namespace:*',
  );

/**
 * Vanilla blocks whose empty-hand right-click changes the world (toggles, presses, eats,
 * ejects, teleports, sleeps...). No observe-only pattern can ever open them.
 */
export const NEVER_OPEN_BLOCKS: ReadonlySet<string> = new Set([
  'minecraft:lever',
  'minecraft:stone_button',
  'minecraft:wooden_button',
  'minecraft:wooden_door',
  'minecraft:iron_door',
  'minecraft:trapdoor',
  'minecraft:fence_gate',
  'minecraft:unpowered_repeater',
  'minecraft:powered_repeater',
  'minecraft:unpowered_comparator',
  'minecraft:powered_comparator',
  'minecraft:noteblock',
  'minecraft:cake',
  'minecraft:jukebox',
  'minecraft:dragon_egg',
  'minecraft:bed',
  'minecraft:tnt',
  'minecraft:command_block',
  'minecraft:redstone_ore',
  'minecraft:lit_redstone_ore',
]);

const DRAWERS_REASON =
  "a second right-click within 10 ticks puts every matching item of the player's inventory into the drawer (TileEntityDrawers.interactPutItemsIntoSlot)";

/**
 * Mods (registry namespaces) whose blocks are never right-clicked, not even to look: an
 * empty-hand right-click moves the player's items, or the window opens through a packet the
 * client cannot recognise. Checked in the GTNH 2.8.4 jars (docs/gtnh-compatibility.md,
 * "Storage blocks"). Drawers and barrels need their own interaction kind (front face, held
 * item, tile-entity contents), which does not exist yet.
 */
export const NEVER_OPEN_MODS: ReadonlyMap<string, string> = new Map([
  [
    'JABBA',
    "a right-click puts items from the player's inventory into the barrel (TileEntityBarrel.rightClick -> manualStackAdd)",
  ],
  ['StorageDrawers', DRAWERS_REASON],
  ['StorageDrawersBop', DRAWERS_REASON],
  ['StorageDrawersForestry', DRAWERS_REASON],
  ['StorageDrawersNatura', DRAWERS_REASON],
  ['StorageDrawersMisc', DRAWERS_REASON],
  [
    'EnderStorage',
    'its window opens through a CodeChickenCore packet the client does not recognise (ServerUtils.openSMPContainer), so the server would keep a window open',
  ],
]);

const namespaceOf = (block: string): string => {
  const colon = block.indexOf(':');
  return colon < 0 ? '' : block.slice(0, colon);
};

/** True when an observe-only pattern list lets the agent look at this (profile-less) block. */
export function isObserveOnlyAllowed(block: string, patterns: readonly string[]): boolean {
  if (profileForBlock(block) !== null || NEVER_OPEN_BLOCKS.has(block)) return false;
  const namespace = namespaceOf(block);
  if (NEVER_OPEN_MODS.has(namespace)) return false;
  return patterns.some((p) => p === block || (p.endsWith(':*') && p.slice(0, -2) === namespace));
}

/**
 * How the agent may use a block: its profile, observe-only (allowlisted, no profile), or
 * not at all (with the reason).
 */
export type BlockUse =
  | { kind: 'profile'; profile: InteractionProfile }
  | { kind: 'observe-only' }
  | { kind: 'refused'; reason: string };

export function blockUse(block: string, observePatterns: readonly string[]): BlockUse {
  const profile = profileForBlock(block);
  if (profile !== null) {
    return profile.open.how === 'never'
      ? { kind: 'refused', reason: `${block}: ${profile.open.reason}` }
      : { kind: 'profile', profile };
  }
  if (NEVER_OPEN_BLOCKS.has(block)) {
    return { kind: 'refused', reason: `${block} changes the world when right-clicked` };
  }
  const never = NEVER_OPEN_MODS.get(namespaceOf(block));
  if (never !== undefined) return { kind: 'refused', reason: `${block}: ${never}` };
  return isObserveOnlyAllowed(block, observePatterns)
    ? { kind: 'observe-only' }
    : {
        kind: 'refused',
        reason: `${block} has no interaction profile and is not on the observe-only allowlist`,
      };
}

// ---------------------------------------------------------------------------
// Furnace fuel and timing (for planning; the server's own numbers win when seen)
// ---------------------------------------------------------------------------

/** Wood item names whose metadata variants all burn alike. */
const WOOD_300 = ['minecraft:planks', 'minecraft:log', 'minecraft:log2'];

/**
 * Burn ticks of the vanilla fuels the agent may use, as the GTNH 2.8.4 server computes them
 * (TileEntityFurnace.getItemBurnTime, Forge-patched; GTNH's MinetweakerFurnaceFix lets any
 * IFuelHandler value win, and none of the server's handlers changes these: GregTech's
 * oredict table gives gemCoal and gemCharcoal 1600, the same as vanilla). Lava buckets are
 * deliberately absent (lava interaction is not allowed).
 */
export function furnaceFuelTicks(item: string): number | null {
  const at = item.indexOf('@');
  const base = at < 0 ? item : item.slice(0, at);
  const meta = at < 0 ? 0 : Number(item.slice(at + 1));
  if (base === 'minecraft:coal' && (meta === 0 || meta === 1)) return 1600; // coal, charcoal
  if (WOOD_300.includes(base)) return 300; // Material.wood blocks
  if (base === 'minecraft:wooden_slab') return 150;
  if (base === 'minecraft:stick' && meta === 0) return 100;
  if (base === 'minecraft:sapling') return 100;
  if (base === 'minecraft:coal_block' && meta === 0) return 16000;
  if (base === 'minecraft:blaze_rod' && meta === 0) return 2400;
  return null;
}

export interface FurnaceView {
  input: { item: string; count: number } | null;
  fuel: { item: string; count: number } | null;
  cookTicks: number | null;
  burnTicksLeft: number | null;
}

export interface FurnaceEstimate {
  /** Seconds until everything in the input slot is smelted, if the fuel lasts; else null. */
  secondsToFinish: number | null;
  /** Items the fuel (burning + in the fuel slot) can still smelt; null if a fuel is unknown. */
  fuelEnoughForItems: number | null;
}

/**
 * Planning estimate from a furnace's contents and properties: 200 ticks per item, one
 * burn tick per cooking tick, the next fuel item lit as soon as the burning one ends.
 */
export function estimateFurnace(view: FurnaceView): FurnaceEstimate {
  const items = view.input?.count ?? 0;
  const cooked = Math.max(0, Math.min(FURNACE_COOK_TICKS - 1, view.cookTicks ?? 0));
  const needed = Math.max(0, items * FURNACE_COOK_TICKS - cooked);
  const perFuel = view.fuel === null ? 0 : furnaceFuelTicks(view.fuel.item);
  const burning = Math.max(0, view.burnTicksLeft ?? 0);
  if (perFuel === null) return { secondsToFinish: null, fuelEnoughForItems: null };
  const available = burning + perFuel * (view.fuel?.count ?? 0);
  const enoughFor = Math.floor((available + cooked) / FURNACE_COOK_TICKS);
  return {
    secondsToFinish: items === 0 ? 0 : available >= needed ? needed / TICKS_PER_SECOND : null,
    fuelEnoughForItems: Math.min(items, enoughFor),
  };
}

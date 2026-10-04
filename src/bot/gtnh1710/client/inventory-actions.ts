import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseObservedStorageId } from '../../../domain/interactions.ts';
import { toolInfo } from '../../../domain/tools.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import {
  applyClick,
  containerRange,
  planEmptyCursor,
  planTransfer,
  playerRange,
  type Click,
  type Stack,
  type TransferDirection,
  type WindowSnapshot,
} from '../container.ts';
import { gridEmpty, INVENTORY_GRID, stackBounds, TABLE_GRID } from '../crafting.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { allSlots } from '../interact.ts';
import { outbound, PLAYER_EYE_HEIGHT } from '../packets.ts';
import { nameItemStack, resolveItemName } from '../registry.ts';
import { WORKBENCH_WINDOW_TYPE, type WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { CLICK_TIMEOUT_MS, WINDOW_OPEN_TIMEOUT_MS } from './shared.ts';

/** Server reach is 8 blocks to the block centre; the client stays well inside it. */
const MAX_BLOCK_DISTANCE = 6;
const VANILLA_CHEST = 'minecraft:chest';
/** 1.7.10 window types: 0 = chest (27 or 54 slots); 1 = crafting table (world-model.ts). */
const CHEST_WINDOW_TYPE = 0;

type ClickOutcome = 'accepted' | 'rejected' | 'unanswered' | 'unpredictable';

/**
 * Vanilla chests (OPEN_CONTAINER, DEPOSIT_ITEM, WITHDRAW_ITEM; container.ts plans the moves),
 * and the window work the other actions build on: opening a block's window with an empty hand,
 * the hotbar, one predicted click at a time confirmed by the server, emptying the cursor after
 * a failed click, moving a stack into the hotbar, and closing a window (never with items on
 * the cursor or in a crafting table's grid).
 */
export class InventoryActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;
  #nextActionNumber = 1;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why container use cannot start now, or null. */
  #containerBlocker(): string | null {
    const cfg = this.#opts.config;
    if (!cfg.containers.enabled) return 'containers are disabled (MC_ENABLE_CONTAINERS)';
    if (this.#core.haltReason !== null) return `halted: ${this.#core.haltReason}`;
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return `the stop file ${cfg.movement.stopFile} exists`;
    }
    if (this.#core.walking) return 'the player is walking';
    if (this.#core.digging) return 'the player is digging';
    if (this.#core.placing) return 'the player is placing a block';
    if (this.#core.eating) return 'the player is eating';
    if (this.#core.fighting) return 'the player is fighting';
    return null;
  }

  /**
   * OPEN_CONTAINER (transfer null), DEPOSIT_ITEM and WITHDRAW_ITEM on a configured vanilla
   * chest. The chest window stays open afterwards (so the chest's side can be verified);
   * the cursor is always empty when this returns, unless it reports that it is not.
   */
  async containerAction(
    containerId: string,
    transfer: { direction: TransferDirection; item: string; quantity: number } | null,
  ): Promise<ClientActionResult> {
    const blocker = this.#containerBlocker();
    if (blocker !== null) {
      const code = this.#opts.config.containers.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED';
      return failed(`not using the chest: ${blocker}`, code);
    }
    if (this.#core.usingContainer) {
      return failed('a chest or crafting operation is already running', 'REFUSED');
    }
    this.#core.usingContainer = true;
    try {
      const opened =
        this.#opts.config.containers.chests[containerId] === undefined &&
        parseObservedStorageId(containerId) !== null
          ? await this.#openObservedStorage(containerId, transfer?.direction ?? null)
          : await this.#openChest(containerId);
      if (opened !== null) return opened;
      if (transfer === null) {
        const w = this.#world.openWindow;
        return ok(`opened ${containerId}`, {
          windowId: w?.windowId ?? null,
          slots: w?.containerSlots ?? null,
        });
      }
      return await this.#transfer(transfer);
    } finally {
      this.#core.usingContainer = false;
    }
  }

  /**
   * Opens a storage block the observation found (`<profile>:<x>.<y>.<z>`: a chest, an Iron
   * Chests chest...) through its interaction profile, or keeps it open. It also needs
   * MC_ENABLE_INTERACT. A move must be one the layout allows for every slot (an Iron Chests
   * dirt chest takes only dirt, so nothing is ever put into it). A failure, or null once open.
   */
  async #openObservedStorage(
    containerId: string,
    direction: TransferDirection | null,
  ): Promise<ClientActionResult | null> {
    const parsed = parseObservedStorageId(containerId);
    if (parsed === null) return failed(`${containerId} is not a storage block id`, 'REFUSED');
    const blocker = this.#core.interact.interactBlocker();
    if (blocker !== null) return failed(`not using ${containerId}: ${blocker}`, 'REFUSED');
    const t = this.#core.interact.interactTarget(parsed.position, parsed.profile);
    if (!t.ok) return t.result;
    const opened = await this.#core.interact.openInteractable(parsed.position, t.block, t.profile);
    if (!opened.ok) return opened.result;
    const layout = opened.layout;
    if (layout === null) return failed('internal: the storage block has no layout', 'ERROR');
    if (direction === 'to_container' && !allSlots(layout, 'put')) {
      return failed(`not depositing: ${containerId} does not take items in every slot`, 'REFUSED');
    }
    if (direction === 'to_player' && !allSlots(layout, 'take')) {
      return failed(
        `not withdrawing: ${containerId} does not give items from every slot`,
        'REFUSED',
      );
    }
    return null;
  }

  /** Opens the chest (or keeps it open); returns a failure, or null when it is open. */
  async #openChest(containerId: string): Promise<ClientActionResult | null> {
    const chest = this.#opts.config.containers.chests[containerId];
    if (chest === undefined) return failed(`${containerId} is not a configured chest`, 'REFUSED');
    const open = this.#world.openWindow;
    if (open !== null && open.containerId === containerId && open.slotsKnown) return null;
    if (open !== null) {
      const closed = this.closeOpenWindow();
      if (closed !== null) return closed;
    }
    const opened = await this.openBlockWindow(containerId, chest.position, VANILLA_CHEST, 'chest');
    if (opened !== null) return opened;
    const w = this.#world.openWindow;
    if (
      w === null ||
      w.containerId !== containerId ||
      w.inventoryType !== CHEST_WINDOW_TYPE ||
      (w.containerSlots !== 27 && w.containerSlots !== 54)
    ) {
      return this.unexpectedWindow();
    }
    return null;
  }

  /**
   * Right-clicks a configured block with an EMPTY hand, so the click can only open it (never
   * place or use an item), and waits for its window. A failure, or null once it is open.
   */
  async openBlockWindow(
    containerId: string,
    position: { x: number; y: number; z: number },
    blockName: string,
    what: string,
  ): Promise<ClientActionResult | null> {
    const { x, y, z } = position;
    const blockId = this.#world.blockAt(x, y, z);
    const found = blockId === undefined ? undefined : this.#world.registry?.blocks.get(blockId);
    if (found !== blockName) {
      return failed(
        `the block at (${x}, ${y}, ${z}) is ${found ?? 'not loaded'}, not a ${blockName}`,
        'REFUSED',
      );
    }
    const me = this.#world.ownPosition;
    if (me === null) return failed('player position unknown', 'REFUSED');
    const eyes = { x: me.x, y: me.y + PLAYER_EYE_HEIGHT, z: me.z };
    const reach = Math.hypot(x + 0.5 - eyes.x, y + 0.5 - eyes.y, z + 0.5 - eyes.z);
    if (reach > MAX_BLOCK_DISTANCE) {
      return failed(
        `the ${what} is ${reach.toFixed(1)} blocks away (max ${MAX_BLOCK_DISTANCE})`,
        'REFUSED',
      );
    }

    const hand = this.clickHand();
    if (hand === null) {
      return failed('no hotbar slot to click with (empty, or a vanilla tool or block)', 'REFUSED');
    }
    if (hand !== this.#world.heldSlot) {
      this.#core.send(outbound.selectHotbarSlot(hand));
      this.#world.setHeldSlot(hand);
    }

    this.#world.expectContainer(containerId);
    this.#core.send(outbound.activateBlock(x, y, z, 1));
    await this.#core.waitFor(() => {
      const w = this.#world.openWindow;
      return w !== null && w.slotsKnown;
    }, WINDOW_OPEN_TIMEOUT_MS);
    this.#world.expectContainer(null);
    const w = this.#world.openWindow;
    if (w === null || !w.slotsKnown) return failed(`the ${what} did not open`, 'FAILED');
    return null;
  }

  /** Closes a window that is not the one asked for; the failure to report. */
  unexpectedWindow(): ClientActionResult {
    const w = this.#world.openWindow;
    const closed = this.closeOpenWindow();
    return (
      closed ??
      failed(
        `an unexpected window opened (type ${w?.inventoryType ?? '?'}, ${w?.containerSlots ?? '?'} slots)`,
        'FAILED',
      )
    );
  }

  /**
   * The stack in hotbar slot `j` (0-8), from the open window or else window 0; null or
   * undefined when the slot is empty or not known.
   */
  hotbar(j: number): Stack | null | undefined {
    const w = this.#world.openWindow;
    const inv = this.#world.inventoryWindow;
    return w !== null && w.slotsKnown && w.layoutKnown !== false
      ? w.slots[w.containerSlots + 27 + j]
      : inv?.[36 + j];
  }

  emptyHotbarSlot(): number | null {
    if (this.hotbar(this.#world.heldSlot) == null) return this.#world.heldSlot;
    for (let j = 0; j < 9; j++) if (this.hotbar(j) == null) return j;
    return null;
  }

  /**
   * A hotbar slot to right-click a block with when only the block may act (open its window,
   * turn a door): an empty one; else, the held slot first, a stack with no NBT data of a
   * vanilla tool or a vanilla block. Forge asks the held item's onItemUseFirst before the
   * block's onBlockActivated, and only modded items hook it (a GregTech tool, a wand); a
   * block that opens or turns then answers the click, so nothing is placed. Null when no slot
   * is fit (seen live 2026-10-04: a full hotbar of dirt, sand, saplings and planks refused
   * to open the crafting table).
   */
  clickHand(): number | null {
    const empty = this.emptyHotbarSlot();
    if (empty !== null) return empty;
    const registry = this.#world.registry;
    if (registry === null) return null;
    const blocks = new Set(registry.blocks.values());
    const held = this.#world.heldSlot;
    for (const j of [held, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].filter((k) => k !== held)]) {
      const s = this.hotbar(j);
      if (s == null || s.hasNbt) continue;
      const item = registry.items.get(s.id) ?? registry.blocks.get(s.id);
      if (item === undefined || !item.startsWith('minecraft:')) continue;
      if (toolInfo(item) !== null || blocks.has(item)) return j;
    }
    return null;
  }

  /**
   * With no empty hotbar slot, the one to give up for another stack (swapIntoHotbar): a stack
   * with no NBT data that is no tool and no weapon (a tool or a weapon stays where the agent
   * uses it), a block item first (sand, dirt, logs: what fills a hotbar), the held slot last.
   * Null when every hotbar slot holds something to keep.
   */
  evictableHotbarSlot(): number | null {
    const registry = this.#world.registry;
    if (registry === null) return null;
    const blocks = new Set(registry.blocks.values());
    const held = this.#world.heldSlot;
    let other: number | null = null;
    for (const j of [...[0, 1, 2, 3, 4, 5, 6, 7, 8].filter((k) => k !== held), held]) {
      const s = this.hotbar(j);
      if (s == null || s.hasNbt) continue;
      const name = registry.items.get(s.id) ?? registry.blocks.get(s.id);
      if (name === undefined || toolInfo(name) !== null || /sword|bow|shield/i.test(name)) continue;
      if (blocks.has(name)) return j;
      other ??= j;
    }
    return other;
  }

  /**
   * Swaps the stack in window-0 slot `from` (the main inventory) with the one in hotbar slot
   * `hotbar` (container.ts: pick it up, a swap click on the hotbar slot, put the other stack
   * down where it was), each click confirmed by the server. After a click that is not
   * accepted, the cursor goes back into the inventory. Null when swapped, else why not
   * ("ITEMS MAY BE ON THE CURSOR..." when that failed too).
   */
  async swapIntoHotbar(from: number, hotbar: number): Promise<string | null> {
    if (this.#world.openWindow !== null) return 'a window is open';
    if (this.clickTarget() === null) return 'the inventory window is not known';
    const clicks: Click[] = [
      { slot: from, button: 0 },
      { slot: 36 + hotbar, button: 0, swap: true },
      { slot: from, button: 0 },
    ];
    for (const [i, click] of clicks.entries()) {
      const outcome = await this.click(click);
      if (outcome === 'accepted') continue;
      if (i === 0) return `picking up the stack was ${outcome}`;
      const left = await this.emptyPlayerCursor(from);
      return left === null
        ? `a click was ${outcome}`
        : `ITEMS MAY BE ON THE CURSOR (${left}): a click was ${outcome}`;
    }
    this.#core.log(`swapped inventory slot ${from} with hotbar slot ${hotbar}`);
    return null;
  }

  /** Moves exactly `quantity` of `item` with confirmed clicks; the cursor ends empty. */
  async #transfer(t: {
    direction: TransferDirection;
    item: string;
    quantity: number;
  }): Promise<ClientActionResult> {
    const target = resolveItemName(this.#world.registry, t.item);
    if (target === null) return failed(`${t.item} is not in the item registry`, 'REFUSED');
    const start = this.#world.openWindow;
    if (start === null || !start.slotsKnown)
      return failed('the chest window is not open', 'FAILED');
    const plan = planTransfer(start, t.direction, target, t.quantity);
    if (!plan.ok) return failed(`not moving items: ${plan.reason}`, 'REFUSED');
    const source = t.direction === 'to_player' ? containerRange(start) : playerRange(start);

    let done = 0;
    for (const click of plan.clicks) {
      const result = await this.click(click);
      if (result !== 'accepted') {
        const recovered = await this.recoverCursor(source);
        return failed(
          `click ${done + 1} of ${plan.clicks.length} was ${result}; ${recovered}`,
          'FAILED',
          { clicksDone: done },
        );
      }
      done += 1;
    }
    const end = this.#world.openWindow;
    if (end?.cursor != null) return failed('the cursor is not empty after moving items', 'ERROR');
    return ok(
      `moved ${t.quantity} ${t.item} ${t.direction === 'to_player' ? 'from the chest' : 'into the chest'} in ${plan.clicks.length} clicks`,
      { clicks: plan.clicks.length },
    );
  }

  /**
   * Where clicks go: the open window, or, when none is open, window 0 (the player's own
   * inventory container, with its 2x2 crafting grid). Null while its slots are not known.
   */
  clickTarget(): { windowId: number; window: WindowSnapshot } | null {
    const open = this.#world.openWindow;
    // Windows of blocks the agent only looks at, or whose layout is unknown, are never clicked.
    if (open !== null) {
      return open.slotsKnown && open.clickable !== false
        ? { windowId: open.windowId, window: open }
        : null;
    }
    const inventory = this.#world.inventoryClickWindow;
    return inventory === null ? null : { windowId: 0, window: inventory };
  }

  #syncsOf(windowId: number): number {
    return windowId === 0 ? this.#world.inventorySyncs : this.#world.windowSyncs;
  }

  /** One predicted click, sent and confirmed by the server before anything else happens. */
  async click(click: Click): Promise<ClickOutcome> {
    const target = this.clickTarget();
    if (target === null || this.#core.phase !== 'play') return 'unanswered';
    const predicted = applyClick(target.window, click);
    if (!predicted.ok) return 'unpredictable';
    return this.sendClick(target, click, predicted.claimed, predicted.window);
  }

  /**
   * Sends one click claiming `claimed` (the slot's stack before the click, as the client
   * believes it) and waits for the verdict. Accepted: the server sends nothing else, so the
   * prediction (`target.window` -> `predicted`) becomes the client's view. Rejected: the
   * server re-sends the whole window and then the cursor, and ignores further clicks until
   * the client acknowledges; 'rejected' means that re-sync has arrived.
   */
  async sendClick(
    target: { windowId: number; window: WindowSnapshot },
    click: Click,
    claimed: Stack | null,
    predicted: WindowSnapshot,
  ): Promise<Exclude<ClickOutcome, 'unpredictable'>> {
    const windowId = target.windowId;
    const action = this.#nextActionNumber;
    this.#nextActionNumber = action >= 32767 ? 1 : action + 1;
    this.#core.clickVerdicts.delete(action);
    // A rejection comes with an immediate re-sync: count from before the click.
    const syncsBefore = this.#syncsOf(windowId);
    const cursorBefore = this.#world.cursorSyncs;
    this.#core.send(
      outbound.clickWindow(
        windowId,
        click.slot,
        click.button,
        action,
        claimed,
        this.#core.decoding.itemStackSizeVarInt,
      ),
    );
    await this.#core.waitFor(() => this.#core.clickVerdicts.has(action), CLICK_TIMEOUT_MS);
    const verdict = this.#core.clickVerdicts.get(action);
    this.#core.clickVerdicts.delete(action);
    if (verdict === undefined) return 'unanswered';
    if (!verdict) {
      this.#core.send(outbound.confirmTransaction(windowId, action));
      const resynced = (): boolean =>
        this.#syncsOf(windowId) > syncsBefore && this.#world.cursorSyncs > cursorBefore;
      await this.#core.waitFor(resynced, CLICK_TIMEOUT_MS);
      return resynced() ? 'rejected' : 'unanswered';
    }
    this.#world.applyAcceptedClick(windowId, target.window, predicted);
    return 'accepted';
  }

  /** After a failed click: put whatever is on the cursor back into an empty slot. */
  async recoverCursor(preferred: [number, number]): Promise<string> {
    let emptied = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const w = this.#world.openWindow;
      if (w === null) return 'the window closed';
      if (w.cursor === null) break;
      const clicks = planEmptyCursor(w, preferred);
      if (clicks === null) break;
      for (const c of clicks) {
        if ((await this.click(c)) !== 'accepted') break;
        emptied += 1;
      }
    }
    const w = this.#world.openWindow;
    if (w?.cursor != null) {
      return `ITEMS MAY BE ON THE CURSOR (${w.cursor.count} of id ${w.cursor.id}); the window was left open`;
    }
    return emptied > 0 ? 'the cursor was emptied' : 'nothing was on the cursor';
  }

  /**
   * With the player's own inventory (window 0) the click target: whatever is on the cursor
   * goes into an empty slot, `preferred` first. Null when nothing is left on it, else what is.
   */
  async emptyPlayerCursor(preferred: number): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = this.clickTarget();
      if (target === null || target.windowId !== 0 || target.window.cursor === null) break;
      const slots = target.window.slots;
      const empty = [preferred, ...Array.from({ length: 36 }, (_, i) => 9 + i)].find(
        (i) => slots[i] === null,
      );
      if (empty === undefined) break;
      await this.click({ slot: empty, button: 0 });
    }
    const cursor = this.clickTarget()?.window.cursor ?? null;
    return cursor === null ? null : `${cursor.count} of id ${cursor.id}`;
  }

  /**
   * Closes the open window, but never with items on the cursor or in a crafting table's
   * grid: the server would drop them into the world.
   */
  closeOpenWindow(): ClientActionResult | null {
    const w = this.#world.openWindow;
    if (w === null) return null;
    if (w.cursor !== null)
      return failed('refusing to close a window with items on the cursor', 'ERROR');
    if (w.inventoryType === WORKBENCH_WINDOW_TYPE && w.slotsKnown && !gridEmpty(w, TABLE_GRID)) {
      return failed(
        'refusing to close a crafting table with items in its grid (the server would drop them)',
        'ERROR',
      );
    }
    this.#core.send(outbound.closeWindow(w.windowId));
    this.#world.closeWindowLocally();
    return null;
  }

  /** "3 x minecraft:planks", or "empty". */
  describeStack(s: Stack | null): string {
    if (s === null) return 'empty';
    const naming = nameItemStack(this.#world.registry, s.id, s.damage);
    const name = naming.ok ? naming.name : `item ${s.id}@${s.damage}`;
    return `${s.count} x ${name}${s.hasNbt ? ' (with NBT data)' : ''}`;
  }

  /**
   * Moves the stack in window-0 slot `from` into the empty hotbar slot `hotbar`: a left-click
   * picks it up, a left-click on the empty slot puts it down, each confirmed by the server.
   * After a click that is not accepted, the cursor goes back into the inventory. Null when
   * moved, else why not ("ITEMS MAY BE ON THE CURSOR..." when that failed too).
   */
  async moveToHotbar(from: number, hotbar: number, stack: Stack): Promise<string | null> {
    if (this.#world.openWindow !== null) return 'a window is open';
    if (this.clickTarget() === null) return 'the inventory window is not known';
    const clicks: Click[] = [
      { slot: from, button: 0 },
      { slot: 36 + hotbar, button: 0 },
    ];
    for (const click of clicks) {
      const outcome = await this.click(click);
      if (outcome === 'accepted') continue;
      const w = this.clickTarget()?.window;
      const cleared =
        w === undefined
          ? 'the inventory is not known'
          : await this.#core.crafting.clearGrid(INVENTORY_GRID, stackBounds(w, INVENTORY_GRID), {
              ...stack,
              count: 1,
            });
      return cleared === null
        ? `a click was ${outcome}`
        : `ITEMS MAY BE ON THE CURSOR (${cleared}): a click was ${outcome}`;
    }
    this.#core.log(`moved the tool from slot ${from} into hotbar slot ${hotbar}`);
    return null;
  }
}

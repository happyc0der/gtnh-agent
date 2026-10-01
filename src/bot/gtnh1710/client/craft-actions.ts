import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { INTERACTION_PROFILES } from '../../../domain/interactions.ts';
import {
  needsCraftingTable,
  RECIPES,
  type CraftingRecipe,
  type RecipeId,
} from '../../../domain/recipes.ts';
import { errorMessage } from '../../../util/json.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import { containerRange, type Stack, type WindowSnapshot } from '../container.ts';
import {
  applyTakeResult,
  gridEmpty,
  INVENTORY_GRID,
  placeRecipe,
  planClearGrid,
  planFill,
  planStoreCursor,
  planSyncClick,
  sameStack,
  simulateCrafts,
  stackBounds,
  TABLE_GRID,
  windowDifferences,
  type CraftingLayout,
  type PlacedRecipe,
} from '../crafting.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { interactAreaProblem } from '../interact.ts';
import { resolveItemName } from '../registry.ts';
import { parseObservedTableId, WORKBENCH_WINDOW_TYPE, type WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { craftFailed } from './shared.ts';

const VANILLA_CRAFTING_TABLE = 'minecraft:crafting_table';
/** How often a crafting grid is emptied again (with fresh server state) before giving up. */
const CLEAR_GRID_ATTEMPTS = 3;

/**
 * Crafting (see crafting.ts): CRAFT_ITEM in the player's own 2x2 grid or at a crafting table,
 * and, before disconnecting, putting back whatever a crafting grid or the cursor still holds.
 */
export class CraftActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;
  /** Sync clicks sent while crafting (diagnostics). */
  #craftSyncs = 0;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why crafting cannot start or go on now, or null. */
  #craftingBlocker(): string | null {
    const cfg = this.#opts.config;
    if (!cfg.crafting.enabled) return 'crafting is disabled (MC_ENABLE_CRAFTING)';
    if (this.#core.phase !== 'play') return 'not connected';
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
   * CRAFT_ITEM: in the player's own 2x2 grid (window 0; any open window is closed first,
   * since the server takes window-0 clicks only when none is open), or at a configured
   * crafting table (3x3), which is closed again afterwards.
   */
  async craft(args: {
    recipe: RecipeId;
    times: number;
    craftingTableId: string | null;
  }): Promise<ClientActionResult> {
    const blocker = this.#craftingBlocker();
    if (blocker !== null) {
      const code = this.#opts.config.crafting.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED';
      return failed(`not crafting: ${blocker}`, code);
    }
    if (this.#core.usingContainer) {
      return failed('a chest or crafting operation is already running', 'REFUSED');
    }
    const recipe = RECIPES[args.recipe];
    const tableId = args.craftingTableId;
    if (tableId === null && needsCraftingTable(recipe)) {
      return failed(`not crafting: ${recipe.id} needs a crafting table (3x3)`, 'REFUSED');
    }
    if (tableId !== null) {
      const where = this.#craftingTablePosition(tableId);
      if (typeof where === 'string') return failed(`not crafting: ${where}`, 'REFUSED');
    }
    const layout = tableId === null ? INVENTORY_GRID : TABLE_GRID;
    const registry = this.#world.registry;
    const placed = placeRecipe(recipe, layout, (name) => resolveItemName(registry, name));
    if (!placed.ok) return failed(`not crafting: ${placed.reason}`, 'REFUSED');
    // Refuse before anything is opened or clicked when the crafts cannot all finish exactly.
    const planned = this.#plannedCraftingWindow(layout);
    if (planned === null) return failed('not crafting: the inventory is not known', 'REFUSED');
    const feasible = simulateCrafts(planned, layout, placed.value, args.times);
    if (!feasible.ok) return failed(`not crafting: ${feasible.reason}`, 'REFUSED');

    this.#core.usingContainer = true;
    try {
      if (tableId === null) {
        const closed = this.#core.inventory.closeOpenWindow();
        if (closed !== null) return closed;
      } else {
        const opened = await this.#openCraftingTable(tableId);
        if (opened !== null) return opened;
      }
      const result = await this.#runCrafts(recipe, placed.value, args.times, layout);
      if (tableId === null) return result;
      // Leave no crafting table open (refused while its grid or the cursor holds items).
      const closed = this.#core.inventory.closeOpenWindow();
      return closed === null
        ? result
        : craftFailed(`${closed.message}; ${result.message}`, 'ERROR', result.data);
    } finally {
      this.#core.usingContainer = false;
    }
  }

  /**
   * Where a crafting table is: a configured one, or one the scan found
   * (`crafting_table:<x>.<y>.<z>`, a vanilla crafting table by its interaction profile),
   * which must lie inside the fence when one is set. The block itself is checked when the
   * table is opened. The position, or why the table may not be used.
   */
  #craftingTablePosition(tableId: string): { x: number; y: number; z: number } | string {
    const configured = this.#opts.config.crafting.tables[tableId];
    if (configured !== undefined) return configured.position;
    const found = parseObservedTableId(tableId);
    if (found === null) return `${tableId} is not a configured crafting table`;
    const fence = this.#core.fence().fence;
    const area = interactAreaProblem(fence, found);
    return area === null ? found : `crafting table ${tableId}: ${area}`;
  }

  /** Opens the crafting table (or keeps it open); a failure, or null when open. */
  async #openCraftingTable(tableId: string): Promise<ClientActionResult | null> {
    const table = this.#craftingTablePosition(tableId);
    if (typeof table === 'string') return failed(table, 'REFUSED');
    const open = this.#world.openWindow;
    const isThisTable = (w: typeof open): boolean =>
      w !== null &&
      w.slotsKnown &&
      w.containerId === tableId &&
      w.inventoryType === WORKBENCH_WINDOW_TYPE &&
      w.containerSlots === TABLE_GRID.playerSlots[0];
    if (isThisTable(open)) return null;
    if (open !== null) {
      const closed = this.#core.inventory.closeOpenWindow();
      if (closed !== null) return closed;
    }
    const opened = await this.#core.inventory.openBlockWindow(
      tableId,
      table,
      VANILLA_CRAFTING_TABLE,
      'crafting table',
    );
    if (opened !== null) return opened;
    return isThisTable(this.#world.openWindow) ? null : this.#core.inventory.unexpectedWindow();
  }

  /** The player's inventory laid out as `layout`'s window, with an empty grid and cursor. */
  #plannedCraftingWindow(layout: CraftingLayout): WindowSnapshot | null {
    const storage = this.#world.playerStorage();
    if (storage === null) return null;
    const first = layout.playerSlots[0];
    const slots: Array<Stack | null> = Array.from({ length: first }, () => null);
    slots.push(...storage);
    return { containerSlots: first, slots, cursor: null };
  }

  /**
   * The crafts themselves, in the window that is open (or window 0). Each: one item into
   * every pattern cell, a sync, the result taken only if it is exactly the expected item and
   * count, and put into an empty slot. Any failure first returns the grid and the cursor to
   * the inventory.
   */
  async #runCrafts(
    recipe: CraftingRecipe,
    placed: PlacedRecipe,
    times: number,
    layout: CraftingLayout,
  ): Promise<ClientActionResult> {
    // The sync click claims one of the expected result: something an empty slot never holds.
    const claim: Stack = { ...placed.expected, count: 1 };
    let crafts = 0;
    let clicks = 0;
    const syncsAtStart = this.#craftSyncs;
    const facts = (): Record<string, number> => ({
      crafts,
      clicks,
      syncs: this.#craftSyncs - syncsAtStart,
    });
    const view = (): WindowSnapshot | null => this.#core.inventory.clickTarget()?.window ?? null;

    // The server's exact view before anything moves. Anything left in the grid or on the
    // cursor by an earlier failure goes back into the inventory first.
    const initial = view();
    if (initial === null) return craftFailed('not crafting: no crafting window', 'FAILED', facts());
    const leftovers = !gridEmpty(initial, layout) || initial.cursor !== null;
    const cleared = await this.clearGrid(layout, stackBounds(initial, layout), claim);
    if (cleared !== null) {
      return leftovers
        ? craftFailed(
            `ITEMS MAY BE LEFT IN THE CRAFTING GRID OR ON THE CURSOR: ${layout.name} already held items and ${cleared}`,
            'ERROR',
            facts(),
          )
        : craftFailed(`not crafting: ${cleared}`, 'FAILED', facts());
    }
    const start = view();
    if (start === null) return craftFailed('not crafting: no crafting window', 'FAILED', facts());
    const bounds = stackBounds(start, layout);
    const feasible = simulateCrafts(start, layout, placed, times);
    if (!feasible.ok) return craftFailed(`not crafting: ${feasible.reason}`, 'REFUSED', facts());

    const stop = async (
      message: string,
      code: 'FAILED' | 'ERROR',
      extra: Record<string, string> = {},
    ): Promise<ClientActionResult> => {
      const cleared = await this.clearGrid(layout, bounds, claim);
      if (cleared === null) return craftFailed(message, code, { ...facts(), ...extra });
      return craftFailed(
        `ITEMS MAY BE LEFT IN THE CRAFTING GRID OR ON THE CURSOR (${cleared}): ${message}`,
        'ERROR',
        { ...facts(), ...extra },
      );
    };

    while (crafts < times) {
      const n = `craft ${crafts + 1} of ${times}`;
      const blocker = this.#craftingBlocker();
      if (blocker !== null)
        return stop(`stopped after ${crafts} of ${times} crafts: ${blocker}`, 'FAILED');

      // 1. One item into every pattern cell.
      const before = view();
      if (before === null) return stop(`${n}: the crafting window went away`, 'FAILED');
      const fill = planFill(before, layout, placed);
      if (!fill.ok) return stop(`${n}: ${fill.reason}`, 'FAILED');
      for (const c of fill.value.clicks) {
        const outcome = await this.#core.inventory.click(c);
        if (outcome !== 'accepted') return stop(`${n}: a click was ${outcome}`, 'FAILED');
        clicks += 1;
      }

      // 2. What does the server make of it? Only a full sync shows the result slot.
      const predicted = view();
      const synced = await this.#sync(layout, claim);
      if (synced !== null) return stop(`${n}: ${synced}`, 'FAILED');
      const actual = view();
      if (predicted === null || actual === null) {
        return stop(`${n}: the crafting window went away`, 'FAILED');
      }
      const diffs = windowDifferences(predicted, actual, new Set([layout.resultSlot]));
      if (diffs.length > 0) {
        return stop(
          `${n}: the server's window differs from the agent's (${diffs.slice(0, 3).join('; ')})`,
          'FAILED',
        );
      }
      const shown = actual.slots[layout.resultSlot] ?? null;
      if (!sameStack(shown, placed.expected)) {
        const observed = this.#core.inventory.describeStack(shown);
        return stop(
          `the server's crafting result for ${recipe.id} is ${observed}, not the expected ` +
            `${this.#core.inventory.describeStack(placed.expected)}; it was not taken and the ingredients ` +
            `were put back (${crafts} of ${times} crafts done)`,
          'FAILED',
          { observedResult: observed },
        );
      }

      // 3. Take exactly that result...
      const target = this.#core.inventory.clickTarget();
      if (target === null) return stop(`${n}: the crafting window went away`, 'FAILED');
      const take = applyTakeResult(target.window, layout);
      if (!take.ok) return stop(`${n}: ${take.reason}`, 'FAILED');
      const took = await this.#core.inventory.sendClick(
        target,
        { slot: layout.resultSlot, button: 0 },
        take.claimed,
        take.window,
      );
      if (took !== 'accepted') return stop(`${n}: taking the result was ${took}`, 'FAILED');
      clicks += 1;
      crafts += 1;

      // 4. ...and put it into an empty slot (results are never merged into other stacks).
      const holding = view();
      const store = holding === null ? null : planStoreCursor(holding, layout);
      if (store === null) return stop(`${n}: the crafting window went away`, 'FAILED');
      if (!store.ok) return stop(`${n}: ${store.reason}`, 'FAILED');
      const stored = await this.#core.inventory.click(store.value);
      if (stored !== 'accepted') return stop(`${n}: storing the result was ${stored}`, 'FAILED');
      clicks += 1;
    }

    // The server must agree: an empty grid and cursor, everything where the agent put it.
    const predicted = view();
    const last = await this.#sync(layout, claim);
    if (last !== null) return stop(`after ${times} crafts: ${last}`, 'ERROR');
    const actual = view();
    const diffs =
      predicted === null || actual === null
        ? ['the crafting window went away']
        : windowDifferences(predicted, actual, new Set([layout.resultSlot]));
    if (
      diffs.length > 0 ||
      actual === null ||
      !gridEmpty(actual, layout) ||
      actual.cursor !== null
    ) {
      return stop(
        `after ${times} crafts the server's window differs from the agent's (${diffs.slice(0, 3).join('; ')})`,
        'ERROR',
      );
    }
    return ok(
      `crafted ${times} x ${recipe.id}: ${times * recipe.result.count} ${recipe.result.item}, ` +
        `${clicks} clicks and ${this.#craftSyncs - syncsAtStart} syncs`,
      facts(),
    );
  }

  /**
   * Asks the server for its exact view of the crafting window. 1.7.10 never sends the result
   * slot as a slot update, only in a full window sync, and it sends one whenever it rejects
   * a click. So: a left-click on an EMPTY slot with an empty cursor (which changes nothing),
   * claiming `claim`, which an empty slot never holds; the server rejects it and re-sends
   * every slot, then the cursor. Null once synced, else why not.
   */
  async #sync(layout: CraftingLayout, claim: Stack): Promise<string | null> {
    const target = this.#core.inventory.clickTarget();
    if (target === null || this.#core.phase !== 'play') return 'no crafting window to sync';
    const probe = planSyncClick(target.window, layout);
    if (!probe.ok) return `cannot sync: ${probe.reason}`;
    this.#craftSyncs += 1;
    // If the server accepted after all, its slot held exactly `claim`, now on the cursor.
    const verdict = await this.#core.inventory.sendClick(target, probe.value, claim, {
      ...target.window,
      cursor: claim,
    });
    if (verdict === 'rejected') return null;
    if (verdict === 'accepted') {
      const back = await this.#core.inventory.click(probe.value);
      return (
        `the agent's view of slot ${probe.value.slot} was wrong: the sync click was accepted` +
        (back === 'accepted' ? ' (the item was put back)' : '')
      );
    }
    return 'the server did not answer a sync click';
  }

  /**
   * Returns the cursor and everything in the crafting grid to the inventory, then asks the
   * server to confirm: null when it shows both empty, else why not.
   */
  async clearGrid(
    layout: CraftingLayout,
    bounds: ReadonlyMap<string, number>,
    claim: Stack,
  ): Promise<string | null> {
    // True while the client's view is the server's own (a sync or a rejection's re-sync).
    let confirmed = false;
    let rounds = 0;
    for (;;) {
      if (this.#core.phase !== 'play') return 'the connection is closed';
      const w = this.#core.inventory.clickTarget()?.window ?? null;
      if (w === null) return 'the crafting window is not available';
      if (gridEmpty(w, layout) && w.cursor === null) {
        if (confirmed) return null;
        const synced = await this.#sync(layout, claim);
        if (synced !== null) return synced;
        confirmed = true;
        continue;
      }
      if (rounds >= CLEAR_GRID_ATTEMPTS) return 'the grid or the cursor still holds items';
      rounds += 1;
      const plan = planClearGrid(w, layout, bounds);
      if (!plan.ok) return plan.reason;
      confirmed = false;
      for (const c of plan.value.clicks) {
        const outcome = await this.#core.inventory.click(c);
        if (outcome === 'accepted') continue;
        if (outcome !== 'rejected') return `a click was ${outcome}`;
        confirmed = true; // the server re-sent the window: plan again from its view
        break;
      }
    }
  }

  /** The crafting grid (with its window's layout) that holds items or has them on the cursor. */
  leftovers(): CraftingLayout | null {
    const open = this.#world.openWindow;
    if (open !== null) {
      if (!open.slotsKnown || open.inventoryType !== WORKBENCH_WINDOW_TYPE) return null;
      return !gridEmpty(open, TABLE_GRID) || open.cursor !== null ? TABLE_GRID : null;
    }
    const inventory = this.#world.inventoryClickWindow;
    if (inventory === null) return null;
    return !gridEmpty(inventory, INVENTORY_GRID) || inventory.cursor !== null
      ? INVENTORY_GRID
      : null;
  }

  /** Before disconnecting: whatever a crafting grid or the cursor holds goes back first. */
  async returnCraftingLeftovers(): Promise<void> {
    if (this.#core.phase !== 'play' || this.#core.usingContainer) return;
    const open = this.#world.openWindow;
    if (open !== null && open.block != null && open.cursor !== null) {
      // A block window (a furnace...) with a stack on the cursor: back into an empty player
      // slot only, never into the block's own slots (an output slot takes nothing).
      const layout =
        open.block.profile === null
          ? null
          : this.#core.interact.profileLayout(INTERACTION_PROFILES[open.block.profile]);
      if (layout === null) return;
      this.#core.log('items are on the cursor: putting them down before disconnecting');
      this.#core.usingContainer = true;
      try {
        this.#core.log(
          (await this.#core.interact.returnCursorToPlayer(layout)) ?? 'the cursor was emptied',
        );
      } finally {
        this.#core.usingContainer = false;
      }
      return;
    }
    if (open !== null && open.inventoryType !== WORKBENCH_WINDOW_TYPE && open.cursor !== null) {
      // A chest window with a stack on the cursor (a failed recovery): one more try.
      this.#core.log('items are on the cursor: putting them down before disconnecting');
      this.#core.usingContainer = true;
      try {
        this.#core.log(await this.#core.inventory.recoverCursor(containerRange(open)));
      } finally {
        this.#core.usingContainer = false;
      }
      return;
    }
    const layout = this.leftovers();
    const w = this.#core.inventory.clickTarget()?.window ?? null;
    if (layout === null || w === null) return;
    const sample = [w.cursor, ...layout.gridSlots.map((s) => w.slots[s] ?? null)].find(
      (s): s is Stack => s != null && !s.hasNbt,
    );
    if (sample === undefined) return;
    this.#core.log(
      `items are in ${layout.name} or on the cursor: returning them before disconnecting`,
    );
    this.#core.usingContainer = true;
    try {
      const problem = await this.clearGrid(layout, stackBounds(w, layout), {
        ...sample,
        count: 1,
      });
      this.#core.log(problem === null ? 'returned them' : `could not return them: ${problem}`);
    } catch (error) {
      this.#core.log(`could not return them: ${errorMessage(error)}`);
    } finally {
      this.#core.usingContainer = false;
    }
  }
}

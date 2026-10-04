import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { BlockPosition } from '../../../domain/common.ts';
import {
  blockUse,
  FURNACE_SLOT,
  furnaceFuelTicks,
  observedStorageId,
  type InteractionProfile,
  type WindowLayout,
} from '../../../domain/interactions.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import type { WindowSnapshot } from '../container.ts';
import { eyesOf, faceTowards, reachTo } from '../digging.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import {
  interactAreaProblem,
  MAX_INTERACT_REACH,
  planInsert,
  planTakeAll,
  playerCount,
  playerRangeOf,
} from '../interact.ts';
import { outbound } from '../packets.ts';
import { resolveItemName } from '../registry.ts';
import type { WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { WINDOW_OPEN_TIMEOUT_MS } from './shared.ts';

/** Never put into a furnace: lava interaction is not allowed. */
const LAVA_BUCKET = 'minecraft:lava_bucket';

/**
 * Interacting with blocks (src/domain/interactions.ts profiles; interact.ts plans):
 * INTERACT_BLOCK, SMELT and TAKE_OUTPUT, each in the block's own window, opened with an empty
 * hand.
 */
export class InteractActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why a block window action cannot start now, or null. */
  interactBlocker(): string | null {
    const cfg = this.#opts.config;
    if (!cfg.interact.enabled) return 'interacting with blocks is disabled (MC_ENABLE_INTERACT)';
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

  /** Runs one block window action alone: no walk, dig, chest or crafting at the same time. */
  async #interactAction(
    what: string,
    run: () => Promise<ClientActionResult>,
  ): Promise<ClientActionResult> {
    const blocker = this.interactBlocker();
    if (blocker !== null) {
      const code = this.#opts.config.interact.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED';
      return failed(`not ${what}: ${blocker}`, code);
    }
    if (this.#core.usingContainer) {
      return failed('a chest, crafting or block window operation is already running', 'REFUSED');
    }
    this.#core.usingContainer = true;
    try {
      return await run();
    } finally {
      this.#core.usingContainer = false;
    }
  }

  /**
   * What the block at `target` is and how the agent may use it, checked on the blocks the
   * server sent: loaded and named, a profile (never opened ones refused) or the observe-only
   * allowlist, within reach of the eyes, inside the fence. `need` is a profile the action
   * requires (a furnace for SMELT).
   */
  interactTarget(
    target: BlockPosition,
    need: InteractionProfile['id'] | null,
  ):
    | { ok: true; block: string; profile: InteractionProfile | null }
    | { ok: false; result: ClientActionResult } {
    const refuse = (reason: string): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result: failed(reason, 'REFUSED'),
    });
    const where = `(${target.x}, ${target.y}, ${target.z})`;
    const id = this.#world.blockAt(target.x, target.y, target.z);
    if (id === undefined) return refuse(`the block at ${where} is not loaded`);
    if (id === 0) return refuse(`there is no block at ${where}`);
    const block = this.#world.registry?.blocks.get(id);
    if (block === undefined) return refuse(`block id ${id} at ${where} is not in the registry`);
    const use = blockUse(block, this.#opts.config.interact.observeOnly);
    if (use.kind === 'refused') return refuse(`not opening ${where}: ${use.reason}`);
    const profile = use.kind === 'profile' ? use.profile : null;
    if (need !== null && profile?.id !== need) {
      return refuse(`the block at ${where} is ${block}, not a ${need}`);
    }
    const feet = this.#world.ownPosition;
    if (feet === null) return refuse('player position unknown');
    const reach = reachTo(feet, target);
    if (reach > MAX_INTERACT_REACH + 1e-9) {
      return refuse(
        `${block} at ${where} is ${reach.toFixed(2)} blocks from the eyes (max ${MAX_INTERACT_REACH})`,
      );
    }
    const fence = this.#core.fence().fence;
    const area = interactAreaProblem(fence, target);
    if (area !== null) return refuse(`not opening ${block}: ${area}`);
    return { ok: true, block, profile };
  }

  /**
   * Opens the window of the block at `target` (never sneaking; with an empty hand, else, for a
   * block with a profile, a vanilla tool or plain block: inventory-actions.ts clickHand), or
   * keeps it open, and checks that the window is the one its profile describes. A failure, or
   * the window's layout (null for an observe-only block) once it is open.
   */
  async openInteractable(
    target: BlockPosition,
    block: string,
    profile: InteractionProfile | null,
  ): Promise<
    { ok: true; layout: WindowLayout | null } | { ok: false; result: ClientActionResult }
  > {
    const done = (result: ClientActionResult): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result,
    });
    const same = (p: { x: number; y: number; z: number } | undefined): boolean =>
      p !== undefined && p.x === target.x && p.y === target.y && p.z === target.z;
    const what = profile?.label.toLowerCase() ?? block;
    const open = this.#world.openWindow;
    if (open !== null && profile !== null && same(open.block?.position) && open.slotsKnown) {
      const layout = this.profileLayout(profile);
      if (layout !== null) return { ok: true, layout };
    }
    if (open !== null) {
      const closed = this.#core.inventory.closeOpenWindow();
      if (closed !== null) return done(closed);
    }
    const feet = this.#world.ownPosition;
    if (feet === null) return done(failed('player position unknown', 'REFUSED'));
    // A block with a profile always answers the click (its window opens); an observe-only
    // one may not, and a click with a block in hand would then place it: an empty hand only.
    const hand =
      profile === null ? this.#core.inventory.emptyHotbarSlot() : this.#core.inventory.clickHand();
    if (hand === null) {
      return done(
        failed(
          profile === null
            ? 'no empty hotbar slot to click with'
            : 'no hotbar slot to click with (empty, or a vanilla tool or block)',
          'REFUSED',
        ),
      );
    }
    if (hand !== this.#world.heldSlot) {
      this.#core.send(outbound.selectHotbarSlot(hand));
      this.#world.setHeldSlot(hand);
    }
    // A storage block opened this way is a container: a configured chest keeps its id, any
    // other gets its position id, so its contents show up in GameState.storage.
    const configured =
      profile?.id === 'chest'
        ? Object.entries(this.#opts.config.containers.chests).find(([, c]) => same(c.position))
        : undefined;
    const containerId =
      configured?.[0] ??
      (profile !== null && profile.storage ? observedStorageId(profile.id, target) : null);
    this.#world.expectBlockWindow({
      position: { ...target },
      block,
      profile: profile?.id ?? null,
    });
    this.#world.expectContainer(containerId);
    const face = faceTowards(eyesOf(feet), target);
    this.#core.send(outbound.activateBlock(target.x, target.y, target.z, face));
    await this.#core.waitFor(() => {
      const w = this.#world.openWindow;
      return w !== null && w.slotsKnown;
    }, WINDOW_OPEN_TIMEOUT_MS);
    this.#world.expectBlockWindow(null);
    this.#world.expectContainer(null);
    const w = this.#world.openWindow;
    if (w === null || !w.slotsKnown) return done(failed(`the ${what} did not open`, 'FAILED'));
    if (!same(w.block?.position)) return done(this.#core.inventory.unexpectedWindow());
    if (profile === null) return { ok: true, layout: null };
    const layout = this.profileLayout(profile);
    return layout === null ? done(this.#core.inventory.unexpectedWindow()) : { ok: true, layout };
  }

  /**
   * The open window's layout if it belongs to a block with this profile and is exactly a
   * window the profile knows (opener and slot count, matched by the world model), else null.
   */
  profileLayout(profile: InteractionProfile): WindowLayout | null {
    const w = this.#world.openWindow;
    if (w === null || !w.slotsKnown || w.layoutKnown === false) return null;
    if (w.block?.profile !== profile.id) return null;
    return w.layout ?? null;
  }

  /** A short description of the open block window, for results (contents: 300 characters). */
  #describeOpenBlockWindow(layout: WindowLayout | null): {
    opener: string;
    slots: number;
    contents: string;
  } {
    const w = this.#world.openWindow;
    if (w === null) return { opener: 'none', slots: 0, contents: 'no window is open' };
    const playerFirst = layout === null ? Infinity : layout.containerSlots;
    const items = w.slots
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s != null && (i < playerFirst || i >= playerFirst + 36))
      .map(({ s, i }) => `slot ${i}: ${this.#core.inventory.describeStack(s ?? null)}`)
      .join('; ');
    return {
      opener: w.fml != null ? `fml:${w.fml.modId}:${w.fml.guiId}` : `vanilla:${w.inventoryType}`,
      slots: w.slots.length,
      contents: (items === '' ? 'empty' : items).slice(0, 300),
    };
  }

  /**
   * INTERACT_BLOCK: opens the block's window and reports it. A block with a profile keeps
   * its window open (its contents stay in the observation); an observe-only block's window
   * is closed again at once: nothing in it is ever clicked.
   */
  interact(target: BlockPosition): Promise<ClientActionResult> {
    return this.#interactAction('opening the block', async () => {
      const t = this.interactTarget(target, null);
      if (!t.ok) return t.result;
      const opened = await this.openInteractable(target, t.block, t.profile);
      if (!opened.ok) return opened.result;
      const where = `(${target.x}, ${target.y}, ${target.z})`;
      const seen = this.#describeOpenBlockWindow(opened.layout);
      const data = { block: t.block, profile: t.profile?.id ?? null, ...seen };
      if (t.profile === null) {
        const closed = this.#core.inventory.closeOpenWindow();
        if (closed !== null) return closed;
        this.#core.log(`looked at ${t.block} at ${where}: ${seen.contents}`);
        return ok(
          `looked at ${t.block} at ${where} (observe-only, nothing clicked; closed again): ` +
            `${seen.opener}, ${seen.slots} slots`,
          data,
        );
      }
      return ok(`opened the ${t.profile.label.toLowerCase()} at ${where}`, data);
    });
  }

  /**
   * Moves exactly `quantity` of `item` from the player's slots into one container slot of
   * the open window, with predicted clicks (interact.ts planInsert). A rejected click (the
   * furnace ticking under the agent, e.g. lighting and using a fuel item) is not an
   * error: the server re-sends the window, the cursor goes back to an empty player slot,
   * and the rest is planned again from the server's own counts. Null on success.
   */
  async #insertExactly(
    layout: WindowLayout,
    target: number,
    item: { id: number; damage: number },
    quantity: number,
    label: string,
  ): Promise<{ ok: true; clicks: number } | { ok: false; result: ClientActionResult }> {
    const view = (): WindowSnapshot | null => this.#core.inventory.clickTarget()?.window ?? null;
    const start = view();
    if (start === null) return { ok: false, result: failed('the window is not open', 'FAILED') };
    const startCount = playerCount(start, layout, item);
    let clicks = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = view();
      if (now === null) {
        return {
          ok: false,
          result: failed(`the window closed while moving the ${label}`, 'FAILED'),
        };
      }
      const moved = startCount - playerCount(now, layout, item);
      const remaining = quantity - moved;
      if (remaining === 0 && now.cursor === null) return { ok: true, clicks };
      if (remaining < 0) {
        return {
          ok: false,
          result: failed(`moved ${moved} ${label}, more than the ${quantity} asked`, 'ERROR'),
        };
      }
      const plan = planInsert(now, layout, target, item, remaining);
      if (!plan.ok) {
        return {
          ok: false,
          result: failed(
            moved === 0
              ? `not moving the ${label}: ${plan.reason}`
              : `moved ${moved} of ${quantity} ${label}, then: ${plan.reason}`,
            moved === 0 ? 'REFUSED' : 'FAILED',
            { moved },
          ),
        };
      }
      let rejected = false;
      for (const c of plan.value.clicks) {
        const outcome = await this.#core.inventory.click(c);
        if (outcome === 'accepted') {
          clicks += 1;
          continue;
        }
        const back = await this.returnCursorToPlayer(layout);
        if (outcome !== 'rejected' || back !== null) {
          return {
            ok: false,
            result: failed(
              `moving the ${label}: a click was ${outcome}${back === null ? '' : `; ${back}`}`,
              back === null ? 'FAILED' : 'ERROR',
              { clicks },
            ),
          };
        }
        rejected = true;
        break;
      }
      if (!rejected) {
        const after = view();
        const done = after === null ? null : startCount - playerCount(after, layout, item);
        if (done === quantity && after?.cursor === null) return { ok: true, clicks };
      }
    }
    return {
      ok: false,
      result: failed(`moving the ${label}: still not done after 3 attempts`, 'FAILED', { clicks }),
    };
  }

  /**
   * After a rejected click: puts the cursor back into an EMPTY player slot (never into the
   * block's own slots). Null when the cursor is empty, else the problem.
   */
  async returnCursorToPlayer(layout: WindowLayout): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const w = this.#core.inventory.clickTarget()?.window ?? null;
      if (w === null) return 'the window closed';
      if (w.cursor === null) return null;
      const [first, last] = playerRangeOf(layout);
      let empty: number | null = null;
      for (let i = first; i <= last; i++) {
        if (w.slots[i] === null) {
          empty = i;
          break;
        }
      }
      if (empty === null) break;
      const outcome = await this.#core.inventory.click({ slot: empty, button: 0 });
      if (outcome !== 'accepted' && outcome !== 'rejected') break;
    }
    const w = this.#world.openWindow;
    return w?.cursor == null
      ? null
      : `ITEMS MAY BE ON THE CURSOR (${w.cursor.count} of id ${w.cursor.id}); the window was left open`;
  }

  /**
   * SMELT: opens the furnace and puts exactly the fuel (first: an unlit furnace cannot light
   * while its input slot is empty) and then the input into it. Everything is planned on the
   * window before the first click, and refused if it cannot finish exactly. The furnace keeps
   * its items and smelts on its own; its window stays open, so the observation shows it.
   */
  smelt(args: {
    position: BlockPosition;
    input: string;
    quantity: number;
    fuel: string;
    fuelQuantity: number;
  }): Promise<ClientActionResult> {
    return this.#interactAction('smelting', async () => {
      if (args.input === LAVA_BUCKET || args.fuel === LAVA_BUCKET) {
        return failed('not smelting: lava is never used', 'REFUSED');
      }
      if (args.fuelQuantity > 0 && furnaceFuelTicks(args.fuel) === null) {
        return failed(`not smelting: ${args.fuel} is not a known furnace fuel`, 'REFUSED');
      }
      const registry = this.#world.registry;
      const input = resolveItemName(registry, args.input);
      const fuel = resolveItemName(registry, args.fuel);
      if (input === null) return failed(`${args.input} is not in the item registry`, 'REFUSED');
      if (fuel === null) return failed(`${args.fuel} is not in the item registry`, 'REFUSED');
      const t = this.interactTarget(args.position, 'furnace');
      if (!t.ok) return t.result;
      const opened = await this.openInteractable(args.position, t.block, t.profile);
      if (!opened.ok) return opened.result;
      const layout = opened.layout;
      if (layout === null) return failed('internal: the furnace has no layout', 'ERROR');

      // Refuse before the first click when the two moves cannot both finish exactly.
      const start = this.#core.inventory.clickTarget()?.window ?? null;
      if (start === null) return failed('the furnace window is not open', 'FAILED');
      let preview = start;
      if (args.fuelQuantity > 0) {
        const p = planInsert(preview, layout, FURNACE_SLOT.fuel, fuel, args.fuelQuantity);
        if (!p.ok) return failed(`not smelting: fuel: ${p.reason}`, 'REFUSED');
        preview = p.value.after;
      }
      const p = planInsert(preview, layout, FURNACE_SLOT.input, input, args.quantity);
      if (!p.ok) return failed(`not smelting: input: ${p.reason}`, 'REFUSED');

      let clicks = 0;
      if (args.fuelQuantity > 0) {
        const f = await this.#insertExactly(
          layout,
          FURNACE_SLOT.fuel,
          fuel,
          args.fuelQuantity,
          'fuel',
        );
        if (!f.ok) return f.result;
        clicks += f.clicks;
      }
      const i = await this.#insertExactly(
        layout,
        FURNACE_SLOT.input,
        input,
        args.quantity,
        'input',
      );
      if (!i.ok) {
        return args.fuelQuantity > 0
          ? failed(
              `the fuel went in, the input did not: ${i.result.message}`,
              i.result.code === 'OK' ? 'FAILED' : i.result.code,
              i.result.data,
            )
          : i.result;
      }
      clicks += i.clicks;
      const where = `(${args.position.x}, ${args.position.y}, ${args.position.z})`;
      return ok(
        `put ${args.quantity} ${args.input}` +
          (args.fuelQuantity > 0 ? ` and ${args.fuelQuantity} ${args.fuel}` : '') +
          ` into the furnace at ${where} in ${clicks} clicks; it smelts on its own (10 s per item)`,
        { clicks, ...this.#describeOpenBlockWindow(layout) },
      );
    });
  }

  /**
   * TAKE_OUTPUT: opens the furnace and takes the WHOLE stack in its output slot, which must
   * be `item`, into an empty inventory slot. Reports how many were taken, counted from the
   * player's own slots (a click the server rejected because another item finished meanwhile
   * still took everything the slot held).
   */
  takeOutput(args: { position: BlockPosition; item: string }): Promise<ClientActionResult> {
    return this.#interactAction('taking the output', async () => {
      const item = resolveItemName(this.#world.registry, args.item);
      if (item === null) return failed(`${args.item} is not in the item registry`, 'REFUSED');
      const t = this.interactTarget(args.position, 'furnace');
      if (!t.ok) return t.result;
      const opened = await this.openInteractable(args.position, t.block, t.profile);
      if (!opened.ok) return opened.result;
      const layout = opened.layout;
      if (layout === null) return failed('internal: the furnace has no layout', 'ERROR');
      const start = this.#core.inventory.clickTarget()?.window ?? null;
      if (start === null) return failed('the furnace window is not open', 'FAILED');
      const output = start.slots[FURNACE_SLOT.output] ?? null;
      if (output === null) return failed("the furnace's output slot is empty", 'REFUSED');
      if (output.hasNbt || output.id !== item.id || output.damage !== item.damage) {
        return failed(
          `the furnace's output is ${this.#core.inventory.describeStack(output)}, not ${args.item}`,
          'REFUSED',
        );
      }
      const plan = planTakeAll(start, layout, FURNACE_SLOT.output);
      if (!plan.ok) return failed(`not taking the output: ${plan.reason}`, 'REFUSED');
      const before = playerCount(start, layout, item);
      let clicks = 0;
      for (const c of plan.value.clicks) {
        const outcome = await this.#core.inventory.click(c);
        if (outcome === 'accepted') {
          clicks += 1;
          continue;
        }
        const back = await this.returnCursorToPlayer(layout);
        if (outcome !== 'rejected' || back !== null) {
          return failed(
            `taking the output: a click was ${outcome}${back === null ? '' : `; ${back}`}`,
            back === null ? 'FAILED' : 'ERROR',
            { clicks },
          );
        }
        break; // the server re-sent the window; the cursor is back in the inventory
      }
      const end = this.#core.inventory.clickTarget()?.window ?? null;
      if (end === null || end.cursor !== null) {
        return failed('the cursor is not empty after taking the output', 'ERROR');
      }
      const taken = playerCount(end, layout, item) - before;
      if (taken < 1) return failed('nothing reached the inventory', 'FAILED', { clicks });
      const where = `(${args.position.x}, ${args.position.y}, ${args.position.z})`;
      return ok(`took ${taken} ${args.item} from the furnace at ${where}`, {
        item: args.item,
        taken,
        clicks,
        ...this.#describeOpenBlockWindow(layout),
      });
    });
  }
}

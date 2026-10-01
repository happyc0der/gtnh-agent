import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { placedBlockOf, type PlaceableItem } from '../../../domain/blocks.ts';
import type { BlockPosition } from '../../../domain/common.ts';
import { TICK_MS } from '../../../domain/dig-time.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import type { Stack } from '../container.ts';
import { eyesOf } from '../digging.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { outbound } from '../packets.ts';
import { checkPlace, type EntityPosition, type PlaceArea, type PlaceCheck } from '../placing.ts';
import { resolveItemName, type Registry } from '../registry.ts';
import type { BlockWatch, WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { delay, lookAt, ON_GROUND } from './shared.ts';

/** After the click: how long to wait for the server's block change at the cell. */
const PLACE_OUTCOME_TIMEOUT_MS = 2_000;
/**
 * After the first block change: a quiet period with no further update for the cell. A mod
 * that cancels the placement restores the cell, and sand or gravel that found nothing under
 * it would fall within these ticks.
 */
const PLACE_SETTLE_MS = 5 * TICK_MS;
/** How long the server's re-send of the held slot (S2F, one item fewer) may take. */
const PLACE_STACK_TIMEOUT_MS = 1_000;

/** The registry id of a block, by name; null when this world's registry does not have it. */
function blockIdOf(registry: Registry | null, name: string): number | null {
  if (registry === null) return null;
  for (const [id, n] of registry.blocks) if (n === name) return id;
  return null;
}

/** Placing one block (see placing.ts): PLACE_BLOCK. */
export class PlaceActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why placing cannot start now, or null. */
  #placeBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.placing.enabled) {
      return { reason: 'placing is disabled (MC_ENABLE_PLACING)', code: 'NOT_IMPLEMENTED' };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    const area = this.#core.fence();
    if (area.fence === null) return refused(`placing stays inside the fence: ${area.problem}`);
    if (!cfg.presenceTicks) return refused('placing needs presence ticks (MC_PRESENCE_TICKS)');
    if (this.#core.haltReason !== null) return refused(`halted: ${this.#core.haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#core.walking) return refused('the player is walking');
    if (this.#core.usingContainer) return refused('a chest or crafting operation is running');
    if (this.#core.digging) return refused('the player is digging');
    if (this.#core.placing) return refused('a placement is already in progress');
    if (this.#core.fighting) return refused('the player is fighting');
    return null;
  }

  /**
   * checkPlace on the latest block data, position and entities, after dig-actions.ts
   * interruption.
   */
  #placeCheck(
    area: PlaceArea,
    target: BlockPosition,
    item: PlaceableItem,
    guard: { placementsAtStart: number; healthAtStart: number | null },
  ): PlaceCheck {
    const interrupted = this.#core.dig.interruption(guard);
    if (interrupted !== null) return { ok: false, reason: interrupted };
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) {
      return { ok: false, reason: 'block data or position unknown' };
    }
    const entities: EntityPosition[] = this.#world
      .trackedEntities()
      .map(({ x, y, z }) => ({ x, y, z }));
    return checkPlace(world, area, feet, target, item, entities);
  }

  /**
   * PLACE_BLOCK: put ONE allowlisted block the player carries into an empty cell, like a
   * player: hold it (a stack from the main inventory is moved into an empty hotbar slot first
   * when none is in the hotbar), face the plain block placing.ts chose to place it against,
   * click that block's face (C08 with the held stack) and swing the arm. Everything is
   * checked again just before the click. Success needs the server's own change of the cell
   * to the placed block, with nothing else after it; the result reports whether the held
   * stack shrank by one.
   */
  async place(args: { position: BlockPosition; item: PlaceableItem }): Promise<ClientActionResult> {
    const blocker = this.#placeBlocker();
    const fence = this.#core.fence().fence;
    if (blocker !== null || fence === null) {
      return failed(`not placing: ${blocker?.reason ?? 'no fence'}`, blocker?.code ?? 'REFUSED');
    }
    const area: PlaceArea = {
      fence,
      maxHeightAboveFence: this.#opts.config.placing.maxHeightAboveFence,
    };
    const target = args.position;
    const { x, y, z } = target;
    const where = `(${x}, ${y}, ${z})`;
    const block = placedBlockOf(args.item);
    this.#core.placing = true;
    try {
      // A chest left open by an earlier action is closed first (never with a full cursor):
      // the hotbar is arranged with window-0 clicks.
      if (this.#world.openWindow !== null) {
        const closed = this.#core.inventory.closeOpenWindow();
        if (closed !== null) return failed(`not placing: ${closed.message}`, 'REFUSED');
      }
      const registry = this.#world.registry;
      const item = resolveItemName(registry, args.item);
      const blockId = blockIdOf(registry, block);
      if (item === null || blockId === null) {
        return failed(`not placing: ${args.item} is not in this world's registry`, 'REFUSED');
      }
      const guard = {
        placementsAtStart: this.#core.confirmedPositions,
        healthAtStart: this.#world.health,
      };
      const check = this.#placeCheck(area, target, args.item, guard);
      if (!check.ok) return failed(`not placing: ${check.reason}`, 'REFUSED');

      const hand = await this.#holdForPlacing(item, args.item);
      if (!hand.ok) return hand.result;
      const moved = hand.moved === null ? '' : ` (${hand.moved})`;

      // Everything again, just before the click: arranging the hotbar took time.
      const final = this.#placeCheck(area, target, args.item, guard);
      if (!final.ok) return failed(`not placing: ${final.reason}${moved}`, 'REFUSED');
      const held = this.#world.playerStorage()?.[27 + hand.slot] ?? null;
      const feet = this.#world.ownPosition;
      if (
        held === null ||
        held.id !== item.id ||
        held.damage !== item.damage ||
        held.hasNbt ||
        feet === null
      ) {
        return failed(`not placing: hotbar slot ${hand.slot} does not hold ${args.item}`, 'ERROR');
      }
      const { clicked, face, cursor } = final.support;
      const clickedName =
        registry?.blocks.get(this.#world.blockAt(clicked.x, clicked.y, clicked.z) ?? -1) ??
        'a block';
      const against = `${clickedName} at (${clicked.x}, ${clicked.y}, ${clicked.z}), face ${face}`;
      const facts = { x, y, z, block, item: args.item, against };

      const clickedWatch = this.#world.watchBlock(clicked.x, clicked.y, clicked.z);
      const cellWatch = this.#world.watchBlock(x, y, z);
      let verdict: { ok: true } | { ok: false; result: ClientActionResult };
      try {
        // Face the point that is clicked, as a player does (others see where the head points).
        const point = {
          x: clicked.x + cursor.x / 16,
          y: clicked.y + cursor.y / 16,
          z: clicked.z + cursor.z / 16,
        };
        const look = lookAt(eyesOf(feet), point);
        this.#core.send(outbound.playerLook(look.yaw, look.pitch, ON_GROUND));
        this.#core.lastYaw = look.yaw;
        this.#core.log(`placing ${args.item} at ${where} against ${against}`);
        const sent = {
          clicked: clickedWatch.updates.length,
          cell: cellWatch.updates.length,
          clickedId: this.#world.blockAt(clicked.x, clicked.y, clicked.z) ?? -1,
        };
        this.#core.send(
          outbound.placeBlock(
            clicked.x,
            clicked.y,
            clicked.z,
            face,
            held,
            cursor,
            this.#core.decoding.itemStackSizeVarInt,
          ),
        );
        // A vanilla client swings the arm once the use went through.
        const self = this.#world.selfEntityId;
        if (self !== null) this.#core.send(outbound.swingArm(self));
        verdict = await this.#placeVerdict(clickedWatch, cellWatch, sent, blockId, block, where);
      } finally {
        this.#world.unwatch(clickedWatch);
        this.#world.unwatch(cellWatch);
      }

      // The click opened a window: the block was not plain after all. Close it again.
      const opened = this.#world.openWindow;
      if (opened !== null) {
        const closed = this.#core.inventory.closeOpenWindow();
        return failed(
          `clicking ${against} opened a window (type ${opened.inventoryType}) instead of placing` +
            `${closed === null ? '; it was closed again' : `; ${closed.message}`}`,
          'FAILED',
          facts,
        );
      }
      if (!verdict.ok) return verdict.result;

      // The server takes the item and re-sends the held slot (S2F) with one fewer.
      const expected = held.count - 1;
      const count = (): number => this.#world.playerStorage()?.[27 + hand.slot]?.count ?? 0;
      await this.#core.waitFor(() => count() === expected, PLACE_STACK_TIMEOUT_MS);
      const stackUsed = count() === expected;
      this.#core.log(`placed ${block} at ${where}; held stack ${held.count} -> ${count()}`);
      return ok(
        `placed ${block} at ${where} against ${against}; ` +
          (stackUsed
            ? `the held ${args.item} went from ${held.count} to ${expected}`
            : `the held ${args.item} did not shrink by one within ${PLACE_STACK_TIMEOUT_MS} ms (${held.count} -> ${count()})`) +
          moved,
        { ...facts, stackUsed, stackBefore: held.count, stackAfter: count() },
      );
    } finally {
      this.#core.placing = false;
    }
  }

  /**
   * Holds `item` (registry id and damage; never a stack with NBT data) in the selected
   * hotbar slot: the held slot if it holds it, else the first hotbar slot that does, else a
   * stack from the main inventory is moved into the first empty hotbar slot with two
   * confirmed window-0 clicks (pick it up, put it down). Refuses when none can be held.
   */
  async #holdForPlacing(
    item: { id: number; damage: number },
    name: string,
  ): Promise<
    { ok: true; slot: number; moved: string | null } | { ok: false; result: ClientActionResult }
  > {
    const refuse = (reason: string): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result: failed(`not placing: ${reason}`, 'REFUSED'),
    });
    const storage = this.#world.playerStorage();
    if (storage === null) return refuse('the inventory is not known');
    const holds = (s: Stack | null | undefined): boolean =>
      s != null && s.id === item.id && s.damage === item.damage && !s.hasNbt && s.count > 0;
    const hotbar = (j: number): Stack | null => storage[27 + j] ?? null;
    let slot: number | null = holds(hotbar(this.#world.heldSlot)) ? this.#world.heldSlot : null;
    for (let j = 0; slot === null && j < 9; j++) if (holds(hotbar(j))) slot = j;
    let moved: string | null = null;
    if (slot === null) {
      const from = storage.slice(0, 27).findIndex(holds);
      if (from === -1) return refuse(`no ${name} without NBT data in the inventory`);
      const to = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((j) => hotbar(j) === null);
      if (to === undefined) {
        return refuse(`no ${name} in the hotbar, and no empty hotbar slot to move one into`);
      }
      const problem = await this.#moveStackToSlot(9 + from, 36 + to);
      if (problem !== null) {
        return {
          ok: false,
          result: failed(
            `not placing: ${problem}`,
            problem.includes('ITEMS MAY BE ON THE CURSOR') ? 'ERROR' : 'FAILED',
          ),
        };
      }
      slot = to;
      moved = `moved ${name} from inventory slot ${9 + from} to hotbar slot ${to}`;
    }
    if (slot !== this.#world.heldSlot) {
      this.#core.send(outbound.selectHotbarSlot(slot));
      this.#world.setHeldSlot(slot);
    }
    return { ok: true, slot, moved };
  }

  /**
   * Moves the whole stack in window-0 slot `from` into the EMPTY slot `to` with two confirmed
   * clicks; null on success. A failed click puts the stack back (see #emptyInventoryCursor).
   */
  async #moveStackToSlot(from: number, to: number): Promise<string | null> {
    if (this.#core.inventory.clickTarget()?.windowId !== 0)
      return 'the inventory cannot be clicked now';
    const take = await this.#core.inventory.click({ slot: from, button: 0 });
    if (take !== 'accepted') {
      return `picking up the stack was ${take}${await this.#emptyInventoryCursor(from)}`;
    }
    const put = await this.#core.inventory.click({ slot: to, button: 0 });
    if (put !== 'accepted') {
      return `putting it into the hotbar was ${put}${await this.#emptyInventoryCursor(from)}`;
    }
    return null;
  }

  /** After a failed window-0 click: whatever is on the cursor goes into an empty player slot. */
  async #emptyInventoryCursor(preferred: number): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = this.#core.inventory.clickTarget();
      if (target === null || target.windowId !== 0 || target.window.cursor === null) break;
      const slots = target.window.slots;
      const empty = [preferred, ...Array.from({ length: 36 }, (_, i) => 9 + i)].find(
        (i) => slots[i] === null,
      );
      if (empty === undefined) break;
      await this.#core.inventory.click({ slot: empty, button: 0 });
    }
    const cursor = this.#core.inventory.clickTarget()?.window.cursor ?? null;
    if (cursor !== null) {
      return `; ITEMS MAY BE ON THE CURSOR (${cursor.count} of id ${cursor.id})`;
    }
    return '; nothing was left on the cursor';
  }

  /**
   * After the click the server sends S23 for the clicked block, then for the cell (both as
   * they are after its attempt), and the world's own change follows. As in mineflayer's
   * placeBlock (MIT), the clicked block's update is the acknowledgement: updates for the
   * cell before it are stale, and the first one after it is the server's answer. Waits for
   * both and a quiet PLACE_SETTLE_MS; succeeds only if every cell update after the
   * acknowledgement is the placed block.
   */
  async #placeVerdict(
    clicked: BlockWatch,
    cell: BlockWatch,
    sent: { clicked: number; cell: number; clickedId: number },
    blockId: number,
    block: string,
    where: string,
  ): Promise<{ ok: true } | { ok: false; result: ClientActionResult }> {
    const clock = this.#opts.clock;
    const deadline = clock.now().getTime() + PLACE_OUTCOME_TIMEOUT_MS + PLACE_SETTLE_MS;
    const answers = (): number[] => {
      const ack = clicked.order[sent.clicked];
      if (ack === undefined) return [];
      return cell.updates.filter((_, i) => i >= sent.cell && (cell.order[i] ?? 0) > ack);
    };
    await this.#core.waitFor(() => answers().length > 0, PLACE_OUTCOME_TIMEOUT_MS);
    let seen = cell.updates.length;
    let quietSince = clock.now().getTime();
    while (answers().length > 0 && clock.now().getTime() < deadline) {
      if (clock.now().getTime() - quietSince >= PLACE_SETTLE_MS) break;
      await delay(TICK_MS);
      if (cell.updates.length !== seen) {
        seen = cell.updates.length;
        quietSince = clock.now().getTime();
      }
    }
    const after = answers();
    const fail = (message: string): { ok: false; result: ClientActionResult } => {
      this.#core.log(message);
      const now = this.#world.blockAt(cell.x, cell.y, cell.z);
      return {
        ok: false,
        result: failed(message, 'FAILED', {
          x: cell.x,
          y: cell.y,
          z: cell.z,
          block,
          placedNow: now === blockId,
        }),
      };
    };
    if (this.#core.phase !== 'play')
      return fail(`the connection closed after the click at ${where}`);
    if (clicked.updates.length <= sent.clicked) {
      return fail(
        `the server did not answer the click within ${PLACE_OUTCOME_TIMEOUT_MS} ms (no update for the clicked block)`,
      );
    }
    if (after.length === 0) {
      return fail(`the server answered the click but sent nothing for ${where}`);
    }
    if (after.some((id) => id !== blockId)) {
      const nameOf = (id: number): string =>
        id === 0
          ? 'minecraft:air'
          : id === -1
            ? 'an unloaded chunk'
            : (this.#world.registry?.blocks.get(id) ?? `block id ${id}`);
      // The server places into the clicked cell itself when that block has become
      // replaceable: the agent's view of it was wrong.
      const ack = clicked.updates[sent.clicked];
      const changed =
        ack !== undefined && ack !== sent.clickedId
          ? `; the clicked block had become ${nameOf(ack)}`
          : '';
      return fail(
        `the server did not place ${block} at ${where} (it sent ${after.slice(0, 4).map(nameOf).join(', ')}${changed}): ` +
          'it refused (something in the way, out of reach, a protected spot, or a mod cancelled ' +
          'it), or the block did not stay',
      );
    }
    return { ok: true };
  }
}

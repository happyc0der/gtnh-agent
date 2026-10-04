import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import type { Stack } from '../container.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { outbound } from '../packets.ts';
import { nameItemStack } from '../registry.ts';
import type { WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { delay } from './shared.ts';

/**
 * Blocks a right-click with an empty hand does nothing to (no window, no state change, no
 * teleport), so clicking one only ends the spawn protection (#endSpawnProtection).
 */
const PLAIN_GROUND: ReadonlySet<string> = new Set([
  'minecraft:grass',
  'minecraft:dirt',
  'minecraft:mycelium',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
  'minecraft:stone',
  'minecraft:cobblestone',
  'minecraft:mossy_cobblestone',
  'minecraft:sandstone',
  'minecraft:hardened_clay',
  'minecraft:stained_hardened_clay',
  'minecraft:snow',
  'minecraft:netherrack',
]);
/** Longest wait for the server to finish eating (vanilla 32 ticks; HungerOverhaul longer). */
const EAT_TIMEOUT_MS = 8_000;

/**
 * WAIT, and EAT_FOOD (first, when need be, the click on the ground that ends the spawn
 * protection, which keeps a player from eating).
 */
export class PlayerActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /**
   * WAIT's postcondition is "observed time advanced by at least `ms`", and a live state is
   * timestamped with the arrival of the last server packet (the honest "as of"). So wait
   * until both the clock and the observed world have moved on by `ms`; the server sends at
   * least a time update every second, so this adds at most about a second.
   */
  async wait(ms: number): Promise<ClientActionResult> {
    const clock = this.#opts.clock;
    const start = clock.now().getTime();
    const observedStart = this.#world.lastPacketAt?.getTime() ?? start;
    await delay(ms);
    await this.#core.waitFor(
      () =>
        clock.now().getTime() - start >= ms &&
        (this.#world.lastPacketAt?.getTime() ?? 0) - observedStart >= ms,
      Math.max(3_000, ms),
    );
    return ok(`waited ${clock.now().getTime() - start} ms`);
  }

  /**
   * EAT_FOOD, as a player eats: the food into a hotbar slot (moved there from the main
   * inventory if need be) and into the hand, then "use the held item in the air" (C08, face
   * 255), standing still while the server counts the eating down (32 ticks in vanilla; mods may
   * take longer), until the stack shrinks. Seen live: the agent had an apple, hunger fell, and
   * EAT_FOOD was not implemented, so every EAT failed until the repeated-failure rule stopped it.
   */
  async eat(item: string): Promise<ClientActionResult> {
    const refuse = (why: string, code: 'REFUSED' | 'FAILED' | 'ERROR' = 'REFUSED') =>
      failed(`not eating: ${why}`.slice(0, 500), code);
    if (this.#core.phase !== 'play') return refuse('not connected', 'ERROR');
    if (!this.#opts.config.eating.enabled) {
      return failed('eating is disabled (MC_ENABLE_EATING)', 'NOT_IMPLEMENTED');
    }
    if (this.#core.walking || this.#core.exploring) return refuse('a walk is in progress');
    if (this.#core.digging || this.#core.placing || this.#core.fighting || this.#core.eating) {
      return refuse('the hand is busy (digging, placing, fighting or eating)');
    }
    if (this.#core.usingContainer || this.#world.openWindow !== null)
      return refuse('a window is open');
    const food = this.#world.food;
    if (food === null) return refuse('the food level is not known yet');
    if (food >= 20) return refuse('the player is not hungry (food 20)');
    const registry = this.#world.registry;
    const storage = this.#world.playerStorage();
    if (registry === null || storage === null) return refuse('the inventory is not known yet');
    // The held slot first, then the rest of the hotbar, then the main inventory.
    const heldIndex = 27 + this.#world.heldSlot;
    const order = [heldIndex];
    for (let i = 27; i < 36; i++) if (i !== heldIndex) order.push(i);
    for (let i = 0; i < 27; i++) order.push(i);
    const index = order.find((i) => {
      const s = storage[i];
      if (s == null || s.hasNbt) return false;
      const naming = nameItemStack(registry, s.id, s.damage);
      return naming.ok && naming.name === item;
    });
    if (index === undefined) return refuse(`no ${item} in the inventory`);
    let slot = index - 27;
    if (index < 27) {
      // An empty hotbar slot, else one holding a plain stack to swap with (seen live: a full
      // hotbar, cooked beef in the main inventory, and every meal refused while hungry).
      const free = this.#core.inventory.emptyHotbarSlot();
      const to = free ?? this.#core.inventory.evictableHotbarSlot();
      if (to === null) {
        return refuse(
          `the ${item} is not in the hotbar, and no hotbar slot is free or holds a plain stack to swap with`,
        );
      }
      const moved =
        free === null
          ? await this.#core.inventory.swapIntoHotbar(9 + index, to)
          : await this.#core.inventory.moveToHotbar(9 + index, free, storage[index] as Stack);
      if (moved !== null) {
        return refuse(
          `the ${item} could not be moved into the hotbar: ${moved}`,
          moved.startsWith('ITEMS MAY') ? 'ERROR' : 'FAILED',
        );
      }
      slot = to;
    }
    // GTNH's AngerMod protects a player after each join (angermod.cfg ProtectionEnabled:
    // invulnerable for up to 90 s, until it walks 5 blocks, attacks or right-clicks a block),
    // and EntityPlayer.canEat() is false while it is: the server answers the use with the
    // inventory as it was, and nothing is eaten (seen live: every EAT right after joining
    // failed). A click in the air does not end it; a click on a block does, as for a player
    // whose right-click with food in hand first lands on the ground.
    if (this.#world.damageDisabled === true) {
      const still = await this.#endSpawnProtection();
      if (still !== null) return refuse(still);
    }
    // Always (re)select it: the server eats what it thinks is in hand.
    this.#core.send(outbound.selectHotbarSlot(slot));
    this.#world.setHeldSlot(slot);
    const held = this.#core.inventory.hotbar(slot);
    if (held == null) return refuse(`the ${item} left the hotbar`, 'FAILED');
    const before = held.count;
    this.#core.eating = true;
    try {
      this.#core.log(`eating ${item} (food ${food})`);
      this.#core.send(
        outbound.useHeldItem(
          { id: held.id, damage: held.damage, count: held.count, hasNbt: false },
          this.#core.decoding.itemStackSizeVarInt,
        ),
      );
      // The server finishes eating on its own after the use time, and sends the slot.
      await this.#core.waitFor(() => {
        const now = this.#core.inventory.hotbar(slot);
        return now == null || now.id !== held.id || now.count < before;
      }, EAT_TIMEOUT_MS);
      const now = this.#core.inventory.hotbar(slot);
      const ate = now == null || now.id !== held.id || now.count < before;
      if (!ate) {
        return failed(
          `not eaten: the server did not finish eating the ${item} within ${EAT_TIMEOUT_MS / 1000} s`,
          'FAILED',
        );
      }
      // The food level comes in its own packet, a tick or so after the slot.
      await this.#core.waitFor(() => (this.#world.food ?? 0) > food, 1_000);
      const after = this.#world.food;
      return ok(`ate 1 x ${item}: food ${food} -> ${after ?? 'unknown'}`, {
        foodBefore: food,
        foodAfter: after,
      });
    } finally {
      this.#core.eating = false;
    }
  }

  /**
   * Ends the server's spawn protection (see eat) with a right-click on the plain ground
   * underfoot with an empty hand, which uses, places and opens nothing. Null once it has
   * ended, else why it is still on.
   */
  async #endSpawnProtection(): Promise<string | null> {
    const on =
      'the server still protects the player after it joined (a protected player cannot eat; ' +
      'it ends after 90 s or a 5-block walk)';
    const feet = this.#world.ownPosition;
    const registry = this.#world.registry;
    if (feet === null || registry === null) return `${on}, and the ground underfoot is not known`;
    // The first block below the feet: the server may have put the player a little above the
    // ground at login (seen live: saved mid-jump, at y 92.42 over sand at 91).
    const x = Math.floor(feet.x);
    const z = Math.floor(feet.z);
    let y = Math.floor(feet.y - 0.01);
    let id = this.#world.blockAt(x, y, z);
    while (id === 0 && y > Math.floor(feet.y) - 3) id = this.#world.blockAt(x, --y, z);
    const ground =
      id === undefined ? undefined : id === 0 ? 'minecraft:air' : registry.blocks.get(id);
    if (ground === undefined || !PLAIN_GROUND.has(ground)) {
      return `${on}, and the block underfoot (${ground ?? 'unknown'}) is not plain ground to click`;
    }
    const hand = this.#core.inventory.emptyHotbarSlot();
    if (hand === null) return `${on}, and no hotbar slot is empty to click the ground with`;
    if (hand !== this.#world.heldSlot) {
      this.#core.send(outbound.selectHotbarSlot(hand));
      this.#world.setHeldSlot(hand);
    }
    this.#core.log(
      `clicking the ${ground} underfoot with an empty hand: it ends the spawn protection`,
    );
    this.#core.send(outbound.activateBlock(x, y, z, 1));
    await this.#core.waitFor(() => this.#world.damageDisabled === false, 1_000);
    return this.#world.damageDisabled === false
      ? null
      : `${on}: a click on the ground did not end it`;
  }
}

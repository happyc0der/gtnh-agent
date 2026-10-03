import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { DiggableBlock } from '../../../domain/blocks.ts';
import type { BlockPosition } from '../../../domain/common.ts';
import { BARE_HAND_SPEED, digWaitTicks, instantDig, TICK_MS } from '../../../domain/dig-time.ts';
import {
  bestTool,
  toolInfo,
  toolProblem,
  toolSpeedOn,
  usesLeft,
  type ToolInfo,
} from '../../../domain/tools.ts';
import { isProtected } from '../../../safety/protected-items.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import type { Stack } from '../container.ts';
import { sameStack } from '../crafting.ts';
import {
  checkDig,
  checkDigDown,
  DIG_SETTLE_TICKS,
  eyesOf,
  type DigArea,
  type DigCheck,
} from '../digging.ts';
import { DIG_DROP_SPAWN_RADIUS } from '../drops.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { DIG_STATUS, outbound } from '../packets.ts';
import { nameItemStack } from '../registry.ts';
import { checkSupport, fallDistances, landingHazard } from '../terrain.ts';
import type { Vec3, WalkWorld } from '../walking.ts';
import type { BlockWatch, WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import type { DropRequest } from './drop-actions.ts';
import {
  delay,
  describeGain,
  DROP_WAIT_MS,
  lookAt,
  ON_GROUND,
  SETTLE_TICKS,
  WALK_TICK_MS,
} from './shared.ts';

/** After the finish: how long to wait for the server's verdict on the block. */
const DIG_OUTCOME_TIMEOUT_MS = 2_000;
/**
 * After the block turned to air: a quiet period with no further update for it. Forge sends
 * "air" to the digging player BEFORE it asks mods whether the break may happen, and re-sends
 * the block if one cancels it, so the first "air" alone is not proof.
 */
const DIG_SETTLE_MS = DIG_SETTLE_TICKS * TICK_MS;

/** What a dig holds: hotbar slot `slot`, with `tool` (null: an empty hand) at `damage`. */
interface Hand {
  ok: true;
  slot: number;
  tool: ToolInfo | null;
  damage: number;
  /** Tools for the block that were passed over, and why (or null). */
  note: string | null;
}

const centreOf = (b: BlockPosition): Vec3 => ({ x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 });

/**
 * Digging one block: DIG_BLOCK, DIG_DOWN (the night pit's dig under the feet, then the fall
 * into the hole), and the dig itself, which a walk's breaks make too (digChecked): the hand or
 * tool to hold, the dig time with every tick re-checked, the server's verdict, and the drop.
 */
export class DigActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why digging cannot start now, or null. */
  #digBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.digging.enabled) {
      return { reason: 'digging is disabled (MC_ENABLE_DIGGING)', code: 'NOT_IMPLEMENTED' };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    const area = this.#core.fence();
    if (area.fence === null) return refused(`${area.problem}: digging stays inside the fence`);
    if (!cfg.presenceTicks) return refused('digging needs presence ticks (MC_PRESENCE_TICKS)');
    if (this.#core.haltReason !== null) return refused(`halted: ${this.#core.haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#core.walking) return refused('the player is walking');
    if (this.#core.usingContainer) return refused('a chest or crafting operation is running');
    if (this.#core.digging) return refused('a dig is already in progress');
    if (this.#core.placing) return refused('the player is placing a block');
    if (this.#core.fighting) return refused('the player is fighting');
    return null;
  }

  /**
   * DIG_BLOCK: break one allowlisted block like a player: hold the best allowlisted tool for
   * it (src/domain/tools.ts; else an empty hand), face it, swing the arm, C07 start, the dig
   * time (vanilla x 1.25 + 2 ticks at the tool's verified speed, re-checking everything
   * every tick), C07 finish; a problem on the way sends C07 cancel. Success needs the
   * server's own block change to air, with no re-send after it. Reports the tool used and
   * its uses left, and whether the drop reached the inventory. A drop that did not reach it
   * by itself (it flew off, or stopped on a log or in a hole out of the pickup reach) is
   * fetched as a player would: the client follows the item the server spawned until it lies
   * still, then walks to where it is within the pickup reach (drop-actions.ts collect: an
   * ordinary checked walk inside the fence), or says why it is left there. What earlier digs
   * left lying near, of the same item, is swept up with it.
   */
  async dig(
    target: BlockPosition,
    protectedItems: ReadonlySet<string>,
  ): Promise<ClientActionResult> {
    const dug = await this.#digOnce(target, protectedItems);
    if (dug.drop === null) return dug.result;
    const { itemsBefore, since, tool, collected } = dug.drop;
    const request: DropRequest = {
      origin: centreOf(target),
      spawnRadius: DIG_DROP_SPAWN_RADIUS,
      since,
      itemsBefore,
      // The tool's wear changes its name (`@damage`): that is no drop.
      notDrop: (item) => tool !== null && (item === tool.item || item.startsWith(`${tool.item}@`)),
    };
    // Picked up where it fell, the usual case: nothing of it is left to fetch, and nothing an
    // earlier dig left lies near to sweep up with it.
    const lying = this.#core.drops.lying(request);
    const allIn = collected && (typeof lying === 'string' || lying.length === 0);
    if (allIn && !this.#core.drops.leftoversNear(request.origin)) return dug.result;
    const fetched = await this.#core.drops.collect(request);
    const quiet = collected && fetched.walks === 0 && fetched.left === 0;
    const message = quiet
      ? dug.result.message.replace(
          /the drop reached the inventory: .*$/,
          `the drop reached the inventory: ${describeGain(fetched.gained)}`,
        )
      : `${collected ? dug.result.message : dug.result.message.replace(/; no drop reached.*$/, '')}; ${fetched.note}`;
    return ok(message.slice(0, 500), {
      ...dug.result.data,
      dropCollected: fetched.gained.length > 0,
      drops: describeGain(fetched.gained),
      walkedToDrop: fetched.walks > 0,
      dropsLeft: fetched.left,
    });
  }

  /**
   * DIG_DOWN (the night pit only; approved 2026-10-01): dig the block under the player's own
   * feet, exactly as DIG_BLOCK digs (the best allowed tool or an empty hand, the dig time,
   * every tick re-checked, C07 start/finish, success only on the server's change to air),
   * with digging.ts checkDigDown's rules instead of checkDig's: exactly one block down onto a
   * plain full block, nothing but air, plants and plain blocks around it. Then the player
   * falls onto the block below with vanilla gravity (#fallInto), and the result reports the
   * new feet position. Walking must be allowed: the fall is a move.
   */
  async digDown(
    target: BlockPosition,
    protectedItems: ReadonlySet<string>,
  ): Promise<ClientActionResult> {
    const moving = this.#core.movement.movementBlocker();
    if (moving !== null && this.#opts.config.digging.enabled) {
      return failed(`not digging down: the player falls into the hole, and ${moving}`, 'REFUSED');
    }
    return (await this.#digOnce(target, protectedItems, true)).result;
  }

  /**
   * DIG_DOWN's fall, as a game client would make it (this client does not otherwise simulate
   * physics): the block under the feet is gone, so the player drops straight down with
   * vanilla gravity onto the block below, one block. Only when checkSupport shows nothing
   * holding the player up and the floor exactly at `landY`, with no hazard next to the
   * landing. Then SETTLE_TICKS for a server correction. Null when it landed, else why not.
   */
  async #fallInto(
    landY: number,
    guard: { placementsAtStart: number; healthAtStart: number | null },
  ): Promise<string | null> {
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) return 'block data or position became unknown';
    const support = checkSupport(world, feet);
    if (support.kind !== 'floating' || support.landY !== landY) {
      return support.kind === 'floating'
        ? `the floor is at y=${support.landY ?? 'none'}, not y=${landY}`
        : `the player is still ${support.kind === 'supported' ? 'held up' : 'over unknown blocks'}`;
    }
    const hazard = landingHazard(world, Math.floor(feet.x), landY, Math.floor(feet.z));
    if (hazard !== null) return `the landing is ${hazard}`;
    // Falling is a walk of its own: nothing else may start meanwhile.
    this.#core.walking = true;
    this.#core.movement.stopIdle();
    try {
      const fallen = fallDistances(feet.y - landY);
      for (const [i, d] of fallen.entries()) {
        if (this.#core.phase !== 'play') return 'the connection closed';
        const last = i === fallen.length - 1;
        const pos = { x: feet.x, y: last ? landY : feet.y - d, z: feet.z };
        this.#core.send(
          outbound.playerMove(
            { x: pos.x, feetY: pos.y, z: pos.z, yaw: this.#core.lastYaw, pitch: 0 },
            last,
          ),
        );
        this.#world.setOwnPosition(pos);
        await delay(WALK_TICK_MS);
      }
      // A correction (S08) or a kick arrives within a few ticks of a move the server rejects.
      for (let i = 0; i < SETTLE_TICKS; i++) {
        if (this.#core.phase !== 'play') return 'the connection closed';
        if (this.#core.confirmedPositions !== guard.placementsAtStart) {
          return 'the server corrected the position after the fall';
        }
        this.#core.send(outbound.playerIdle(ON_GROUND));
        await delay(WALK_TICK_MS);
      }
      if (this.#core.confirmedPositions !== guard.placementsAtStart) {
        return 'the server corrected the position after the fall';
      }
      // The feet must be exactly where the fall ended: straight down, on the block below.
      const now = this.#world.ownPosition;
      if (now === null || now.x !== feet.x || now.z !== feet.z || Math.abs(now.y - landY) > 1e-9) {
        return `the feet are not on the landing after the fall (${now === null ? 'unknown' : `${now.x}, ${now.y}, ${now.z}`})`;
      }
      this.#core.log(`fell ${(feet.y - landY).toFixed(2)} blocks into the hole, onto y=${landY}`);
      return null;
    } finally {
      this.#core.walking = false;
      if (this.#core.phase === 'play') this.#core.movement.startIdle();
    }
  }

  /**
   * Items gained since `before`, waiting up to DROP_WAIT_MS for the first one. The tool used
   * (if any) is left out: its wear changes its name (`@damage`), which is not a gain.
   */
  async #dropGain(
    before: Readonly<Record<string, number>>,
    tool: ToolInfo | null,
  ): Promise<Array<[string, number]>> {
    await this.#core.waitFor(() => this.gainSince(before, tool).length > 0, DROP_WAIT_MS);
    return this.gainSince(before, tool);
  }

  /** Items gained since `before`, now (the tool used, if any, left out: see #dropGain). */
  gainSince(
    before: Readonly<Record<string, number>>,
    tool: ToolInfo | null,
  ): Array<[string, number]> {
    const isTool = (item: string): boolean =>
      tool !== null && (item === tool.item || item.startsWith(`${tool.item}@`));
    const now = this.#world.inventoryItems() ?? {};
    return Object.entries(now)
      .filter(([item]) => !isTool(item))
      .map(([item, n]): [string, number] => [item, n - (before[item] ?? 0)])
      .filter(([, d]) => d > 0);
  }

  async #digOnce(
    target: BlockPosition,
    protectedItems: ReadonlySet<string>,
    /** DIG_DOWN: the block under the feet, by checkDigDown's rules, then the fall into it. */
    down = false,
  ): Promise<{
    result: ClientActionResult;
    /**
     * Set when a DIG_BLOCK succeeded with the inventory known: what dig() needs to fetch the
     * drop (the inventory before, when the dig began, the tool used, whether something
     * reached the inventory by itself).
     */
    drop: {
      itemsBefore: Readonly<Record<string, number>>;
      since: Date;
      tool: ToolInfo | null;
      collected: boolean;
    } | null;
  }> {
    const done = (result: ClientActionResult): { result: ClientActionResult; drop: null } => ({
      result,
      drop: null,
    });
    const verb = down ? 'digging down' : 'digging';
    const blocker = this.#digBlocker();
    const fence = this.#core.fence().fence;
    if (blocker !== null || fence === null) {
      return done(
        failed(`not ${verb}: ${blocker?.reason ?? 'no fence'}`, blocker?.code ?? 'REFUSED'),
      );
    }
    const area: DigArea = {
      fence,
      maxHeightAboveFence: this.#opts.config.digging.maxHeightAboveFence,
    };
    /** The rules this dig is checked by, before it starts and every tick (digging.ts). */
    const rule = (world: WalkWorld, at: Vec3): DigCheck =>
      down ? checkDigDown(world, area, at, target) : checkDig(world, area, at, target);
    const where = `(${target.x}, ${target.y}, ${target.z})`;
    // Items that appear after this are the dig's drop (dig() fetches one that is not picked up).
    const since = this.#opts.clock.now();
    this.#core.digging = true;
    try {
      const dug = await this.digChecked(target, rule, protectedItems, verb, null);
      if (!dug.ok) return done(dug.result);
      const { check, hand, held, itemsBefore, ticks, guard } = dug;
      const tool = hand.tool;
      const { x, y, z } = target;

      // DIG_DOWN: the block under the feet is gone; fall onto the one below it at once.
      if (down) {
        const fell = await this.#fallInto(y, guard);
        if (fell !== null) {
          this.#core.log(`dug ${check.block} at ${where}, but did not fall into the hole: ${fell}`);
          return done(
            failed(
              `dug ${check.block} at ${where}, but the fall into the hole failed: ${fell}`,
              'FAILED',
              { x, y, z, block: check.block },
            ),
          );
        }
      }

      // The tool wore by one: the server sends its slot again (a tick or so later).
      const wear = held === null || tool === null ? null : await this.#toolAfterDig(held, tool);
      // The drop spawns in the block's cell and is picked up (after 10 ticks) only when it
      // lands within reach of the player's body; report whether it arrived.
      const gained = itemsBefore === null ? [] : await this.#dropGain(itemsBefore, tool);
      const drops = describeGain(gained);
      const dropCollected = gained.length > 0;
      const used =
        tool === null
          ? `an empty hand${hand.note === null ? '' : ` (${hand.note.slice(0, 120)})`}`
          : `${tool.item} (${wear?.text ?? 'its wear was not seen'})`;
      this.#core.log(
        `dug ${check.block} at ${where} with ${used}; drop ${dropCollected ? drops : 'not collected'}`,
      );
      const now = this.#world.ownPosition;
      const result = ok(
        (
          `dug ${check.block} at ${where} in ${ticks} ticks with ${used}; ` +
          (down && now !== null
            ? `fell into the hole: the feet are at (${now.x}, ${now.y}, ${now.z}); `
            : '') +
          (dropCollected
            ? `the drop reached the inventory: ${drops}`
            : itemsBefore === null
              ? 'the inventory was unknown, so the drop could not be checked'
              : 'no drop reached the inventory (none, or it lies out of pickup reach)')
        ).slice(0, 500),
        {
          x,
          y,
          z,
          block: check.block,
          ticks,
          tool: tool?.item ?? null,
          toolUsesLeft: wear?.usesLeft ?? null,
          ...(hand.note === null ? {} : { toolNote: hand.note.slice(0, 200) }),
          dropCollected,
          drops,
          ...(down && now !== null ? { feetX: now.x, feetY: now.y, feetZ: now.z } : {}),
        },
      );
      // dig() fetches what did not reach the inventory by itself: the drop may stop where the
      // player cannot reach it (seen live: logs dug high in a tree dropped onto the logs and
      // leaves under them). After DIG_DOWN the player falls into the hole with it.
      if (itemsBefore === null || down) return { result, drop: null };
      return { result, drop: { itemsBefore, since, tool, collected: dropCollected } };
    } finally {
      this.#core.digging = false;
    }
  }

  /**
   * The dig itself, as DIG_BLOCK, DIG_DOWN and a walk's breaks all make it (the caller holds
   * core.digging and has checked its blockers). A window left open is closed first (never with a
   * full cursor); `rule` is checked on the latest blocks, the hand chosen (#chooseHand) and
   * `rule` checked again; then it faces the block, swings, sends C07 start, waits the dig time
   * (digWaitTicks at the tool's speed) with `rule`, the guard, the block and the tool in hand
   * re-checked every tick (C07 cancel on any problem), sends C07 finish and takes the server's
   * verdict (#digVerdict: air, and no re-send). The guard is the caller's (a walk's own),
   * else taken just before the start.
   */
  async digChecked(
    target: BlockPosition,
    rule: (world: WalkWorld, at: Vec3) => DigCheck,
    protectedItems: ReadonlySet<string>,
    verb: string,
    callerGuard: { placementsAtStart: number; healthAtStart: number | null } | null,
  ): Promise<
    | { ok: false; result: ClientActionResult }
    | {
        ok: true;
        world: WalkWorld;
        check: Extract<DigCheck, { ok: true }>;
        hand: Hand;
        held: { slot: number; stack: Stack | null } | null;
        itemsBefore: Readonly<Record<string, number>> | null;
        ticks: number;
        guard: { placementsAtStart: number; healthAtStart: number | null };
      }
  > {
    const done = (result: ClientActionResult): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result,
    });
    const where = `(${target.x}, ${target.y}, ${target.z})`;
    // A chest left open by an earlier action is closed first (never with a full cursor).
    if (this.#world.openWindow !== null) {
      const closed = this.#core.inventory.closeOpenWindow();
      if (closed !== null) return done(failed(`not ${verb}: ${closed.message}`, 'REFUSED'));
    }
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) {
      return done(failed(`not ${verb}: block data or position unknown`, 'REFUSED'));
    }
    const first = rule(world, feet);
    if (!first.ok) return done(failed(`not ${verb}: ${first.reason}`, 'REFUSED'));
    // What to hold: the best allowlisted tool for this block that one more use cannot
    // break (src/domain/tools.ts), moved into the hotbar if needed; else an empty hand.
    const hand = await this.#chooseHand(first.block, protectedItems);
    if (!hand.ok) return done(failed(`not ${verb}: ${hand.reason}`, hand.code));
    if (hand.slot !== this.#world.heldSlot) {
      this.#core.send(outbound.selectHotbarSlot(hand.slot));
      this.#world.setHeldSlot(hand.slot);
    }
    const tool = hand.tool;
    // Choosing the hand may have taken a few clicks: check again before starting.
    const check = rule(world, this.#world.ownPosition ?? feet);
    if (!check.ok) return done(failed(`not ${verb}: ${check.reason}`, 'REFUSED'));
    const held =
      tool === null
        ? null
        : { slot: hand.slot, stack: this.#core.inventory.hotbar(hand.slot) ?? null };

    const itemsBefore = this.#world.inventoryItems();
    // A block of hardness 0 (a HarvestCraft garden) breaks on the dig's start: the server's
    // ItemInWorldManager.onBlockClicked harvests it there, and a vanilla client sends no finish.
    const instant = instantDig(check.block);
    const ticks = instant
      ? 0
      : digWaitTicks(check.block, tool === null ? BARE_HAND_SPEED : tool.speed);
    const holding =
      tool === null ? 'an empty hand' : `${tool.item} (${usesLeft(tool, hand.damage)} uses left)`;
    const guard = callerGuard ?? {
      placementsAtStart: this.#core.confirmedPositions,
      healthAtStart: this.#world.health,
    };
    const clock = this.#opts.clock;
    const watch = this.#world.watchBlock(target.x, target.y, target.z);
    const { x, y, z } = target;
    let verdict: { ok: true } | { ok: false; result: ClientActionResult };
    try {
      this.#core.log(`digging ${check.block} at ${where} with ${holding}: ${ticks} ticks`);
      // Face the block, as a player does (other players see where the head points).
      const look = lookAt(eyesOf(feet), centreOf(target));
      this.#core.send(outbound.playerLook(look.yaw, look.pitch, ON_GROUND));
      this.#core.lastYaw = look.yaw;
      const self = this.#world.selfEntityId;
      if (self !== null) this.#core.send(outbound.swingArm(self));
      const startSentAt = watch.updates.length;
      this.#core.send(outbound.digBlock(DIG_STATUS.start, x, y, z, check.face));
      if (instant) {
        // The server's answer to the start is the verdict: air with no re-send, as for a
        // finish (a cancelled break re-sends the block).
        verdict = await this.#digVerdict(watch, startSentAt, check.block, where);
        if (!verdict.ok) return done(verdict.result);
        this.#world.noteDug(target);
        return { ok: true, world, check, hand, held, itemsBefore, ticks, guard };
      }
      const startedAt = clock.now().getTime();
      let tick = 0;
      while (clock.now().getTime() - startedAt < ticks * TICK_MS) {
        await delay(TICK_MS);
        tick += 1;
        // A digging client swings its arm every few ticks; the server shows it to others.
        if (self !== null && tick % 4 === 0 && this.#core.phase === 'play') {
          this.#core.send(outbound.swingArm(self));
        }
        const problem = this.#digProblem(rule, check.blockId, watch, guard, held);
        if (problem !== null) {
          if (this.#core.phase === 'play') {
            this.#core.send(outbound.digBlock(DIG_STATUS.cancel, x, y, z, check.face));
          }
          this.#core.log(`dig stopped: ${problem}`);
          return done(
            failed(`dig of ${check.block} at ${where} stopped: ${problem}`, 'FAILED', {
              x,
              y,
              z,
              block: check.block,
            }),
          );
        }
      }
      const sentAt = watch.updates.length;
      this.#core.send(outbound.digBlock(DIG_STATUS.finish, x, y, z, check.face));
      verdict = await this.#digVerdict(watch, sentAt, check.block, where);
    } finally {
      this.#world.unwatch(watch);
    }
    if (!verdict.ok) return done(verdict.result);
    this.#world.noteDug(target);
    return { ok: true, world, check, hand, held, itemsBefore, ticks, guard };
  }

  /**
   * What to dig `block` with. The fastest tool for it from the allowlist (src/domain/tools.ts)
   * that has no NBT data, is not protected, and that one more use cannot break; at equal
   * speed the one already in hand, then the hotbar, then the main inventory. A tool in the
   * main inventory is first moved into an empty hotbar slot (two confirmed clicks in window
   * 0). With no usable tool, an empty hotbar slot: an empty hand. `note` says which tools
   * for this block were passed over, and why.
   */
  async #chooseHand(
    block: DiggableBlock,
    protectedItems: ReadonlySet<string>,
  ): Promise<Hand | { ok: false; reason: string; code: 'REFUSED' | 'FAILED' | 'ERROR' }> {
    const storage = this.#world.playerStorage();
    const registry = this.#world.registry;
    interface Candidate {
      tool: ToolInfo;
      damage: number;
      /** 0-26 main inventory, 27-35 hotbar (playerStorage order). */
      index: number;
      stack: Stack;
    }
    const candidates: Candidate[] = [];
    const passedOver: string[] = [];
    if (storage !== null && registry !== null) {
      const heldIndex = 27 + this.#world.heldSlot;
      const order = [heldIndex];
      for (let i = 27; i < 36; i++) if (i !== heldIndex) order.push(i);
      for (let i = 0; i < 27; i++) order.push(i);
      for (const index of order) {
        const s = storage[index];
        if (s == null) continue;
        const base = registry.items.get(s.id);
        const tool = base === undefined ? null : toolInfo(base);
        if (tool === null || toolSpeedOn(tool, block) === null) continue;
        const naming = nameItemStack(registry, s.id, s.damage);
        const problem = !naming.ok
          ? `${tool.item}: ${naming.reason}`
          : isProtected(naming.name, protectedItems)
            ? `${tool.item} is a protected item`
            : toolProblem({ tool, damage: s.damage, count: s.count, hasNbt: s.hasNbt }, block);
        if (problem === null) candidates.push({ tool, damage: s.damage, index, stack: s });
        else passedOver.push(problem);
      }
    }
    const note = passedOver.length === 0 ? null : `not used: ${passedOver.slice(0, 2).join('; ')}`;
    const inHotbar = (c: Candidate): boolean => c.index >= 27;
    const use = (c: Candidate, slot: number): Hand => ({
      ok: true,
      slot,
      tool: c.tool,
      damage: c.damage,
      note,
    });

    const best = bestTool(block, candidates, () => true);
    if (best !== null && inHotbar(best)) return use(best, best.index - 27);
    if (best !== null) {
      const free = this.#core.inventory.emptyHotbarSlot();
      if (free !== null) {
        const moved = await this.#core.inventory.moveToHotbar(9 + best.index, free, best.stack);
        if (moved === null) return use(best, free);
        return {
          ok: false,
          reason: `the ${best.tool.item} could not be moved into the hotbar: ${moved}`,
          code: moved.startsWith('ITEMS MAY') ? 'ERROR' : 'FAILED',
        };
      }
      // No room to move it: a slower tool already in the hotbar, else nothing to dig with.
      const slower = bestTool(block, candidates.filter(inHotbar), () => true);
      if (slower !== null) return use(slower, slower.index - 27);
      return {
        ok: false,
        reason: `no empty hotbar slot (to move the ${best.tool.item} into, or to dig with an empty hand)`,
        code: 'REFUSED',
      };
    }
    const empty = this.#core.inventory.emptyHotbarSlot() ?? this.#plainHotbarSlot();
    if (empty === null) {
      return {
        ok: false,
        reason:
          'no empty hotbar slot (with no usable tool for this block, the agent digs with an empty hand)' +
          (note === null ? '' : `; ${note}`),
        code: 'REFUSED',
      };
    }
    return { ok: true, slot: empty, tool: null, damage: 0, note };
  }

  /**
   * With no empty hotbar slot: one holding a plain block item (sand, dirt, a log, a sapling;
   * not a tool, no NBT), the held one first. Digging with it is digging with a bare hand: in
   * 1.7.10 a non-tool item's dig speed is 1 (Item.getDigSpeed), it harvests what a hand
   * harvests, and nothing of it wears or is used (a left click places nothing). Seen live:
   * the hotbar full of sand, dirt, logs and saplings, and every dig of the gravel it had
   * walked to refused: "no empty hotbar slot". Null when none holds such an item.
   */
  #plainHotbarSlot(): number | null {
    const registry = this.#world.registry;
    if (registry === null) return null;
    const blocks = new Set(registry.blocks.values());
    const held = this.#world.heldSlot;
    for (const j of [held, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].filter((k) => k !== held)]) {
      const s = this.#core.inventory.hotbar(j);
      if (s == null || s.hasNbt) continue;
      const name = registry.items.get(s.id) ?? registry.blocks.get(s.id);
      if (name !== undefined && blocks.has(name) && toolInfo(name) === null) return j;
    }
    return null;
  }

  /**
   * After a dig with a tool: waits (up to 1 s) for the server to re-send its slot with one
   * more damage, then describes its state.
   */
  async #toolAfterDig(
    held: { slot: number; stack: Stack | null },
    tool: ToolInfo,
  ): Promise<{ usesLeft: number | null; text: string }> {
    await this.#core.waitFor(
      () => !sameStack(this.#core.inventory.hotbar(held.slot) ?? null, held.stack),
      1_000,
    );
    const now = this.#core.inventory.hotbar(held.slot) ?? null;
    const before = held.stack;
    if (now === null) return { usesLeft: 0, text: 'the tool is gone from its slot' };
    if (before === null || now.id !== before.id || now.hasNbt) {
      return { usesLeft: null, text: 'its slot now holds something else' };
    }
    const left = usesLeft(tool, now.damage);
    const wore = now.damage - before.damage;
    return {
      usesLeft: left,
      text:
        wore === 1
          ? `${left} uses left`
          : `${left} uses left; its damage went from ${before.damage} to ${now.damage}`,
    };
  }

  /**
   * Why work on a block (a dig, a placement) must stop or not start now, or null: the
   * connection, halt(), the stop file, a server correction or a health drop since `guard`
   * was taken, an incomplete entity picture, or a hostile (not a calm spider) or unidentified
   * entity within threatRadius.
   */
  interruption(guard: { placementsAtStart: number; healthAtStart: number | null }): string | null {
    if (this.#core.phase !== 'play') return 'the connection closed';
    const cfg = this.#opts.config;
    if (this.#core.haltReason !== null) return `halted: ${this.#core.haltReason}`;
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return `the stop file ${cfg.movement.stopFile} exists`;
    }
    if (this.#core.confirmedPositions !== guard.placementsAtStart) return this.#core.corrected();
    const health = this.#world.health;
    if (
      !this.#core.starving() &&
      guard.healthAtStart !== null &&
      health !== null &&
      health < guard.healthAtStart
    ) {
      return `health dropped from ${guard.healthAtStart} to ${health}`;
    }
    const now = this.#opts.clock.now();
    if (!this.#world.entitiesReady(now)) {
      return 'the entities around the player are not fully known';
    }
    const threat = this.#world
      .nearbyEntities(cfg.movement.threatRadius, now)
      .find((e) => (e.category === 'hostile' && !e.calm) || e.category === 'unclassified');
    if (threat !== undefined) {
      return `${threat.category} entity ${threat.name} ${threat.distance.toFixed(1)} blocks away`;
    }
    return null;
  }

  /**
   * Why the dig in progress must stop now, or null. Checked every tick, with the dig's own
   * rules (`rule`: checkDig, or checkDigDown for DIG_DOWN).
   */
  #digProblem(
    rule: (world: WalkWorld, feet: Vec3) => DigCheck,
    blockId: number,
    watch: BlockWatch,
    guard: { placementsAtStart: number; healthAtStart: number | null },
    held: { slot: number; stack: Stack | null } | null,
  ): string | null {
    const interrupted = this.interruption(guard);
    if (interrupted !== null) return interrupted;
    // The server digs with whatever is in hand: with a tool, it must stay exactly as it was.
    if (
      held !== null &&
      (this.#world.heldSlot !== held.slot ||
        !sameStack(this.#core.inventory.hotbar(held.slot) ?? null, held.stack))
    ) {
      return 'the tool in hand changed';
    }
    // Any update for the block while digging: the server refused the dig (it re-sends the
    // block), or the block changed. Either way this dig is over.
    if (watch.updates.length > 0) {
      return `the server sent the block again while digging (id ${watch.updates[0]}): the dig was refused or the block changed`;
    }
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) return 'block data or position became unknown';
    const check = rule(world, feet);
    if (!check.ok) return `it is no longer safe to dig: ${check.reason}`;
    if (check.blockId !== blockId) return 'the block changed';
    return null;
  }

  /**
   * After the finish: the server either breaks the block (Forge first sends "air" to the
   * digging player, then the world's own change follows) or re-sends it. Waits for the
   * first update, then for a quiet DIG_SETTLE_MS, and fails on anything but air.
   */
  async #digVerdict(
    watch: BlockWatch,
    sentAt: number,
    block: string,
    where: string,
  ): Promise<{ ok: true } | { ok: false; result: ClientActionResult }> {
    const clock = this.#opts.clock;
    const deadline = clock.now().getTime() + DIG_OUTCOME_TIMEOUT_MS;
    await this.#core.waitFor(() => watch.updates.length > sentAt, DIG_OUTCOME_TIMEOUT_MS);
    let seen = watch.updates.length;
    let quietSince = clock.now().getTime();
    while (seen > sentAt && clock.now().getTime() < deadline) {
      if (clock.now().getTime() - quietSince >= DIG_SETTLE_MS) break;
      await delay(TICK_MS);
      if (watch.updates.length !== seen) {
        seen = watch.updates.length;
        quietSince = clock.now().getTime();
      }
    }
    const after = watch.updates.slice(sentAt);
    const fail = (message: string): { ok: false; result: ClientActionResult } => {
      this.#core.log(message);
      const now = this.#world.blockAt(watch.x, watch.y, watch.z);
      return {
        ok: false,
        result: failed(message, 'FAILED', {
          x: watch.x,
          y: watch.y,
          z: watch.z,
          block,
          airNow: now === 0,
        }),
      };
    };
    if (this.#core.phase !== 'play')
      return fail(`the connection closed after finishing the dig at ${where}`);
    if (after.length === 0) {
      return fail(
        `no block change arrived within ${DIG_OUTCOME_TIMEOUT_MS} ms of finishing the dig at ${where}`,
      );
    }
    if (after.some((id) => id !== 0)) {
      return fail(
        `the server re-sent the block at ${where} after the finish (updates ${after.slice(0, 4).join(', ')}): ` +
          'the dig was judged too early or the break was cancelled. A vanilla server still ' +
          'breaks a too-early dig on its own once its timer reaches 100%.',
      );
    }
    return { ok: true };
  }
}

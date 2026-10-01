import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  attackRefusal,
  BARE_HAND,
  calmRefusal,
  ENGAGE_RADIUS,
  FARM_ANIMALS,
  killStrikeAllowed,
  MAX_BURST_MS,
  MAX_SWINGS_PER_BURST,
  mayExplode,
  mayKill,
  strikeReach,
  SWING_INTERVAL_TICKS,
  type Weapon,
} from '../../../domain/combat.ts';
import { TICK_MS } from '../../../domain/dig-time.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import {
  chooseWeapon,
  dropSpot,
  eyeHeightOf,
  insideFence,
  lineOfSightClear,
  lookAtPoint,
  playerEyes,
  withinPickup,
} from '../combat.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { outbound } from '../packets.ts';
import type { Fence, Vec3 } from '../walking.ts';
import { ENTITY_SCAN_RADIUS, type WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { craftFailed, delay, describeGain, DROP_WAIT_MS, ON_GROUND } from './shared.ts';

/**
 * An ATTACK_ENTITY burst's outcome: the action's result, and the kill when the target died
 * (where it last stood, its type, and the weapon struck with: null for a bare hand).
 */
interface Burst {
  result: ClientActionResult;
  kill: { at: Vec3; type: string; weapon: string | null } | null;
}

/**
 * Fighting: one ATTACK_ENTITY burst (combat.ts, src/domain/combat.ts), and after killing a
 * farm animal, picking up its drops.
 */
export class CombatActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why fighting cannot start now, or null. */
  #combatBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.combat.enabled) {
      return { reason: 'combat is disabled (MC_ENABLE_COMBAT)', code: 'NOT_IMPLEMENTED' };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    const area = this.#core.fence();
    if (area.fence === null) {
      return refused(`${area.problem}: the player and its target stay inside the fence`);
    }
    if (!cfg.presenceTicks) return refused('fighting needs presence ticks (MC_PRESENCE_TICKS)');
    if (this.#core.haltReason !== null) return refused(`halted: ${this.#core.haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#core.walking) return refused('the player is walking');
    if (this.#core.usingContainer) return refused('a chest or crafting operation is running');
    if (this.#core.digging) return refused('the player is digging');
    if (this.#core.placing) return refused('the player is placing a block');
    if (this.#core.exploring) return refused('the player is exploring');
    if (this.#core.questBookBusy) return refused('a quest-book action is running');
    if (this.#core.fighting) return refused('a fight is already in progress');
    return null;
  }

  /** Why this target cannot be engaged (never, not now, or not from here), or null. */
  #targetProblem(entityId: number, fence: Fence): string | null {
    const t = this.#world.combatEntity(entityId, this.#opts.clock.now());
    if (t === null) return `entity ${entityId} is not tracked near the player`;
    const refusal = attackRefusal(t) ?? calmRefusal(t);
    if (refusal !== null) return refusal;
    if (!insideFence(t.position, fence)) return `the ${t.type} is outside the fence`;
    if (t.distance > ENGAGE_RADIUS) {
      return `the ${t.type} is ${t.distance.toFixed(1)} blocks away (engages within ${ENGAGE_RADIUS})`;
    }
    return null;
  }

  /**
   * Why the moment is unsafe for fighting, or null: the entity picture is incomplete, an
   * unidentified entity is within the threat radius, or something that explodes (or might:
   * anything unidentified) is within the scan. Checked before the burst and every tick of it.
   */
  #fightMomentProblem(): string | null {
    const now = this.#opts.clock.now();
    if (!this.#world.entitiesReady(now)) {
      return 'the entities around the player are not fully known';
    }
    const unidentified = this.#world
      .nearbyEntities(this.#opts.config.movement.threatRadius, now)
      .find((e) => e.category === 'unclassified');
    if (unidentified !== undefined) {
      return `unidentified entity ${unidentified.name} ${unidentified.distance.toFixed(1)} blocks away`;
    }
    const explosive = this.#world
      .nearbyEntities(ENTITY_SCAN_RADIUS, now)
      .find(
        (e) =>
          (e.category === 'hostile' || e.category === 'unclassified') &&
          mayExplode(e.name, e.category),
      );
    if (explosive !== undefined) {
      return `${explosive.name} ${explosive.distance.toFixed(1)} blocks away may explode: back off`;
    }
    return null;
  }

  /**
   * ATTACK_ENTITY: engage ONE entity for a bounded burst. The player does not move. It holds
   * the best allowlisted weapon in the hotbar (else an empty hand), and strikes as a player
   * does (C05 look, C0A arm swing, C02 attack) whenever the target is within reach, one full
   * hit per SWING_INTERVAL_TICKS (a mob takes full damage again only 10 ticks after one),
   * until the target dies, MAX_SWINGS_PER_BURST swings, or MAX_BURST_MS. Every tick it stops
   * for: the halt, the stop file, a server correction, a lost connection, ANY damage taken (so
   * System 1 decides again), an unidentified entity or something that may explode nearby, and
   * a target that is gone, out of the fence or out of range. A blow that may kill is held
   * back while the player would not survive GTNH's kill explosion from where it stands.
   * After killing a farm animal it picks up the drops (#collectKillDrops), as a dig does.
   */
  async attack(entityId: number): Promise<ClientActionResult> {
    const blocker = this.#combatBlocker();
    const fence = this.#core.fence().fence;
    if (blocker !== null || fence === null) {
      return failed(`not attacking: ${blocker?.reason ?? 'no fence'}`, blocker?.code ?? 'REFUSED');
    }
    const me = this.#world.ownPosition;
    if (me === null) return failed('not attacking: player position unknown', 'REFUSED');
    if (!insideFence(me, fence))
      return failed('not attacking: the player is outside the fence', 'REFUSED');
    const notTarget = this.#targetProblem(entityId, fence);
    if (notTarget !== null) return failed(`not attacking: ${notTarget}`, 'REFUSED');
    const unsafe = this.#fightMomentProblem();
    if (unsafe !== null) return failed(`not attacking: ${unsafe}`, 'REFUSED');

    const itemsBefore = this.#world.inventoryItems();
    let burst: Burst;
    this.#core.fighting = true;
    try {
      // A window left open by an earlier action is closed first (never with a full cursor).
      if (this.#world.openWindow !== null) {
        const closed = this.#core.inventory.closeOpenWindow();
        if (closed !== null) return failed(`not attacking: ${closed.message}`, 'REFUSED');
      }
      const hotbar = this.#world.hotbar();
      if (hotbar === null) return failed('not attacking: the inventory is not known', 'REFUSED');
      // The best allowlisted weapon in the hotbar, else an empty hand: never anything else
      // (a held item's own left-click code could do anything).
      const choice = chooseWeapon(hotbar, this.#world.heldSlot);
      let slot: number;
      let weapon: Weapon;
      if (choice !== null) {
        slot = choice.slot;
        weapon = choice.weapon;
      } else {
        const hand = this.#core.inventory.emptyHotbarSlot();
        if (hand === null) {
          return failed(
            'not attacking: no allowlisted weapon and no empty hotbar slot to strike with',
            'REFUSED',
          );
        }
        slot = hand;
        weapon = BARE_HAND;
      }
      if (slot !== this.#world.heldSlot) {
        this.#core.send(outbound.selectHotbarSlot(slot));
        this.#world.setHeldSlot(slot);
      }
      burst = await this.#strikeBurst(entityId, fence, weapon);
    } finally {
      this.#core.fighting = false;
    }
    const { result, kill } = burst;
    // Hunting: a farm animal's drops are what it was killed for. Never after a fight with a
    // hostile (DEFEND): walking to its drops is no escape.
    if (!result.ok || kill === null || !FARM_ANIMALS.has(kill.type) || itemsBefore === null) {
      return result;
    }
    return this.#collectKillDrops(result, kill.at, itemsBefore, kill.weapon);
  }

  /**
   * One ATTACK_ENTITY burst (see #attack): the action's result and, when the target died,
   * where it last stood (its drops spawn there), its type and the weapon struck with.
   */
  async #strikeBurst(entityId: number, fence: Fence, weapon: Weapon): Promise<Burst> {
    const clock = this.#opts.clock;
    const first = this.#world.combatEntity(entityId);
    if (first === null) {
      return { result: failed('not attacking: the target is gone', 'REFUSED'), kill: null };
    }
    let lastAt: Vec3 = first.position;
    const what = `${first.type} ${entityId}`;
    const startedAt = clock.now().getTime();
    const deadline = startedAt + MAX_BURST_MS;
    // The held item's damage counts only after the server's next player tick (idle ticks run
    // every 50 ms), so the first swing waits two ticks.
    let nextSwingAt = startedAt + 2 * TICK_MS;
    const healthAtStart = this.#world.health;
    const placementsAtStart = this.#core.confirmedPositions;
    let hurt = first.hurtCount;
    let lastHealth = first.health;
    let swings = 0;
    let heldBack = 0;
    let stop: { reason: string; hard: boolean } | null = null;
    this.#core.log(
      `engaging ${what} with ${weapon.item ?? 'a bare hand'} (${weapon.damage} per hit)`,
    );

    while (stop === null) {
      await delay(TICK_MS);
      const now = clock.now().getTime();
      // Hard stops: the operator, the connection, the server moving the player.
      if (this.#core.phase !== 'play') stop = { reason: 'the connection closed', hard: true };
      else if (this.#core.haltReason !== null)
        stop = { reason: `halted: ${this.#core.haltReason}`, hard: true };
      else if (existsSync(resolvePath(this.#opts.config.movement.stopFile))) {
        stop = {
          reason: `the stop file ${this.#opts.config.movement.stopFile} exists`,
          hard: true,
        };
      } else if (this.#core.confirmedPositions !== placementsAtStart) {
        stop = { reason: this.#core.corrected(), hard: true };
      }
      if (stop !== null) break;
      const t = this.#world.combatEntity(entityId);
      if (t !== null) {
        hurt = Math.max(hurt, t.hurtCount);
        lastHealth = t.health ?? lastHealth;
        lastAt = t.position;
      }
      const health = this.#world.health;
      if (this.#world.hasDied(entityId) || t?.dead === true) {
        stop = { reason: 'the target died', hard: false };
      } else if (t === null) {
        stop = { reason: 'the target is gone', hard: false };
      } else if (healthAtStart !== null && health !== null && health < healthAtStart) {
        stop = { reason: `the player took ${healthAtStart - health} damage`, hard: false };
      } else {
        const moment = this.#fightMomentProblem();
        const target = moment ?? this.#targetProblem(entityId, fence);
        if (target !== null) stop = { reason: target, hard: false };
        else if (swings >= MAX_SWINGS_PER_BURST && now >= nextSwingAt) {
          stop = { reason: `${swings} swings`, hard: false };
        } else if (now >= deadline) {
          stop = { reason: 'the burst is over', hard: false };
        }
      }
      if (stop !== null || t === null || swings >= MAX_SWINGS_PER_BURST || now < nextSwingAt) {
        continue;
      }
      const feet = this.#world.ownPosition;
      if (feet === null) {
        stop = { reason: 'player position unknown', hard: true };
        continue;
      }
      const eyes = playerEyes(feet);
      const aim = { x: t.position.x, y: t.position.y + eyeHeightOf(t.type), z: t.position.z };
      const world = this.#world.walkWorld();
      const sight = world !== null && lineOfSightClear(world, eyes, aim);
      if (t.distance > strikeReach(weapon, sight)) continue; // wait for it to come within reach
      if (mayKill(t.health, weapon) && !killStrikeAllowed(health ?? 0, t.distance)) {
        // GTNH's AngerMod may blow up what a player kills: not from this close, at this health.
        if (heldBack === 0) {
          this.#core.log(
            `holding a blow that may kill the ${t.type} ${t.distance.toFixed(1)} blocks away`,
          );
        }
        heldBack += 1;
        continue;
      }
      const look = lookAtPoint(eyes, aim);
      this.#core.send(outbound.playerLook(look.yaw, look.pitch, ON_GROUND));
      this.#core.lastYaw = look.yaw;
      const self = this.#world.selfEntityId;
      if (self !== null) this.#core.send(outbound.swingArm(self));
      this.#core.send(outbound.attackEntity(entityId));
      swings += 1;
      nextSwingAt = now + SWING_INTERVAL_TICKS * TICK_MS;
    }

    // The answers to the last swing (hurt and death statuses, the new health) take a tick.
    if (swings > 0 && this.#core.phase === 'play') {
      await this.#core.waitFor(() => this.#world.hasDied(entityId), 4 * TICK_MS);
      const t = this.#world.combatEntity(entityId);
      if (t !== null) {
        hurt = Math.max(hurt, t.hurtCount);
        lastHealth = t.health ?? lastHealth;
        lastAt = t.position;
      }
    }
    const killed = this.#world.hasDied(entityId);
    const hits = hurt - first.hurtCount;
    const healthNow = this.#world.health;
    const damageTaken =
      healthAtStart !== null && healthNow !== null ? Math.max(0, healthAtStart - healthNow) : null;
    const reason = stop?.reason ?? 'the burst is over';
    const data = {
      entityId,
      target: first.type,
      weapon: weapon.item,
      swings,
      hits,
      kills: killed ? 1 : 0,
      targetHealthBefore: first.health,
      targetHealthAfter: killed ? 0 : lastHealth,
      damageTaken,
      heldBack,
      stopReason: reason.slice(0, 200),
    };
    this.#core.log(
      `fight with ${what}: ${swings} swing(s), ${hits} hit(s)${killed ? ', killed' : ''}; ${reason}`,
    );
    const summary =
      `${killed ? 'killed' : 'struck'} ${what}: ${swings} swing(s), ${hits} hit(s) seen` +
      `${first.health !== null ? `, health ${first.health} -> ${killed ? 0 : (lastHealth ?? '?')}` : ''}` +
      `${damageTaken !== null && damageTaken > 0 ? `, took ${damageTaken} damage` : ''}; stopped: ${reason}`;
    const kill = killed ? { at: lastAt, type: first.type, weapon: weapon.item } : null;
    if (stop?.hard === true) {
      return { result: craftFailed(`fight stopped: ${summary}`, 'FAILED', data), kill };
    }
    if (hits > 0 || killed) return { result: ok(summary.slice(0, 500), data), kill };
    return { result: craftFailed(`no hit landed on ${what}: ${summary}`, 'FAILED', data), kill };
  }

  /**
   * After killing a farm animal: its drops (raw meat, leather, wool...) spawn where it died,
   * and the player struck from up to 2.2 blocks away with a bare hand (4.5 with an axe), out
   * of the pickup reach (the body's box grown by 1 sideways and 0.5 up and down: the vanilla
   * player's onLivingUpdate). As a dig fetches a drop it cannot reach (#dig), it walks onto the
   * spot the animal died on, or the nearest standable spot beside it, with an ordinary checked
   * walk that stops for threats, then waits for the drops to arrive. The kill stands whatever
   * the walk does; the result says what was picked up.
   */
  async #collectKillDrops(
    result: ClientActionResult,
    at: Vec3,
    itemsBefore: Readonly<Record<string, number>>,
    weapon: string | null,
  ): Promise<ClientActionResult> {
    // A struck weapon wears (its name's @damage changes): that is no drop.
    const isWeapon = (item: string): boolean =>
      weapon !== null && (item === weapon || item.startsWith(`${weapon}@`));
    const gains = (): Array<[string, number]> =>
      this.#core.dig.gainSince(itemsBefore, null).filter(([item]) => !isWeapon(item));
    const where = `(${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)})`;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const fence = this.#core.fence().fence;
    let walked: ClientActionResult | null = null;
    if (world !== null && feet !== null && fence !== null && !withinPickup(feet, at)) {
      const spot = dropSpot(world, fence, at);
      walked =
        spot === null
          ? failed(`no spot a player could stand on at or beside ${where}`, 'REFUSED')
          : await this.#core.movement.walkTo(spot, { stopForThreats: true });
    }
    if (walked === null || walked.ok) {
      await this.#core.waitFor(() => gains().length > 0, DROP_WAIT_MS);
      // Several stacks (meat and leather) arrive a tick or two apart.
      if (gains().length > 0) await delay(5 * TICK_MS);
    }
    const gained = gains();
    const drops = describeGain(gained);
    const how =
      walked === null
        ? gained.length > 0
          ? `picked up ${drops}`
          : 'no drop reached the inventory'
        : !walked.ok
          ? `its drops lie at ${where}, but walking there failed: ${walked.message}`
          : gained.length > 0
            ? `walked to the drops at ${where} and picked up ${drops}`
            : `walked to ${where}, but no drop reached the inventory`;
    this.#core.log(`after the kill: ${how}`);
    return ok(`${result.message}; ${how}`.slice(0, 500), {
      ...result.data,
      dropsCollected: gained.length > 0,
      drops,
      walkedToDrops: walked?.ok ?? false,
    });
  }
}

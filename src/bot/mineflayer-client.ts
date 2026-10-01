import type { Bot } from 'mineflayer';
import type { MinecraftConfig } from '../config/env.ts';
import { assertPrivateDestination } from '../config/network.ts';
import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSchema,
  type GameState,
} from '../domain/game-state.ts';
import { known, unknown } from '../domain/known.ts';
import { assertValidatedAction, type ValidatedAction } from '../domain/validated-action.ts';
import type { Clock } from '../util/clock.ts';
import { failed, ok, type ClientActionResult, type MinecraftClient } from './minecraft-client.ts';

/**
 * SKELETON Mineflayer adapter. Not used by the CLI in milestone 1.
 *
 * COMPATIBILITY WARNING (see docs/gtnh-compatibility.md):
 *  - GTNH is Minecraft 1.7.10 + Forge. The installed mineflayer (4.39) lists 1.8.8 as
 *    its oldest tested version; minecraft-protocol lists "1.7" but has no Forge/FML
 *    handshake. Connecting to a GTNH server is expected to FAIL until a Forge-capable
 *    transport is added and verified.
 *  - Modded items/blocks are not in minecraft-data's vanilla registry. Everything
 *    GTNH-specific is reported as unknown, so the agent fails closed.
 *
 * Safety properties that hold even in this skeleton:
 *  - refuses to connect unless `enableLiveConnection` is true,
 *  - refuses non-private hosts, and hostnames that resolve to non-private addresses,
 *  - performs no world-changing action (every mutating action returns NOT_IMPLEMENTED).
 */
export class MineflayerClient implements MinecraftClient {
  readonly kind = 'mineflayer';
  readonly #config: MinecraftConfig;
  readonly #clock: Clock;
  #bot: Bot | null = null;

  constructor(config: MinecraftConfig, clock: Clock) {
    this.#config = config;
    this.#clock = clock;
  }

  async connect(): Promise<void> {
    const cfg = this.#config;
    if (!cfg.enableLiveConnection) {
      throw new Error(
        'MineflayerClient: live connection is disabled (set MC_ENABLE_LIVE_CONNECTION=true only for a private test world).',
      );
    }
    await assertPrivateDestination(cfg.host, cfg.allowedHostnames);

    // Lazy import keeps mineflayer (and its protocol stack) out of tests and mock runs.
    const mineflayer = await import('mineflayer');
    const bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      auth: cfg.auth,
      version: cfg.version,
      hideErrors: false,
      // TODO(gtnh): Forge 1.7.10 servers need an FML handshake that mineflayer does not
      // implement. Evaluate a Forge-capable transport on a private test server first.
    });
    this.#bot = bot;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Mineflayer spawn timed out')),
        cfg.connectTimeoutMs,
      );
      bot.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      bot.once('kicked', (reason) => {
        clearTimeout(timer);
        reject(new Error(`Kicked: ${String(reason)}`));
      });
      bot.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  disconnect(): Promise<void> {
    this.#bot?.quit('agent disconnect');
    this.#bot = null;
    return Promise.resolve();
  }

  /**
   * Maps only vanilla-observable fields. UNVERIFIED against GTNH. Threat scanning,
   * machines, power and storage are reported unknown, so the safety policy pauses.
   */
  observe(): Promise<GameState> {
    const bot = this.#bot;
    if (bot === null) return Promise.reject(new Error('MineflayerClient is not connected'));

    const p = bot.entity.position;
    const items = bot.inventory.items();
    // Modded items may have no registry name; if so the inventory cannot be trusted.
    const unnamed = items.some((i) => typeof i.name !== 'string' || i.name.length === 0);
    const counts: Record<string, number> = {};
    for (const i of items) {
      const name = `minecraft:${i.name}${i.metadata ? `@${i.metadata}` : ''}`;
      counts[name] = (counts[name] ?? 0) + i.count;
    }

    const state: GameState = {
      schemaVersion: GAME_STATE_SCHEMA_VERSION,
      timestamp: this.#clock.now().toISOString(),
      source: 'mineflayer',
      player: {
        position: known({ x: p.x, y: p.y, z: p.z }),
        dimension: known(normalizeDimension(bot.game.dimension)),
        health: known(bot.health),
        hunger: known(bot.food),
        armor: unknown('TODO: armor mapping not implemented'),
        heldTool: unknown('TODO: held tool mapping not implemented'),
      },
      inventory: unnamed
        ? unknown('inventory contains items without a known registry name (modded?)')
        : known({ items: counts, usedSlots: items.length, capacitySlots: 36 }),
      nearbyThreats: unknown('TODO: entity scan not implemented or verified for GTNH'),
      environmentHazards: unknown('TODO: lava/void scan not implemented or verified for GTNH'),
      time: unknown('the Mineflayer adapter does not read the world clock'),
      nearbyBlocks: unknown('block scan not implemented for Mineflayer'),
      questBook: unknown('the Mineflayer adapter does not read the quest book'),
      power: {
        availableEUt: unknown('GTNH EU is not observable via the vanilla protocol'),
        generators: [],
      },
      machines: [],
      storage: [],
      craftingTables: [],
      openContainerId: null,
      currentTask: null,
      knownRecipeState: null,
      lastAction: null,
    };
    return Promise.resolve(GameStateSchema.parse(state));
  }

  perform(validated: ValidatedAction): Promise<ClientActionResult> {
    assertValidatedAction(validated);
    if (this.#bot === null) return Promise.resolve(failed('not connected', 'ERROR'));
    const action = validated.action;
    switch (action.type) {
      case 'OBSERVE_STATE':
        return Promise.resolve(ok('observation is taken by the executor after every action'));
      case 'WAIT':
        return new Promise((resolve) =>
          setTimeout(
            () => resolve(ok(`waited ${action.args.durationMs} ms`)),
            action.args.durationMs,
          ),
        );
      case 'PAUSE_AND_ASK_USER':
        // Deliberately not sent as in-game chat: user notification is the agent's job.
        return Promise.resolve(ok('pause recorded', { acknowledged: true }));
      // TODO(movement): mineflayer-pathfinder with a movement config that forbids digging,
      //   block placement, parkour and fluids; verify on a private test world first.
      // TODO(containers): modded container GUIs (GT, AE2, etc.) need per-mod window adapters.
      // TODO(machines): GT machine state is not exposed via the vanilla protocol; needs research.
      case 'MOVE_TO':
      case 'RETURN_TO_SAFE_LOCATION':
      case 'EAT_FOOD':
      case 'OPEN_CONTAINER':
      case 'DEPOSIT_ITEM':
      case 'WITHDRAW_ITEM':
      case 'INSPECT_MACHINE':
      case 'REFUEL_KNOWN_GENERATOR':
      case 'DIG_BLOCK':
      case 'CRAFT_ITEM':
        return Promise.resolve(
          failed(`${action.type} is not implemented for Mineflayer yet`, 'NOT_IMPLEMENTED'),
        );
    }
  }
}

function normalizeDimension(raw: unknown): string {
  // 1.7.10 uses numeric dimension IDs; newer versions use names.
  const byId: Record<string, string> = { '0': 'overworld', '-1': 'the_nether', '1': 'the_end' };
  const s = String(raw);
  return byId[s] ?? s.replace(/^minecraft:/, '');
}

import { isPlaceableItem, PLACEABLE_ITEMS } from '../../domain/blocks.ts';
import { MAX_EXPLORE_DISTANCE, MIN_EXPLORE_DISTANCE } from '../../domain/actions.ts';
import { compact, type Cli } from './cli-context.ts';
import {
  movementStatus,
  parseBlockPosition,
  parseExploreToward,
  runLiveAttack,
  runLiveChest,
  runLiveDig,
  runLivePlace,
  runLiveExplore,
  runLiveInteract,
  runLiveMove,
  summarizeObservation,
  watchLive,
  withLiveClient,
} from './live-commands.ts';

/**
 * The CLI's live commands (src/app/cli.ts): what the agent sees on the test server (observe,
 * watch), and single checked actions a human asks for there (move, explore, chest, dig,
 * place, interact, attack). Each needs --live to confirm.
 */

/** `observe --live`: what the agent can observe, and a map of the movement fence. */
export async function observeCommand(cli: Cli): Promise<number> {
  const { values, config, print, log } = cli;
  if (!values.live) {
    process.stderr.write(
      'observe connects to the configured test server; pass --live to confirm.\n',
    );
    return 1;
  }
  const radius = Math.max(1, Math.min(128, Number(values.radius) || 16));
  const { summary, map } = await withLiveClient(
    config,
    async (client) => ({
      summary: {
        ...summarizeObservation(
          await client.observe(),
          client.info(),
          client.world.nearbyEntities(radius),
          radius > 32 ? client.world.diagnosticHazardScan(radius) : null,
          client.world.trackedMachines(),
        ),
        movement: movementStatus(config),
      },
      map: client.previewWalk(null)?.map ?? [],
    }),
    log,
  );
  print(summary);
  if (map.length > 0) process.stdout.write(`\n${map.join('\n')}\n`);
  return 0;
}

/** `move --live --to <x,y,z | location>`: one checked walk (or, with --dry-run, its plan). */
export async function moveCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  if (!values.live) {
    process.stderr.write('move walks on the configured test server; pass --live to confirm.\n');
    return 1;
  }
  if (values.to === undefined) {
    process.stderr.write('move requires --to <x,y,z | location name>\n');
    return 1;
  }
  const tolerance = Number(values.tolerance);
  if (!Number.isFinite(tolerance)) {
    process.stderr.write('--tolerance must be a number\n');
    return 1;
  }
  const out = await runLiveMove(config, dbPath, values.to, {
    tolerance,
    dryRun: values['dry-run'],
    ...(log ? { log } : {}),
  });
  print(
    out.result === null
      ? { dryRun: true, plan: out.plan }
      : values.full
        ? { result: out.result, connection: out.info }
        : compact('live-move', dbPath, out.result),
  );
  const maps = [
    ...(out.mapBefore.length > 0 ? ['', 'Before (planned path):', ...out.mapBefore] : []),
    ...(out.mapAfter.length > 0 ? ['', 'After:', ...out.mapAfter] : []),
  ];
  if (maps.length > 0) process.stdout.write(`${maps.join('\n')}\n`);
  if (out.result === null) return out.plan?.ok === true ? 0 : 1;
  return out.result.status === 'succeeded' ? 0 : 1;
}

/** `explore --live --toward <direction | x,z>`: one checked EXPLORE, and what world memory knows. */
export async function exploreCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  if (!values.live) {
    process.stderr.write('explore walks on the configured test server; pass --live to confirm.\n');
    return 1;
  }
  const toward = values.toward === undefined ? null : parseExploreToward(values.toward);
  if (toward === null) {
    process.stderr.write(
      'explore requires --toward <direction | x,z>: north, north_east, east, south_east, ' +
        'south, south_west, west, north_west, or a point such as 120,-40\n',
    );
    return 1;
  }
  const distance = Number(values.distance);
  if (
    !Number.isInteger(distance) ||
    distance < MIN_EXPLORE_DISTANCE ||
    distance > MAX_EXPLORE_DISTANCE
  ) {
    process.stderr.write(
      `--distance must be a whole number from ${MIN_EXPLORE_DISTANCE} to ${MAX_EXPLORE_DISTANCE}\n`,
    );
    return 1;
  }
  const out = await runLiveExplore(config, dbPath, toward, distance, log);
  print({
    ...(values.full
      ? { result: out.result, connection: out.info }
      : compact('live-explore', dbPath, out.result)),
    worldMemory: out.exploration,
  });
  return out.result.status === 'succeeded' ? 0 : 1;
}

/** `watch --live`: stays connected (read-only) and prints what the agent sees every few seconds. */
export async function watchCommand(cli: Cli): Promise<number> {
  const { values, config, log } = cli;
  if (!values.live) {
    process.stderr.write('watch connects to the configured test server; pass --live to confirm.\n');
    return 1;
  }
  const seconds = Math.max(1, Math.min(3600, Number(values.seconds) || 60));
  const every = Math.max(1, Math.min(60, Number(values.every) || 5));
  await watchLive(config, seconds, every, (line) => process.stdout.write(`${line}\n`), log);
  return 0;
}

/** `chest --live --container <id>`: opens a configured chest, and optionally moves items. */
export async function chestCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  if (!values.live) {
    process.stderr.write('chest uses the configured test server; pass --live to confirm.\n');
    return 1;
  }
  if (values.container === undefined) {
    process.stderr.write('chest requires --container <id>\n');
    return 1;
  }
  if (values.withdraw !== undefined && values.deposit !== undefined) {
    process.stderr.write('use either --withdraw or --deposit, not both\n');
    return 1;
  }
  const quantity = Number(values.count);
  if (!Number.isInteger(quantity) || quantity < 1) {
    process.stderr.write('--count must be a positive whole number\n');
    return 1;
  }
  const item = values.withdraw ?? values.deposit;
  const out = await runLiveChest(
    config,
    dbPath,
    values.container,
    item === undefined
      ? null
      : { direction: values.withdraw !== undefined ? 'withdraw' : 'deposit', item, quantity },
    log,
  );
  print({
    actions: out.results.map((r) => (values.full ? r : compact('live-chest', dbPath, r))),
    chest: out.chest,
    inventory: out.inventory,
  });
  return out.results.every((r) => r.status === 'succeeded') ? 0 : 1;
}

/** `dig --live --at <x,y,z>`: breaks one allowlisted block, as a checked user action. */
export async function digCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  if (!values.live) {
    process.stderr.write('dig breaks a block on the test server; pass --live to confirm.\n');
    return 1;
  }
  const at = values.at === undefined ? null : parseBlockPosition(values.at);
  if (at === null) {
    process.stderr.write(
      'dig requires --at <x,y,z> (whole-block coordinates; use --at=-8,200,-11 for negatives)\n',
    );
    return 1;
  }
  const out = await runLiveDig(config, dbPath, at, log);
  print({
    action: values.full
      ? { result: out.result, connection: out.info }
      : compact('live-dig', dbPath, out.result),
    diggable: out.diggable,
    inventory: out.inventory,
  });
  return out.result.status === 'succeeded' ? 0 : 1;
}

/** `place --live --at <x,y,z> --item <item>`: places one allowlisted block it carries. */
export async function placeCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  if (!values.live) {
    process.stderr.write('place puts a block on the test server; pass --live to confirm.\n');
    return 1;
  }
  const at = values.at === undefined ? null : parseBlockPosition(values.at);
  if (at === null || values.item === undefined || !isPlaceableItem(values.item)) {
    process.stderr.write(
      'place requires --at <x,y,z> (whole-block coordinates; use --at=-8,200,-11 for ' +
        `negatives) and --item, one of: ${PLACEABLE_ITEMS.join(', ')}\n`,
    );
    return 1;
  }
  const out = await runLivePlace(config, dbPath, at, values.item, log);
  print({
    action: values.full
      ? { result: out.result, connection: out.info }
      : compact('live-place', dbPath, out.result),
    placing: out.placing,
    inventory: out.inventory,
  });
  return out.result.status === 'succeeded' ? 0 : 1;
}

/** `interact --live --at <x,y,z>`: opens a block, and optionally smelts in it or takes its output. */
export async function interactCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  if (!values.live) {
    process.stderr.write('interact opens a block on the test server; pass --live to confirm.\n');
    return 1;
  }
  const at = values.at === undefined ? null : parseBlockPosition(values.at);
  if (at === null) {
    process.stderr.write('interact requires --at <x,y,z> (use --at=-8,200,-11 for negatives)\n');
    return 1;
  }
  if (values.smelt !== undefined && values.take !== undefined) {
    process.stderr.write('use either --smelt or --take, not both\n');
    return 1;
  }
  const quantity = Number(values.count);
  const fuelQuantity = Number(values['fuel-count']);
  if (values.smelt !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
    process.stderr.write('--count must be a positive whole number\n');
    return 1;
  }
  if (!Number.isInteger(fuelQuantity) || fuelQuantity < 0) {
    process.stderr.write('--fuel-count must be a whole number (0 adds no fuel)\n');
    return 1;
  }
  if (values.smelt !== undefined && fuelQuantity > 0 && values.fuel === undefined) {
    process.stderr.write('--fuel-count needs --fuel <item>\n');
    return 1;
  }
  const out = await runLiveInteract(
    config,
    dbPath,
    at,
    values.smelt !== undefined
      ? {
          kind: 'smelt',
          input: values.smelt,
          quantity,
          fuel: values.fuel ?? values.smelt,
          fuelQuantity,
        }
      : values.take !== undefined
        ? { kind: 'take', item: values.take }
        : null,
    log,
  );
  print({
    actions: out.results.map((r) => (values.full ? r : compact('live-interact', dbPath, r))),
    window: out.window,
    interactables: out.interactables,
    inventory: out.inventory,
  });
  return out.results.every((r) => r.status === 'succeeded') ? 0 : 1;
}

/** `attack --live --entity <id>`: strikes one creature for a short burst, as a checked user action. */
export async function attackCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  if (!values.live) {
    process.stderr.write('attack strikes a creature on the test server; pass --live to confirm.\n');
    return 1;
  }
  const entityId = Number(values.entity);
  if (values.entity === undefined || !Number.isInteger(entityId)) {
    process.stderr.write(
      'attack requires --entity <id> (an entity id from observe --live, e.g. --entity=1234)\n',
    );
    return 1;
  }
  const out = await runLiveAttack(config, dbPath, entityId, log);
  print({
    action: values.full
      ? { result: out.result, connection: out.info }
      : compact('live-attack', dbPath, out.result),
    health: out.health,
    combat: out.entities,
  });
  return out.result.status === 'succeeded' ? 0 : 1;
}

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { runLiveAttack } from '../../../src/app/commands/live-commands.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import type { FakeMob } from './fixtures/fake-combat.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5); the fence is the digging tests' pen.
const FEET_Y = 106;
const FENCE = { min: { x: -9, y: FEET_Y, z: -12 }, max: { x: -1, y: FEET_Y, z: -4 } };
const ITEMS: Array<[number, string]> = [
  [297, 'minecraft:bread'],
  [258, 'minecraft:iron_axe'],
  [267, 'minecraft:iron_sword'],
];
/** A creature `d` blocks east of the player (same level). */
const east = (d: number) => ({ x: -4.5 + d, y: FEET_Y, z: -7.5 });
const zombie = (entityId: number, d: number, health = 20, extra: Partial<FakeMob> = {}) => ({
  entityId,
  mobType: 54,
  ...east(d),
  health,
  ...extra,
});

let dir = '';
let stopFile = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-combat-'));
  stopFile = join(dir, 'STOP');
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(server: FakeServerOptions = {}, enabled = true) {
  const fake = new FakeGtnhServer({ items: ITEMS, inventory: [], ...server });
  servers.push(fake);
  const config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port: await fake.listen(),
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      movement: { enabled: true, fence: FENCE, stopFile },
      combat: { enabled },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { server: fake, client, config };
}

const ids = sequentialIds();
function attack(client: Gtnh1710Client, entityId: number) {
  const spec: ActionSpec = { type: 'ATTACK_ENTITY', args: { entityId } };
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}
const attackPackets = (server: FakeGtnhServer) =>
  server.playPacketIds().filter((id) => id === 0x02);

describe('Gtnh1710Client fighting', () => {
  it('is off unless enabled, and then sends nothing', async () => {
    const { server, client } = await start({ combat: { mobs: [zombie(301, 2)] } }, false);
    expect(await attack(client, 301)).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
    expect(attackPackets(server)).toEqual([]);
  });

  it('observes creatures with health, owner and age, and what it would strike with', async () => {
    const { client } = await start({
      combat: {
        mobs: [
          zombie(301, 2, 17),
          { entityId: 302, mobType: 92, ...east(4), health: 10, age: 0 },
          { entityId: 303, mobType: 92, ...east(5), health: 10, age: -24000 },
          { entityId: 304, mobType: 92, ...east(6), health: 10, age: 0, customName: 'Bessie' },
        ],
      },
    });
    const state = await client.observe();
    if (!state.nearbyEntities.known) throw new Error(state.nearbyEntities.reason);
    expect(
      state.nearbyEntities.value.entities.map((e) => [e.id, e.type, e.health, e.owned, e.baby]),
    ).toEqual([
      [301, 'minecraft:Zombie', 17, null, null],
      [302, 'minecraft:Cow', 10, false, false],
      [303, 'minecraft:Cow', 10, false, true],
      [304, 'minecraft:Cow', 10, true, false],
    ]);
    expect(JSON.stringify(state)).not.toContain('Bessie'); // name tags never reach the state
    expect(state.player.weapon).toEqual({ known: true, value: { item: null, damage: 1 } });
  });

  it('kills a weak zombie with a bare hand: look, swing, attack; the death is seen', async () => {
    const { server, client } = await start({ combat: { mobs: [zombie(301, 2, 1)] } });
    const result = await attack(client, 301);
    expect(result).toMatchObject({
      ok: true,
      data: { entityId: 301, target: 'minecraft:Zombie', weapon: null, hits: 1, kills: 1 },
    });
    expect(result.message).toMatch(/killed minecraft:Zombie 301/);
    expect(server.combatSim.attacks).toEqual([
      expect.objectContaining({ entityId: 301, heldItem: null, outcome: 'hit' }),
    ]);
    // Like a player: it faced the target, swung its arm, then attacked.
    const play = server.playPacketIds().filter((id) => [0x02, 0x05, 0x0a].includes(id));
    expect(play).toEqual([0x05, 0x0a, 0x02]);
    const state = await client.observe();
    if (!state.nearbyEntities.known) throw new Error(state.nearbyEntities.reason);
    expect(state.nearbyEntities.value.recentDeaths).toMatchObject([
      { id: 301, type: 'minecraft:Zombie' },
    ]);
    expect(state.nearbyEntities.value.entities).toEqual([]);
    // Only allowed packets: keep-alive, idle ticks, look, echoes, hotbar, swing, attack, FML.
    expect(
      server
        .playPacketIds()
        .every((id) => [0x00, 0x02, 0x03, 0x05, 0x06, 0x09, 0x0a, 0x17].includes(id)),
    ).toBe(true);
  }, 15_000);

  it('walks to where a cow died and picks up its drops: a farm animal is killed for them', async () => {
    const { server, client } = await start({
      items: [...ITEMS, [363, 'minecraft:beef'], [334, 'minecraft:leather']],
      combat: {
        mobs: [
          {
            entityId: 401,
            mobType: 92,
            ...east(2),
            health: 1,
            age: 0,
            drops: [
              { item: 'minecraft:beef', count: 2 },
              { item: 'minecraft:leather', count: 1 },
            ],
          },
        ],
      },
    });
    const result = await attack(client, 401);
    expect(result).toMatchObject({
      ok: true,
      data: {
        target: 'minecraft:Cow',
        kills: 1,
        dropsCollected: true,
        walkedToDrops: true,
        dropsLeft: 0,
      },
    });
    // The drops came to rest 2 blocks away, beyond a player's pickup reach (1.4): it followed
    // the items there, and walked onto the block they lay in.
    expect(result.message).toMatch(
      /walked to the drops at \(-3, 106, -8\) and picked up 2 x minecraft:beef, 1 x minecraft:leather/,
    );
    expect(server.walkSteps().at(-1)).toMatchObject({ x: -2.5, feetY: 106, z: -7.5 });
    expect(server.combatSim.pickedUp).toEqual(
      expect.arrayContaining([
        { item: 'minecraft:beef', count: 2 },
        { item: 'minecraft:leather', count: 1 },
      ]),
    );
    expect((await client.observe()).inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:beef': 2, 'minecraft:leather': 1 } },
    });
  }, 15_000);

  it('never walks to the drops of a hostile it killed (that is no escape)', async () => {
    const { server, client } = await start({
      items: [...ITEMS, [367, 'minecraft:rotten_flesh']],
      combat: {
        mobs: [zombie(301, 2, 1, { drops: [{ item: 'minecraft:rotten_flesh', count: 1 }] })],
      },
    });
    const result = await attack(client, 301);
    expect(result).toMatchObject({ ok: true, data: { kills: 1 } });
    expect(result.data).not.toHaveProperty('walkedToDrops');
    expect(server.combatSim.pickedUp).toEqual([]);
  }, 10_000);

  it('holds the best axe in the hotbar and strikes once per hurt-resistance window', async () => {
    const { server, client } = await start({
      inventory: [
        { slot: 36, id: 297, count: 2, damage: 0 },
        { slot: 37, id: 267, count: 1, damage: 0 }, // a sword: deals nothing on GTNH
        { slot: 38, id: 258, count: 1, damage: 30 }, // a worn iron axe
      ],
      combat: { mobs: [zombie(301, 2, 12)], weaponDamage: { 258: 6 }, swordIds: [267] },
    });
    expect((await client.observe()).player.weapon).toEqual({
      known: true,
      value: { item: 'minecraft:iron_axe', damage: 6 },
    });
    const result = await attack(client, 301);
    expect(result).toMatchObject({
      ok: true,
      data: { weapon: 'minecraft:iron_axe', hits: 2, kills: 1, targetHealthBefore: 12 },
    });
    expect(server.chestSim.heldSlot).toBe(2);
    const hits = server.combatSim.attacks;
    expect(hits.map((a) => [a.heldItem, a.outcome])).toEqual([
      [258, 'hit'],
      [258, 'hit'],
    ]);
    // A mob takes full damage again only 10 ticks after a hit: the agent waits 12.
    expect((hits[1]?.at ?? 0) - (hits[0]?.at ?? 0)).toBeGreaterThanOrEqual(550);
  }, 15_000);

  it('never strikes with a sword: with nothing else, an empty hand', async () => {
    const { server, client } = await start({
      inventory: [{ slot: 36, id: 267, count: 1, damage: 0 }],
      combat: { mobs: [zombie(301, 2, 1)], swordIds: [267] },
    });
    expect(await attack(client, 301)).toMatchObject({ ok: true, data: { weapon: null } });
    expect(server.combatSim.attacks.map((a) => a.heldItem)).toEqual([null]);
    expect(server.chestSim.heldSlot).not.toBe(0);
  }, 15_000);

  it('refuses before sending anything', async () => {
    const { server, client } = await start({
      entities: [
        { kind: 'player', entityId: 401, name: 'Someone', ...east(2) },
        { kind: 'modded', entityId: 402, modId: 'etfuturum', typeId: 3, ...east(3) },
      ],
      combat: {
        mobs: [
          { entityId: 403, mobType: 120, ...east(2), health: 20 }, // a villager
          { entityId: 404, mobType: 92, ...east(2), health: 10, age: 0, customName: 'Bessie' },
          { entityId: 405, mobType: 92, ...east(2), health: 10, age: -100 },
          zombie(407, 5.2), // x = 0.7: outside the fence's columns
        ],
      },
    });
    const refusals: Array<[number, RegExp]> = [
      [401, /is a player/],
      [402, /etfuturum#3 is not identified/],
      [403, /minecraft:Villager is not a farm animal/],
      [404, /belongs to someone/],
      [405, /is a baby/],
      [407, /outside the fence/],
      [999, /not tracked/],
    ];
    for (const [id, reason] of refusals) {
      const r = await attack(client, id);
      expect(r, reason.source).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    }
    expect(attackPackets(server)).toEqual([]);
  }, 15_000);

  it('refuses to fight with a creeper or an unidentified entity near, or when stopped', async () => {
    const creeper = await start({
      combat: { mobs: [zombie(301, 2), { entityId: 302, mobType: 50, ...east(-8), health: 20 }] },
    });
    expect((await attack(creeper.client, 302)).message).toMatch(
      /minecraft:Creeper explodes: the agent backs off/,
    );
    expect((await attack(creeper.client, 301)).message).toMatch(
      /minecraft:Creeper 8.0 blocks away may explode: back off/,
    );
    expect(attackPackets(creeper.server)).toEqual([]);

    const { server, client } = await start({
      entities: [{ kind: 'modded', entityId: 402, modId: 'etfuturum', typeId: 3, ...east(-3) }],
      combat: { mobs: [zombie(301, 2)] },
    });
    expect((await attack(client, 301)).message).toMatch(/unidentified entity etfuturum#3/);
    writeFileSync(stopFile, 'stop');
    expect((await attack(client, 301)).message).toMatch(/stop file .* exists/);
    unlinkSync(stopFile);
    client.halt('operator said stop');
    expect((await attack(client, 301)).message).toMatch(/halted: operator said stop/);
    expect(attackPackets(server)).toEqual([]);
  }, 15_000);

  it('the observation says when the player last lost health (a danger with a hostile about)', async () => {
    const { server, client } = await start({ combat: { mobs: [] } });
    expect((await client.observe()).player.lastHurtAt).toBeNull();
    const before = Date.now();
    server.combatSim.hurtPlayer(3);
    await vi.waitFor(async () => {
      const at = (await client.observe()).player.lastHurtAt;
      expect(at).not.toBeNull();
      expect(Date.parse(at ?? '')).toBeGreaterThanOrEqual(before - 1000);
    });
  });

  it('waits for a zombie to come within reach, and stops as soon as the player is hit', async () => {
    // 4.4 blocks west: out of reach, but inside the fence from the start (a target outside
    // the fence is refused, and under load the fake mob's first steps may come late).
    const { server, client } = await start({
      combat: { mobs: [zombie(301, -4.4, 20, { chase: { speed: 0.12, damage: 3 } })] },
    });
    const result = await attack(client, 301);
    expect(result, result.message).toMatchObject({ ok: true, data: { kills: 0, damageTaken: 3 } });
    expect(result.data['hits']).toBeGreaterThanOrEqual(1);
    expect(result.message).toMatch(/stopped: the player took 3 damage/);
    // Every strike was within a bare hand's reach (Battlegear2 cancels beyond 2.3).
    expect(server.combatSim.attacks.every((a) => a.outcome === 'hit')).toBe(true);
  }, 15_000);

  it('stops when a creeper comes near during the fight', async () => {
    const { server, client } = await start({
      inventory: [{ slot: 36, id: 258, count: 1, damage: 0 }],
      combat: { mobs: [zombie(301, 2, 40)], weaponDamage: { 258: 6 } },
    });
    const fighting = attack(client, 301);
    await vi.waitFor(() => expect(server.combatSim.attacks.length).toBeGreaterThanOrEqual(1));
    server.combatSim.spawn({ entityId: 302, mobType: 50, ...east(-9), health: 20 });
    const result = await fighting;
    expect(result).toMatchObject({ ok: true, data: { kills: 0 } });
    expect(result.message).toMatch(/minecraft:Creeper .* may explode: back off/);
  }, 15_000);

  it('holds a blow that may kill while the kill explosion would hurt too much', async () => {
    // One health left, one block away: a kill explosion there deals 21 on Hard. The agent
    // holds the blow; once the zombie is 2 blocks away (9 damage at worst) it strikes.
    const { server, client } = await start({ combat: { mobs: [zombie(301, 1, 1)] } });
    const fighting = attack(client, 301);
    await new Promise((r) => setTimeout(r, 800));
    expect(attackPackets(server)).toEqual([]);
    server.combatSim.moveMob(301, east(2).x, east(2).y, east(2).z);
    const result = await fighting;
    expect(result).toMatchObject({ ok: true, data: { kills: 1 } });
    expect(result.data['heldBack']).toBeGreaterThan(0);
  }, 15_000);

  it("survives GTNH's kill explosion and reports the damage it took", async () => {
    const { server, client } = await start({
      combat: { mobs: [zombie(301, 2, 1)], kamikaze: true },
    });
    const result = await attack(client, 301);
    expect(server.combatSim.explosions).toEqual([expect.objectContaining({ playerDamage: 9 })]);
    expect(result).toMatchObject({ ok: true, data: { kills: 1, damageTaken: 9 } });
    expect((await client.observe()).player.health).toEqual({ known: true, value: 11 });
  }, 15_000);

  it('goes through the executor: validated, struck and verified (ENTITY_ATTACKED)', async () => {
    const { client, config } = await start({ combat: { mobs: [zombie(301, 2, 1)] } });
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    const deps = {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: null,
      clock: systemClock,
      newId: sequentialIds(),
    };
    const done = await runUserAction(
      deps,
      { type: 'ATTACK_ENTITY', args: { entityId: 301 } },
      'test',
    );
    expect(done.status).toBe('succeeded');
    expect(
      done.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(['PASS execution-ok', 'PASS observation-fresh', 'PASS entity-attacked']);
    // It is dead: the policy now refuses another attack as a stale step.
    expect(
      (await runUserAction(deps, { type: 'ATTACK_ENTITY', args: { entityId: 301 } }, 'test'))
        .summary,
    ).toMatch(/rejected \[TARGET_GONE\]/);
  }, 15_000);

  it('cli attack: one operator-requested strike, checked and verified', async () => {
    const fake = new FakeGtnhServer({
      items: ITEMS,
      inventory: [],
      combat: {
        mobs: [zombie(301, 2, 1), { entityId: 302, mobType: 92, ...east(3), health: 10, age: 0 }],
      },
    });
    servers.push(fake);
    const config = defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port: await fake.listen(),
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
        movement: { enabled: true, fence: FENCE, stopFile },
        combat: { enabled: true },
      },
    });
    const out = await runLiveAttack(config, IN_MEMORY, 301);
    expect(out.result.status).toBe('succeeded');
    expect(out.entities).toMatchObject({
      weapon: 'bare hand (1 per full hit)',
      nearest: ['#302 minecraft:Cow 3.0 m, health 10, attackable'],
      recentDeaths: [expect.stringMatching(/^#301 minecraft:Zombie at /)],
    });
    // An id that is not near the player: refused by the policy, nothing is sent.
    const before = fake.combatSim.attacks.length;
    const unknownTarget = await runLiveAttack(config, IN_MEMORY, 999);
    expect(unknownTarget.result.summary).toMatch(/rejected \[TARGET_GONE\]/);
    expect(fake.combatSim.attacks).toHaveLength(before);
  }, 20_000);

  it('walking, chests and digging wait while a fight runs', async () => {
    const { server, client } = await start({
      combat: { mobs: [zombie(301, 2, 20, { chase: { speed: 0.01, damage: 0 } })] },
    });
    const fighting = attack(client, 301);
    await vi.waitFor(() => expect(server.combatSim.attacks.length).toBe(1));
    const walk = await client.perform(
      mintValidatedAction(
        createAction(
          {
            spec: {
              type: 'MOVE_TO',
              args: { target: { x: -6.5, y: FEET_Y, z: -8.5 }, tolerance: 0.5 },
            },
            reason: 'test',
            origin: 'test',
            taskId: null,
          },
          { newId: ids, now: () => new Date() },
        ),
        null,
        new Date(),
      ),
    );
    expect(walk).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(walk.message).toMatch(/the player is fighting/);
    expect(await attack(client, 301)).toMatchObject({ ok: false, code: 'REFUSED' });
    client.halt('done');
    expect(await fighting).toMatchObject({ ok: false, code: 'FAILED' });
    expect(server.walkSteps()).toEqual([]);
  }, 15_000);
});

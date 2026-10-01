import { afterEach, describe, expect, it } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig, type MinecraftConfig } from '../../../src/config/env.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import type { QuestBook } from '../../../src/domain/quest-book.ts';
import { systemClock } from '../../../src/util/clock.ts';
import type { FakeQuest } from './fake-better-questing.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
});

/** Items of the fake server's registry: its default inventory's, and the ones the quests use. */
export const ITEMS: Array<[number, string]> = [
  [297, 'minecraft:bread'],
  [263, 'minecraft:coal'],
  [7495, 'gregtech:gt.metaitem.01'],
  [9001, 'BuildCraft|Core:engineBlock'],
  [9002, 'Natura:N Crops'],
  [3, 'minecraft:dirt'],
  [13, 'minecraft:gravel'],
  [17, 'minecraft:log'],
  [318, 'minecraft:flint'],
  [5, 'minecraft:planks'],
  [357, 'minecraft:cookie'],
  [260, 'minecraft:apple'],
  [264, 'minecraft:diamond'],
];

/** A small "And So, It Begins": dirt, then logs (two consumed), a checkbox, a choice reward. */
export const BOOK: FakeQuest[] = [
  {
    id: '0:0',
    name: 'Your First Night',
    tasks: [{ type: 'bq_standard:retrieval', items: [{ name: 'minecraft:dirt', count: 8 }] }],
    rewards: [{ type: 'bq_standard:item', items: [{ name: 'minecraft:apple', count: 1 }] }],
  },
  {
    id: '0:2',
    name: "Sticks 'n Stones",
    prerequisites: ['0:0'],
    tasks: [
      { type: 'bq_standard:retrieval', items: [{ name: 'minecraft:gravel', count: 2 }] },
      {
        type: 'bq_standard:retrieval',
        consume: true,
        items: [{ name: 'minecraft:log', damage: 0, count: 2, oreDict: 'logWood' }],
      },
    ],
  },
  {
    id: '0:4',
    name: 'Main Quests and Secondary Quests',
    prerequisites: ['0:2'],
    tasks: [{ type: 'bq_standard:checkbox' }],
    rewards: [
      {
        type: 'bq_standard:choice',
        choices: [
          { name: 'minecraft:planks', count: 10 },
          { name: 'minecraft:cookie', count: 1 },
        ],
      },
    ],
  },
];

export const SCOPE = BOOK.map((q) => q.id);

export async function startQuestServer(
  serverOptions: FakeServerOptions = {},
  mc: Partial<MinecraftConfig> = {},
  scope: readonly string[] = SCOPE,
  withQuestBook = true,
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client }> {
  const server = new FakeGtnhServer({
    items: ITEMS,
    ...(withQuestBook ? { questBook: { quests: BOOK, loopTicks: 4 } } : {}),
    ...serverOptions,
  });
  servers.push(server);
  const port = await server.listen();
  const config = {
    ...defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port,
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
      },
    }).minecraft,
    ...mc,
  };
  const client = new Gtnh1710Client({
    config,
    clock: systemClock,
    retryDelayMs: 50,
    questScope: scope,
  });
  clients.push(client);
  return { server, client };
}

/** Observes until `test` holds for the quest book (or two seconds pass). */
export async function bookWhen(
  client: Gtnh1710Client,
  test: (book: QuestBook) => boolean = () => true,
): Promise<GameState> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const state = await client.observe();
    if (state.questBook.known && test(state.questBook.value)) return state;
    if (Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const questOf = (state: GameState, id: string) =>
  state.questBook.known ? state.questBook.value.quests.find((q) => q.id === id) : undefined;

describe('the quest book, read from Better Questing on a scripted server', () => {
  it('answers main_sync once, as the stock client does, and then knows the server records', async () => {
    const { server, client } = await startQuestServer({
      inventory: [{ slot: 36, id: 3, count: 5, damage: 0 }],
    });
    await client.connect();
    const state = await bookWhen(client);
    expect(state.questBook.known).toBe(true);
    // REGISTER announced the channel, and the only BQ message sent was the main_sync answer.
    const register = server.received.find((p) => p.state === 'play' && p.id === 0x17);
    expect(register?.body.toString('latin1')).toContain('BQ_NET_CHAN');
    expect(server.questBookSim?.receivedIds()).toEqual(['betterquesting:main_sync']);
    expect(Object.keys(server.questBookSim?.received[0]?.payload ?? {})).toEqual(['ID']);
    if (!state.questBook.known) return;
    expect(state.questBook.value.totalQuests).toBe(3);
    expect(
      state.questBook.value.quests.map((q) => [q.id, q.active, q.unlocked, q.completed]),
    ).toEqual([
      ['0:0', true, true, false],
      ['0:2', false, false, false],
      ['0:4', false, false, false],
    ]);
    // Held before the quest was active: dirt does NOT count until the inventory changes.
    expect(questOf(state, '0:0')?.tasks).toEqual([
      {
        index: 0,
        type: 'bq_standard:retrieval',
        complete: false,
        consume: false,
        items: [{ item: 'minecraft:dirt', count: 8, oreDict: null, anyDamage: false }],
        progress: [0],
      },
    ]);
  });

  it('follows the server: an inventory change counts items, the quest loop completes the quest', async () => {
    const { server, client } = await startQuestServer({
      inventory: [{ slot: 36, id: 3, count: 5, damage: 0 }],
    });
    await client.connect();
    await bookWhen(client);
    server.chestSim.pickUp({ id: 3, count: 3, damage: 0 }); // 8 dirt now: the task completes
    const after = await bookWhen(
      client,
      (b) => b.quests.find((q) => q.id === '0:0')?.completed === true,
    );
    expect(questOf(after, '0:0')).toMatchObject({
      completed: true,
      claimed: false,
      active: false,
      tasks: [],
      rewards: [
        {
          index: 0,
          type: 'bq_standard:item',
          choice: false,
          items: [{ item: 'minecraft:apple', count: 1, oreDict: null, anyDamage: false }],
          selected: null,
        },
      ],
    });
    // Completing it unlocked the next quest, which the server now lists as active.
    expect(questOf(after, '0:2')).toMatchObject({ active: true, unlocked: true, completed: false });
  });

  it('reassembles a full sync that spans several slices', async () => {
    const { server, client } = await startQuestServer({
      questBook: { quests: BOOK, loopTicks: 4, fillerQuests: 400 },
    });
    await client.connect();
    const state = await bookWhen(client);
    expect(state.questBook.known && state.questBook.value.totalQuests).toBe(403);
    expect(server.questBookSim?.receivedIds()).toEqual(['betterquesting:main_sync']);
  });

  it('stays unknown, and says why, without a sync, after a broken slice, or without Better Questing', async () => {
    const quiet = await startQuestServer({ questBook: { quests: BOOK, ignoreMainSync: true } });
    await quiet.client.connect();
    expect((await quiet.client.observe()).questBook).toEqual({
      known: false,
      reason: 'waiting for the quest book sync from the server (Better Questing)',
    });

    const broken = await startQuestServer({ questBook: { quests: BOOK, corruptFullSync: true } });
    await broken.client.connect();
    await new Promise((r) => setTimeout(r, 200));
    const state = await broken.client.observe();
    expect(state.questBook.known).toBe(false);
    if (!state.questBook.known) {
      expect(state.questBook.reason).toMatch(/^quest book: undecodable Better Questing message/);
    }
    // The connection itself is fine.
    expect(state.inventory.known).toBe(true);

    const vanilla = await startQuestServer({}, {}, SCOPE, false);
    await vanilla.client.connect();
    expect((await vanilla.client.observe()).questBook).toEqual({
      known: false,
      reason: 'the server does not run Better Questing',
    });
    expect(vanilla.server.pluginChannels()).not.toContain('BQ_NET_CHAN');
  });

  it('reports only the quests in its scope', async () => {
    const { client } = await startQuestServer({}, {}, ['0:4']);
    await client.connect();
    const state = await bookWhen(client);
    expect(state.questBook.known && state.questBook.value.quests.map((q) => q.id)).toEqual(['0:4']);
  });
});

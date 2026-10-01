import { afterEach, describe, expect, it } from 'vitest';
import {
  runQuestBookAction,
  syncConfigToDatabase,
  type AgentDeps,
} from '../../../src/app/agent-loop.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig, type AgentConfig, type MinecraftConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import type { QuestBook } from '../../../src/domain/quest-book.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
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
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client; config: AgentConfig }> {
  const server = new FakeGtnhServer({
    items: ITEMS,
    ...(withQuestBook
      ? { questBook: { quests: BOOK, loopTicks: 4, oreDict: { logWood: ['minecraft:log'] } } }
      : {}),
    ...serverOptions,
  });
  servers.push(server);
  const port = await server.listen();
  const base = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port,
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
    },
    safety: { protectedItems: ['minecraft:diamond'] },
  });
  const config: AgentConfig = { ...base, minecraft: { ...base.minecraft, ...mc } };
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    retryDelayMs: 50,
    questScope: scope,
    questBookTimeoutMs: 1_500,
  });
  clients.push(client);
  return { server, client, config };
}

/** The executor's dependencies for running quest-book clicks against the client. */
function executorDeps(config: AgentConfig, client: Gtnh1710Client): AgentDeps {
  const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
  syncConfigToDatabase(config, repos);
  return {
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner: null,
    clock: systemClock,
    newId: sequentialIds(),
  };
}

const ENABLED: Partial<MinecraftConfig> = { questBook: { enabled: true } };

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

/** The client perform() of a hand-minted action (the executor is tested separately). */
async function performDirect(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: sequentialIds(), now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}

const checks = (r: Awaited<ReturnType<typeof runQuestBookAction>>): string[] =>
  r.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`) ?? [];

describe('quest-book clicks, through the executor, judged by the server', () => {
  it('submits, ticks a box and claims rewards (with a choice), each verified by the server records', async () => {
    const { server, client, config } = await startQuestServer(
      {
        inventory: [
          { slot: 36, id: 3, count: 8, damage: 0 }, // dirt, held BEFORE the quest was active
          { slot: 37, id: 13, count: 2, damage: 0 }, // gravel
          { slot: 38, id: 17, count: 5, damage: 2 }, // birch logs: logWood
          { slot: 39, id: 264, count: 1, damage: 0 }, // a protected diamond
        ],
      },
      ENABLED,
    );
    await client.connect();
    await bookWhen(client);
    const deps = executorDeps(config, client);
    const sim = server.questBookSim;
    if (sim === null) throw new Error('no quest book');

    // 1. The dirt was held before the quest became active: only a submit makes the server count it.
    expect(sim.quest('0:0').tasks[0]?.progress).toEqual([0]);
    const submitted = await runQuestBookAction(
      deps,
      { type: 'SUBMIT_QUEST', args: { questId: '0:0' } },
      'all 8 dirt are held',
      'quest-0:0',
    );
    expect(submitted.status).toBe('succeeded');
    expect(checks(submitted)).toEqual(
      expect.arrayContaining(['PASS quest-completed', 'PASS only-handed-in-items']),
    );
    expect(sim.quest('0:0')).toMatchObject({ completed: true, claimed: false });

    // 2. Claim its reward: exactly one apple arrives.
    const claimed = await runQuestBookAction(
      deps,
      { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:0', choice: null } },
      'claim',
      'quest-0:0',
    );
    expect(claimed.status).toBe('succeeded');
    expect(checks(claimed)).toEqual(
      expect.arrayContaining(['PASS reward-claimed', 'PASS reward-items']),
    );
    expect(claimed.outcome?.execution?.data['gained']).toBe('1 x minecraft:apple');

    // 3. "Sticks 'n Stones" hands in two logs (logWood): refused while a diamond is held.
    await bookWhen(client, (b) => b.quests.find((q) => q.id === '0:2')?.active === true);
    const refused = await runQuestBookAction(
      deps,
      { type: 'SUBMIT_QUEST', args: { questId: '0:2' } },
      'logs',
      'quest-0:2',
    );
    expect(refused.summary).toMatch(/rejected \[PROTECTED_ITEM\]/);
    server.chestSim.take(39, 1); // the diamond goes elsewhere (as if the player stored it)
    await new Promise((r) => setTimeout(r, 100));
    const handedIn = await runQuestBookAction(
      deps,
      { type: 'SUBMIT_QUEST', args: { questId: '0:2' } },
      'logs',
      'quest-0:2',
    );
    expect(handedIn.status).toBe('succeeded');
    expect(handedIn.outcome?.execution?.data['handedIn']).toBe('2 x minecraft:log@2');
    expect(checks(handedIn)).toEqual(expect.arrayContaining(['PASS only-handed-in-items']));

    // 4. The checkbox quest: tick it; the server's quest loop completes it.
    await bookWhen(client, (b) => b.quests.find((q) => q.id === '0:4')?.active === true);
    const ticked = await runQuestBookAction(
      deps,
      { type: 'CHECK_QUEST_BOX', args: { questId: '0:4', taskIndex: 0 } },
      'read it',
      'quest-0:4',
    );
    expect(ticked.status).toBe('succeeded');

    // 5. Its choice reward: select the cookie, then claim.
    await bookWhen(client, (b) => b.quests.find((q) => q.id === '0:4')?.completed === true);
    const chosen = await runQuestBookAction(
      deps,
      { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:4', choice: 1 } },
      'cookie',
      'quest-0:4',
    );
    expect(chosen.status).toBe('succeeded');
    expect(chosen.outcome?.execution?.data['gained']).toBe('1 x minecraft:cookie');

    expect(sim.receivedIds()).toEqual([
      'betterquesting:main_sync',
      'betterquesting:quest_action',
      'betterquesting:quest_action',
      'betterquesting:quest_action',
      'bq_standard:task_checkbox',
      'bq_standard:choice_reward',
      'betterquesting:quest_action',
    ]);
    expect(sim.received.map((m) => m.payload['action'])).toEqual([
      undefined,
      1,
      0,
      1,
      undefined,
      undefined,
      0,
    ]);
    expect(sim.dropped).toEqual([]);
    expect(deps.repos.actions.recent(10, 'quest-0:2').map((a) => [a.origin, a.status])).toEqual([
      ['deterministic-router', 'succeeded'],
      ['deterministic-router', 'rejected'],
    ]);
  });

  it('refuses without sending anything: disabled, outside the scope, inactive, locked or done', async () => {
    const off = await startQuestServer({});
    await off.client.connect();
    await bookWhen(off.client);
    expect(
      await performDirect(off.client, { type: 'SUBMIT_QUEST', args: { questId: '0:0' } }),
    ).toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });

    const { server, client } = await startQuestServer({}, ENABLED, ['0:0', '0:2']);
    await client.connect();
    await bookWhen(client);
    const refuse = async (spec: ActionSpec, message: RegExp): Promise<void> => {
      const r = await performDirect(client, spec);
      expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(message);
    };
    await refuse({ type: 'SUBMIT_QUEST', args: { questId: '0:4' } }, /not one the agent tracks/);
    await refuse({ type: 'SUBMIT_QUEST', args: { questId: '0:2' } }, /is not active on the server/);
    await refuse(
      { type: 'CHECK_QUEST_BOX', args: { questId: '0:0', taskIndex: 0 } },
      /task 0 of "Your First Night" is not a checkbox/,
    );
    await refuse(
      { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:0', choice: null } },
      /is not completed/,
    );
    expect(server.questBookSim?.receivedIds()).toEqual(['betterquesting:main_sync']);
    expect(off.server.questBookSim?.receivedIds()).toEqual(['betterquesting:main_sync']);
  });

  it('a submit the server does not complete fails, and says what the server counted', async () => {
    const { client } = await startQuestServer(
      { inventory: [{ slot: 36, id: 3, count: 5, damage: 0 }] },
      ENABLED,
    );
    await client.connect();
    await bookWhen(client);
    const r = await performDirect(client, { type: 'SUBMIT_QUEST', args: { questId: '0:0' } });
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toBe(
      'the server did not record "Your First Night" as completed within 1.5 s of the submit ' +
        '(tasks: 0 retrieval [5/8 minecraft:dirt])',
    );
  });
});

import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BQ_SLICE_BYTES,
  BqAssembler,
  decodeBqMessage,
  decodeBqSlice,
  encodeBqOutbound,
  encodeBqSlices,
  QuestBookModel,
  type BqMessage,
} from '../../../src/bot/gtnh1710/better-questing.ts';
import { nbtTag, readNbt, writeNbt, type NbtTagCompound } from '../../../src/bot/gtnh1710/nbt.ts';
import { outbound } from '../../../src/bot/gtnh1710/packets.ts';
import { ProtocolError, Reader } from '../../../src/bot/gtnh1710/wire.ts';
import { logicResult, QUEST_LOGICS } from '../../../src/domain/quest-book.ts';

const PLAYER = '3dfc863b-6ad1-3d61-b872-36bf96373604';
const OTHER = '61cb1b75-ae88-3692-8d0c-e959380993c6';

/** A slice exactly as PacketQuesting carries it: discriminator, short length, gzip NBT. */
function handSlice(fields: NbtTagCompound, discriminator = 0): Buffer {
  const body = gzipSync(writeNbt(fields));
  const len = Buffer.alloc(2);
  len.writeInt16BE(body.length);
  return Buffer.concat([Buffer.from([discriminator]), len, body]);
}

/** The tag type of every top-level entry of an uncompressed NBT document (for exact checks). */
function topLevelTypes(doc: Buffer): Record<string, number> {
  const out: Record<string, number> = {};
  const r = new Reader(doc);
  r.u8(); // root compound
  r.bytes(r.u16()); // root name
  const skip = (type: number): void => {
    switch (type) {
      case 1:
        r.bytes(1);
        return;
      case 2:
        r.bytes(2);
        return;
      case 3:
      case 5:
        r.bytes(4);
        return;
      case 4:
      case 6:
        r.bytes(8);
        return;
      case 7:
        r.bytes(r.i32());
        return;
      case 8:
        r.bytes(r.u16());
        return;
      case 9: {
        const item = r.u8();
        const n = r.i32();
        for (let i = 0; i < n; i++) skip(item);
        return;
      }
      case 10:
        for (let t = r.u8(); t !== 0; t = r.u8()) {
          r.bytes(r.u16());
          skip(t);
        }
        return;
      case 11:
        r.bytes(r.i32() * 4);
        return;
      default:
        throw new Error(`type ${type}`);
    }
  };
  for (let t = r.u8(); t !== 0; t = r.u8()) {
    const name = r.bytes(r.u16()).toString('utf8');
    out[name] = t;
    skip(t);
  }
  return out;
}

/** The single slice of a client message, opened: slice fields and the payload document. */
function openSingle(payloads: Buffer[]): { slice: Record<string, unknown>; doc: Buffer } {
  expect(payloads).toHaveLength(1);
  const p = payloads[0] as Buffer;
  expect(p[0]).toBe(0); // discriminator
  const len = p.readInt16BE(1);
  expect(p.length).toBe(3 + len);
  const slice = readNbt(gunzipSync(p.subarray(3))).value;
  const data = slice['data'] as Buffer;
  return { slice, doc: gunzipSync(data) };
}

/** Incompressible bytes (xorshift32), so gzip cannot shrink a test message below a slice. */
function noise(length: number, seed = 2463534242): Buffer {
  const b = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

const ids = (...list: string[]) =>
  nbtTag.list(
    'compound',
    list.map((id) => {
      const [h, l] = id.split(':').map((x) => BigInt(x)) as [bigint, bigint];
      return nbtTag.compound({ questIDHigh: nbtTag.long(h), questIDLow: nbtTag.long(l) });
    }),
  );

describe('Better Questing framing (PacketAssembly, PacketQuesting)', () => {
  it('reads a slice built by hand: {size, index, end, data} in gzip NBT after a short length', () => {
    const slice = handSlice({
      size: nbtTag.int(10),
      index: nbtTag.int(0),
      end: nbtTag.bool(true),
      data: nbtTag.byteArray(Buffer.from('0123456789')),
    });
    expect(decodeBqSlice(slice)).toEqual({
      size: 10,
      index: 0,
      end: true,
      data: Buffer.from('0123456789'),
    });
    expect(() => decodeBqSlice(Buffer.concat([slice, Buffer.from([0])]))).toThrow(/after/);
    expect(() =>
      decodeBqSlice(
        handSlice(
          {
            size: nbtTag.int(1),
            index: nbtTag.int(0),
            end: nbtTag.bool(true),
            data: nbtTag.byteArray(Buffer.from('x')),
          },
          1,
        ),
      ),
    ).toThrow(/discriminator 1/);
    expect(() =>
      decodeBqSlice(Buffer.concat([Buffer.from([0, 0, 4]), Buffer.from([1, 2, 3, 4])])),
    ).toThrow(/gzip/);
  });

  it('cuts a message into 20,480-byte slices and reassembles it in order', () => {
    // Incompressible bytes, so the gzip is about 50 KB: three slices.
    const blob = noise(50_000);
    const payloads = encodeBqSlices('betterquesting:quest_sync', { blob: nbtTag.byteArray(blob) });
    expect(payloads.length).toBe(3);
    const slices = payloads.map(decodeBqSlice);
    const size = slices[0]?.size ?? 0;
    expect(slices.map((s) => s.index)).toEqual([0, BQ_SLICE_BYTES, 2 * BQ_SLICE_BYTES]);
    expect(slices.map((s) => s.end)).toEqual([false, false, true]);
    expect(slices.every((s) => s.size === size && s.data.length <= BQ_SLICE_BYTES)).toBe(true);
    const assembler = new BqAssembler();
    expect(assembler.push(payloads[0] as Buffer)).toBeNull();
    expect(assembler.push(payloads[1] as Buffer)).toBeNull();
    const whole = assembler.push(payloads[2] as Buffer);
    expect(whole?.['ID']).toBe('betterquesting:quest_sync');
    expect(whole?.['blob']).toEqual(blob);
  });

  it('refuses slices that do not belong together', () => {
    const big = encodeBqSlices('a:b', { blob: nbtTag.byteArray(noise(30_000)) });
    expect(big.length).toBe(2);
    const small = encodeBqSlices('a:c', {});
    const a = new BqAssembler();
    a.push(big[0] as Buffer);
    expect(() => a.push(small[0] as Buffer)).toThrow(/another message/);
    const outside = handSlice({
      size: nbtTag.int(4),
      index: nbtTag.int(2),
      end: nbtTag.bool(true),
      data: nbtTag.byteArray(Buffer.from([1, 2, 3])),
    });
    expect(() => new BqAssembler().push(outside)).toThrow(/outside 4 bytes/);
  });
});

describe('the four client messages (exact keys and tag types, from the jar)', () => {
  it('main_sync answer: an empty payload with its ID', () => {
    const { slice, doc } = openSingle(encodeBqOutbound({ kind: 'main-sync-reply' }));
    expect(slice).toMatchObject({ index: 0, end: 1 });
    expect(topLevelTypes(doc)).toEqual({ ID: 8 });
    expect(readNbt(doc).value).toEqual({ ID: 'betterquesting:main_sync' });
  });

  it('quest_action: int action (1 = detect, 0 = claim) and a list of quest ids as longs', () => {
    const { doc } = openSingle(
      encodeBqOutbound({
        kind: 'quest-action',
        action: 'detect',
        questIds: ['0:5', '-2157870659866113684:-8191827436027574183'],
      }),
    );
    expect(topLevelTypes(doc)).toEqual({ action: 3, questIDs: 9, ID: 8 });
    expect(readNbt(doc).value).toEqual({
      action: 1,
      questIDs: [
        { questIDHigh: 0n, questIDLow: 5n },
        { questIDHigh: -2157870659866113684n, questIDLow: -8191827436027574183n },
      ],
      ID: 'betterquesting:quest_action',
    });
    const claim = openSingle(
      encodeBqOutbound({ kind: 'quest-action', action: 'claim', questIds: ['0:5'] }),
    );
    expect(readNbt(claim.doc).value['action']).toBe(0);
  });

  it('task_checkbox and choice_reward: the quest id halves (longs) and int fields', () => {
    const box = openSingle(
      encodeBqOutbound({ kind: 'task-checkbox', questId: '0:4', taskIndex: 0 }),
    );
    expect(topLevelTypes(box.doc)).toEqual({ questIDHigh: 4, questIDLow: 4, taskID: 3, ID: 8 });
    expect(readNbt(box.doc).value).toEqual({
      questIDHigh: 0n,
      questIDLow: 4n,
      taskID: 0,
      ID: 'bq_standard:task_checkbox',
    });
    const choice = openSingle(
      encodeBqOutbound({ kind: 'choice-reward', questId: '0:5', rewardIndex: 0, selection: 2 }),
    );
    expect(topLevelTypes(choice.doc)).toEqual({
      questIDHigh: 4,
      questIDLow: 4,
      rewardID: 3,
      selection: 3,
      ID: 8,
    });
    expect(readNbt(choice.doc).value).toMatchObject({
      rewardID: 0,
      selection: 2,
      ID: 'bq_standard:choice_reward',
    });
  });

  it('refuses anything else: bad ids, indexes and quest counts', () => {
    expect(() => encodeBqOutbound({ kind: 'task-checkbox', questId: '1', taskIndex: 0 })).toThrow(
      ProtocolError,
    );
    expect(() =>
      encodeBqOutbound({ kind: 'task-checkbox', questId: '0:99999999999999999999', taskIndex: 0 }),
    ).toThrow(ProtocolError);
    expect(() =>
      encodeBqOutbound({ kind: 'task-checkbox', questId: '0:4', taskIndex: -1 }),
    ).toThrow(ProtocolError);
    expect(() =>
      encodeBqOutbound({ kind: 'choice-reward', questId: '0:4', rewardIndex: 0, selection: 4096 }),
    ).toThrow(ProtocolError);
    expect(() => encodeBqOutbound({ kind: 'quest-action', action: 'claim', questIds: [] })).toThrow(
      ProtocolError,
    );
  });

  it('goes out as C17 on BQ_NET_CHAN with a short length, never through the generic plugin builder', () => {
    const [packet] = outbound.questBook({ kind: 'main-sync-reply' });
    expect(packet?.kind).toBe('quest-book');
    const r = new Reader(packet?.frame ?? Buffer.alloc(0));
    const length = r.varInt();
    expect(length).toBe((packet?.frame.length ?? 0) - r.offset);
    expect(r.varInt()).toBe(0x17);
    expect(r.string()).toBe('BQ_NET_CHAN');
    const dataLength = r.u16();
    expect(r.remaining).toBe(dataLength);
    expect(() => outbound.pluginMessage('BQ_NET_CHAN', Buffer.from([0]))).toThrow(/refusing/);
  });
});

const quest = (id: string, extra: Record<string, unknown> = {}): NbtTagCompound => {
  const [h, l] = id.split(':').map((x) => BigInt(x)) as [bigint, bigint];
  return { questIDHigh: nbtTag.long(h), questIDLow: nbtTag.long(l), ...(extra as NbtTagCompound) };
};

const config = (
  name: string,
  opts: {
    pre?: string[];
    questLogic?: string;
    taskLogic?: string;
    tasks?: Array<{
      type: string;
      consume?: boolean;
      items?: Array<[string, number, number, string?]>;
    }>;
    rewards?: Array<{ type: string; items: Array<[string, number, number]> }>;
  } = {},
) =>
  nbtTag.compound({
    properties: nbtTag.compound({
      betterquesting: nbtTag.compound({
        name: nbtTag.string(name),
        questLogic: nbtTag.string(opts.questLogic ?? 'AND'),
        taskLogic: nbtTag.string(opts.taskLogic ?? 'AND'),
        isMain: nbtTag.bool(true),
      }),
    }),
    preRequisites: ids(...(opts.pre ?? [])),
    tasks: nbtTag.list(
      'compound',
      (opts.tasks ?? []).map((t, index) =>
        nbtTag.compound({
          taskID: nbtTag.string(t.type),
          index: nbtTag.int(index),
          consume: nbtTag.bool(t.consume ?? false),
          requiredItems: nbtTag.list(
            'compound',
            (t.items ?? []).map(([id, damage, count, ore]) =>
              nbtTag.compound({
                id: nbtTag.string(id),
                Damage: nbtTag.short(damage),
                Count: nbtTag.int(count),
                OreDict: nbtTag.string(ore ?? ''),
              }),
            ),
          ),
        }),
      ),
    ),
    rewards: nbtTag.list(
      'compound',
      (opts.rewards ?? []).map((r, index) =>
        nbtTag.compound({
          rewardID: nbtTag.string(r.type),
          index: nbtTag.int(index),
          [r.type === 'bq_standard:choice' ? 'choices' : 'rewards']: nbtTag.list(
            'compound',
            r.items.map(([id, damage, count]) =>
              nbtTag.compound({
                id: nbtTag.string(id),
                Damage: nbtTag.short(damage),
                Count: nbtTag.int(count),
                OreDict: nbtTag.string(''),
              }),
            ),
          ),
        }),
      ),
    ),
  });

const progress = (
  completed: Array<[string, boolean]>,
  tasks: Array<{ index: number; done: string[]; data?: Array<[string, number[]]> }> = [],
) =>
  nbtTag.compound({
    completed: nbtTag.list(
      'compound',
      completed.map(([uuid, claimed]) =>
        nbtTag.compound({
          uuid: nbtTag.string(uuid),
          claimed: nbtTag.bool(claimed),
          timestamp: nbtTag.long(1n),
        }),
      ),
    ),
    tasks: nbtTag.list(
      'compound',
      tasks.map((t) =>
        nbtTag.compound({
          index: nbtTag.int(t.index),
          taskID: nbtTag.string('bq_standard:retrieval'),
          completeUsers: nbtTag.list(
            'string',
            t.done.map((u) => nbtTag.string(u)),
          ),
          userProgress: nbtTag.list(
            'compound',
            (t.data ?? []).map(([uuid, data]) =>
              nbtTag.compound({ uuid: nbtTag.string(uuid), data: nbtTag.intArray(data) }),
            ),
          ),
        }),
      ),
    ),
  });

/** Encodes and reassembles a server payload, then decodes it, like the client does. */
function receive(id: string, payload: NbtTagCompound): BqMessage {
  const assembler = new BqAssembler();
  let whole = null;
  for (const p of encodeBqSlices(id, payload)) whole = assembler.push(p);
  if (whole === null) throw new Error('incomplete');
  return decodeBqMessage(whole);
}

describe('server messages and the quest book model', () => {
  it('decodes main_sync, cache_sync, chapter_sync and choice_reward', () => {
    expect(
      receive('betterquesting:main_sync', { reset: nbtTag.bool(true), respond: nbtTag.bool(true) }),
    ).toEqual({
      type: 'main-sync',
      reset: true,
      respond: true,
    });
    expect(
      receive('betterquesting:cache_sync', {
        data: nbtTag.compound({
          activeQuests: ids('0:1', '0:2'),
          visibleQuests: ids('0:1'),
          autoClaims: ids(),
        }),
      }),
    ).toEqual({ type: 'cache-sync', active: ['0:1', '0:2'], visible: ['0:1'], autoClaims: [] });
    expect(
      receive('betterquesting:chapter_sync', {
        merge: nbtTag.bool(false),
        data: nbtTag.list('compound', [
          nbtTag.compound({
            questLineIDHigh: nbtTag.long(0n),
            questLineIDLow: nbtTag.long(1n),
            config: nbtTag.compound({
              properties: nbtTag.compound({
                betterquesting: nbtTag.compound({ name: nbtTag.string('Tier 0 - Stone Age') }),
              }),
              quests: ids('0:15'),
            }),
          }),
        ]),
      }),
    ).toEqual({
      type: 'chapter-sync',
      merge: false,
      chapters: [{ id: '0:1', name: 'Tier 0 - Stone Age', quests: ['0:15'] }],
    });
    expect(
      receive('bq_standard:choice_reward', {
        ...quest('0:5'),
        rewardID: nbtTag.int(0),
        selection: nbtTag.int(2),
      }),
    ).toEqual({ type: 'choice-reward', questId: '0:5', rewardIndex: 0, selection: 2 });
    expect(receive('betterquesting:name_sync', {})).toEqual({
      type: 'other',
      id: 'betterquesting:name_sync',
    });
    expect(() =>
      receive('betterquesting:quest_sync', {
        merge: nbtTag.bool(false),
        data: nbtTag.list('compound', [
          nbtTag.compound(quest('0:1', { config: config('X', { questLogic: 'MAYBE' }) })),
        ]),
      }),
    ).toThrow(/unknown quest logic/);
  });

  it("keeps only this player's progress, and applies BQ's own rules for unlocking and claiming", () => {
    const book = new QuestBookModel();
    book.setPlayer(PLAYER.toUpperCase());
    expect(book.toState(['0:1'])).toMatchObject({ known: false });
    book.apply(
      receive('betterquesting:main_sync', { reset: nbtTag.bool(true), respond: nbtTag.bool(true) }),
    );
    book.apply(
      receive('betterquesting:quest_sync', {
        merge: nbtTag.bool(false),
        resetCompletion: nbtTag.bool(false),
        data: nbtTag.list('compound', [
          // Done by this player; no rewards, so it counts as claimed.
          nbtTag.compound(
            quest('0:1', { config: config('§6One'), progress: progress([[PLAYER, false]]) }),
          ),
          // Done by ANOTHER player only.
          nbtTag.compound(
            quest('0:2', { config: config('Two'), progress: progress([[OTHER, true]]) }),
          ),
          // Completed with an unclaimed choice reward.
          nbtTag.compound(
            quest('0:3', {
              config: config('Three', {
                pre: ['0:1'],
                rewards: [
                  {
                    type: 'bq_standard:choice',
                    items: [
                      ['minecraft:planks', 0, 10],
                      ['minecraft:cookie', 0, 1],
                    ],
                  },
                ],
              }),
              progress: progress([[PLAYER, false]]),
            }),
          ),
          // XOR: exactly one prerequisite must be done (0:1 is, 0:2 is not, for this player).
          nbtTag.compound(
            quest('0:4', { config: config('Four', { pre: ['0:1', '0:2'], questLogic: 'XOR' }) }),
          ),
          // OR with a missing prerequisite; AND that is not met.
          nbtTag.compound(
            quest('0:5', {
              config: config('Five', {
                pre: ['0:2', '0:404'],
                questLogic: 'OR',
                tasks: [
                  {
                    type: 'bq_standard:retrieval',
                    consume: true,
                    items: [
                      ['minecraft:log', 32767, 2, 'logWood'],
                      ['minecraft:dirt', 0, 8],
                    ],
                  },
                ],
              }),
              progress: progress(
                [],
                [
                  {
                    index: 0,
                    done: [OTHER],
                    data: [
                      [OTHER, [2, 8]],
                      [PLAYER, [1, 3]],
                    ],
                  },
                ],
              ),
            }),
          ),
          nbtTag.compound(quest('0:6', { config: config('Six', { pre: ['0:1', '0:2'] }) })),
        ]),
      }),
    );
    expect(book.toState(['0:1'])).toEqual({
      known: false,
      reason: 'waiting for the quest book sync from the server (Better Questing)',
    });
    book.apply(
      receive('betterquesting:cache_sync', {
        data: nbtTag.compound({ activeQuests: ids('0:4', '0:5') }),
      }),
    );
    expect(book.completed('0:1')).toBe(true);
    expect(book.claimed('0:1')).toBe(true); // no rewards
    expect(book.completed('0:2')).toBe(false); // someone else's completion
    expect(book.claimed('0:3')).toBe(false);
    expect(book.unlocked('0:4')).toBe(true); // XOR: one of two
    expect(book.unlocked('0:5')).toBe(false); // OR: neither 0:2 (not ours) nor the missing 0:404
    expect(book.unlocked('0:6')).toBe(false); // AND
    expect(book.taskComplete('0:5', 0)).toBe(false);
    expect(book.taskProgress('0:5', 0)).toEqual([1, 3]);

    const state = book.toState(['0:404', '0:1', '0:3', '0:5']);
    expect(state.known).toBe(true);
    if (!state.known) return;
    expect(state.value.totalQuests).toBe(6);
    expect(state.value.quests.map((q) => q.id)).toEqual(['0:1', '0:3', '0:5']); // 0:404 unknown
    expect(state.value.quests[0]).toMatchObject({
      name: 'One',
      completed: true,
      claimed: true,
      tasks: [],
      rewards: [],
    });
    expect(state.value.quests[1]?.rewards).toEqual([
      {
        index: 0,
        type: 'bq_standard:choice',
        choice: true,
        items: [
          { item: 'minecraft:planks', count: 10, oreDict: null, anyDamage: false },
          { item: 'minecraft:cookie', count: 1, oreDict: null, anyDamage: false },
        ],
        selected: null,
      },
    ]);
    expect(state.value.quests[2]).toMatchObject({
      active: true,
      unlocked: false,
      completed: false,
      tasks: [
        {
          index: 0,
          type: 'bq_standard:retrieval',
          complete: false,
          consume: true,
          items: [
            { item: 'minecraft:log', count: 2, oreDict: 'logWood', anyDamage: true },
            { item: 'minecraft:dirt', count: 8, oreDict: null, anyDamage: false },
          ],
          progress: [1, 3],
        },
      ],
    });

    // The server acknowledges a choice; a progress-only update replaces this player's progress.
    book.apply(
      receive('bq_standard:choice_reward', {
        ...quest('0:3'),
        rewardID: nbtTag.int(0),
        selection: nbtTag.int(1),
      }),
    );
    book.apply(
      receive('betterquesting:quest_sync', {
        merge: nbtTag.bool(true),
        resetCompletion: nbtTag.bool(true),
        data: nbtTag.list('compound', [
          nbtTag.compound(quest('0:3', { progress: progress([[PLAYER, true]]) })),
        ]),
      }),
    );
    expect(book.selection('0:3', 0)).toBe(1);
    expect(book.claimed('0:3')).toBe(true);
    expect(book.counters).toMatchObject({
      mainSyncs: 1,
      questSyncs: 2,
      cacheSyncs: 1,
      choiceAcks: 1,
    });

    // A new main_sync with reset forgets everything until the next full sync.
    book.apply(
      receive('betterquesting:main_sync', { reset: nbtTag.bool(true), respond: nbtTag.bool(true) }),
    );
    expect(book.synced).toBe(false);
    expect(book.size).toBe(0);
  });

  it('a decoding problem makes the book unknown for good', () => {
    const book = new QuestBookModel();
    book.setPlayer(PLAYER);
    book.markProblem('undecodable Better Questing message: BQ: gzip');
    expect(book.toState([])).toEqual({
      known: false,
      reason: 'quest book: undecodable Better Questing message: BQ: gzip',
    });
  });

  it("EnumLogic.getResult, exactly as the jar's bytecode computes it", () => {
    const table = QUEST_LOGICS.map((logic) => [
      logic,
      [0, 1, 2, 3].map((n) => logicResult(logic, n, 3)),
    ]);
    expect(Object.fromEntries(table)).toEqual({
      AND: [false, false, false, true],
      NAND: [true, true, true, false],
      OR: [false, true, true, true],
      NOR: [true, false, false, false],
      XOR: [false, true, false, false],
      XNOR: [false, false, true, false],
    });
  });
});

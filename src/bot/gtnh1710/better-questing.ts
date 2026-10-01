import { gunzipSync, gzipSync } from 'node:zlib';
import { known, unknown, type Known } from '../../domain/known.ts';
import {
  logicResult,
  QUEST_REWARD,
  QUEST_TASK,
  QuestBookSchema,
  QuestIdSchema,
  QuestLogicSchema,
  type QuestBook,
  type QuestBookItem,
  type QuestLogic,
} from '../../domain/quest-book.ts';
import { errorMessage } from '../../util/json.ts';
import {
  isCompound,
  nbtTag,
  readNbt,
  writeNbt,
  type NbtCompound,
  type NbtTagCompound,
  type NbtValue,
} from './nbt.ts';
import { ProtocolError, Reader } from './wire.ts';

/**
 * Better Questing 3.7.15-GTNH (GTNH's quest book) on its own plugin channel. Everything here
 * was read from the bytecode of the test server's BetterQuesting-3.7.15-GTNH.jar (see
 * docs/gtnh-compatibility.md, "Quest book"):
 *
 *  - Channel BQ_NET_CHAN, a SimpleNetworkWrapper with ONE message, PacketQuesting, on
 *    discriminator 0 in both directions. Its body is ByteBufUtils.writeTag: a short length,
 *    then a gzip'd NBT compound.
 *  - That compound is a SLICE (PacketAssembly): {size: int, index: int, end: byte, data:
 *    byte[]}. A message is gzip(NBT payload) cut into 20,480-byte slices; `index` is the
 *    slice's offset, `size` the whole gzip length, `end` marks the last slice.
 *  - The payload's String "ID" names the handler (betterquesting:main_sync, ...).
 *  - At login the server sends main_sync {reset, respond}; a client with `respond` answers
 *    main_sync (an empty payload), and only then does the server send the quest database
 *    with this player's progress (quest_sync), the chapters (chapter_sync) and the quest
 *    cache (cache_sync: which quests are active).
 *
 * The client may send exactly four messages (BqOutbound): that answer, quest_action (claim or
 * detect = "submit"), task_checkbox and choice_reward. quest_action 2 (claim with a RANDOM
 * choice) and every editing message are deliberately not expressible.
 */
export const BQ_CHANNEL = 'BQ_NET_CHAN';
/** SimpleNetworkWrapper discriminator of PacketQuesting, in both directions. */
export const BQ_DISCRIMINATOR = 0;
/** PacketAssembly.bufSize: the most gzip bytes one slice carries. */
export const BQ_SLICE_BYTES = 20_480;

export const BQ_MESSAGE = {
  mainSync: 'betterquesting:main_sync',
  questSync: 'betterquesting:quest_sync',
  cacheSync: 'betterquesting:cache_sync',
  chapterSync: 'betterquesting:chapter_sync',
  questAction: 'betterquesting:quest_action',
  taskCheckbox: 'bq_standard:task_checkbox',
  choiceReward: 'bq_standard:choice_reward',
} as const;

/** NetQuestAction actions the agent may request (2, a forced claim with a random choice, is not). */
export const BQ_QUEST_ACTION = { claim: 0, detect: 1 } as const;

/** Why GameState.questBook is unknown while the server's sync after login has not arrived. */
export const QUEST_BOOK_SYNC_PENDING =
  'waiting for the quest book sync from the server (Better Questing)';

/** The whole gzip'd message a client accepts (the full quest database is a few MB). */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** The decompressed payload a client accepts. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** One decompressed slice compound (20,480 data bytes plus a little framing). */
const MAX_SLICE_NBT_BYTES = 1024 * 1024;
/** Indexes the agent may name in task_checkbox and choice_reward. */
const MAX_INDEX = 1023;

function gunzip(b: Buffer, max: number): Buffer {
  try {
    return gunzipSync(b, { maxOutputLength: max });
  } catch (error) {
    throw new ProtocolError(`BQ: gzip: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Framing: slices in, slices out
// ---------------------------------------------------------------------------

export interface BqSlice {
  /** Length of the whole gzip'd message. */
  size: number;
  /** Where this slice's bytes go in it. */
  index: number;
  end: boolean;
  data: Buffer;
}

/** Reads one BQ_NET_CHAN plugin message (one PacketQuesting). */
export function decodeBqSlice(payload: Buffer): BqSlice {
  const r = new Reader(payload);
  const discriminator = r.u8();
  if (discriminator !== BQ_DISCRIMINATOR) {
    throw new ProtocolError(`BQ: unexpected discriminator ${discriminator}`);
  }
  const length = r.i16();
  if (length <= 0) throw new ProtocolError('BQ: a message without NBT');
  const slice = readNbt(gunzip(Buffer.from(r.bytes(length)), MAX_SLICE_NBT_BYTES)).value;
  if (r.remaining !== 0) throw new ProtocolError(`BQ: ${r.remaining} bytes after the message`);
  const { size, index, end, data } = slice;
  if (
    typeof size !== 'number' ||
    typeof index !== 'number' ||
    typeof end !== 'number' ||
    !Buffer.isBuffer(data)
  ) {
    throw new ProtocolError('BQ: malformed slice (size, index, end, data)');
  }
  return { size, index, end: end !== 0, data };
}

/**
 * Reassembles the server's messages, like PacketAssembly.assemblePacket on the client: the
 * first slice sizes the buffer, each slice is copied to its index, the slice marked `end`
 * completes the message. A slice for a different size, or bytes outside the message, break
 * the stream: that throws (the caller stops trusting the quest book).
 */
export class BqAssembler {
  #buffer: Buffer | null = null;

  push(payload: Buffer): NbtCompound | null {
    const s = decodeBqSlice(payload);
    if (s.size <= 0 || s.size > MAX_MESSAGE_BYTES) {
      throw new ProtocolError(`BQ: message size ${s.size} out of range`);
    }
    if (s.index < 0 || s.index + s.data.length > s.size) {
      throw new ProtocolError(
        `BQ: slice at ${s.index} (+${s.data.length}) outside ${s.size} bytes`,
      );
    }
    if (this.#buffer === null) this.#buffer = Buffer.alloc(s.size);
    else if (this.#buffer.length !== s.size) {
      this.#buffer = null;
      throw new ProtocolError('BQ: a slice of another message arrived before the last one ended');
    }
    s.data.copy(this.#buffer, s.index);
    if (!s.end) return null;
    const whole = this.#buffer;
    this.#buffer = null;
    return readNbt(gunzip(whole, MAX_PAYLOAD_BYTES)).value;
  }
}

/**
 * The plugin-message payloads that carry one message: its payload with the handler "ID"
 * (PacketSender), gzip'd NBT cut into 20,480-byte slices (PacketAssembly.splitPacket), each
 * sent as its own PacketQuesting (discriminator, short length, gzip'd slice compound).
 */
export function encodeBqSlices(id: string, payload: NbtTagCompound): Buffer[] {
  const whole = gzipSync(writeNbt({ ...payload, ID: nbtTag.string(id) }));
  const parts = Math.max(1, Math.ceil(whole.length / BQ_SLICE_BYTES));
  const out: Buffer[] = [];
  for (let i = 0; i < parts; i++) {
    const offset = i * BQ_SLICE_BYTES;
    const slice = gzipSync(
      writeNbt({
        size: nbtTag.int(whole.length),
        index: nbtTag.int(offset),
        end: nbtTag.bool(i === parts - 1),
        data: nbtTag.byteArray(whole.subarray(offset, offset + BQ_SLICE_BYTES)),
      }),
    );
    if (slice.length > 32_767) throw new ProtocolError('BQ: slice too large for a short length');
    const length = Buffer.alloc(2);
    length.writeInt16BE(slice.length);
    out.push(Buffer.concat([Buffer.from([BQ_DISCRIMINATOR]), length, slice]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client -> server: the only four messages the agent can send
// ---------------------------------------------------------------------------

export type BqOutbound =
  /** NetBulkSync's answer to main_sync {respond: true}: asks for the quest database. */
  | { kind: 'main-sync-reply' }
  /** NetQuestAction: claim (0) or detect (1, the quest book's "Submit"). */
  | { kind: 'quest-action'; action: keyof typeof BQ_QUEST_ACTION; questIds: readonly string[] }
  /** NetTaskCheckbox: tick the checkbox task `taskIndex` of a quest. */
  | { kind: 'task-checkbox'; questId: string; taskIndex: number }
  /** NetRewardChoice: select item `selection` of the choice reward `rewardIndex`. */
  | { kind: 'choice-reward'; questId: string; rewardIndex: number; selection: number };

function questIdTags(id: string): NbtTagCompound {
  if (!QuestIdSchema.safeParse(id).success) throw new ProtocolError(`BQ: bad quest id ${id}`);
  const [high, low] = id.split(':').map((half) => BigInt(half)) as [bigint, bigint];
  return { questIDHigh: nbtTag.long(high), questIDLow: nbtTag.long(low) };
}

function index(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0 || n > MAX_INDEX) {
    throw new ProtocolError(`BQ: ${what} ${n} out of range`);
  }
  return n;
}

/** The plugin-message payloads for one client message (see BqOutbound). */
export function encodeBqOutbound(m: BqOutbound): Buffer[] {
  switch (m.kind) {
    case 'main-sync-reply':
      return encodeBqSlices(BQ_MESSAGE.mainSync, {});
    case 'quest-action': {
      if (m.questIds.length < 1 || m.questIds.length > 16) {
        throw new ProtocolError('BQ: a quest action names 1-16 quests');
      }
      return encodeBqSlices(BQ_MESSAGE.questAction, {
        action: nbtTag.int(BQ_QUEST_ACTION[m.action]),
        questIDs: nbtTag.list(
          'compound',
          m.questIds.map((id) => nbtTag.compound(questIdTags(id))),
        ),
      });
    }
    case 'task-checkbox':
      return encodeBqSlices(BQ_MESSAGE.taskCheckbox, {
        ...questIdTags(m.questId),
        taskID: nbtTag.int(index(m.taskIndex, 'task index')),
      });
    case 'choice-reward':
      return encodeBqSlices(BQ_MESSAGE.choiceReward, {
        ...questIdTags(m.questId),
        rewardID: nbtTag.int(index(m.rewardIndex, 'reward index')),
        selection: nbtTag.int(index(m.selection, 'selection')),
      });
  }
}

// ---------------------------------------------------------------------------
// Server -> client messages
// ---------------------------------------------------------------------------

/** An item in a quest (BigItemStack NBT: id string, Count int, Damage short, OreDict string). */
export interface BqItem {
  name: string;
  damage: number;
  count: number;
  oreDict: string | null;
}

export interface BqTaskConfig {
  index: number;
  type: string;
  consume: boolean;
  autoConsume: boolean;
  ignoreNBT: boolean;
  partialMatch: boolean;
  /** Crafting tasks: crafts made before the quest became active count (vanilla statistics). */
  allowCraftedFromStatistics: boolean;
  items: BqItem[];
}

export interface BqRewardConfig {
  index: number;
  type: string;
  /** bq_standard:item rewards. */
  items: BqItem[];
  /** bq_standard:choice rewards. */
  choices: BqItem[];
}

export interface BqQuestConfig {
  name: string;
  questLogic: QuestLogic;
  taskLogic: QuestLogic;
  main: boolean;
  lockedProgress: boolean;
  /** -1: not repeatable. */
  repeatTime: number;
  prerequisites: string[];
  tasks: BqTaskConfig[];
  rewards: BqRewardConfig[];
}

/** A quest's progress as the server wrote it (every user it chose to include). */
export interface BqQuestProgress {
  completed: Array<{ uuid: string; claimed: boolean }>;
  tasks: Array<{
    index: number;
    type: string;
    completeUsers: string[];
    userProgress: Array<{ uuid: string; data: number[] }>;
  }>;
}

export interface BqQuestEntry {
  id: string;
  config: BqQuestConfig | null;
  progress: BqQuestProgress | null;
}

export interface BqChapter {
  id: string;
  name: string;
  quests: string[];
}

export type BqMessage =
  | { type: 'main-sync'; reset: boolean; respond: boolean }
  | { type: 'quest-sync'; merge: boolean; resetCompletion: boolean; entries: BqQuestEntry[] }
  | { type: 'cache-sync'; active: string[]; visible: string[]; autoClaims: string[] }
  | { type: 'chapter-sync'; merge: boolean; chapters: BqChapter[] }
  | { type: 'choice-reward'; questId: string; rewardIndex: number; selection: number }
  | { type: 'other'; id: string };

const num = (v: NbtValue | undefined): number | null =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
/** NBT booleans are bytes. */
const flag = (v: NbtValue | undefined): boolean => (num(v) ?? 0) !== 0;
const text = (v: NbtValue | undefined): string => (typeof v === 'string' ? v : '');
const compound = (v: NbtValue | undefined): NbtCompound => (isCompound(v) ? v : {});
const compounds = (v: NbtValue | undefined): NbtCompound[] =>
  Array.isArray(v) ? v.filter((x): x is NbtCompound => isCompound(x)) : [];

/** NBTConverter.UuidValueType: {prefix}High and {prefix}Low longs; null if absent. */
export function bqIdOf(c: NbtCompound, prefix = 'questID'): string | null {
  const high = c[`${prefix}High`];
  const low = c[`${prefix}Low`];
  const half = (v: NbtValue | undefined): bigint | null =>
    typeof v === 'bigint'
      ? BigInt.asIntN(64, v)
      : typeof v === 'number' && Number.isInteger(v)
        ? BigInt(v)
        : null;
  const h = half(high);
  const l = half(low);
  return h === null || l === null ? null : `${h}:${l}`;
}

function idsOf(v: NbtValue | undefined, prefix = 'questID'): string[] {
  return compounds(v).flatMap((c) => {
    const id = bqIdOf(c, prefix);
    return id === null ? [] : [id];
  });
}

function logicOf(v: NbtValue | undefined): QuestLogic {
  const raw = text(v) || 'AND';
  const parsed = QuestLogicSchema.safeParse(raw);
  if (!parsed.success) throw new ProtocolError(`BQ: unknown quest logic ${raw.slice(0, 20)}`);
  return parsed.data;
}

function bqItem(c: NbtCompound): BqItem {
  return {
    name: text(c['id']),
    damage: num(c['Damage']) ?? 0,
    count: num(c['Count']) ?? 1,
    oreDict: text(c['OreDict']) || null,
  };
}

function questConfig(c: NbtCompound): BqQuestConfig {
  const props = compound(compound(c['properties'])['betterquesting']);
  return {
    name: text(props['name']),
    questLogic: logicOf(props['questLogic']),
    taskLogic: logicOf(props['taskLogic']),
    main: flag(props['isMain']),
    lockedProgress: flag(props['lockedProgress']),
    repeatTime: num(props['repeatTime']) ?? -1,
    prerequisites: idsOf(c['preRequisites']),
    tasks: compounds(c['tasks']).map((t) => ({
      index: num(t['index']) ?? -1,
      type: text(t['taskID']),
      consume: flag(t['consume']),
      autoConsume: flag(t['autoConsume']),
      ignoreNBT: flag(t['ignoreNBT']),
      partialMatch: flag(t['partialMatch']),
      allowCraftedFromStatistics: flag(t['allowCraftedFromStatistics']),
      items: compounds(t['requiredItems']).map(bqItem),
    })),
    rewards: compounds(c['rewards']).map((r) => ({
      index: num(r['index']) ?? -1,
      type: text(r['rewardID']),
      items: compounds(r['rewards']).map(bqItem),
      choices: compounds(r['choices']).map(bqItem),
    })),
  };
}

/** Task progress values: an int array (or, from older saves, a list of ints, or one int). */
function progressData(v: NbtValue | undefined): number[] {
  if (v instanceof Int32Array) return Array.from(v);
  if (Array.isArray(v)) return v.map((x) => num(x) ?? 0);
  const n = num(v);
  return n === null ? [] : [n];
}

function questProgress(p: NbtCompound): BqQuestProgress {
  return {
    completed: compounds(p['completed']).map((c) => ({
      uuid: text(c['uuid']).toLowerCase(),
      claimed: flag(c['claimed']),
    })),
    tasks: compounds(p['tasks']).map((t) => ({
      index: num(t['index']) ?? -1,
      type: text(t['taskID']),
      completeUsers: (Array.isArray(t['completeUsers']) ? t['completeUsers'] : []).map((u) =>
        text(u).toLowerCase(),
      ),
      userProgress: compounds(t['userProgress']).map((u) => ({
        uuid: text(u['uuid']).toLowerCase(),
        data: progressData(u['data']),
      })),
    })),
  };
}

/** Decodes one reassembled server message by its handler ID; unknown IDs are 'other'. */
export function decodeBqMessage(payload: NbtCompound): BqMessage {
  const id = text(payload['ID']);
  switch (id) {
    case BQ_MESSAGE.mainSync:
      return {
        type: 'main-sync',
        reset: flag(payload['reset']),
        respond: flag(payload['respond']),
      };
    case BQ_MESSAGE.questSync:
      return {
        type: 'quest-sync',
        merge: flag(payload['merge']),
        resetCompletion: flag(payload['resetCompletion']),
        entries: compounds(payload['data']).flatMap((e) => {
          const qid = bqIdOf(e);
          if (qid === null) return [];
          const config = e['config'];
          const progress = e['progress'];
          return [
            {
              id: qid,
              config: isCompound(config) ? questConfig(config) : null,
              progress: isCompound(progress) ? questProgress(progress) : null,
            },
          ];
        }),
      };
    case BQ_MESSAGE.cacheSync: {
      const data = compound(payload['data']);
      return {
        type: 'cache-sync',
        active: idsOf(data['activeQuests']),
        visible: idsOf(data['visibleQuests']),
        autoClaims: idsOf(data['autoClaims']),
      };
    }
    case BQ_MESSAGE.chapterSync:
      return {
        type: 'chapter-sync',
        merge: flag(payload['merge']),
        chapters: compounds(payload['data']).flatMap((c) => {
          const lineId = bqIdOf(c, 'questLineID');
          if (lineId === null) return [];
          const config = compound(c['config']);
          return [
            {
              id: lineId,
              name: text(compound(compound(config['properties'])['betterquesting'])['name']),
              quests: idsOf(config['quests']),
            },
          ];
        }),
      };
    case BQ_MESSAGE.choiceReward: {
      const questId = bqIdOf(payload);
      const rewardIndex = num(payload['rewardID']);
      const selection = num(payload['selection']);
      if (questId === null || rewardIndex === null || selection === null) {
        throw new ProtocolError('BQ: malformed choice_reward');
      }
      return { type: 'choice-reward', questId, rewardIndex, selection };
    }
    default:
      return { type: 'other', id: id.slice(0, 100) };
  }
}

// ---------------------------------------------------------------------------
// The quest book as the server records it for this player
// ---------------------------------------------------------------------------

/** One quest's progress, reduced to this player. */
interface PlayerProgress {
  /** Present once the server records the quest as completed by the player. */
  completion: { claimed: boolean } | null;
  tasks: Map<number, { complete: boolean; data: number[] }>;
}

function playerProgress(p: BqQuestProgress, player: string): PlayerProgress {
  const mine = p.completed.find((c) => c.uuid === player);
  return {
    completion: mine === undefined ? null : { claimed: mine.claimed },
    tasks: new Map(
      p.tasks.map((t) => [
        t.index,
        {
          complete: t.completeUsers.includes(player),
          data: t.userProgress.find((u) => u.uuid === player)?.data ?? [],
        },
      ]),
    ),
  };
}

/** Colour codes and runs of whitespace removed (quest names use Minecraft's § codes). */
export function plainText(s: string): string {
  return s.replace(/§./g, '').replace(/\s+/g, ' ').trim();
}

/** The agent's inventory naming for a quest item: name, plus @damage unless 0 or any (32767). */
export function questItemOf(i: BqItem): QuestBookItem {
  const anyDamage = i.damage === 32767;
  return {
    item: i.damage === 0 || anyDamage ? i.name : `${i.name}@${i.damage}`,
    count: Math.max(1, i.count),
    oreDict: i.oreDict === null ? null : i.oreDict.slice(0, 100),
    anyDamage,
  };
}

export interface QuestBookCounters {
  mainSyncs: number;
  questSyncs: number;
  cacheSyncs: number;
  choiceAcks: number;
}

/**
 * The server's quest book for this player, folded from its messages (pure: no sockets). The
 * client's own copy, like BQ's client-side QuestDatabase and QuestCache: quest configs and
 * this player's progress from quest_sync, the active set from cache_sync, chapters from
 * chapter_sync, acknowledged reward choices from choice_reward. A message that could not be
 * decoded makes the whole book unknown for the connection (fail closed).
 */
export class QuestBookModel {
  #player: string | null = null;
  readonly #quests = new Map<
    string,
    { config: BqQuestConfig | null; progress: PlayerProgress | null }
  >();
  #active: ReadonlySet<string> | null = null;
  readonly #chapters = new Map<string, BqChapter>();
  readonly #selections = new Map<string, number>();
  #fullSync = false;
  #problem: string | null = null;
  readonly #counters: QuestBookCounters = {
    mainSyncs: 0,
    questSyncs: 0,
    cacheSyncs: 0,
    choiceAcks: 0,
  };

  /** The player's UUID from Login Success: Better Questing keys progress by it. */
  setPlayer(uuid: string): void {
    this.#player = uuid.toLowerCase();
  }

  markProblem(reason: string): void {
    this.#problem ??= reason;
  }

  get problem(): string | null {
    return this.#problem;
  }

  /** Message counts, so a caller can wait for the server's next sync. */
  get counters(): Readonly<QuestBookCounters> {
    return { ...this.#counters };
  }

  /** The full database and the active set have arrived, and nothing went wrong. */
  get synced(): boolean {
    return this.#fullSync && this.#active !== null && this.#problem === null;
  }

  get size(): number {
    return this.#quests.size;
  }

  apply(m: BqMessage): void {
    switch (m.type) {
      case 'main-sync':
        this.#counters.mainSyncs += 1;
        if (m.reset) {
          // NetBulkSync.onClient: unloadDatabases, then wait for the new sync.
          this.#quests.clear();
          this.#chapters.clear();
          this.#selections.clear();
          this.#active = null;
          this.#fullSync = false;
        }
        return;
      case 'quest-sync': {
        const player = this.#player;
        if (player === null) {
          this.markProblem('quest progress arrived before the player was known');
          return;
        }
        // NetQuestSync.onClient: without `merge` the database is replaced.
        if (!m.merge) this.#quests.clear();
        for (const e of m.entries) {
          const q = this.#quests.get(e.id) ?? { config: null, progress: null };
          if (e.config !== null) q.config = e.config;
          // The server writes this player's whole progress for the quest: it replaces ours.
          if (e.progress !== null) q.progress = playerProgress(e.progress, player);
          this.#quests.set(e.id, q);
        }
        if (!m.merge) this.#fullSync = true;
        this.#counters.questSyncs += 1;
        return;
      }
      case 'cache-sync':
        this.#active = new Set(m.active);
        this.#counters.cacheSyncs += 1;
        return;
      case 'chapter-sync':
        if (!m.merge) this.#chapters.clear();
        for (const c of m.chapters) this.#chapters.set(c.id, c);
        return;
      case 'choice-reward':
        this.#selections.set(`${m.questId}#${m.rewardIndex}`, m.selection);
        this.#counters.choiceAcks += 1;
        return;
      case 'other':
        return;
    }
  }

  config(id: string): BqQuestConfig | null {
    return this.#quests.get(id)?.config ?? null;
  }

  /** QuestInstance.isComplete (non-global quests): the player has a completion record. */
  completed(id: string): boolean {
    return (this.#quests.get(id)?.progress?.completion ?? null) !== null;
  }

  /** QuestInstance.hasClaimed: a quest without rewards counts as claimed. */
  claimed(id: string): boolean {
    const q = this.#quests.get(id);
    const completion = q?.progress?.completion ?? null;
    if (completion === null) return false;
    return (q?.config?.rewards.length ?? 0) === 0 || completion.claimed;
  }

  /** In cache_sync's activeQuests. */
  active(id: string): boolean {
    return this.#active?.has(id) ?? false;
  }

  /**
   * QuestInstance.isUnlocked: no prerequisites, or questLogic over how many prerequisites
   * the player completed (prerequisites missing from the database never count as complete,
   * but count towards the total).
   */
  unlocked(id: string): boolean {
    const config = this.config(id);
    if (config === null) return false;
    const pre = config.prerequisites;
    if (pre.length === 0) return true;
    const done = pre.filter((p) => this.#quests.has(p) && this.completed(p)).length;
    return logicResult(config.questLogic, done, pre.length);
  }

  taskComplete(id: string, taskIndex: number): boolean {
    return this.#quests.get(id)?.progress?.tasks.get(taskIndex)?.complete ?? false;
  }

  taskProgress(id: string, taskIndex: number): number[] {
    return this.#quests.get(id)?.progress?.tasks.get(taskIndex)?.data ?? [];
  }

  /** The choice the server acknowledged for a choice reward, or null. */
  selection(id: string, rewardIndex: number): number | null {
    return this.#selections.get(`${id}#${rewardIndex}`) ?? null;
  }

  chapterNamed(name: string): BqChapter | null {
    return [...this.#chapters.values()].find((c) => plainText(c.name) === name) ?? null;
  }

  /**
   * The GameState view: the quests in `scope` (in its order) that the server knows. Tasks are
   * listed while a quest is active and not completed; rewards while it is completed and not
   * claimed. Unknown until the full sync and the active set have arrived.
   */
  toState(scope: readonly string[]): Known<QuestBook> {
    if (this.#problem !== null) return unknown(`quest book: ${this.#problem}`.slice(0, 200));
    if (!this.synced) {
      return unknown(QUEST_BOOK_SYNC_PENDING);
    }
    const quests: QuestBook['quests'] = [];
    for (const id of scope) {
      const config = this.config(id);
      if (config === null) continue;
      const active = this.active(id);
      const completed = this.completed(id);
      const claimed = this.claimed(id);
      quests.push({
        id,
        name: plainText(config.name).slice(0, 100),
        active,
        unlocked: this.unlocked(id),
        completed,
        claimed,
        taskLogic: config.taskLogic,
        tasks:
          active && !completed
            ? config.tasks.map((t) => ({
                index: t.index,
                type: t.type.slice(0, 64),
                complete: this.taskComplete(id, t.index),
                consume: t.consume,
                items: t.items.map(questItemOf),
                progress: this.taskProgress(id, t.index)
                  .slice(0, Math.max(t.items.length, 1))
                  .map((n) => Math.max(0, Math.trunc(n))),
              }))
            : [],
        rewards:
          completed && !claimed
            ? config.rewards.map((r) => {
                const choice = r.type === QUEST_REWARD.choice;
                return {
                  index: r.index,
                  type: r.type.slice(0, 64),
                  choice,
                  items: (choice ? r.choices : r.items).map(questItemOf),
                  selected: this.selection(id, r.index),
                };
              })
            : [],
      });
    }
    const parsed = QuestBookSchema.safeParse({ totalQuests: this.#quests.size, quests });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return unknown(
        `the quest book does not fit the agent's schema (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''})`.slice(
          0,
          200,
        ),
      );
    }
    return known(parsed.data);
  }
}

// ---------------------------------------------------------------------------
// The agent's quest-book clicks, checked against the live quest book just before sending
// ---------------------------------------------------------------------------

export type QuestBookRequest =
  | { kind: 'submit'; questId: string }
  | { kind: 'check'; questId: string; taskIndex: number }
  | { kind: 'claim'; questId: string; choice: number | null };

/**
 * Why the client must not send this request now, or null. The executor validated the action
 * against an observation; this re-checks the server's quest book as it is at sending time:
 * a quest the agent tracks, known to the server, and for a submit or a checkbox active,
 * unlocked and not completed; for a claim completed, unclaimed, with a valid choice.
 */
export function questBookRequestProblem(
  book: QuestBookModel,
  scope: readonly string[],
  req: QuestBookRequest,
): string | null {
  if (!book.synced) return book.problem ?? 'the quest book has not been synced yet';
  const id = req.questId;
  if (!scope.includes(id)) return `quest ${id} is not one the agent tracks`;
  const config = book.config(id);
  if (config === null) return `the server's quest book has no quest ${id}`;
  const name = `"${plainText(config.name)}"`;
  switch (req.kind) {
    case 'submit':
    case 'check': {
      if (book.completed(id)) return `${name} is already completed`;
      if (!book.active(id)) return `${name} is not active on the server`;
      if (!book.unlocked(id)) return `${name} is locked`;
      if (req.kind === 'submit') return null;
      const task = config.tasks.find((t) => t.index === req.taskIndex);
      if (task?.type !== QUEST_TASK.checkbox) {
        return `task ${req.taskIndex} of ${name} is not a checkbox`;
      }
      return book.taskComplete(id, req.taskIndex) ? `the checkbox of ${name} is ticked` : null;
    }
    case 'claim': {
      if (!book.completed(id)) return `${name} is not completed`;
      if (book.claimed(id)) return `the rewards of ${name} are already claimed`;
      const items = claimRewardItems(config, req.choice);
      return typeof items === 'string' ? `${name}: ${items}` : null;
    }
  }
}

/** The quest's choice reward, if it has exactly one; a string when it has more. */
export function choiceRewardOf(config: BqQuestConfig): BqRewardConfig | null | string {
  const choices = config.rewards.filter((r) => r.type === QUEST_REWARD.choice);
  if (choices.length > 1) return 'more than one choice reward';
  return choices[0] ?? null;
}

/**
 * The items a claim gives, by inventory name: every item reward's items and the chosen item
 * of the choice reward. A string when the choice does not fit the rewards.
 */
export function claimRewardItems(
  config: BqQuestConfig,
  choice: number | null,
): Map<string, number> | string {
  const choiceReward = choiceRewardOf(config);
  if (typeof choiceReward === 'string') return choiceReward;
  if (choiceReward === null && choice !== null) return 'it has no choice reward';
  if (choiceReward !== null && (choice === null || choice >= choiceReward.choices.length)) {
    return `choose one of the ${choiceReward.choices.length} items of its choice reward`;
  }
  const out = new Map<string, number>();
  const add = (i: BqItem): void => {
    const q = questItemOf(i);
    out.set(q.item, (out.get(q.item) ?? 0) + q.count);
  };
  for (const r of config.rewards) {
    if (r.type === QUEST_REWARD.choice) {
      const picked = choice === null ? undefined : r.choices[choice];
      if (picked !== undefined) add(picked);
    } else r.items.forEach(add);
  }
  return out;
}

/** "0 done; 1 [3/8 minecraft:dirt]" for messages. */
export function describeQuestTasks(book: QuestBookModel, id: string): string {
  const config = book.config(id);
  if (config === null) return 'unknown quest';
  return config.tasks
    .map((t) => {
      if (book.taskComplete(id, t.index)) return `${t.index} done`;
      const progress = book.taskProgress(id, t.index);
      const items = t.items
        .map((i, k) => `${progress[k] ?? 0}/${questItemOf(i).count} ${questItemOf(i).item}`)
        .join(', ');
      return `${t.index} ${t.type.replace(/^bq_standard:/, '')}${items === '' ? '' : ` [${items}]`}`;
    })
    .join('; ')
    .slice(0, 300);
}

import {
  BQ_CHANNEL,
  BqAssembler,
  encodeBqSlices,
} from '../../../src/bot/gtnh1710/better-questing.ts';
import {
  isCompound,
  nbtTag,
  type NbtCompound,
  type NbtTag,
  type NbtTagCompound,
  type NbtValue,
} from '../../../src/bot/gtnh1710/nbt.ts';
import { encodeFrame, encodeString, encodeVarShort } from '../../../src/bot/gtnh1710/wire.ts';
import { logicResult, type QuestLogic } from '../../../src/domain/quest-book.ts';
import type { FakeChestSim, FakeStack } from './fake-chests.ts';

/**
 * Better Questing 3.7.15-GTNH, server side, for one player, as read from the jar's bytecode
 * (docs/gtnh-compatibility.md, "Quest book"). Payload keys are written here by hand, not with
 * the client's decoders, so a wrong key on either side shows up as a test failure.
 *  - at join: main_sync {reset: 1, respond: 1}; the client's main_sync answer gets the full
 *    sync (setting_sync, quest_sync merge 0 with configs and this player's progress,
 *    chapter_sync, cache_sync);
 *  - QuestCache.updateCache: a quest is ACTIVE when unlocked (or lockedProgress) and not
 *    completed; cache_sync is sent when that changes;
 *  - the quest loop (EventHandler.onLivingUpdate, every 60 player ticks): an active, unlocked
 *    quest whose tasks are complete or ignored (optional retrieval), by taskLogic, completes;
 *  - inventory changes (PlayerContainerListener) re-count the non-consume retrieval tasks of
 *    ACTIVE quests only; quest_action 1 (detect) runs every incomplete task's detect: consume
 *    tasks REMOVE matching items from slots 0-39 in order (decrStackSize);
 *  - quest_action 0 claims (completed, unclaimed, every choice reward selected): rewards go
 *    into the inventory like addItemStackToInventory, and what does not fit is dropped;
 *  - task_checkbox ticks a checkbox task (no unlock check, like NetTaskCheckbox);
 *  - choice_reward stores the selection and echoes it.
 * Changed quests are sent as quest_sync (merge 1, resetCompletion 1, progress only).
 */

export interface FakeQuestItem {
  name: string;
  damage?: number;
  count: number;
  oreDict?: string;
}

export type FakeQuestTask =
  | { type: 'bq_standard:checkbox' }
  | { type: 'bq_standard:retrieval'; consume?: boolean; items: FakeQuestItem[] }
  | { type: 'bq_standard:optional_retrieval'; items: FakeQuestItem[] }
  | { type: 'bq_standard:crafting'; items: FakeQuestItem[]; fromStatistics?: boolean }
  | { type: 'bq_standard:hunt'; target: string; required: number };

export type FakeQuestReward =
  | { type: 'bq_standard:item'; items: FakeQuestItem[] }
  | { type: 'bq_standard:choice'; choices: FakeQuestItem[] };

export interface FakeQuest {
  id: string;
  name: string;
  prerequisites?: string[];
  questLogic?: QuestLogic;
  taskLogic?: QuestLogic;
  lockedProgress?: boolean;
  main?: boolean;
  tasks: FakeQuestTask[];
  rewards?: FakeQuestReward[];
}

export interface FakeQuestBookOptions {
  quests: FakeQuest[];
  /** Quests the player completed before joining. */
  completed?: Array<{ id: string; claimed: boolean }>;
  /** Player ticks (C03/C06) between quest-loop runs: Better Questing's is 60 (3 s). */
  loopTicks?: number;
  /** Filler quests with random text, so the full sync spans several 20,480-byte slices. */
  fillerQuests?: number;
  /** Never answer the client's main_sync (the client must stay "waiting"). */
  ignoreMainSync?: boolean;
  /** Send the full quest_sync with one slice damaged. */
  corruptFullSync?: boolean;
  /** Ore dictionary names and the item names they hold (for matching). */
  oreDict?: Record<string, string[]>;
  /** Item registry of the fake server ([id, name]), for inventory matching and rewards. */
  items: ReadonlyArray<[number, string]>;
}

interface TaskState {
  complete: boolean;
  progress: number[];
}

interface QuestState {
  def: FakeQuest;
  completion: { claimed: boolean } | null;
  tasks: TaskState[];
  selections: Map<number, number>;
}

/** A tiny deterministic PRNG (filler text). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const PLAYER = '3dfc863b-6ad1-3d61-b872-36bf96373604';

const idTags = (id: string, prefix = 'questID'): NbtTagCompound => {
  const [high, low] = id.split(':').map((h) => BigInt(h)) as [bigint, bigint];
  return { [`${prefix}High`]: nbtTag.long(high), [`${prefix}Low`]: nbtTag.long(low) };
};

const itemTag = (i: FakeQuestItem): NbtTag =>
  nbtTag.compound({
    id: nbtTag.string(i.name),
    Count: nbtTag.int(i.count),
    Damage: nbtTag.short(i.damage ?? 0),
    OreDict: nbtTag.string(i.oreDict ?? ''),
  });

const n = (v: NbtValue | undefined): number =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN;

const half = (v: NbtValue | undefined): string =>
  typeof v === 'bigint' || typeof v === 'number' ? v.toString() : 'NaN';
const idOf = (c: NbtCompound): string => `${half(c['questIDHigh'])}:${half(c['questIDLow'])}`;

export class FakeQuestBookSim {
  readonly player = PLAYER;
  /** Every message the client sent: its handler ID and payload. */
  readonly received: Array<{ id: string; payload: NbtCompound }> = [];
  /** Reward items that did not fit and were dropped into the world. */
  readonly dropped: FakeStack[] = [];
  /** quest_sync messages sent (full and dirty). */
  questSyncsSent = 0;
  readonly #opts: FakeQuestBookOptions;
  readonly #quests = new Map<string, QuestState>();
  readonly #chest: FakeChestSim;
  #assembler = new BqAssembler();
  #send: (frame: Buffer) => void = () => undefined;
  #ticks = 0;
  #active = new Set<string>();
  #synced = false;

  constructor(opts: FakeQuestBookOptions, chest: FakeChestSim) {
    this.#opts = opts;
    this.#chest = chest;
    for (const def of opts.quests) {
      const done = opts.completed?.find((c) => c.id === def.id);
      this.#quests.set(def.id, {
        def,
        completion: done === undefined ? null : { claimed: done.claimed },
        tasks: def.tasks.map((t) => ({
          complete: done !== undefined,
          progress: 'items' in t ? t.items.map(() => 0) : [],
        })),
        selections: new Map(),
      });
    }
    this.#active = this.#computeActive();
    chest.onInventoryChange = () => this.#onInventoryChange();
  }

  /** Server-side state, for assertions. */
  quest(id: string): {
    completed: boolean;
    claimed: boolean;
    tasks: TaskState[];
    active: boolean;
  } {
    const q = this.#quests.get(id);
    if (q === undefined) throw new Error(`no quest ${id}`);
    return {
      completed: q.completion !== null,
      claimed: q.completion?.claimed ?? false,
      tasks: q.tasks.map((t) => ({ ...t, progress: [...t.progress] })),
      active: this.#active.has(id),
    };
  }

  /** IDs of the client's messages, in order. */
  receivedIds(): string[] {
    return this.received.map((r) => r.id);
  }

  /** PlayerLoggedInEvent: main_sync {reset, respond}. */
  onJoin(send: (frame: Buffer) => void): void {
    this.#send = send;
    this.#assembler = new BqAssembler();
    this.#synced = false;
    this.#message('betterquesting:main_sync', {
      reset: nbtTag.bool(true),
      respond: nbtTag.bool(true),
    });
  }

  /** A C17 on BQ_NET_CHAN from the client. */
  handle(data: Buffer): void {
    const payload = this.#assembler.push(data);
    if (payload === null) return;
    const id = typeof payload['ID'] === 'string' ? payload['ID'] : '';
    this.received.push({ id, payload });
    switch (id) {
      case 'betterquesting:main_sync':
        if (!this.#opts.ignoreMainSync) this.#fullSync();
        return;
      case 'betterquesting:quest_action': {
        const action = n(payload['action']);
        const ids = (Array.isArray(payload['questIDs']) ? payload['questIDs'] : [])
          .filter((c): c is NbtCompound => isCompound(c))
          .map(idOf);
        if (action === 0) this.#claim(ids);
        else if (action === 1) this.#detect(ids);
        return;
      }
      case 'bq_standard:task_checkbox': {
        const q = this.#quests.get(idOf(payload));
        const t = q?.tasks[n(payload['taskID'])];
        const def = q?.def.tasks[n(payload['taskID'])];
        if (q === undefined || t === undefined || def?.type !== 'bq_standard:checkbox') return;
        t.complete = true;
        this.#dirty([q.def.id]);
        return;
      }
      case 'bq_standard:choice_reward': {
        const questId = idOf(payload);
        const q = this.#quests.get(questId);
        const rewardIndex = n(payload['rewardID']);
        const selection = n(payload['selection']);
        if (q === undefined || q.def.rewards?.[rewardIndex]?.type !== 'bq_standard:choice') return;
        q.selections.set(rewardIndex, selection);
        this.#message('bq_standard:choice_reward', {
          ...idTags(questId),
          rewardID: nbtTag.int(rewardIndex),
          selection: nbtTag.int(selection),
        });
        return;
      }
      default:
        return;
    }
  }

  /** A player tick (C03 or C06): every `loopTicks` the quest loop runs. */
  onPlayerTick(): void {
    this.#ticks += 1;
    if (this.#ticks % (this.#opts.loopTicks ?? 60) === 0) this.#questLoop();
  }

  // -------------------------------------------------------------------------

  #unlocked(q: QuestState): boolean {
    const pre = q.def.prerequisites ?? [];
    if (pre.length === 0) return true;
    const done = pre.filter((p) => this.#quests.get(p)?.completion != null).length;
    return logicResult(q.def.questLogic ?? 'AND', done, pre.length);
  }

  #computeActive(): Set<string> {
    const out = new Set<string>();
    for (const q of this.#quests.values()) {
      if ((this.#unlocked(q) || q.def.lockedProgress === true) && q.completion === null) {
        out.add(q.def.id);
      }
    }
    return out;
  }

  /** Does an inventory item (by name and damage) match a quest item? */
  #matches(item: FakeQuestItem, stack: FakeStack): boolean {
    const name = this.#opts.items.find(([id]) => id === stack.id)?.[1];
    if (name === undefined) return false;
    const damageOk = (item.damage ?? 0) === 32767 || (item.damage ?? 0) === stack.damage;
    if (name === item.name && damageOk) return true;
    return item.oreDict !== undefined && (this.#opts.oreDict?.[item.oreDict] ?? []).includes(name);
  }

  /** InventoryPlayer slots 0-39 in window-0 numbering: hotbar, main, then armor. */
  #inventoryOrder(): number[] {
    return [
      ...Array.from({ length: 9 }, (_, i) => 36 + i),
      ...Array.from({ length: 27 }, (_, i) => 9 + i),
      8,
      7,
      6,
      5,
    ];
  }

  /** TaskRetrieval.detect for one task. */
  #retrievalDetect(def: { consume?: boolean; items: FakeQuestItem[] }, t: TaskState): void {
    if (t.complete) return;
    const slots = this.#chest.playerSlots();
    if (def.consume === true) {
      def.items.forEach((item, i) => {
        for (const slot of this.#inventoryOrder()) {
          const need = item.count - (t.progress[i] ?? 0);
          const s = slots[slot];
          if (need <= 0 || s == null || !this.#matches(item, s)) continue;
          t.progress[i] = (t.progress[i] ?? 0) + this.#chest.take(slot, need);
        }
      });
    } else {
      // Unfinished counts start again from zero and are re-counted from what is held.
      def.items.forEach((item, i) => {
        if ((t.progress[i] ?? 0) < item.count) t.progress[i] = 0;
      });
      for (const slot of this.#inventoryOrder()) {
        const s = slots[slot];
        if (s == null) continue;
        let left = s.count;
        def.items.forEach((item, i) => {
          const have = t.progress[i] ?? 0;
          if (left <= 0 || have >= item.count || !this.#matches(item, s)) return;
          const add = Math.min(item.count - have, left);
          t.progress[i] = have + add;
          left -= add;
        });
      }
    }
    if (def.items.every((item, i) => (t.progress[i] ?? 0) >= item.count)) t.complete = true;
  }

  /** PlayerContainerListener -> ITaskInventory.onInventoryChange, for ACTIVE quests only. */
  #onInventoryChange(): void {
    if (!this.#synced) return;
    const changed: string[] = [];
    for (const id of this.#active) {
      const q = this.#quests.get(id);
      if (q === undefined) continue;
      q.def.tasks.forEach((def, i) => {
        const t = q.tasks[i];
        if (t === undefined) return;
        const isRetrieval =
          def.type === 'bq_standard:retrieval' || def.type === 'bq_standard:optional_retrieval';
        if (!isRetrieval || ('consume' in def && def.consume === true)) return;
        const before = JSON.stringify(t);
        this.#retrievalDetect(def, t);
        if (JSON.stringify(t) !== before) changed.push(id);
      });
    }
    if (changed.length > 0) this.#dirty([...new Set(changed)]);
  }

  /** NetQuestAction 1 -> QuestInstance.detect. */
  #detect(ids: string[]): void {
    const changed: string[] = [];
    for (const id of ids) {
      const q = this.#quests.get(id);
      if (q === undefined || q.completion !== null || !this.#unlocked(q)) continue;
      q.def.tasks.forEach((def, i) => {
        const t = q.tasks[i];
        if (t === undefined || t.complete) return;
        if (def.type === 'bq_standard:retrieval' || def.type === 'bq_standard:optional_retrieval') {
          this.#retrievalDetect(def, t);
        }
      });
      changed.push(id);
    }
    if (changed.length > 0) this.#dirty(changed);
  }

  /** QuestInstance.update for active quests (the 3 s loop). */
  #questLoop(): void {
    if (!this.#synced) return;
    const completed: string[] = [];
    for (const id of this.#active) {
      const q = this.#quests.get(id);
      if (q === undefined || q.completion !== null || !this.#unlocked(q)) continue;
      const done = q.def.tasks.filter(
        (def, i) => q.tasks[i]?.complete === true || def.type === 'bq_standard:optional_retrieval',
      ).length;
      if (
        q.def.tasks.length === 0 ||
        logicResult(q.def.taskLogic ?? 'AND', done, q.def.tasks.length)
      ) {
        q.completion = { claimed: false };
        completed.push(id);
      }
    }
    if (completed.length > 0) this.#dirty(completed);
  }

  /** NetQuestAction 0 -> claimQuest. */
  #claim(ids: string[]): void {
    const changed: string[] = [];
    for (const id of ids) {
      const q = this.#quests.get(id);
      const rewards = q?.def.rewards ?? [];
      if (q?.completion == null || q.completion.claimed || rewards.length === 0) continue;
      const choicesOk = rewards.every((r, i) => {
        if (r.type !== 'bq_standard:choice') return true;
        const sel = q.selections.get(i);
        return sel !== undefined && sel >= 0 && sel < r.choices.length;
      });
      if (!choicesOk) continue;
      rewards.forEach((r, i) => {
        const items =
          r.type === 'bq_standard:item' ? r.items : [r.choices[q.selections.get(i) ?? 0]];
        for (const item of items) {
          if (item === undefined) continue;
          const itemId = this.#opts.items.find(([, name]) => name === item.name)?.[0];
          if (itemId === undefined) continue;
          const stack = { id: itemId, count: item.count, damage: item.damage ?? 0 };
          const left = this.#chest.pickUp(stack);
          if (left > 0) this.dropped.push({ ...stack, count: left });
        }
      });
      q.completion.claimed = true;
      changed.push(id);
    }
    if (changed.length > 0) this.#dirty(changed);
  }

  /** Changed quests: progress-only quest_sync, then cache_sync if the active set changed. */
  #dirty(ids: string[]): void {
    this.#message('betterquesting:quest_sync', {
      merge: nbtTag.bool(true),
      resetCompletion: nbtTag.bool(true),
      data: nbtTag.list(
        'compound',
        ids.map((id) => {
          const q = this.#quests.get(id) as QuestState;
          return nbtTag.compound({ progress: this.#progressTag(q), ...idTags(id) });
        }),
      ),
    });
    this.questSyncsSent += 1;
    const active = this.#computeActive();
    if ([...active].sort().join() !== [...this.#active].sort().join()) {
      this.#active = active;
      this.#cacheSync();
    }
  }

  #fullSync(): void {
    this.#message('betterquesting:setting_sync', { data: nbtTag.compound({}) });
    const filler = this.#opts.fillerQuests ?? 0;
    const random = lcg(7);
    const fillerTags = Array.from({ length: filler }, (_, i) =>
      nbtTag.compound({
        config: nbtTag.compound({
          properties: nbtTag.compound({
            betterquesting: nbtTag.compound({
              name: nbtTag.string(`Filler ${i}`),
              desc: nbtTag.string(
                Array.from({ length: 96 }, () => Math.floor(random() * 16).toString(16)).join(''),
              ),
              questLogic: nbtTag.string('AND'),
              taskLogic: nbtTag.string('AND'),
            }),
          }),
          tasks: nbtTag.list('compound', []),
          rewards: nbtTag.list('compound', []),
          preRequisites: nbtTag.list('compound', []),
        }),
        progress: nbtTag.compound({
          completed: nbtTag.list('compound', []),
          tasks: nbtTag.list('compound', []),
        }),
        ...idTags(`9:${i}`),
      }),
    );
    this.#message(
      'betterquesting:quest_sync',
      {
        merge: nbtTag.bool(false),
        resetCompletion: nbtTag.bool(false),
        data: nbtTag.list('compound', [
          ...[...this.#quests.values()].map((q) =>
            nbtTag.compound({
              config: this.#configTag(q.def),
              progress: this.#progressTag(q),
              ...idTags(q.def.id),
            }),
          ),
          ...fillerTags,
        ]),
      },
      this.#opts.corruptFullSync === true,
    );
    this.questSyncsSent += 1;
    this.#message('betterquesting:chapter_sync', {
      merge: nbtTag.bool(false),
      data: nbtTag.list('compound', [
        nbtTag.compound({
          ...idTags('0:1', 'questLineID'),
          config: nbtTag.compound({
            properties: nbtTag.compound({
              betterquesting: nbtTag.compound({ name: nbtTag.string('§lTier 0 - Stone Age') }),
            }),
            quests: nbtTag.list(
              'compound',
              [...this.#quests.keys()].map((id) =>
                nbtTag.compound({ ...idTags(id), x: nbtTag.int(0), y: nbtTag.int(0) }),
              ),
            ),
          }),
        }),
      ]),
      order: nbtTag.list('compound', [nbtTag.compound(idTags('0:1', 'questLineID'))]),
    });
    this.#message('betterquesting:life_sync', { data: nbtTag.compound({}) });
    this.#message('betterquesting:name_sync', { data: nbtTag.list('compound', []) });
    this.#synced = true;
    this.#active = this.#computeActive();
    this.#cacheSync();
  }

  #cacheSync(): void {
    const ids = (set: Iterable<string>): NbtTag =>
      nbtTag.list(
        'compound',
        [...set].map((id) => nbtTag.compound(idTags(id))),
      );
    this.#message('betterquesting:cache_sync', {
      data: nbtTag.compound({
        visibleQuests: ids(this.#quests.keys()),
        activeQuests: ids(this.#active),
        autoClaims: ids([]),
        markedDirty: ids([]),
        resetSchedule: nbtTag.list('compound', []),
      }),
    });
  }

  /** QuestInstance.writeToNBT. */
  #configTag(def: FakeQuest): NbtTag {
    return nbtTag.compound({
      properties: nbtTag.compound({
        betterquesting: nbtTag.compound({
          name: nbtTag.string(def.name),
          questLogic: nbtTag.string(def.questLogic ?? 'AND'),
          taskLogic: nbtTag.string(def.taskLogic ?? 'AND'),
          isMain: nbtTag.bool(def.main ?? false),
          lockedProgress: nbtTag.bool(def.lockedProgress ?? false),
          repeatTime: nbtTag.int(-1),
          visibility: nbtTag.string('NORMAL'),
        }),
      }),
      tasks: nbtTag.list(
        'compound',
        def.tasks.map((t, index) => {
          const base: NbtTagCompound = {
            taskID: nbtTag.string(t.type),
            index: nbtTag.int(index),
          };
          if (t.type === 'bq_standard:retrieval' || t.type === 'bq_standard:optional_retrieval') {
            return nbtTag.compound({
              ...base,
              requiredItems: nbtTag.list('compound', t.items.map(itemTag)),
              consume: nbtTag.bool('consume' in t && t.consume === true),
              autoConsume: nbtTag.bool(false),
              ignoreNBT: nbtTag.bool(true),
              partialMatch: nbtTag.bool(true),
              groupDetect: nbtTag.bool(false),
            });
          }
          if (t.type === 'bq_standard:crafting') {
            return nbtTag.compound({
              ...base,
              requiredItems: nbtTag.list('compound', t.items.map(itemTag)),
              ignoreNBT: nbtTag.bool(true),
              partialMatch: nbtTag.bool(true),
              allowCraft: nbtTag.bool(true),
              allowSmelt: nbtTag.bool(true),
              allowAnvil: nbtTag.bool(false),
              allowCraftedFromStatistics: nbtTag.bool(t.fromStatistics === true),
            });
          }
          if (t.type === 'bq_standard:hunt') {
            return nbtTag.compound({
              ...base,
              target: nbtTag.string(t.target),
              required: nbtTag.int(t.required),
            });
          }
          return nbtTag.compound(base);
        }),
      ),
      rewards: nbtTag.list(
        'compound',
        (def.rewards ?? []).map((r, index) =>
          nbtTag.compound({
            rewardID: nbtTag.string(r.type),
            index: nbtTag.int(index),
            ...(r.type === 'bq_standard:item'
              ? { rewards: nbtTag.list('compound', r.items.map(itemTag)) }
              : { choices: nbtTag.list('compound', r.choices.map(itemTag)) }),
          }),
        ),
      ),
      preRequisites: nbtTag.list(
        'compound',
        (def.prerequisites ?? []).map((p) => nbtTag.compound(idTags(p))),
      ),
    });
  }

  /** QuestInstance.writeProgressToNBT for this player (plus another player, to be ignored). */
  #progressTag(q: QuestState): NbtTag {
    const other = '61cb1b75-ae88-3692-8d0c-e959380993c6';
    return nbtTag.compound({
      completed: nbtTag.list(
        'compound',
        q.completion === null
          ? []
          : [
              nbtTag.compound({
                claimed: nbtTag.bool(q.completion.claimed),
                timestamp: nbtTag.long(1_759_000_000_000n),
                uuid: nbtTag.string(PLAYER),
              }),
            ],
      ),
      tasks: nbtTag.list(
        'compound',
        q.def.tasks.map((def, index) => {
          const t = q.tasks[index] as TaskState;
          return nbtTag.compound({
            completeUsers: nbtTag.list(
              'string',
              [...(t.complete ? [PLAYER] : []), other].map((u) => nbtTag.string(u)),
            ),
            userProgress: nbtTag.list(
              'compound',
              'items' in def
                ? [
                    nbtTag.compound({
                      uuid: nbtTag.string(PLAYER),
                      data: nbtTag.intArray(t.progress),
                    }),
                    nbtTag.compound({
                      uuid: nbtTag.string(other),
                      data: nbtTag.intArray(def.items.map((i) => i.count)),
                    }),
                  ]
                : [],
            ),
            taskID: nbtTag.string(def.type),
            index: nbtTag.int(index),
          });
        }),
      ),
    });
  }

  /** One message as PacketSender sends it: sliced PacketQuesting frames on BQ_NET_CHAN. */
  #message(id: string, payload: NbtTagCompound, corrupt = false): void {
    encodeBqSlices(id, payload).forEach((data, i) => {
      const bytes =
        corrupt && i === 0 ? Buffer.concat([data.subarray(0, 8), Buffer.alloc(8)]) : data;
      this.#send(
        encodeFrame(
          0x3f,
          Buffer.concat([encodeString(BQ_CHANNEL), encodeVarShort(bytes.length), bytes]),
        ),
      );
    });
  }
}

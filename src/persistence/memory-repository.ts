import { z } from 'zod';
import { ItemCountsSchema } from '../domain/common.ts';
import { MAX_JOURNAL_LINE } from '../planner/plan-schema.ts';
import type { Clock } from '../util/clock.ts';
import type { Db } from './database.ts';

/** Keys in agent_state. */
export const CURRENT_TASK_KEY = 'current_task';
/** agent_state key prefix for a task's item requirements: `task_requirements:<taskId>`. */
export const TASK_REQUIREMENTS_PREFIX = 'task_requirements:';
/** agent_state key prefix for a building task's blueprint lines: `task_blueprint:<taskId>`. */
export const TASK_BLUEPRINT_PREFIX = 'task_blueprint:';
/** agent_state key prefix for a task's journal: `task_journal:<taskId>`. */
export const TASK_JOURNAL_PREFIX = 'task_journal:';
/** agent_state key prefix for the progress of a task's GATHER plan step: `task_gather:<taskId>`. */
export const TASK_GATHER_PREFIX = 'task_gather:';
/** Journal lines kept in full; older ones are folded into one summary line. */
export const JOURNAL_KEEP = 16;

const JournalSchema = z.array(z.strictObject({ at: z.string(), text: z.string().max(300) }));

/**
 * Small pieces of agent memory that the live server cannot tell the agent: which task it
 * is working on, and what it last saw in each configured container.
 */
export class MemoryRepository {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  getValue(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM agent_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setValue(key: string, value: string | null): void {
    if (value === null) {
      this.#db.prepare('DELETE FROM agent_state WHERE key = ?').run(key);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO agent_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.#clock.now().toISOString());
  }

  /** A building task's blueprint: route lines ("place <item> at (x, y, z) (role)"). */
  taskBlueprint(taskId: string): string[] | null {
    const raw = this.getValue(`${TASK_BLUEPRINT_PREFIX}${taskId}`);
    return raw === null ? null : z.array(z.string().max(300)).max(32).parse(JSON.parse(raw));
  }

  setTaskBlueprint(taskId: string, lines: readonly string[] | null): void {
    this.setValue(
      `${TASK_BLUEPRINT_PREFIX}${taskId}`,
      lines === null ? null : JSON.stringify(lines.slice(0, 32)),
    );
  }

  /** The items a task's goal needs (item -> count), or null. */
  taskRequirements(taskId: string): Record<string, number> | null {
    const raw = this.getValue(`${TASK_REQUIREMENTS_PREFIX}${taskId}`);
    return raw === null ? null : ItemCountsSchema.parse(JSON.parse(raw));
  }

  setTaskRequirements(taskId: string, items: Record<string, number> | null): void {
    this.setValue(
      `${TASK_REQUIREMENTS_PREFIX}${taskId}`,
      items === null || Object.keys(items).length === 0
        ? null
        : JSON.stringify(ItemCountsSchema.parse(items)),
    );
  }

  /**
   * A task's journal: what happened at each checkpoint (plans made, done or failed, quests,
   * interruptions), oldest first. Compacted like a conversation: past JOURNAL_KEEP lines,
   * the oldest are folded into a single "earlier" summary line, so it stays small.
   */
  journal(taskId: string): Array<{ at: string; text: string }> {
    const raw = this.getValue(`${TASK_JOURNAL_PREFIX}${taskId}`);
    return raw === null ? [] : JournalSchema.parse(JSON.parse(raw));
  }

  appendJournal(taskId: string, text: string): void {
    const entries = [
      ...this.journal(taskId),
      { at: this.#clock.now().toISOString(), text: text.slice(0, MAX_JOURNAL_LINE) },
    ];
    let kept = entries;
    if (entries.length > JOURNAL_KEEP + 1) {
      const old = entries.slice(0, entries.length - JOURNAL_KEEP);
      kept = [
        { at: (old[0] as { at: string }).at, text: compactJournal(old.map((e) => e.text)) },
        ...entries.slice(entries.length - JOURNAL_KEEP),
      ];
    }
    this.setValue(`${TASK_JOURNAL_PREFIX}${taskId}`, JSON.stringify(kept));
  }

  /** Records what a container held at `observedAt` (a newer observation replaces an older one). */
  rememberContainer(containerId: string, items: Record<string, number>, observedAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO container_contents (container_id, items_json, observed_at) VALUES (?, ?, ?)
         ON CONFLICT(container_id) DO UPDATE SET items_json = excluded.items_json,
           observed_at = excluded.observed_at
         WHERE excluded.observed_at >= container_contents.observed_at`,
      )
      .run(containerId, JSON.stringify(ItemCountsSchema.parse(items)), observedAt);
  }

  recallContainer(
    containerId: string,
  ): { items: Record<string, number>; observedAt: string } | null {
    const row = this.#db
      .prepare('SELECT items_json, observed_at FROM container_contents WHERE container_id = ?')
      .get(containerId) as { items_json: string; observed_at: string } | undefined;
    if (row === undefined) return null;
    return {
      items: ItemCountsSchema.parse(JSON.parse(row.items_json)),
      observedAt: z.string().parse(row.observed_at),
    };
  }
}

/**
 * Folds journal lines into one: counts of plans made, done and failed, quests completed and
 * interruptions, then the most recent failure reasons (what to avoid). Deterministic.
 */
export function compactJournal(lines: readonly string[]): string {
  const prior = lines.find((l) => l.startsWith('earlier: '));
  const body = lines.filter((l) => !l.startsWith('earlier: '));
  const count = (re: RegExp): number => body.filter((l) => re.test(l)).length;
  const failures = body
    .filter((l) => / failed| escalated/.test(l))
    .slice(-2)
    .map((l) => l.replace(/^plan #\d+ /, '').slice(0, 80));
  const parts = [
    `${count(/^new plan /)} plans made`,
    `${count(/^plan #\d+ done/)} done`,
    `${count(/ failed/)} failed`,
    `${count(/^QUEST /)} quests completed`,
    `${count(/^interrupted/)} interruptions`,
  ];
  const text =
    `earlier: ${parts.join(', ')}` +
    (failures.length > 0 ? `; recent failures: ${failures.join(' | ')}` : '') +
    (prior !== undefined ? ` (before that: ${prior.slice('earlier: '.length, 120)})` : '');
  return text.slice(0, 300);
}

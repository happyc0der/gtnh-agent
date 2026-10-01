import { z } from 'zod';
import { ItemCountsSchema } from '../domain/common.ts';
import type { Clock } from '../util/clock.ts';
import type { Db } from './database.ts';

/** Keys in agent_state. */
export const CURRENT_TASK_KEY = 'current_task';
/** agent_state key prefix for a task's item requirements: `task_requirements:<taskId>`. */
export const TASK_REQUIREMENTS_PREFIX = 'task_requirements:';

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

import { migration001Initial } from './001-initial.ts';
import { migration002Plans } from './002-plans.ts';
import { migration003LiveTasks } from './003-live-tasks.ts';
import { migration004TaskMachines } from './004-task-machines.ts';
import { migration005WorldMemory } from './005-world-memory.ts';
import { migration006WindowLayouts } from './006-window-layouts.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only list. Never edit an applied migration; add a new one.
 * Migrations are TS modules (not .sql files) so they ship with `tsc` output unchanged.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration001Initial,
  migration002Plans,
  migration003LiveTasks,
  migration004TaskMachines,
  migration005WorldMemory,
  migration006WindowLayouts,
];

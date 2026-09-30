import { migration001Initial } from './001-initial.ts';
import { migration002Plans } from './002-plans.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only list. Never edit an applied migration; add a new one.
 * Migrations are TS modules (not .sql files) so they ship with `tsc` output unchanged.
 */
export const MIGRATIONS: readonly Migration[] = [migration001Initial, migration002Plans];

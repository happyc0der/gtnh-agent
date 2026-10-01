import { describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { compactJournal, JOURNAL_KEEP } from '../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../src/persistence/repositories.ts';
import { buildPlannerRequest } from '../../src/planner/planner-provider.ts';
import { systemClock } from '../../src/util/clock.ts';
import { makeState, safetyCtx } from '../fixtures/index.ts';

describe('the task journal: checkpoints, compacted', () => {
  it('keeps the recent lines and folds the older ones into one summary line', () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    for (let i = 1; i <= 30; i++) {
      repos.memory.appendJournal('t', `new plan #${i}: dig sand (8 steps)`);
      if (i % 3 === 0) {
        repos.memory.appendJournal('t', `plan #${i} failed at step 2 (DIG_BLOCK): out of reach`);
      } else {
        repos.memory.appendJournal('t', `plan #${i} done: dig sand`);
      }
    }
    const lines = repos.memory.journal('t').map((e) => e.text);
    expect(lines).toHaveLength(JOURNAL_KEEP + 1);
    expect(lines[0]).toMatch(/^earlier: \d+ plans made, \d+ done, \d+ failed/);
    expect(lines.at(-1)).toBe('plan #30 failed at step 2 (DIG_BLOCK): out of reach');
    // Another task's journal is separate.
    expect(repos.memory.journal('other')).toEqual([]);
  });

  it('summarises counts and the latest failures, and nests an earlier summary', () => {
    const text = compactJournal([
      'earlier: 3 plans made, 2 done, 1 failed, 0 quests completed, 0 interruptions',
      'new plan #4: x (2 steps)',
      'plan #4 failed at step 1 (MOVE_TO): blocked by minecraft:cactus',
      'interrupted: needs attention after: RETREAT_HOME',
      'QUEST "Sand: The Gathering" completed',
    ]);
    expect(text).toMatch(
      /^earlier: 1 plans made, 0 done, 1 failed, 1 quests completed, 1 interruptions/,
    );
    expect(text).toContain('blocked by minecraft:cactus');
    expect(text).toContain('(before that: 3 plans made');
  });

  it('reaches the planner in its request', () => {
    const request = buildPlannerRequest({
      state: makeState(),
      safety: safetyCtx(),
      maxPlanSteps: 8,
      recentActions: [],
      recentFailures: [],
      journal: ['new plan #1: dig sand (8 steps)', 'plan #1 done: dig sand'],
    });
    expect(request.journal).toEqual(['new plan #1: dig sand (8 steps)', 'plan #1 done: dig sand']);
  });
});

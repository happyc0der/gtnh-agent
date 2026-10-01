import type { Repositories } from '../../persistence/repositories.ts';
import { describeSystem1Stats } from '../../system1/model-cadence.ts';
import type { CycleResult } from '../loop/agent-loop.ts';
import type { PlayEvent } from './play.ts';

/**
 * Play's narration: the events it emits about a cycle (System 1's choice, a new plan, what
 * the executor reported), and one human-readable line per event for the terminal (cli play).
 */

/** A cycle of a play session, for narration (the same event the quest sessions emit). */
export function cycleEvent(
  repos: Repositories,
  session: number,
  r: CycleResult,
  index: number,
): PlayEvent {
  return {
    kind: 'cycle',
    session,
    index,
    summary: r.summary,
    decision:
      r.decision === null || r.decision === undefined
        ? null
        : {
            provider: r.decision.provider,
            decision: r.decision.decision,
            reasons: r.decision.reasonCodes,
            confidence: r.decision.confidence,
          },
    newPlan: r.planner?.kind === 'plan-accepted' ? planOf(repos, r.planner.planId) : null,
    detail: r.outcome?.execution?.message ?? null,
  };
}

/** A stored plan as one line per step, for narration. */
export function planOf(
  repos: Repositories,
  planId: number,
): { goal: string; explanation: string; steps: string[] } | null {
  const p = repos.plans.get(planId);
  if (p === null) return null;
  return {
    goal: p.plan.goal,
    explanation: p.plan.explanation,
    steps: p.plan.steps.map(
      (s) => `${s.step}. ${s.action.type} ${JSON.stringify(s.action.args)}  -- ${s.rationale}`,
    ),
  };
}

/** One human-readable line per play event, for the terminal. */
export function describePlayEvent(e: PlayEvent): string {
  switch (e.kind) {
    case 'quest-completed':
      return `QUEST DONE: "${e.quest}" (${e.completed}/${e.total})`;
    case 'scout':
      return `goal: scout the area before settling (${e.chunksSeen} chunk(s) seen so far)${e.created ? ' (new task)' : ''}`;
    case 'goal': {
      const missing = Object.entries(e.missing)
        .map(([item, n]) => `${n} ${item}`)
        .join(', ');
      return `goal: "${e.quest}"${missing === '' ? '' : ` - missing ${missing}`}${e.created ? ' (new task)' : ''}`;
    }
    case 'cycle': {
      const tag = `  [${e.session}.${e.index}]`;
      const lines: string[] = [];
      if (e.decision !== null) {
        lines.push(
          `${tag} SYSTEM 1 (${e.decision.provider}): ${e.decision.decision} ` +
            `[${e.decision.reasons.join(', ')}] confidence ${e.decision.confidence}`,
        );
      }
      if (e.newPlan !== null) {
        lines.push(`${tag} PLANNER new plan: ${e.newPlan.goal}`);
        lines.push(`        why: ${e.newPlan.explanation}`);
        for (const step of e.newPlan.steps) lines.push(`        ${step}`);
      }
      lines.push(
        `  [${e.session}.${e.index}] ${e.summary}${e.detail === null ? '' : ` (${e.detail})`}`,
      );
      return lines.join('\n');
    }
    case 'session-end': {
      const line = `session ${e.session}: ${e.cycles} cycle(s); ${e.stopReason}`;
      const stats = e.system1 === undefined ? null : describeSystem1Stats(e.system1);
      return stats === null ? line : `${line}\n  ${stats}`;
    }
    case 'night':
      return `night: ${e.message}`;
    case 'food':
      return `food: ${e.message}`;
    case 'quest-book':
      return `QUEST BOOK ${e.action} "${e.quest}": ${e.ok ? 'done' : 'FAILED'} (${e.detail})`;
  }
}

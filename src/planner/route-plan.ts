import { ActionSpecSchema, type ActionSpec } from '../domain/actions.ts';
import type { Plan, PlannerRequest } from './plan-schema.ts';

/**
 * Plans code makes from the route alone, without a model: when the route (calculated in code
 * from GTNH's recipes and what the player holds: planner-provider.ts) lists only steps that
 * are exact actions, following it IS the plan. Seen live 2026-10-04: with 7 planks and 2
 * sticks held, the route said "craft the wooden axe, craft sticks, craft the wooden hoe", and
 * the model planned planks from logs it did not have, plan after plan.
 */

/** The planner name plans made here are stored with. */
export const ROUTE_PLANNER = 'route';

/** The JSON object that starts at `from` in `text` (braces balanced; no braces in strings). */
function objectAt(text: string, from: number): string | null {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** The actions after " => " in one route line ("make it: CRAFT_ITEM {...}" first), or null. */
function lineActions(line: string): ActionSpec[] | null {
  const at = line.indexOf(' => ');
  if (at === -1) return null;
  const hint = line.slice(at);
  const out: ActionSpec[] = [];
  for (const m of hint.matchAll(/(PLACE_BLOCK|CRAFT_ITEM) \{/g)) {
    const json = objectAt(hint, m.index + m[0].length - 1);
    if (json === null) return null;
    let args: unknown;
    try {
      args = JSON.parse(json);
    } catch {
      return null;
    }
    const spec = ActionSpecSchema.safeParse({ type: m[1], args });
    if (!spec.success) return null;
    out.push(spec.data);
  }
  return out.length === 0 ? null : out;
}

/**
 * The actions a route's lines end with, in the route's order, as a planner that follows the
 * route writes them: "... => PLACE_BLOCK {...}" for a station to place (after "make it:
 * CRAFT_ITEM {...}" when it is not held), "... => CRAFT_ITEM {...}" for each craft
 * (planner-provider.ts withActionArgs). Lines without one are left out.
 */
export function routeActions(steps: readonly string[]): ActionSpec[] {
  return steps.flatMap((line) => lineActions(line) ?? []);
}

/** A route line that is a step to do: numbered ("3. craft ...") or a station to place. */
const isStep = (line: string): boolean => /^\d+\. /.test(line) || line.startsWith('station:');

/**
 * The plan of following the route when every step it lists is an exact action (crafts, a
 * station to place), at most `maxSteps` of them; null when any step is not (a gather, an
 * explore, a smelt) or there is none: then the model plans.
 */
export function planFromRoute(route: PlannerRequest['route'], maxSteps: number): Plan | null {
  if (route === null) return null;
  const actions: ActionSpec[] = [];
  for (const line of route.steps) {
    if (!isStep(line)) continue;
    const found = lineActions(line);
    if (found === null) return null;
    actions.push(...found);
  }
  if (actions.length === 0) return null;
  const steps = actions.slice(0, Math.max(1, maxSteps)).map((action, i) => ({
    step: i + 1,
    action,
    rationale: `the route's step ${i + 1}: code follows the route (every step is an exact action with what is held)`,
  }));
  const missing = route.stock.filter((s) => s.missing > 0).map((s) => `${s.missing} ${s.item}`);
  return {
    goal: `make ${missing.join(', ') || 'what the route makes'}`.slice(0, 200),
    steps,
    requiresUserApproval: false,
    explanation:
      'Every step of the route is an exact action the player can do with what it holds, so code follows the route as it is.',
    failureHandling: {
      onStepFailure: 'REPLAN',
      maxRetriesPerStep: 1,
      escalationMessage: 'A step of the route failed; the planner is asked again.',
    },
  };
}

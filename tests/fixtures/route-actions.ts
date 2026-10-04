import { ActionSpecSchema, type ActionSpec } from '../../src/domain/actions.ts';

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

/**
 * The actions a route's lines end with, in the route's order, as a planner that follows the
 * route writes them: "... => PLACE_BLOCK {...}" for a station to place (after "make it:
 * CRAFT_ITEM {...}" when it is not held), "... => CRAFT_ITEM {...}" for each craft
 * (src/planner/planner-provider.ts withActionArgs). Each is checked against the action schema.
 */
export function routeActions(steps: readonly string[]): ActionSpec[] {
  const out: ActionSpec[] = [];
  for (const line of steps) {
    const at = line.indexOf(' => ');
    if (at === -1) continue;
    const hint = line.slice(at);
    for (const m of hint.matchAll(/(PLACE_BLOCK|CRAFT_ITEM) \{/g)) {
      const json = objectAt(hint, m.index + m[0].length - 1);
      if (json === null) continue;
      out.push(ActionSpecSchema.parse({ type: m[1], args: JSON.parse(json) as unknown }));
    }
  }
  return out;
}

import { isAllowlistedActionType } from '../domain/actions.ts';

/**
 * Keywords that mark an action type as a world/base modification or otherwise
 * destructive. These are refused as FORBIDDEN_MODIFICATION, even if a future
 * version of the allowlist accidentally gained a matching type. Unrecognized
 * types are UNSUPPORTED_ACTION. Both fail closed.
 */
const FORBIDDEN_KEYWORDS = [
  'PLACE',
  'BREAK',
  'MINE',
  'DIG',
  'BUILD',
  'DESTROY',
  'DISMANTLE',
  'WRENCH',
  'ROTATE',
  'CABLE',
  'WIRE',
  'ENERGY',
  'NETWORK',
  'MULTIBLOCK',
  'CONFIGURE',
  'LAVA',
  'BUCKET',
  'IGNITE',
  'EXPLODE',
  'ATTACK',
  'KILL',
  'DROP',
  'TOSS',
  'DISCARD',
  'TRASH',
  'COMMAND',
  'SHELL',
  'EXEC',
  'EVAL',
  'SCRIPT',
] as const;

/**
 * Action types the operator allows although they contain a forbidden keyword, matched
 * EXACTLY (case included). DIG_BLOCK breaks one allowlisted natural block and PLACE_BLOCK
 * places one allowlisted plain block (approved 2026-09-30); every other type with a
 * forbidden keyword (BREAK_BLOCK, MINE_ORE, DIG_AREA, dig_block, PLACE_BLOCKS, PLACE_TNT,
 * place_block, ...) stays forbidden.
 */
const OPERATOR_APPROVED_TYPES: ReadonlySet<string> = new Set(['DIG_BLOCK', 'PLACE_BLOCK']);

export type ActionTypeClass = 'allowlisted' | 'forbidden' | 'unsupported';

export function classifyActionType(rawType: unknown): ActionTypeClass {
  if (typeof rawType !== 'string') return 'unsupported';
  if (OPERATOR_APPROVED_TYPES.has(rawType) && isAllowlistedActionType(rawType)) {
    return 'allowlisted';
  }
  const upper = rawType.toUpperCase();
  const tokens = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  const hasForbiddenKeyword = FORBIDDEN_KEYWORDS.some(
    (k) => tokens.includes(k) || upper.includes(k),
  );
  if (hasForbiddenKeyword) return 'forbidden';
  return isAllowlistedActionType(rawType) ? 'allowlisted' : 'unsupported';
}

export function forbiddenKeywords(): readonly string[] {
  return FORBIDDEN_KEYWORDS;
}

/** The exact action types allowed despite a forbidden keyword (for the planner's request). */
export function operatorApprovedTypes(): readonly string[] {
  return [...OPERATOR_APPROVED_TYPES];
}

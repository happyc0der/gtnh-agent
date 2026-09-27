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

export type ActionTypeClass = 'allowlisted' | 'forbidden' | 'unsupported';

export function classifyActionType(rawType: unknown): ActionTypeClass {
  if (typeof rawType !== 'string') return 'unsupported';
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

import { z } from 'zod';

/** The only decisions System 1 (deterministic now, possibly a model later) may return. */
export const DECISIONS = [
  'RETREAT_HOME',
  'EAT',
  'EMPTY_INVENTORY',
  'REFUEL_GENERATOR',
  'WAIT_FOR_MACHINE',
  'EXECUTE_KNOWN_SAFE_STEP',
  'REQUEST_PLANNER',
  'PAUSE_AND_ASK_USER',
] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

export const REASON_CODES = [
  'STATE_UNRELIABLE',
  'OUT_OF_BOUNDS',
  'DIMENSION_NOT_ALLOWED',
  'HAZARD_NEARBY',
  'HOSTILES_NEARBY',
  'LOW_HEALTH',
  'HUNGRY',
  'NO_APPROVED_FOOD',
  'ALREADY_AT_SAFE_LOCATION',
  'NO_SAFE_LOCATION',
  'INVENTORY_NEARLY_FULL',
  'NO_DUMP_CONTAINER',
  'NOTHING_DEPOSITABLE',
  'GENERATOR_OUT_OF_FUEL',
  'APPROVED_FUEL_AVAILABLE',
  'MACHINE_BUSY',
  'MACHINE_ERROR',
  'MACHINE_NOT_READY',
  'KNOWN_SAFE_STEP',
  'NO_ACTIVE_TASK',
  'NO_KNOWN_STEP',
  'SAFETY_OVERRIDE',
  'PROVIDER_OUTPUT_INVALID',
  'MOCK_DECISION',
] as const;
export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const FactValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FactValue = z.infer<typeof FactValueSchema>;

export const DecisionResultSchema = z.strictObject({
  decision: DecisionSchema,
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(ReasonCodeSchema).min(1).max(16),
  /** The observed facts the decision was based on, for the audit log. */
  factsUsed: z.record(z.string(), FactValueSchema),
  requiresHumanConfirmation: z.boolean(),
  /** Which DecisionProvider produced this. */
  provider: z.string().min(1).max(64),
});
export type DecisionResult = z.infer<typeof DecisionResultSchema>;

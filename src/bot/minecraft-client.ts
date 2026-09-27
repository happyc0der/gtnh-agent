import { z } from 'zod';
import { FactValueSchema } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import type { ValidatedAction } from '../domain/validated-action.ts';

export const ClientResultCodeSchema = z.enum([
  'OK',
  'FAILED',
  'NOT_IMPLEMENTED',
  'REFUSED',
  'ERROR',
]);

export const ClientActionResultSchema = z.strictObject({
  ok: z.boolean(),
  code: ClientResultCodeSchema,
  message: z.string().max(500),
  data: z.record(z.string(), FactValueSchema),
});
export type ClientActionResult = z.infer<typeof ClientActionResultSchema>;

/**
 * The only boundary between the agent and Minecraft.
 *
 * - `observe()` returns a normalized GameState; anything the adapter cannot observe
 *   reliably is reported as `{ known: false }`, never guessed.
 * - `perform()` accepts only a ValidatedAction minted by the ActionExecutor and must
 *   call assertValidatedAction() before touching the world.
 * - No other in-game operations are exposed: no chat commands, no raw packets, no
 *   block placing/breaking, no arbitrary code.
 */
export interface MinecraftClient {
  readonly kind: 'mock' | 'mineflayer';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  observe(): Promise<GameState>;
  perform(action: ValidatedAction): Promise<ClientActionResult>;
}

export function ok(message: string, data: ClientActionResult['data'] = {}): ClientActionResult {
  return { ok: true, code: 'OK', message, data };
}

export function failed(
  message: string,
  code: Exclude<ClientActionResult['code'], 'OK'> = 'FAILED',
  data: ClientActionResult['data'] = {},
): ClientActionResult {
  return { ok: false, code, message, data };
}

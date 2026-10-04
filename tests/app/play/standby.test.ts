import { describe, expect, it } from 'vitest';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { standbyReason } from '../../../src/app/play/live-play.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { makeState, memoryRepos, testConfig } from '../../fixtures/index.ts';

/** The mock state, observed just now (standby checks a fresh observation). */
const now = (s: GameState): GameState => ({ ...s, timestamp: new Date().toISOString() });

describe('an idle bot stands by for System 1', () => {
  const config = testConfig();
  const repos = memoryRepos();
  syncConfigToDatabase(config, repos);

  it('acts on a reflex: a retreat, a meal, a rest', () => {
    expect(standbyReason(now(makeState()), config, repos)).toBeNull();
    const away = now(
      makeState((w) => {
        w.player.position = { x: 40, y: 64, z: 40 };
        w.hostiles = [{ x: 43, y: 64, z: 40 }];
      }),
    );
    expect(standbyReason(away, config, repos)).toEqual({
      kind: 'reflex',
      text: 'RETREAT_HOME [HOSTILES_NEARBY]',
    });
    const hungry = now(makeState((w) => void (w.player.hunger = 8)));
    expect(standbyReason(hungry, config, repos)).toEqual({ kind: 'reflex', text: 'EAT [HUNGRY]' });
    const hurt = now(makeState((w) => void (w.player.health = 6)));
    expect(standbyReason(hurt, config, repos)).toEqual({
      kind: 'reflex',
      text: 'REST [LOW_HEALTH]',
    });
  });

  it('waits offline for a mob near home, unless sealed in: nowhere is left to retreat to', () => {
    // Seen live 2026-10-04: a zombie followed the bot home, and the idle bot, paused there,
    // stood still until it was killed.
    const atHome = now(makeState((w) => void (w.hostiles = [{ x: 3, y: 64, z: 1 }])));
    expect(standbyReason(atHome, config, repos)).toEqual({
      kind: 'mob',
      reasons: 'HOSTILES_NEARBY, ALREADY_AT_SAFE_LOCATION',
    });
    // Sealed in its shelter, no mob can reach it: it stays, online for commands.
    const sealed = now(
      makeState((w) => {
        w.hostiles = [{ x: 3, y: 64, z: 1 }];
        w.player.sealed = true;
      }),
    );
    expect(standbyReason(sealed, config, repos)).toBeNull();
  });

  it('nothing on an unreliable observation', () => {
    // An old observation is unreliable: nothing is done on it.
    expect(
      standbyReason(
        makeState((w) => void (w.player.hunger = 8)),
        config,
        repos,
      ),
    ).toBeNull();
  });
});

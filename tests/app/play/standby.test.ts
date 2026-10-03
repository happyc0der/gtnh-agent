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

  it('acts only on a reflex: a retreat, a meal, a rest', () => {
    expect(standbyReason(now(makeState()), config, repos)).toBeNull();
    const away = now(
      makeState((w) => {
        w.player.position = { x: 40, y: 64, z: 40 };
        w.hostiles = [{ x: 43, y: 64, z: 40 }];
      }),
    );
    expect(standbyReason(away, config, repos)).toBe('RETREAT_HOME [HOSTILES_NEARBY]');
    const hungry = now(makeState((w) => void (w.player.hunger = 8)));
    expect(standbyReason(hungry, config, repos)).toBe('EAT [HUNGRY]');
    const hurt = now(makeState((w) => void (w.player.health = 6)));
    expect(standbyReason(hurt, config, repos)).toBe('REST [LOW_HEALTH]');
  });

  it('not on a pause or an unreliable observation: those are for a person', () => {
    // A hostile at home: System 1 pauses (nowhere to retreat to), which standing by cannot fix.
    const atHome = now(makeState((w) => void (w.hostiles = [{ x: 3, y: 64, z: 1 }])));
    expect(standbyReason(atHome, config, repos)).toBeNull();
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

import { describe, expect, it } from 'vitest';
import type { GameState, InteractableBlock } from '../../src/domain/game-state.ts';
import { eyeDistanceToBlock } from '../../src/domain/geometry.ts';
import { PLANNER_SYSTEM_PROMPT } from '../../src/llm/ollama-planner-provider.ts';
import { CompactStateSchema, MAX_COMPACT_INTERACTABLES } from '../../src/planner/plan-schema.ts';
import { sanitizeStateForPlanner } from '../../src/planner/planner-provider.ts';
import { makeState } from '../fixtures/index.ts';

/** The base state (player at (1, 64, 1)) with these interactable blocks. */
function withInteractables(blocks: InteractableBlock[]): GameState {
  const state = makeState();
  return { ...state, interactables: { known: true, value: { scanRadius: 16, blocks } } };
}

/** `seconds` before the state's own timestamp. */
const before = (state: GameState, seconds: number): string =>
  new Date(Date.parse(state.timestamp) - seconds * 1000).toISOString();

describe('interactable blocks for the planner', () => {
  it('a burning furnace: its contents as last seen and the seconds until all is smelted', () => {
    const base = makeState();
    const state = withInteractables([
      {
        profile: 'furnace',
        block: 'minecraft:lit_furnace',
        position: { x: 2, y: 64, z: 2 },
        standAt: { x: 1.5, y: 64, z: 1.5 },
        furnace: {
          burning: true,
          seen: {
            observedAt: before(base, 10),
            input: { item: 'minecraft:cobblestone', count: 4 },
            fuel: { item: 'minecraft:coal', count: 1 },
            output: { item: 'minecraft:stone', count: 2 },
            cookTicks: 100,
            burnTicksLeft: 1000,
            fuelItemTicks: 1600,
          },
        },
      },
    ]);
    const compact = sanitizeStateForPlanner(state);
    // 4 items: 800 - 100 ticks = 35 s when seen, 10 s ago.
    expect(compact.interactables).toEqual([
      {
        profile: 'furnace',
        block: 'minecraft:lit_furnace',
        position: { x: 2, y: 64, z: 2 },
        reach: Number(eyeDistanceToBlock({ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }).toFixed(2)),
        standAt: { x: 1.5, y: 64, z: 1.5 },
        furnace: {
          burning: true,
          input: '4 minecraft:cobblestone',
          fuel: '1 minecraft:coal',
          output: '2 minecraft:stone',
          secondsLeft: 25,
          seenSecondsAgo: 10,
        },
      },
    ]);
    expect(CompactStateSchema.safeParse(compact).success).toBe(true);
  });

  it('no estimate for a furnace that went out or was never seen; observe-only blocks have none', () => {
    const base = makeState();
    const seen = {
      observedAt: before(base, 5),
      input: { item: 'minecraft:cobblestone', count: 4 },
      fuel: null,
      output: null,
      cookTicks: 0,
      burnTicksLeft: 0,
      fuelItemTicks: 0,
    };
    const compact = sanitizeStateForPlanner(
      withInteractables([
        {
          profile: 'furnace',
          block: 'minecraft:furnace',
          position: { x: 2, y: 64, z: 2 },
          furnace: { burning: false, seen },
        },
        {
          profile: 'furnace',
          block: 'minecraft:furnace',
          position: { x: 3, y: 64, z: 2 },
          furnace: { burning: false, seen: null },
        },
        {
          profile: null,
          block: 'appliedenergistics2:tile.BlockDrive',
          position: { x: 0, y: 64, z: 2 },
        },
      ]),
    );
    expect(compact.interactables.map((b) => b.furnace)).toEqual([
      {
        burning: false,
        input: '4 minecraft:cobblestone',
        fuel: null,
        output: null,
        secondsLeft: null,
        seenSecondsAgo: 5,
      },
      {
        burning: false,
        input: null,
        fuel: null,
        output: null,
        secondsLeft: null,
        seenSecondsAgo: null,
      },
      null,
    ]);
    // standAt not computed (the mock): null for the planner.
    expect(compact.interactables.map((b) => b.standAt)).toEqual([null, null, null]);
  });

  it('only the nearest ones; unknown when the blocks were not observed', () => {
    const many: InteractableBlock[] = Array.from({ length: 30 }, (_, i) => ({
      profile: 'chest',
      block: 'minecraft:chest',
      position: { x: i, y: 64, z: 5 },
    }));
    expect(sanitizeStateForPlanner(withInteractables(many)).interactables).toHaveLength(
      MAX_COMPACT_INTERACTABLES,
    );
    const hidden = sanitizeStateForPlanner(makeState((w) => void (w.unobservable = ['blocks'])));
    expect(hidden.interactables).toEqual([]);
    expect(hidden.unknownFields).toContain('interactables');
  });

  it('the planner prompt documents the three actions and the furnace rule', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('- INTERACT_BLOCK {"position"');
    expect(PLANNER_SYSTEM_PROMPT).toContain('- SMELT {"position"');
    expect(PLANNER_SYSTEM_PROMPT).toContain('- TAKE_OUTPUT {"position"');
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/never assume a result you have not seen/);
    // Smelting is no longer a reason to escalate.
    expect(PLANNER_SYSTEM_PROMPT).not.toMatch(/mining stone or ores, smelting/);
  });
});

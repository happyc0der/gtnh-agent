import { describe, expect, it } from 'vitest';
import type { MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { routeForPlanner } from '../../src/planner/planner-provider.ts';
import { known } from '../../src/domain/known.ts';
import { makeState } from '../fixtures/index.ts';
import { routeActions } from '../fixtures/route-actions.ts';

/** The mock world with a task that needs `requirements`, holding `items`. */
const needing = (
  requirements: Record<string, number>,
  items: Record<string, number>,
  mutate: (w: MockWorld) => void = () => undefined,
) =>
  makeState((w) => {
    w.inventory.items = items;
    w.recipe = null;
    w.task = { taskId: 'goal-test', goal: 'test', subgoal: null, status: 'active', requirements };
    mutate(w);
  });

const steps = (state: ReturnType<typeof makeState>): string[] =>
  routeForPlanner(state)?.steps ?? [];

// Routes read the knowledge base: a moment on a busy machine.
describe(
  'the route names the exact PLACE_BLOCK and CRAFT_ITEM for its steps',
  { timeout: 30_000 },
  () => {
    it('puts a held table only where the client allows a station (seen live: one in the way)', () => {
      const base = needing(
        { 'minecraft:wooden_sword': 1 },
        { 'minecraft:log': 2, 'minecraft:crafting_table': 1 },
        (w) => {
          w.craftingTables = [];
        },
      );
      if (!base.nearbyBlocks.known) throw new Error('no blocks observed');
      const blocks = base.nearbyBlocks.value;
      const floors = blocks.placeable.filter((c) => c.takesFalling);
      const [first, second] = floors;
      if (first === undefined || second === undefined) throw new Error('two floor cells needed');
      const key = (c: { position: { x: number; y: number; z: number } }): string =>
        `${c.position.x},${c.position.y},${c.position.z}`;
      const flagged = (station: (k: string) => boolean | undefined) => ({
        ...base,
        nearbyBlocks: known({
          ...blocks,
          placeable: blocks.placeable.map((c) => {
            const v = station(key(c));
            return v === undefined ? c : { ...c, station: v };
          }),
        }),
      });
      // The client found the cell the route would take in the way, and the next one fine.
      const line = (state: ReturnType<typeof makeState>): string | undefined =>
        steps(state).find((l) => l.startsWith('station:'));
      const placed = flagged((k) =>
        k === key(first) ? false : k === key(second) ? true : undefined,
      );
      expect(line(placed)).toContain(
        JSON.stringify({ position: second.position, item: 'minecraft:crafting_table' }),
      );
      // Every floor cell in the way: walk to open ground first.
      const none = flagged((k) => (floors.some((c) => key(c) === k) ? false : undefined));
      expect(line(none)).toContain('MOVE_TO open, flat ground first');
    });

    it('a held table: placed on the floor beside the player, then the 3x3 crafts at it', () => {
      const lines = steps(
        needing(
          { 'minecraft:wooden_sword': 1 },
          { 'minecraft:log': 2, 'minecraft:crafting_table': 1 },
          (w) => {
            w.craftingTables = [];
          },
        ),
      );
      expect(lines.find((l) => l.startsWith('station:'))).toBe(
        'station: crafting_table: minecraft:crafting_table is held: place it => PLACE_BLOCK ' +
          '{"position":{"x":2,"y":65,"z":1},"item":"minecraft:crafting_table"} (a listed cell a ' +
          'station may take: on the ground beside the player, out of its way); it is ' +
          'then the table crafting_table:2.65.1',
      );
      expect(routeActions(lines)).toEqual([
        {
          type: 'PLACE_BLOCK',
          args: { position: { x: 2, y: 65, z: 1 }, item: 'minecraft:crafting_table' },
        },
        { type: 'CRAFT_ITEM', args: { recipe: 'planks_oak', times: 2, craftingTableId: null } },
        { type: 'CRAFT_ITEM', args: { recipe: 'sticks', times: 1, craftingTableId: null } },
        {
          type: 'CRAFT_ITEM',
          args: {
            recipe: 'minecraft:wooden_sword#1',
            times: 1,
            craftingTableId: 'crafting_table:2.65.1',
          },
        },
      ]);
    });

    it('a table it knows (configured or seen): the crafts use it, nothing is placed', () => {
      const lines = steps(needing({ 'minecraft:wooden_hoe': 1 }, { 'minecraft:log': 2 }));
      expect(lines.some((l) => l.startsWith('station:'))).toBe(false);
      expect(routeActions(lines).at(-1)).toEqual({
        type: 'CRAFT_ITEM',
        args: { recipe: 'minecraft:wooden_hoe#1', times: 1, craftingTableId: 'table.main' },
      });
    });

    it('no table at all: make one (GTNH: flint above logs, 2x2), then place it', () => {
      const lines = steps(
        needing(
          { 'minecraft:wooden_hoe': 1 },
          { 'minecraft:log': 4, 'minecraft:flint': 2 },
          (w) => {
            w.craftingTables = [];
          },
        ),
      );
      const station = lines.find((l) => l.startsWith('station: crafting_table:')) ?? '';
      expect(station).toMatch(
        /^station: crafting_table: none known; make one: crafting_table: 2 minecraft:flint, 2 minecraft:log \(2x2\), then place it => make it: CRAFT_ITEM \{"recipe":"crafting_table","times":1,"craftingTableId":null\}; then PLACE_BLOCK \{/,
      );
      expect(routeActions([station]).map((a) => a.type)).toEqual(['CRAFT_ITEM', 'PLACE_BLOCK']);
    });

    it('says so when no listed cell takes a station, or CRAFT_ITEM cannot make a step yet', () => {
      // Nothing to stand a table on: only the ground block the player stands on is simulated,
      // and the cell above it is the player's own.
      const nowhere = steps(
        needing(
          { 'minecraft:wooden_sword': 1 },
          { 'minecraft:planks': 2, 'minecraft:stick': 1, 'minecraft:crafting_table': 1 },
          (w) => {
            w.craftingTables = [];
            w.resourceBlocks = w.resourceBlocks.filter((r) => r.block === 'minecraft:grass');
          },
        ),
      );
      expect(nowhere.find((l) => l.startsWith('station:'))).toMatch(
        /is held: place it => no listed placeable cell takes it here .*MOVE_TO open, flat ground first$/,
      );
      // A GregTech mortar: its result carries its material as NBT data.
      const mortar = steps(needing({ 'gregtech:gt.metatool.01@24': 1 }, {}));
      expect(mortar.find((l) => l.includes('craft gregtech:gt.metatool.01@24[Flint]#1'))).toMatch(
        /=> CRAFT_ITEM cannot make gregtech:gt\.metatool\.01@24\[Flint\]#1 yet: the result carries NBT data/,
      );
    });
  },
);

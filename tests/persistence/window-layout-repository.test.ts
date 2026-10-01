import { describe, expect, it } from 'vitest';
import type { BlockWindow } from '../../src/domain/game-state.ts';
import { MAX_LAYOUT_SAMPLE } from '../../src/persistence/window-layout-repository.ts';
import { memoryRepos } from '../fixtures/index.ts';

const window = (over: Partial<BlockWindow> = {}): BlockWindow => ({
  position: { x: 0, y: 64, z: 2 },
  block: 'appliedenergistics2:tile.BlockDrive',
  profile: null,
  opener: 'fml:appliedenergistics2:0',
  title: null,
  slotCount: 46,
  containerSlots: null,
  inventoryAt: 10,
  slots: [
    {
      slot: 0,
      item: 'appliedenergistics2:item.ItemBasicStorageCell.1k',
      count: 1,
      role: null,
      nbt: true,
    },
  ],
  properties: {},
  open: false,
  observedAt: '2026-01-01T12:00:00.000Z',
  ...over,
});

describe('learned window layouts', () => {
  it('one row per block, opener and size; seen again counts once more, never older', () => {
    const { windowLayouts } = memoryRepos();
    expect(windowLayouts.record(window())).toBe(true);
    // The same observation again changes nothing; an older one never overwrites.
    expect(windowLayouts.record(window())).toBe(false);
    expect(windowLayouts.record(window({ observedAt: '2026-01-01T11:00:00.000Z' }))).toBe(false);
    expect(
      windowLayouts.record(
        window({
          observedAt: '2026-01-01T12:05:00.000Z',
          position: { x: 5, y: 64, z: 5 },
          slots: [],
        }),
      ),
    ).toBe(true);
    // Another size (or opener) of the same block is another layout.
    expect(
      windowLayouts.record(window({ slotCount: 47, observedAt: '2026-01-01T12:01:00.000Z' })),
    ).toBe(true);

    const all = windowLayouts.list();
    expect(all.map((l) => [l.slotCount, l.timesSeen, l.lastSeenAt])).toEqual([
      [46, 2, '2026-01-01T12:05:00.000Z'],
      [47, 1, '2026-01-01T12:01:00.000Z'],
    ]);
    expect(all[0]).toMatchObject({
      block: 'appliedenergistics2:tile.BlockDrive',
      opener: 'fml:appliedenergistics2:0',
      profile: null,
      inventoryAt: 10,
      firstSeenAt: '2026-01-01T12:00:00.000Z',
      position: { x: 5, y: 64, z: 5 },
      sample: [],
    });
    expect(windowLayouts.forBlock('appliedenergistics2:tile.BlockDrive')).toHaveLength(2);
    expect(windowLayouts.forBlock('minecraft:furnace')).toEqual([]);
  });

  it('keeps a bounded sample of the non-empty slots', () => {
    const { windowLayouts } = memoryRepos();
    const slots = Array.from({ length: 100 }, (_, i) => ({
      slot: i,
      item: 'minecraft:cobblestone',
      count: 1,
      role: 'storage' as const,
      nbt: false,
    }));
    windowLayouts.record(window({ slotCount: 136, slots }));
    const [layout] = windowLayouts.list();
    expect(layout?.sample).toHaveLength(MAX_LAYOUT_SAMPLE);
    expect(layout?.sample[0]).toEqual({
      slot: 0,
      item: 'minecraft:cobblestone',
      count: 1,
      role: 'storage',
    });
  });
});

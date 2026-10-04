import { describe, expect, it } from 'vitest';
import { gtOreByName, gtOreLabel, gtOreOfMeta } from '../../src/goals/ore-names.ts';

describe('GT ores by name and by their tile entity metadata', () => {
  it('names an ore by what a person calls it', () => {
    expect(gtOreByName('iron ore')).toEqual({
      block: 'gregtech:gt.blockores',
      item: 'gregtech:gt.metaitem.03@5032',
      material: 'Iron',
    });
    expect(gtOreByName('Brown Limonite')?.material).toBe('BrownLimonite');
    expect(gtOreByName('unobtainium')).toBeNull();
  });

  it('reads the material, the stone and small ores out of TileEntityOres.mMetaData', () => {
    // Iron (32) in stone, in black granite (+3000), and a small copper ore (16000 + 35).
    expect(gtOreOfMeta(32)).toEqual({
      material: 'Iron',
      small: false,
      drops: ['gregtech:gt.metaitem.03@5032'],
    });
    expect(gtOreOfMeta(3032)).toEqual(gtOreOfMeta(32));
    const copper = gtOreOfMeta(16035);
    expect(copper).toMatchObject({ material: 'Copper', small: true });
    expect(copper?.drops).toContain('IC2:itemCrushedOre@1');
    expect(gtOreOfMeta(-1)).toBeNull();
    expect(gtOreOfMeta(999)).toBeNull();
  });

  it('labels an ore for people', () => {
    // Brown limonite is material 930 (its raw ore: gt.metaitem.03@5930).
    expect(gtOreByName('brown limonite')?.item).toBe('gregtech:gt.metaitem.03@5930');
    const limonite = gtOreOfMeta(930);
    expect(limonite === null ? null : gtOreLabel(limonite)).toBe('brown limonite ore');
    expect(gtOreLabel({ material: 'Copper', small: true, drops: [] })).toBe('small copper ore');
  });
});

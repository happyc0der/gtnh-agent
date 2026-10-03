import { describe, expect, it } from 'vitest';
import {
  DIGGABLE_BLOCKS,
  TOOL_DIGGABLE_BLOCKS,
  type DiggableBlock,
} from '../../src/domain/blocks.ts';
import {
  digFacts,
  digProgressPerTick,
  digWaitTicks,
  serverMinimumTicks,
  vanillaDigTicks,
  type DigFacts,
} from '../../src/domain/dig-time.ts';
import {
  bestTool,
  carriedHarvester,
  DISABLED_VANILLA_TOOLS,
  harvests,
  parseToolName,
  readTinkersTool,
  tinkersTool,
  TOOL_ITEMS,
  TOOLS,
  toolInfo,
  toolProblem,
  toolSpeedOn,
  usesLeft,
  type NbtData,
  type TinkersStats,
  type ToolItem,
  type ToolStack,
} from '../../src/domain/tools.ts';
import { mintValidatedAction } from '../../src/domain/validated-action.ts';
import { SERVER_TOOLS } from '../bot/gtnh1710/fixtures/fake-digging.ts';
import { action, makeWorld } from '../fixtures/index.ts';

const SHOVEL_BLOCKS: DiggableBlock[] = [
  'minecraft:dirt',
  'minecraft:grass',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
];
const LOGS: DiggableBlock[] = ['minecraft:log', 'minecraft:log2'];
/** Every allowlisted block of material rock: what ItemPickaxe digs at its efficiency. */
const ROCK: DiggableBlock[] = [...TOOL_DIGGABLE_BLOCKS];

describe('the tool allowlist', () => {
  it('holds the verified vanilla tools that work on the test server, and nothing else', () => {
    expect(
      Object.values(TOOLS).map((t) => [
        t.item,
        t.kind,
        t.speed,
        t.harvestLevel,
        t.maxDamage,
        t.digsFaster,
      ]),
    ).toEqual([
      // GregTech raises the wooden tools' maximum to 64; the agent keeps vanilla's 59.
      // Harvest levels: IguanaTweaks' ToolDefaults.cfg.
      ['minecraft:wooden_shovel', 'shovel', 2, 0, 59, SHOVEL_BLOCKS],
      ['minecraft:wooden_pickaxe', 'pickaxe', 2, 0, 59, ROCK],
      ['minecraft:wooden_axe', 'axe', 2, 0, 59, LOGS],
      ['minecraft:stone_axe', 'axe', 4, 0, 131, LOGS],
      ['minecraft:iron_axe', 'axe', 6, 3, 250, LOGS],
      ['minecraft:golden_axe', 'axe', 12, 0, 32, LOGS],
      ['minecraft:diamond_axe', 'axe', 8, 5, 1561, LOGS],
    ]);
    for (const t of Object.values(TOOLS)) expect(t.evidence.length).toBeGreaterThan(40);
    // IguanaTweaks makes every other vanilla shovel and pickaxe dig nothing on this server.
    for (const useless of ['stone', 'iron', 'golden', 'diamond']) {
      for (const kind of ['shovel', 'pickaxe']) {
        expect(toolInfo(`minecraft:${useless}_${kind}`)).toBeNull();
        expect(DISABLED_VANILLA_TOOLS).toContain(`minecraft:${useless}_${kind}`);
      }
    }
    // GregTech's tools are not dug with; Tinkers' Construct's are read from their NBT data
    // (TINKERS_TOOLS), not from this table.
    expect(toolInfo('gregtech:gt.metatool.01')).toBeNull();
    expect(toolInfo('TConstruct:shovel')).toBeNull();
    // Leaves are dug with an empty hand (an axe does not dig them faster).
    expect(TOOL_ITEMS.some((i) => TOOLS[i].digsFaster.includes('minecraft:leaves'))).toBe(false);
  });

  it("never claims more than the server does: speeds and maxima are lower bounds of the server's", () => {
    // SERVER_TOOLS is the fake server's copy of the test server's rules (docs: "Tools").
    for (const item of TOOL_ITEMS) {
      const server = SERVER_TOOLS[item];
      if (server === undefined) throw new Error(`the fake server has no rule for ${item}`);
      const ours = TOOLS[item];
      expect(server.useless, item).not.toBe(true);
      expect(ours.speed, item).toBeLessThanOrEqual(server.speed);
      expect(ours.maxDamage, item).toBeLessThanOrEqual(server.maxDamage);
      expect(ours.harvestLevel, item).toBeLessThanOrEqual(server.level ?? 0);
      for (const b of ours.digsFaster) expect(server.blocks, `${item} on ${b}`).toContain(b);
    }
    for (const item of ['minecraft:stone_pickaxe', 'minecraft:iron_pickaxe']) {
      expect(SERVER_TOOLS[item]?.useless, item).toBe(true);
    }
  });

  it('a pickaxe harvests stone and ores up to its level; other kinds and lower levels never', () => {
    const pick = TOOLS['minecraft:wooden_pickaxe'];
    const rule = (block: DiggableBlock, meta?: number) => {
      const f = digFacts(block, meta ?? 0);
      if ('problem' in f) throw new Error(f.problem);
      return f.harvest;
    };
    expect(harvests(pick, rule('minecraft:stone'))).toBe(true);
    expect(harvests(pick, rule('minecraft:hardened_clay'))).toBe(true);
    expect(harvests(pick, rule('gregtech:gt.blockores', 0))).toBe(true); // lignite, small copper
    expect(harvests(pick, rule('gregtech:gt.blockores', 1))).toBe(false); // coal, brown limonite
    expect(harvests(pick, rule('gregtech:gt.blockgranites'))).toBe(false); // level 3
    expect(harvests(pick, rule('minecraft:emerald_ore'))).toBe(false); // level 4
    expect(harvests(TOOLS['minecraft:diamond_axe'], rule('minecraft:stone'))).toBe(false);
    // A hand harvests what needs no tool.
    expect(harvests(TOOLS['minecraft:wooden_axe'], rule('minecraft:dirt'))).toBe(true);
    expect(
      toolProblem({ tool: pick, damage: 0, count: 1, hasNbt: false }, 'gregtech:gt.blockores', {
        tool: 'pickaxe',
        level: 2,
      }),
    ).toMatch(
      /minecraft:wooden_pickaxe \(a level-0 pickaxe\) does not harvest .*a pickaxe of level 2 or more/,
    );
    expect(
      toolProblem({ tool: pick, damage: 58, count: 1, hasNbt: false }, 'minecraft:stone'),
    ).toBeNull();
  });
});

describe('what the player carries harvests (the safety policy, by inventory names)', () => {
  const stone = { tool: 'pickaxe', level: 0 } as const;
  it('a vanilla pickaxe by its name and wear; a Tinkers one by its kind (its level is NBT)', () => {
    expect(carriedHarvester({ 'minecraft:wooden_pickaxe@3': 1 }, stone)).toEqual({
      ok: true,
      tool: 'minecraft:wooden_pickaxe@3',
      levelKnown: true,
    });
    expect(carriedHarvester({ 'TConstruct:pickaxe@12': 1 }, { tool: 'pickaxe', level: 3 })).toEqual(
      { ok: true, tool: 'TConstruct:pickaxe@12', levelKnown: false },
    );
    expect(carriedHarvester({ 'minecraft:wooden_pickaxe@59': 1 }, stone)).toMatchObject({
      ok: false,
      reason: 'it needs a pickaxe of level 0 or more, and the player carries none',
    });
    expect(
      carriedHarvester({ 'minecraft:wooden_pickaxe': 1 }, { tool: 'pickaxe', level: 2 }),
    ).toMatchObject({
      ok: false,
      reason: /carries none \(too low: minecraft:wooden_pickaxe \(level 0\)\)/,
    });
    // A shovel or a hatchet is no pickaxe; a disabled iron pickaxe is no tool at all.
    expect(
      carriedHarvester(
        { 'TConstruct:shovel': 1, 'TConstruct:hatchet': 1, 'minecraft:iron_pickaxe': 1 },
        stone,
      ),
    ).toMatchObject({ ok: false });
    expect(
      carriedHarvester({ 'minecraft:wooden_pickaxe': 1 }, stone, (n) => n.startsWith('minecraft:')),
    ).toMatchObject({ ok: false });
  });
});

/** A Tinkers' tool's NBT root, as readNbt gives it (TConstruct's ToolBuilder writes these). */
function tinkers(tags: Record<string, unknown>, root: Record<string, unknown> = {}): NbtData {
  return {
    InfiTool: {
      HarvestLevel: 2,
      MiningSpeed: 500,
      Damage: 0,
      TotalDurability: 135,
      Broken: 0,
      Shoddy: 0,
      ...tags,
    },
    ...root,
  };
}

function stats(item: string, root: NbtData): TinkersStats {
  const r = readTinkersTool(item, root);
  if (!r.ok) throw new Error(r.reason);
  return r.stats;
}

function facts(block: DiggableBlock, meta?: number): DigFacts {
  const f = digFacts(block, meta ?? 0);
  if ('problem' in f) throw new Error(f.problem);
  return f;
}

describe("Tinkers' Construct tools, read from their NBT data", () => {
  it('reads InfiTool, failing closed on anything missing or of the wrong type', () => {
    expect(stats('TConstruct:pickaxe', tinkers({}))).toMatchObject({
      item: 'TConstruct:pickaxe',
      harvestLevel: 2,
      miningSpeed: 500,
      damage: 0,
      totalDurability: 135,
      broken: false,
      autoSmelt: false,
      silkTouch: false,
    });
    expect(readTinkersTool('TConstruct:pickaxe', {})).toMatchObject({
      ok: false,
      reason: /no InfiTool/,
    });
    expect(readTinkersTool('TConstruct:pickaxe', tinkers({ MiningSpeed: 'fast' }))).toMatchObject({
      ok: false,
      reason: /unexpected type/,
    });
    expect(readTinkersTool('TConstruct:pickaxe', tinkers({ TotalDurability: 0 }))).toMatchObject({
      ok: false,
      reason: /no durability or speed/,
    });
    // Never the area tools: one dig breaks many blocks.
    for (const area of ['TConstruct:hammer', 'TConstruct:excavator', 'TConstruct:lumberaxe']) {
      expect(readTinkersTool(area, tinkers({}))).toMatchObject({ ok: false });
    }
  });

  it("mines what its NBT level harvests, at calcToolSpeed's speed, with its wear", () => {
    // A copper pickaxe (MiningSpeed 500, level 2 once boosted) on stone and on a level-2 ore.
    const copper = stats('TConstruct:pickaxe', tinkers({ Damage: 10 }));
    const onStone = tinkersTool(copper, 'minecraft:stone', facts('minecraft:stone'));
    expect(onStone).toMatchObject({
      ok: true,
      damage: 10,
      tool: { item: 'TConstruct:pickaxe', kind: 'pickaxe', speed: 5, maxDamage: 135 },
    });
    if (!onStone.ok) throw new Error(onStone.reason);
    expect(usesLeft(onStone.tool, onStone.damage)).toBe(125);
    expect(tinkersTool(copper, 'gregtech:gt.blockores', facts('gregtech:gt.blockores', 2)).ok).toBe(
      true,
    );
    // A level-3 ore (tin), a granite (3), an emerald ore (4): too high.
    for (const [block, meta] of [
      ['gregtech:gt.blockores', 3],
      ['gregtech:gt.blockgranites', 0],
      ['minecraft:emerald_ore', 0],
    ] as const) {
      expect(tinkersTool(copper, block, facts(block, meta)), block).toMatchObject({
        ok: false,
        notForBlock: false,
        reason: /does not harvest .* a pickaxe of level [34] or more/,
      });
    }
    // Made for rock only: dirt and logs are none of its business.
    expect(tinkersTool(copper, 'minecraft:dirt', facts('minecraft:dirt'))).toMatchObject({
      ok: false,
      notForBlock: true,
    });
  });

  it('a new pickaxe is a level lower until it levels up (IguanaTweaks pickaxeBoostRequired)', () => {
    // A flint pickaxe (flint: level 1) has HarvestLevel 0 until its boost: it mines lignite and
    // stone, not coal.
    const flint = stats('TConstruct:pickaxe', tinkers({ HarvestLevel: 0, MiningSpeed: 400 }));
    expect(
      tinkersTool(flint, 'gregtech:gt.blockores', facts('gregtech:gt.blockores', 0)),
    ).toMatchObject({
      ok: true,
      tool: { speed: 4 },
    });
    expect(tinkersTool(flint, 'gregtech:gt.blockores', facts('gregtech:gt.blockores', 1)).ok).toBe(
      false,
    );
  });

  it('averages the speeds of its parts and adds Stonebound, as the server does (in floats)', () => {
    // MiningSpeed 400 and MiningSpeedHandle 300: (400 + 300) / 200 = 3.5.
    const handle = stats(
      'TConstruct:pickaxe',
      tinkers({ MiningSpeed: 400, MiningSpeedHandle: 300 }),
    );
    expect(tinkersTool(handle, 'minecraft:stone', facts('minecraft:stone'))).toMatchObject({
      tool: { speed: 3.5 },
    });
    // A stone head (Shoddy 1) at Damage 72: + log(2) x 2 x 1 = 1.386, rounded down.
    const stonebound = stats(
      'TConstruct:pickaxe',
      tinkers({ MiningSpeed: 150, Damage: 72, Shoddy: 1 }),
    );
    const r = tinkersTool(stonebound, 'minecraft:stone', facts('minecraft:stone'));
    if (!r.ok) throw new Error(r.reason);
    expect(r.tool.speed).toBeCloseTo(1.5 + 2 * Math.log(2), 2);
    expect(r.tool.speed).toBeLessThanOrEqual(Math.fround(1.5 + 2 * Math.log(2)));
  });

  it('never a broken one, one more use from breaking, auto-smelting or Silk Touch', () => {
    const block = 'minecraft:stone';
    const f = facts(block);
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
      [{ Broken: 1 }, {}, /is broken/],
      [{ Damage: 135 }, {}, /worn out \(Damage 135 of TotalDurability 135/],
      [{ Lava: 1 }, {}, /auto-smelts/],
      [{}, { ench: [{ id: 33, lvl: 1 }] }, /Silk Touch/],
    ];
    for (const [tags, root, reason] of cases) {
      expect(tinkersTool(stats('TConstruct:pickaxe', tinkers(tags, root)), block, f)).toMatchObject(
        {
          ok: false,
          reason,
        },
      );
    }
    // One use left is fine (Damage 134 of 135: the 135th use leaves it whole).
    expect(tinkersTool(stats('TConstruct:pickaxe', tinkers({ Damage: 134 })), block, f).ok).toBe(
      true,
    );
    // Fortune (35) changes nothing it counts on.
    expect(
      tinkersTool(
        stats('TConstruct:pickaxe', tinkers({}, { ench: [{ id: 35, lvl: 2 }] })),
        block,
        f,
      ).ok,
    ).toBe(true);
  });

  it('a shovel digs the ground; a hatchet logs and leaves; a mattock each side with its own stats', () => {
    const shovel = stats('TConstruct:shovel', tinkers({}));
    expect(tinkersTool(shovel, 'minecraft:gravel', facts('minecraft:gravel')).ok).toBe(true);
    expect(tinkersTool(shovel, 'minecraft:stone', facts('minecraft:stone'))).toMatchObject({
      ok: false,
      notForBlock: true,
    });
    const hatchet = stats('TConstruct:hatchet', tinkers({}));
    expect(tinkersTool(hatchet, 'minecraft:log', facts('minecraft:log')).ok).toBe(true);
    expect(tinkersTool(hatchet, 'minecraft:leaves', facts('minecraft:leaves')).ok).toBe(true);
    // The mattock: logs with MiningSpeed, dirt with MiningSpeed2; sand and gravel are neither
    // of its materials (DualHarvestTool.getDigSpeed: by material only).
    const mattock = stats(
      'TConstruct:mattock',
      tinkers({ MiningSpeed: 600, MiningSpeed2: 300, HarvestLevel2: 1 }),
    );
    expect(tinkersTool(mattock, 'minecraft:log', facts('minecraft:log'))).toMatchObject({
      tool: { speed: 6, kind: 'axe' },
    });
    expect(tinkersTool(mattock, 'minecraft:dirt', facts('minecraft:dirt'))).toMatchObject({
      tool: { speed: 3, kind: 'shovel' },
    });
    expect(tinkersTool(mattock, 'minecraft:sand', facts('minecraft:sand'))).toMatchObject({
      notForBlock: true,
    });
    // A garden breaks at once: no tool.
    expect(
      tinkersTool(mattock, 'harvestcraft:berrygarden', facts('harvestcraft:berrygarden')),
    ).toMatchObject({ notForBlock: true });
  });
});

describe('dig time with a tool', () => {
  it.each<[DiggableBlock, ToolItem | null, number, number, number]>([
    // block, tool, vanilla client ticks, the server's minimum, what the agent waits
    ['minecraft:sand', null, 15, 10, 21],
    ['minecraft:sand', 'minecraft:wooden_shovel', 8, 5, 12],
    ['minecraft:dirt', 'minecraft:wooden_shovel', 8, 5, 12],
    ['minecraft:grass', 'minecraft:wooden_shovel', 9, 6, 14],
    ['minecraft:gravel', 'minecraft:wooden_shovel', 9, 6, 14],
    ['minecraft:clay', 'minecraft:wooden_shovel', 9, 6, 14],
    ['minecraft:log', null, 60, 41, 77],
    ['minecraft:log', 'minecraft:wooden_axe', 30, 20, 40],
    ['minecraft:log2', 'minecraft:stone_axe', 15, 10, 21],
    ['minecraft:log', 'minecraft:iron_axe', 10, 6, 15],
    ['minecraft:log', 'minecraft:diamond_axe', 8, 5, 12],
    ['minecraft:log', 'minecraft:golden_axe', 5, 3, 9],
    // Stone: only with a pickaxe (by hand it would drop nothing, and is never dug).
    ['minecraft:stone', 'minecraft:wooden_pickaxe', 23, 15, 31],
    ['minecraft:cobblestone', 'minecraft:wooden_pickaxe', 30, 20, 40],
    ['minecraft:sandstone', 'minecraft:wooden_pickaxe', 12, 8, 17],
    ['minecraft:netherrack', 'minecraft:wooden_pickaxe', 6, 4, 10],
  ])(
    '%s with %s: vanilla %i ticks, the server accepts from %i, the agent waits %i',
    (b, t, v, s, w) => {
      const speed = t === null ? 1 : TOOLS[t].speed;
      expect(vanillaDigTicks(b, speed)).toBe(v);
      expect(serverMinimumTicks(b, speed)).toBe(s);
      expect(digWaitTicks(b, speed)).toBe(w);
      // The server's rule, in its own float arithmetic: progress x (ticks + 1) >= 0.7.
      const p = Math.fround(digProgressPerTick(b, speed));
      expect(Math.fround(p * (s + 1))).toBeGreaterThanOrEqual(Math.fround(0.7));
      expect(Math.fround(p * s)).toBeLessThan(Math.fround(0.7));
      // Still about twice what the server needs, so a slow server accepts it.
      expect(w / s).toBeGreaterThan(1.8);
    },
  );

  it("a GT ore's time comes from its own hardness (1 + its level), not the table's hardest", () => {
    // A level-2 ore (hardness 3) with a copper Tinkers' pickaxe (speed 5): 18 ticks, the
    // server takes it from 12; with the table's hardness 8 the agent would wait 62.
    expect(vanillaDigTicks('gregtech:gt.blockores', 5, 3)).toBe(18);
    expect(serverMinimumTicks('gregtech:gt.blockores', 5, 3)).toBe(12);
    expect(digWaitTicks('gregtech:gt.blockores', 5, 3)).toBe(25);
    expect(digWaitTicks('gregtech:gt.blockores', 5)).toBe(62);
    // Lignite (level 0, hardness 1) with the wooden pickaxe.
    expect(digWaitTicks('gregtech:gt.blockores', 2, 1)).toBe(21);
  });

  it('a tool only speeds up the blocks it is made for', () => {
    const shovel = TOOLS['minecraft:wooden_shovel'];
    for (const b of DIGGABLE_BLOCKS) {
      expect(toolSpeedOn(shovel, b), b).toBe(SHOVEL_BLOCKS.includes(b) ? 2 : null);
    }
    expect(toolSpeedOn(TOOLS['minecraft:wooden_axe'], 'minecraft:sand')).toBeNull();
    expect(() => digWaitTicks('minecraft:sand', 0)).toThrow(/bad dig speed/);
  });
});

describe('tool wear and choice', () => {
  const shovel = TOOLS['minecraft:wooden_shovel'];
  const stack = (damage: number, more: Partial<{ count: number; hasNbt: boolean }> = {}) => ({
    tool: shovel,
    damage,
    count: 1,
    hasNbt: false,
    ...more,
  });

  it('uses a tool only while one more use leaves it at or below its maximum', () => {
    expect(usesLeft(shovel, 0)).toBe(59);
    expect(usesLeft(shovel, 58)).toBe(1);
    expect(usesLeft(shovel, 59)).toBe(0);
    expect(usesLeft(shovel, 63)).toBe(0); // possible on the server (64), never used by the agent
    expect(usesLeft(shovel, -1)).toBe(0);
    expect(toolProblem(stack(58), 'minecraft:sand')).toBeNull();
    expect(toolProblem(stack(59), 'minecraft:sand')).toMatch(
      /worn out \(damage 59, the agent stops at 59\)/,
    );
    expect(toolProblem(stack(0, { hasNbt: true }), 'minecraft:sand')).toMatch(/NBT data/);
    expect(toolProblem(stack(0, { count: 2 }), 'minecraft:sand')).toMatch(/2 x .* in one stack/);
    expect(toolProblem(stack(0), 'minecraft:log')).toMatch(/does not dig minecraft:log faster/);
  });

  it('picks the fastest usable tool; ties keep the order of preference', () => {
    const tools: Array<ToolStack & { id: string }> = [
      { id: 'wooden axe in hand', tool: TOOLS['minecraft:wooden_axe'], damage: 3 },
      { id: 'worn stone axe', tool: TOOLS['minecraft:stone_axe'], damage: 131 },
      { id: 'iron axe', tool: TOOLS['minecraft:iron_axe'], damage: 0 },
      { id: 'second iron axe', tool: TOOLS['minecraft:iron_axe'], damage: 9 },
      { id: 'shovel', tool: shovel, damage: 0 },
    ];
    const usable = (t: ToolStack) => usesLeft(t.tool, t.damage) > 0;
    expect(bestTool('minecraft:log', tools, usable)?.id).toBe('iron axe');
    expect(bestTool('minecraft:sand', tools, usable)?.id).toBe('shovel');
    expect(bestTool('minecraft:leaves', tools, usable)).toBeNull();
    expect(bestTool('minecraft:log', tools.slice(0, 2), usable)?.id).toBe('wooden axe in hand');
  });

  it('reads tools from inventory names, where the damage is appended', () => {
    expect(parseToolName('minecraft:wooden_shovel')).toEqual({ tool: shovel, damage: 0 });
    expect(parseToolName('minecraft:wooden_shovel@12')).toEqual({ tool: shovel, damage: 12 });
    expect(parseToolName('minecraft:iron_shovel@3')).toBeNull();
    expect(parseToolName('minecraft:sand')).toBeNull();
  });
});

describe('the mock client digs with tools like the live one', () => {
  const dig = (protectedItems: string[] = []) =>
    mintValidatedAction(
      action({ type: 'DIG_BLOCK', args: { position: { x: 2, y: 64, z: 1 } } }),
      null,
      new Date(),
      protectedItems,
    );

  it('holds the best usable tool and wears it by one', async () => {
    const { world, client } = makeWorld((w) => {
      Object.assign(w.inventory.items, {
        'minecraft:wooden_shovel@59': 1, // worn out for the agent
        'minecraft:wooden_shovel@4': 1,
        'minecraft:wooden_axe': 1, // not for dirt
      });
    });
    await client.connect();
    const r = await client.perform(dig());
    expect(r).toMatchObject({
      ok: true,
      data: { tool: 'minecraft:wooden_shovel', toolUsesLeft: 54, drops: '1 x minecraft:dirt' },
    });
    expect(r.message).toMatch(/with minecraft:wooden_shovel \(54 uses left\)/);
    expect(world.inventory.items).toMatchObject({
      'minecraft:wooden_shovel@4': 0,
      'minecraft:wooden_shovel@5': 1,
      'minecraft:wooden_shovel@59': 1,
      'minecraft:wooden_axe': 1,
    });
  });

  it('never wears a protected tool', async () => {
    const { world, client } = makeWorld((w) => {
      w.inventory.items['minecraft:wooden_shovel'] = 1;
    });
    await client.connect();
    const r = await client.perform(dig(['minecraft:wooden_shovel']));
    expect(r).toMatchObject({ ok: true, data: { tool: null, toolUsesLeft: null } });
    expect(world.inventory.items['minecraft:wooden_shovel']).toBe(1);
  });

  const digAt = (x: number, y: number, z: number) =>
    mintValidatedAction(
      action({ type: 'DIG_BLOCK', args: { position: { x, y, z } } }),
      null,
      new Date(),
      [],
    );

  it('digs stone only with a pickaxe: a hand would leave nothing, so it refuses', async () => {
    const { world, client } = makeWorld((w) => {
      w.resourceBlocks.push({ block: 'minecraft:stone', position: { x: 2, y: 65, z: 1 } });
    });
    await client.connect();
    const bare = await client.perform(digAt(2, 65, 1));
    expect(bare).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(bare.message).toMatch(
      /no carried tool harvests minecraft:stone .* a pickaxe of level 0/,
    );
    expect(world.resourceBlocks.some((r) => r.block === 'minecraft:stone')).toBe(true);

    world.inventory.items['minecraft:wooden_pickaxe'] = 1;
    const r = await client.perform(digAt(2, 65, 1));
    expect(r).toMatchObject({
      ok: true,
      data: {
        tool: 'minecraft:wooden_pickaxe',
        toolUsesLeft: 58,
        drops: '1 x minecraft:cobblestone',
      },
    });
    expect(world.inventory.items['minecraft:wooden_pickaxe@1']).toBe(1);
  });

  it("digs a GT ore of its pickaxe's level, read from a Tinkers' tool's NBT data", async () => {
    const { world, client } = makeWorld((w) => {
      // A level-2 iron ore and a level-3 tin ore (their metadata), with what each drops.
      w.resourceBlocks.push(
        {
          block: 'gregtech:gt.blockores',
          position: { x: 2, y: 65, z: 1 },
          meta: 2,
          drop: { item: 'gregtech:gt.metaitem.03@5032', count: 1 },
        },
        {
          block: 'gregtech:gt.blockores',
          position: { x: 2, y: 66, z: 1 },
          meta: 3,
          drop: { item: 'gregtech:gt.metaitem.03@5057', count: 1 },
        },
      );
      w.inventory.items['minecraft:wooden_pickaxe'] = 1;
      w.inventory.items['TConstruct:pickaxe'] = 1;
      w.toolNbt = { 'TConstruct:pickaxe': tinkers({ HarvestLevel: 2, Damage: 7 }) };
    });
    await client.connect();
    const iron = await client.perform(digAt(2, 65, 1));
    expect(iron).toMatchObject({
      ok: true,
      data: {
        tool: 'TConstruct:pickaxe',
        toolUsesLeft: 127,
        drops: '1 x gregtech:gt.metaitem.03@5032',
      },
    });
    expect(world.toolNbt?.['TConstruct:pickaxe']?.['InfiTool']).toMatchObject({ Damage: 8 });
    // Tin needs level 3: neither pickaxe harvests it.
    const tin = await client.perform(digAt(2, 66, 1));
    expect(tin).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(tin.message).toMatch(/a pickaxe of level 3 or more/);
    expect(world.inventory.items['minecraft:wooden_pickaxe']).toBe(1); // never worn for nothing
  });
});

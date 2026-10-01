import { describe, expect, it } from 'vitest';
import { DIGGABLE_BLOCKS, type DiggableBlock } from '../../src/domain/blocks.ts';
import {
  digProgressPerTick,
  digWaitTicks,
  serverMinimumTicks,
  vanillaDigTicks,
} from '../../src/domain/dig-time.ts';
import {
  bestTool,
  parseToolName,
  TOOL_ITEMS,
  TOOLS,
  toolInfo,
  toolProblem,
  toolSpeedOn,
  usesLeft,
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

describe('the tool allowlist', () => {
  it('holds the verified vanilla tools that work on the test server, and nothing else', () => {
    expect(
      Object.values(TOOLS).map((t) => [t.item, t.kind, t.speed, t.maxDamage, t.digsFaster]),
    ).toEqual([
      // GregTech raises the wooden tools' maximum to 64; the agent keeps vanilla's 59.
      ['minecraft:wooden_shovel', 'shovel', 2, 59, SHOVEL_BLOCKS],
      ['minecraft:wooden_axe', 'axe', 2, 59, LOGS],
      ['minecraft:stone_axe', 'axe', 4, 131, LOGS],
      ['minecraft:iron_axe', 'axe', 6, 250, LOGS],
      ['minecraft:golden_axe', 'axe', 12, 32, LOGS],
      ['minecraft:diamond_axe', 'axe', 8, 1561, LOGS],
    ]);
    for (const t of Object.values(TOOLS)) expect(t.evidence.length).toBeGreaterThan(40);
    // IguanaTweaks makes every other vanilla shovel dig nothing on this server.
    for (const useless of ['stone', 'iron', 'golden', 'diamond']) {
      expect(toolInfo(`minecraft:${useless}_shovel`)).toBeNull();
    }
    // No GregTech or TConstruct tool: their wear lives in NBT data the agent does not read.
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
      for (const b of ours.digsFaster) expect(server.blocks, `${item} on ${b}`).toContain(b);
    }
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
});

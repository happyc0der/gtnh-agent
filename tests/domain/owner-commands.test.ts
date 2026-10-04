import { describe, expect, it } from 'vitest';
import { gtOreByName } from '../../src/goals/ore-names.ts';
import {
  commandTextOf,
  DEFAULT_GOAL_COUNT,
  describeCommand,
  HELP_TEXT,
  isActionCommand,
  isStopText,
  isStructured,
  isTravelCommand,
  MAX_GOAL_COUNT,
  OwnerCommandSchema,
  parseOwnerCommand,
  resolveItemName,
  type ChatMessage,
  type OwnerCommand,
} from '../../src/domain/owner-commands.ts';

const OWNERS = ['DankAxon'];
const SELF = 'gtnh_agent';
const whisper = (sender: string, text: string): ChatMessage => ({ kind: 'whisper', sender, text });
const pub = (sender: string, text: string): ChatMessage => ({ kind: 'public', sender, text });

/** The command a text parses to (fails the test otherwise). */
function parsed(text: string): OwnerCommand {
  const p = parseOwnerCommand(text);
  if (!p.ok) throw new Error(`"${text}" did not parse: ${JSON.stringify(p)}`);
  return p.command;
}

describe('find and goto a block', () => {
  it('parses !find <block> and !goto <block> (a registry name, or words that name one)', () => {
    expect(parseOwnerCommand('!find chest')).toEqual({
      ok: true,
      command: { verb: 'find', block: 'minecraft:chest' },
    });
    expect(parseOwnerCommand('!find crafting table')).toEqual({
      ok: true,
      command: { verb: 'find', block: 'minecraft:crafting_table' },
    });
    expect(parseOwnerCommand('!locate table')).toEqual({
      ok: true,
      command: { verb: 'find', block: 'minecraft:crafting_table' },
    });
    expect(parseOwnerCommand('!find')).toMatchObject({ ok: false, kind: 'usage' });
    expect(parseOwnerCommand('!goto minecraft:chest')).toEqual({
      ok: true,
      command: { verb: 'goto-block', block: 'minecraft:chest' },
    });
    expect(parseOwnerCommand('!goto crafting table')).toEqual({
      ok: true,
      command: { verb: 'goto-block', block: 'minecraft:crafting_table' },
    });
    // "the", "nearest" mean nothing; numbers are a mistyped goto, never a block.
    expect(parseOwnerCommand('!goto the chest')).toEqual({
      ok: true,
      command: { verb: 'goto-block', block: 'minecraft:chest' },
    });
    expect(parseOwnerCommand('!find the nearest crafting table')).toEqual({
      ok: true,
      command: { verb: 'find', block: 'minecraft:crafting_table' },
    });
    expect(parseOwnerCommand('!goto 10 64 x')).toMatchObject({ ok: false, kind: 'usage' });
    // One plain word may be a waypoint: play looks for a block only when it is none.
    expect(parseOwnerCommand('!goto chest')).toEqual({
      ok: true,
      command: { verb: 'goto-waypoint', name: 'chest' },
    });
    expect(describeCommand({ verb: 'goto-block', block: 'minecraft:chest' })).toBe(
      'go to the nearest minecraft:chest',
    );
    // A GregTech ore by its material, as !mine names one.
    expect(parseOwnerCommand('!find iron ore', { ore: gtOreByName })).toEqual({
      ok: true,
      command: {
        verb: 'find',
        block: 'gregtech:gt.blockores',
        item: 'gregtech:gt.metaitem.03@5032',
      },
    });
  });
});

describe('surface', () => {
  it('parses !surface and !top, and takes no arguments', () => {
    expect(parseOwnerCommand('!surface')).toEqual({ ok: true, command: { verb: 'surface' } });
    expect(parseOwnerCommand('#top')).toEqual({ ok: true, command: { verb: 'surface' } });
    expect(parseOwnerCommand('!surface now')).toMatchObject({ ok: false, kind: 'usage' });
    expect(describeCommand({ verb: 'surface' })).toBe('go up to the surface');
  });
});

describe('which chat is a command', () => {
  it('an owner whispering the bot: always (the text as written)', () => {
    expect(commandTextOf(whisper('DankAxon', 'come here please'), OWNERS, SELF)).toEqual({
      sender: 'DankAxon',
      text: 'come here please',
      via: 'whisper',
    });
    expect(commandTextOf(whisper('DankAxon', '!stop'), OWNERS, SELF)?.text).toBe('!stop');
  });

  it('public chat only with a prefix or addressed to the bot by name', () => {
    expect(commandTextOf(pub('DankAxon', '!come'), OWNERS, SELF)).toMatchObject({
      text: '!come',
      via: 'public',
    });
    expect(commandTextOf(pub('DankAxon', '#goto 1 2'), OWNERS, SELF)?.text).toBe('#goto 1 2');
    expect(commandTextOf(pub('DankAxon', 'gtnh_agent, follow me'), OWNERS, SELF)?.text).toBe(
      'follow me',
    );
    expect(commandTextOf(pub('DankAxon', 'GTNH_Agent: status'), OWNERS, SELF)?.text).toBe('status');
    expect(commandTextOf(pub('DankAxon', '@gtnh_agent come'), OWNERS, SELF)?.text).toBe('come');
    expect(commandTextOf(pub('DankAxon', '@gtnh_agent, come'), OWNERS, SELF)?.text).toBe('come');
    // Talking about the bot, or to someone else, is not a command.
    for (const text of [
      'hello everyone',
      'gtnh_agent is slow today',
      '@gtnh_agentx come',
      'gtnh_agentx, come',
      '! come',
      '!',
    ]) {
      expect(commandTextOf(pub('DankAxon', text), OWNERS, SELF), text).toBeNull();
    }
  });

  it('only the owners, by exact name; never the bot itself; never other lines', () => {
    expect(commandTextOf(whisper('dankaxon', '!come'), OWNERS, SELF)).toBeNull();
    expect(commandTextOf(whisper('Mallory', '!come'), OWNERS, SELF)).toBeNull();
    expect(commandTextOf(pub('gtnh_agent', '!come'), [...OWNERS, 'gtnh_agent'], SELF)).toBeNull();
    expect(
      commandTextOf({ kind: 'other', sender: null, text: '<DankAxon> !come' }, OWNERS, SELF),
    ).toBeNull();
    expect(commandTextOf(whisper('DankAxon', '   '), OWNERS, SELF)).toBeNull();
    // No owners: nothing is a command.
    expect(commandTextOf(whisper('DankAxon', '!come'), [], SELF)).toBeNull();
    // RCON is an owner only when listed by its exact name (the live test).
    expect(commandTextOf(whisper('Rcon', 'status'), ['Rcon'], SELF)?.sender).toBe('Rcon');
  });
});

describe('GregTech ores by name (the caller resolves them: src/goals/ore-names.ts)', () => {
  const names = { ore: gtOreByName };
  it('mines an ore for its raw ore, and gets the raw ore, by the name a person uses', () => {
    expect(parseOwnerCommand('!mine 16 iron ore', names)).toEqual({
      ok: true,
      command: {
        verb: 'mine',
        count: 16,
        block: 'gregtech:gt.blockores',
        item: 'gregtech:gt.metaitem.03@5032',
      },
    });
    expect(parseOwnerCommand('!mine 8 brown limonite ores', names)).toMatchObject({
      ok: true,
      command: { verb: 'mine', item: 'gregtech:gt.metaitem.03@5930' },
    });
    expect(parseOwnerCommand('!get 4 copper ore', names)).toEqual({
      ok: true,
      command: { verb: 'get', count: 4, item: 'gregtech:gt.metaitem.03@5035' },
    });
  });

  it('without names, or for an ore that does not generate, it gives the usage', () => {
    expect(parseOwnerCommand('!mine 16 iron ore')).toMatchObject({ ok: false, kind: 'usage' });
    expect(parseOwnerCommand('!mine 2 unobtainium ore', names)).toMatchObject({
      ok: false,
      kind: 'usage',
    });
    // Not an ore: as before.
    expect(parseOwnerCommand('!mine 10 sand', names)).toMatchObject({
      ok: true,
      command: { block: 'minecraft:sand' },
    });
  });
});

describe('the structured form', () => {
  it('parses every verb, case-insensitively, with or without a prefix', () => {
    const cases: Array<[string, OwnerCommand]> = [
      ['!stop', { verb: 'stop' }],
      ['#STOP', { verb: 'stop' }],
      ['stop it!', { verb: 'stop' }],
      ['halt', { verb: 'stop' }],
      ['!pause', { verb: 'pause' }],
      ['!resume', { verb: 'resume' }],
      ['!status', { verb: 'status' }],
      ['!help', { verb: 'help' }],
      ['!come', { verb: 'come' }],
      ['come here please', { verb: 'come' }],
      ['come to me', { verb: 'come' }],
      ['!follow', { verb: 'follow', player: null }],
      ['follow me', { verb: 'follow', player: null }],
      ['!follow Steve_2', { verb: 'follow', player: 'Steve_2' }],
      ['!goto 120 64 -40', { verb: 'goto', x: 120, y: 64, z: -40 }],
      ['!goto 120, 64, -40.5', { verb: 'goto', x: 120, y: 64, z: -40.5 }],
      ['!goto 120 -40', { verb: 'goto', x: 120, y: null, z: -40 }],
      ['go to 5 7', { verb: 'goto', x: 5, y: null, z: 7 }],
      ['!goto Base', { verb: 'goto-waypoint', name: 'base' }],
      ['!goto home', { verb: 'home' }],
      ['!home', { verb: 'home' }],
      ['go home', { verb: 'home' }],
      ['!sethome', { verb: 'sethome' }],
      ['set home', { verb: 'sethome' }],
      ['!get 20 logs', { verb: 'get', count: 20, item: 'minecraft:log' }],
      ['!get logs 20', { verb: 'get', count: 20, item: 'minecraft:log' }],
      ['!get 3 minecraft:sand', { verb: 'get', count: 3, item: 'minecraft:sand' }],
      ['!get 64 cobble', { verb: 'get', count: 64, item: 'minecraft:cobblestone' }],
      ['!get 2 BiomesOPlenty:food@8', { verb: 'get', count: 2, item: 'BiomesOPlenty:food@8' }],
      ['!get 5 Natura:N Crops', { verb: 'get', count: 5, item: 'Natura:N Crops' }],
      ['!get 1 Minecraft:Flint', { verb: 'get', count: 1, item: 'minecraft:flint' }],
      [
        '!mine 10 sand',
        { verb: 'mine', count: 10, block: 'minecraft:sand', item: 'minecraft:sand' },
      ],
      [
        '!mine 8 grass',
        { verb: 'mine', count: 8, block: 'minecraft:grass', item: 'minecraft:dirt' },
      ],
      [
        '!mine 12 clay',
        { verb: 'mine', count: 12, block: 'minecraft:clay', item: 'minecraft:clay_ball' },
      ],
      ['!quests off', { verb: 'quests', on: false }],
      ['!QUESTS On', { verb: 'quests', on: true }],
      ['!waypoint base', { verb: 'waypoint', name: 'base' }],
      ['!wp Mine-2', { verb: 'waypoint', name: 'mine-2' }],
      ['!waypoint delete base', { verb: 'waypoint-delete', name: 'base' }],
      ['!wp rm base', { verb: 'waypoint-delete', name: 'base' }],
      ['!waypoints', { verb: 'waypoints' }],
      ['!waypoint', { verb: 'waypoints' }],
      ['!wp list', { verb: 'waypoints' }],
    ];
    for (const [text, command] of cases) {
      expect(parseOwnerCommand(text), text).toEqual({ ok: true, command });
      expect(OwnerCommandSchema.safeParse(command).success, text).toBe(true);
    }
  });

  it('a get or mine with no count: 16, or one of a tool; "me", "some" and "a" mean nothing', () => {
    const cases: Array<[string, unknown]> = [
      ['!get logs', { verb: 'get', count: DEFAULT_GOAL_COUNT, item: 'minecraft:log' }],
      ['!get me some logs', { verb: 'get', count: 16, item: 'minecraft:log' }],
      ['!get me 20 logs', { verb: 'get', count: 20, item: 'minecraft:log' }],
      ['!get wooden_pickaxe', { verb: 'get', count: 1, item: 'minecraft:wooden_pickaxe' }],
      ['!get a stone_axe', { verb: 'get', count: 1, item: 'minecraft:stone_axe' }],
      ['!get a furnace', { verb: 'get', count: 1, item: 'minecraft:furnace' }],
      ['!get me an iron_ingot', { verb: 'get', count: 1, item: 'minecraft:iron_ingot' }],
      ['!get some logs', { verb: 'get', count: 16, item: 'minecraft:log' }],
      ['!mine sand', { verb: 'mine', count: 16, block: 'minecraft:sand', item: 'minecraft:sand' }],
    ];
    for (const [text, command] of cases) {
      expect(parseOwnerCommand(text), text).toEqual({ ok: true, command });
    }
  });

  it('a known verb with arguments it does not take gives its usage', () => {
    const usage = (text: string): string => {
      const p = parseOwnerCommand(text);
      if (p.ok || p.kind !== 'usage') throw new Error(`${text}: ${JSON.stringify(p)}`);
      return p.usage;
    };
    expect(usage('!goto 10')).toMatch(/^usage: !goto/);
    expect(usage('!goto 1 2 3 4')).toMatch(/^usage: !goto/);
    expect(usage('!goto 1 300 3')).toMatch(/^usage: !goto/); // y is 0-255
    expect(usage('!get')).toMatch(/^usage: !get/);
    expect(usage('!get me')).toMatch(/^usage: !get/);
    expect(usage('!get 2.5 logs')).toMatch(/^usage: !get/);
    expect(usage(`!get ${MAX_GOAL_COUNT + 1} logs`)).toBe(`the count must be 1-${MAX_GOAL_COUNT}`);
    expect(usage('!get 0 logs')).toBe(`the count must be 1-${MAX_GOAL_COUNT}`);
    expect(usage('!mine 5 not:an:item')).toMatch(/^usage: !mine/);
    expect(usage('!quests maybe')).toMatch(/^usage: !quests/);
    expect(usage('!come with me now')).toMatch(/^usage: !come/);
    expect(usage('!follow two people')).toMatch(/^usage: !follow/);
    expect(usage('!waypoint delete')).toMatch(/^usage: !waypoint/); // "delete" is no name
    expect(usage('!waypoint _x')).toMatch(/^usage: !waypoint/); // names start with a letter or digit
    expect(usage('!waypoint 10')).toMatch(/^usage: !waypoint/); // and have a letter in them
    expect(usage(`!waypoint ${'a'.repeat(33)}`)).toMatch(/^usage: !waypoint/);
  });

  it('anything else is natural language: unknown, for the model', () => {
    for (const text of ['please bring me some wood', 'what are you doing', '!dance', '']) {
      expect(parseOwnerCommand(text), text).toEqual({ ok: false, kind: 'unknown' });
    }
  });

  it('knows its own form, its stops, and which commands are actions', () => {
    expect(isStructured('!come')).toBe(true);
    expect(isStructured(' #come')).toBe(true);
    expect(isStructured('come')).toBe(false);
    expect(isStopText('!stop')).toBe(true);
    expect(isStopText('stop now')).toBe(true);
    expect(isStopText('stop the music')).toBe(false);
    expect(isStopText('!status')).toBe(false);
    expect(isActionCommand(parsed('!come'))).toBe(true);
    expect(isActionCommand(parsed('!get 1 dirt'))).toBe(true);
    expect(isActionCommand(parsed('!status'))).toBe(false);
    expect(isTravelCommand(parsed('!home'))).toBe(true);
    expect(isTravelCommand(parsed('!mine 1 sand'))).toBe(false);
  });

  it('describes each command in a few words, and its help fits three whisper lines', () => {
    expect(describeCommand(parsed('!goto 120 64 -40.5'))).toBe('go to 120 64 -40.5');
    expect(describeCommand(parsed('!goto 1 2'))).toBe('go to 1 2');
    expect(describeCommand(parsed('!get 20 logs'))).toBe('get minecraft:log until I have 20');
    expect(describeCommand(parsed('!mine 8 grass'))).toBe(
      'mine minecraft:grass until I have 8 minecraft:dirt',
    );
    expect(describeCommand(parsed('!follow Steve'))).toBe('follow Steve');
    // 3 lines of 100 characters, less "/tell DankAxon " each.
    expect(HELP_TEXT.length).toBeLessThanOrEqual(3 * 85);
  });

  it('resolves item names: aliases, vanilla without its namespace, mod names as typed', () => {
    expect(resolveItemName('Logs')).toBe('minecraft:log');
    expect(resolveItemName('sand')).toBe('minecraft:sand');
    expect(resolveItemName('IronChest:BlockIronChest')).toBe('IronChest:BlockIronChest');
    expect(resolveItemName('minecraft:log@1')).toBe('minecraft:log@1');
    expect(resolveItemName('')).toBeNull();
    expect(resolveItemName('two words')).toBeNull();
  });
});

describe('explore (Baritone #explore)', () => {
  it('takes a compass direction and a distance in either order, both optional', () => {
    expect(parsed('!explore')).toEqual({ verb: 'explore', direction: null, distance: 64 });
    expect(parsed('!explore north')).toEqual({ verb: 'explore', direction: 'north', distance: 64 });
    expect(parsed('!explore ne 100')).toEqual({
      verb: 'explore',
      direction: 'north_east',
      distance: 100,
    });
    expect(parsed('!explore 40 south-west')).toEqual({
      verb: 'explore',
      direction: 'south_west',
      distance: 40,
    });
    expect(describeCommand(parsed('!explore north 100'))).toBe('explore 100 blocks north');
    expect(describeCommand(parsed('!explore'))).toBe('explore 64 blocks the way I have seen least');
  });

  it('is what going a compass direction means: !goto north, !go east, !walk 20 blocks west', () => {
    const north = { verb: 'explore', direction: 'north', distance: 64 };
    expect(parsed('!goto north')).toEqual(north);
    expect(parsed('!go to north')).toEqual(north);
    expect(parsed('!go north')).toEqual(north);
    expect(parsed('!head n')).toEqual(north);
    expect(parsed('!head north for a bit')).toEqual(north);
    expect(parsed('!goto north 20')).toEqual({ ...north, distance: 20 });
    expect(parsed('!walk 20 blocks west')).toEqual({ ...north, direction: 'west', distance: 20 });
    expect(parsed('!explore 30 blocks east')).toEqual({
      ...north,
      direction: 'east',
      distance: 30,
    });
    // Not a direction: a waypoint, a block, coordinates, as before.
    expect(parsed('!goto northgate')).toEqual({ verb: 'goto-waypoint', name: 'northgate' });
    expect(parsed('!goto 10 20')).toEqual({ verb: 'goto', x: 10, y: null, z: 20 });
    expect(parseOwnerCommand('!go somewhere')).toMatchObject({ ok: false });
  });

  it('gives its usage for anything else (a word that is no direction, too far, too much)', () => {
    for (const text of ['!explore up', '!explore 300', '!explore north south', '!explore 5']) {
      const p = parseOwnerCommand(text);
      expect(p, text).toMatchObject({ ok: false, kind: 'usage' });
    }
  });
});

describe('tunnel (Baritone #tunnel)', () => {
  it('takes a direction along an axis and a length, the length optional', () => {
    const level = { verb: 'tunnel', slope: 'level' };
    expect(parsed('!tunnel east')).toEqual({ ...level, direction: 'east', length: 16 });
    expect(parsed('!tunnel n 40')).toEqual({ ...level, direction: 'north', length: 40 });
    expect(parsed('!tunnel 8 west')).toEqual({ ...level, direction: 'west', length: 8 });
    expect(parsed('!tunnel east 20 down')).toEqual({
      verb: 'tunnel',
      direction: 'east',
      length: 20,
      slope: 'down',
    });
    expect(describeCommand(parsed('!tunnel south 20'))).toBe('dig a tunnel 20 blocks south');
    expect(describeCommand(parsed('!tunnel down south 20'))).toBe(
      'dig stairs 20 blocks down, going south',
    );
  });

  it('with no direction, the bot picks the way ("dig down 10": !tunnel down 10)', () => {
    expect(parsed('!tunnel down 10')).toEqual({
      verb: 'tunnel',
      direction: null,
      length: 10,
      slope: 'down',
    });
    expect(parsed('!tunnel')).toEqual({
      verb: 'tunnel',
      direction: null,
      length: 16,
      slope: 'level',
    });
    expect(parsed('!tunnel 20 blocks')).toMatchObject({ direction: null, length: 20 });
    expect(describeCommand(parsed('!tunnel down 10'))).toBe('dig stairs 10 blocks down');
    expect(describeCommand(parsed('!tunnel'))).toBe('dig a tunnel 16 blocks (I pick the way)');
  });

  it('gives its usage for a diagonal, two directions, a length past 64 or a stray word', () => {
    for (const text of [
      '!tunnel ne',
      '!tunnel east 100',
      '!tunnel east west',
      '!tunnel down 100',
      '!tunnel foo east',
    ]) {
      const p = parseOwnerCommand(text);
      expect(p, text).toMatchObject({ ok: false, kind: 'usage' });
    }
  });
});

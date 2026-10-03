import { describe, expect, it } from 'vitest';
import {
  commandTextOf,
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

  it('a known verb with arguments it does not take gives its usage', () => {
    const usage = (text: string): string => {
      const p = parseOwnerCommand(text);
      if (p.ok || p.kind !== 'usage') throw new Error(`${text}: ${JSON.stringify(p)}`);
      return p.usage;
    };
    expect(usage('!goto 10')).toMatch(/^usage: !goto/);
    expect(usage('!goto 1 2 3 4')).toMatch(/^usage: !goto/);
    expect(usage('!goto 1 300 3')).toMatch(/^usage: !goto/); // y is 0-255
    expect(usage('!get logs')).toMatch(/^usage: !get/);
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

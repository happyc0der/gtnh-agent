import { z } from 'zod';
import { ExploreDirectionSchema, type ExploreDirection } from './actions.ts';
import { COORDINATE_LIMIT, ItemNameSchema, MAX_TRANSFER_QUANTITY } from './common.ts';

/**
 * Owner commands: what the bot's owners (MC_OWNERS) may tell it in chat, Baritone-style
 * (`!come`, `!goto 120 64 -40`, `!get 20 logs`, `!stop`). The set is fixed: a command is one of
 * OwnerCommandSchema's, parsed here deterministically from the structured form, or translated
 * from natural language by the local model into the same schema (src/llm/
 * ollama-command-provider.ts) and then parsed and validated here like any other. A command
 * never acts by itself: the play loop (src/app/play/commands.ts) turns it into ordinary
 * actions, each validated by the safety policy, executed and verified like the agent's own.
 *
 * Chat text is untrusted. Only an owner's message is a command at all: a whisper to the bot,
 * or public chat that starts with a command prefix or the bot's own name (commandTextOf). Its
 * text is the only chat that ever reaches a model, and only to be translated into this schema.
 */

/**
 * A sender's name as the server shows it: a 1.7.10 player name (letters, digits and _), or
 * RCON's "Rcon" (seen live: an RCON /tell names its sender as the plain string "Rcon").
 */
export const SENDER_NAME = /^[A-Za-z0-9_]{1,16}$/;

/** An owner's (or the bot's own) player name, as MC_OWNERS lists them. */
export const PlayerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{3,16}$/, 'expected a player name (3-16 letters, digits or _)');

/** One chat line as the client reads it (src/bot/gtnh1710/chat.ts parseChat). */
export type ChatMessage =
  /** A whisper to the bot, or public chat, from a sender the server names. */
  | { kind: 'whisper' | 'public'; sender: string; text: string }
  /** Anything that cannot be attributed to a sender this way: never a command. */
  | { kind: 'other'; sender: null; text: string };

/** An owner's command as heard in chat: who sent it, its text, and how it came. */
export interface HeardCommand {
  sender: string;
  /** The command's text: a prefix (`!`, `#`) is kept, an address to the bot is not. */
  text: string;
  via: 'whisper' | 'public';
}

/** Longest command text kept (a player's chat line is at most 100 characters). */
export const MAX_COMMAND_TEXT = 256;

/**
 * The command in an owner's chat line, or null when it is none: the sender must be one of the
 * owners (exact, case-sensitive: offline-mode players that differ only by case are different
 * players, with different UUIDs) and not the bot itself, and the line a whisper to the bot, or
 * public chat that starts with `!` or `#`, or addresses the bot by name ("gtnh_agent, come
 * here", "@gtnh_agent come here").
 */
export function commandTextOf(
  message: ChatMessage,
  owners: readonly string[],
  self: string,
): HeardCommand | null {
  if (message.kind === 'other') return null;
  const sender = message.sender;
  if (sender === self || !owners.includes(sender)) return null;
  const text = message.text.trim().slice(0, MAX_COMMAND_TEXT);
  if (text === '') return null;
  if (message.kind === 'whisper') return { sender, text, via: 'whisper' };
  if (/^[!#]\S/.test(text)) return { sender, text, via: 'public' };
  const addressed = addressedText(text, self);
  return addressed === null ? null : { sender, text: addressed, via: 'public' };
}

/** "@gtnh_agent come here" or "gtnh_agent, come here" -> "come here"; anything else null. */
function addressedText(text: string, self: string): string | null {
  // A player name holds only [A-Za-z0-9_], so it is safe inside a regular expression.
  if (!SENDER_NAME.test(self)) return null;
  const m = new RegExp(`^(?:@${self}(?:[,:]\\s*|\\s+)|${self}[,:]\\s*)(\\S.*)$`, 'is').exec(text);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/** Most items a get or mine goal may ask for: a full inventory (36 stacks of 64). */
export const MAX_GOAL_COUNT = MAX_TRANSFER_QUANTITY;

/**
 * A waypoint's name: lowercase letters, digits, - and _, at most 32, starting with a letter or
 * a digit (it is stored as a named location, like `home`), and with a letter in it (`!goto 10`
 * is a coordinate gone wrong, not a waypoint).
 */
export const WAYPOINT_NAME = /^(?=[a-z0-9_-]*[a-z])[a-z0-9][a-z0-9_-]{0,31}$/;
/** Words a waypoint may not be called: they are the waypoint command's own. */
const RESERVED_WAYPOINTS: ReadonlySet<string> = new Set(['delete', 'del', 'remove', 'rm', 'list']);
export const WaypointNameSchema = z
  .string()
  .regex(
    WAYPOINT_NAME,
    'expected a waypoint name: lowercase letters, digits, - and _ (max 32, a letter in it)',
  )
  .refine((n) => !RESERVED_WAYPOINTS.has(n), 'that word is the waypoint command itself');

const Coordinate = z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT);
/** How far an explore command goes when the owner names no distance (blocks). */
export const EXPLORE_COMMAND_DISTANCE = 64;
/** The farthest an explore command goes (blocks): more is a goto. */
export const EXPLORE_COMMAND_MAX = 256;
/** The ways a tunnel goes: one block wide only along an axis. */
export const TUNNEL_DIRECTIONS = ['north', 'south', 'east', 'west'] as const;
export type TunnelDirection = (typeof TUNNEL_DIRECTIONS)[number];
/** A tunnel level, or a staircase down: one block down for each block forward. */
export type TunnelSlope = 'level' | 'down';
/** How long a tunnel is when the owner names no length (blocks). */
export const TUNNEL_COMMAND_LENGTH = 16;
/** The longest tunnel one command digs (blocks). */
export const TUNNEL_COMMAND_MAX = 64;
const Count = z.int().min(1).max(MAX_GOAL_COUNT);

export const OwnerCommandSchema = z.discriminatedUnion('verb', [
  /** Cancel the current command, stop the action in progress, and idle. */
  z.strictObject({ verb: z.literal('stop') }),
  /** Autonomous play off / on (commands still work while paused). */
  z.strictObject({ verb: z.literal('pause') }),
  z.strictObject({ verb: z.literal('resume') }),
  z.strictObject({ verb: z.literal('status') }),
  z.strictObject({ verb: z.literal('help') }),
  /** Walk to the sender. */
  z.strictObject({ verb: z.literal('come') }),
  /** Keep within about 3 blocks of a player (null: the sender), an owner only. */
  z.strictObject({ verb: z.literal('follow'), player: z.string().regex(SENDER_NAME).nullable() }),
  /** Travel to a point (y null: wherever the ground is at x, z). */
  z.strictObject({
    verb: z.literal('goto'),
    x: Coordinate,
    y: z.number().min(0).max(255).nullable(),
    z: Coordinate,
  }),
  /** Travel to a named location (a waypoint, home included). */
  z.strictObject({ verb: z.literal('goto-waypoint'), name: WaypointNameSchema }),
  /**
   * Explore `distance` blocks toward a compass direction (null: the one seen least), as
   * Baritone's #explore: a travel to the point that far that way from where it starts.
   */
  z.strictObject({
    verb: z.literal('explore'),
    direction: ExploreDirectionSchema.nullable(),
    distance: z.int().min(8).max(EXPLORE_COMMAND_MAX),
  }),
  /**
   * Dig a straight tunnel, one block wide and two high, `length` blocks toward a compass
   * direction from where the bot stands, as Baritone's #tunnel (code plans it: tunnel.ts).
   */
  z.strictObject({
    verb: z.literal('tunnel'),
    direction: z.enum(TUNNEL_DIRECTIONS),
    length: z.int().min(1).max(TUNNEL_COMMAND_MAX),
    /** Stored before stairs existed: level. */
    slope: z.enum(['level', 'down']).default('level'),
  }),
  /** Have `count` of `item`, pursued like `cli play --needs`. */
  z.strictObject({ verb: z.literal('get'), count: Count, item: ItemNameSchema }),
  /** Have `count` of what `block` drops (`item`), by mining it, likewise. */
  z.strictObject({
    verb: z.literal('mine'),
    count: Count,
    block: ItemNameSchema,
    item: ItemNameSchema,
  }),
  /** Home (the `home` safe location) is where the bot stands now; go there. */
  z.strictObject({ verb: z.literal('sethome') }),
  z.strictObject({ verb: z.literal('home') }),
  /** Autonomous quest play on or off, kept across restarts. */
  z.strictObject({ verb: z.literal('quests'), on: z.boolean() }),
  /** Save where the bot stands as a waypoint, delete one, list them. */
  z.strictObject({ verb: z.literal('waypoint'), name: WaypointNameSchema }),
  z.strictObject({ verb: z.literal('waypoint-delete'), name: WaypointNameSchema }),
  z.strictObject({ verb: z.literal('waypoints') }),
]);
export type OwnerCommand = z.infer<typeof OwnerCommandSchema>;
export type OwnerVerb = OwnerCommand['verb'];

/** Commands that walk somewhere: come, follow, goto (a point or a waypoint), home. */
export type TravelCommand = Extract<
  OwnerCommand,
  { verb: 'come' | 'follow' | 'goto' | 'goto-waypoint' | 'home' | 'explore' }
>;
/** Commands that pursue items to have: get, mine. */
export type GoalCommand = Extract<OwnerCommand, { verb: 'get' | 'mine' }>;
/** A tunnel to dig: code plans its steps. */
export type TunnelCommand = Extract<OwnerCommand, { verb: 'tunnel' }>;
/** Commands that make the bot do something over time: one runs at a time. */
export type ActionCommand = TravelCommand | GoalCommand | TunnelCommand;
/** Commands done at once: stop, pause, status, waypoints... */
export type InstantCommand = Exclude<OwnerCommand, ActionCommand>;

const TRAVEL_VERBS: ReadonlySet<OwnerVerb> = new Set<OwnerVerb>([
  'come',
  'follow',
  'goto',
  'goto-waypoint',
  'home',
  'explore',
]);

export function isTravelCommand(c: OwnerCommand): c is TravelCommand {
  return TRAVEL_VERBS.has(c.verb);
}

export function isActionCommand(c: OwnerCommand): c is ActionCommand {
  return isTravelCommand(c) || c.verb === 'get' || c.verb === 'mine' || c.verb === 'tunnel';
}

// ---------------------------------------------------------------------------
// The structured form
// ---------------------------------------------------------------------------

/** Words an owner may name items and blocks by (aliases), and what they mean. */
export const ITEM_ALIASES: Readonly<Record<string, string>> = {
  log: 'minecraft:log',
  logs: 'minecraft:log',
  wood: 'minecraft:log',
  plank: 'minecraft:planks',
  planks: 'minecraft:planks',
  stick: 'minecraft:stick',
  sticks: 'minecraft:stick',
  cobble: 'minecraft:cobblestone',
  cobblestone: 'minecraft:cobblestone',
  stone: 'minecraft:stone',
  dirt: 'minecraft:dirt',
  grass: 'minecraft:grass',
  sand: 'minecraft:sand',
  gravel: 'minecraft:gravel',
  flint: 'minecraft:flint',
  clay: 'minecraft:clay',
  leaves: 'minecraft:leaves',
  sapling: 'minecraft:sapling',
  saplings: 'minecraft:sapling',
  apple: 'minecraft:apple',
  apples: 'minecraft:apple',
  torch: 'minecraft:torch',
  torches: 'minecraft:torch',
  coal: 'minecraft:coal',
};

/**
 * What mining a block leaves in the inventory, where it is not the block itself (vanilla
 * 1.7.10, unchanged by GTNH for these: grass drops dirt, stone cobblestone, a clay block 4
 * clay balls). Every other block counts as its own item.
 */
const MINE_DROPS: Readonly<Record<string, string>> = {
  'minecraft:grass': 'minecraft:dirt',
  'minecraft:stone': 'minecraft:cobblestone',
  'minecraft:clay': 'minecraft:clay_ball',
};

/** How each verb is written, for a reply when its arguments are not understood. */
export const USAGE: Readonly<Partial<Record<string, string>>> = {
  follow: 'usage: !follow [player]',
  goto: 'usage: !goto <x> <y> <z>, !goto <x> <z> or !goto <waypoint>',
  explore: 'usage: !explore [direction] [blocks], e.g. !explore north 100 (8-256 blocks)',
  tunnel:
    'usage: !tunnel <north|south|east|west> [blocks] [down], e.g. !tunnel east 20, or !tunnel east 20 down for stairs (1-64 blocks)',
  get: 'usage: !get <count> <item>, e.g. !get 20 logs (any wood; minecraft:log@2: birch only)',
  mine: 'usage: !mine <count> <block>, e.g. !mine 10 sand or !mine 16 iron ore',
  quests: 'usage: !quests on or !quests off',
  waypoint: 'usage: !waypoint <name>, !waypoint delete <name> or !waypoints',
};

export const HELP_TEXT =
  'Commands: !stop !pause !resume !status !come !follow [player] !goto <x> [y] <z> | <waypoint> ' +
  '!explore [dir] [n] !tunnel <dir> [n] ' +
  '!get <n> <item> !mine <n> <block> !sethome !home !waypoint <name> | delete <name> ' +
  '!waypoints !quests on|off';

/**
 * Names the parser cannot know by itself (the domain holds no game data): `ore` resolves a
 * GregTech ore a person names ("iron ore") to the block to dig and the raw ore it yields
 * (src/goals/ore-names.ts gtOreByName). Without it, ores are not understood.
 */
export interface CommandNames {
  ore?: (name: string) => { block: string; item: string } | null;
}

/** How an owner's text parses. */
export type CommandParse =
  | { ok: true; command: OwnerCommand }
  /** Not the structured form: natural language, for the model to translate. */
  | { ok: false; kind: 'unknown' }
  /** A known verb with arguments it does not take: how to write it. */
  | { ok: false; kind: 'usage'; usage: string };

/** The structured form starts with `!` or `#`: it is parsed in code only, never by a model. */
export function isStructured(text: string): boolean {
  return /^[!#]/.test(text.trim());
}

/** Words that may stand anywhere in a command and mean nothing to it. */
const FILLER: ReadonlySet<string> = new Set(['please', 'pls', 'plz']);

const NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Parses an owner's command text deterministically: a verb (case-insensitive) and its
 * arguments, with or without the `!`/`#` prefix; item names with or without `minecraft:`,
 * and aliases (logs, cobble...). Commas count as spaces, and a trailing `.`, `!` or `?` and
 * "please" are ignored. Anything that is not a known verb is 'unknown' (natural language);
 * a known verb with arguments it does not take gives its usage.
 */
export function parseOwnerCommand(text: string, names: CommandNames = {}): CommandParse {
  const body = text
    .trim()
    .replace(/^[!#]\s*/, '')
    .replace(/[.!?]+$/, '');
  const tokens = body.split(/[\s,]+/).filter((t) => t !== '' && !FILLER.has(t.toLowerCase()));
  let verb = (tokens[0] ?? '').toLowerCase();
  let args = tokens.slice(1);
  const lower = (i: number): string => (args[i] ?? '').toLowerCase();
  // Two-word forms of one verb.
  if (verb === 'go' && lower(0) === 'to') [verb, args] = ['goto', args.slice(1)];
  if (verb === 'go' && lower(0) === 'home' && args.length === 1) [verb, args] = ['home', []];
  if (verb === 'set' && lower(0) === 'home' && args.length === 1) [verb, args] = ['sethome', []];
  if (verb === 'come' && (lower(0) === 'here' || lower(0) === 'back') && args.length === 1) {
    args = [];
  }
  if (verb === 'come' && lower(0) === 'to' && lower(1) === 'me' && args.length === 2) args = [];
  const none = args.length === 0;
  const ok = (command: OwnerCommand): CommandParse => {
    const parsed = OwnerCommandSchema.safeParse(command);
    return parsed.success ? { ok: true, command: parsed.data } : usage(verb);
  };
  switch (verb) {
    case 'stop':
    case 'halt':
    case 'cancel':
      return none || (args.length === 1 && ['it', 'now'].includes(lower(0)))
        ? ok({ verb: 'stop' })
        : usage(verb);
    case 'pause':
      return none ? ok({ verb: 'pause' }) : usage(verb);
    case 'resume':
    case 'continue':
      return none ? ok({ verb: 'resume' }) : usage(verb);
    case 'status':
      return none ? ok({ verb: 'status' }) : usage(verb);
    case 'help':
    case 'commands':
      return none ? ok({ verb: 'help' }) : usage(verb);
    case 'come':
      return none ? ok({ verb: 'come' }) : usage(verb);
    case 'follow':
      if (none || (args.length === 1 && lower(0) === 'me'))
        return ok({ verb: 'follow', player: null });
      return args.length === 1 && SENDER_NAME.test(args[0] ?? '')
        ? ok({ verb: 'follow', player: args[0] ?? null })
        : usage(verb);
    case 'goto':
      return gotoCommand(args);
    case 'explore':
      return exploreCommand(args);
    case 'tunnel':
      return tunnelCommand(args);
    case 'home':
      return none ? ok({ verb: 'home' }) : usage(verb);
    case 'sethome':
      return none ? ok({ verb: 'sethome' }) : usage(verb);
    case 'get':
    case 'mine':
      return goalCommand(verb, args, names);
    case 'quests':
      return args.length === 1 && (lower(0) === 'on' || lower(0) === 'off')
        ? ok({ verb: 'quests', on: lower(0) === 'on' })
        : usage(verb);
    case 'waypoint':
    case 'wp':
      return waypointCommand(args);
    case 'waypoints':
    case 'wps':
      return none ? ok({ verb: 'waypoints' }) : usage('waypoint');
    default:
      return { ok: false, kind: 'unknown' };
  }
}

function usage(verb: string): CommandParse {
  const known = verb === 'wp' ? 'waypoint' : verb;
  return {
    ok: false,
    kind: 'usage',
    usage: USAGE[known] ?? `usage: !${known} (it takes no arguments)`,
  };
}

function gotoCommand(args: readonly string[]): CommandParse {
  const nums = args.every((a) => NUMBER.test(a)) ? args.map(Number) : null;
  let command: unknown = null;
  if (nums !== null && nums.length === 3) {
    command = { verb: 'goto', x: nums[0], y: nums[1], z: nums[2] };
  } else if (nums !== null && nums.length === 2) {
    command = { verb: 'goto', x: nums[0], y: null, z: nums[1] };
  } else if (args.length === 1) {
    const name = (args[0] ?? '').toLowerCase();
    // Home is the waypoint named home: going there is `home`.
    command = name === 'home' ? { verb: 'home' } : { verb: 'goto-waypoint', name };
  }
  const parsed = OwnerCommandSchema.safeParse(command);
  return parsed.success ? { ok: true, command: parsed.data } : usage('goto');
}

/** Words for the compass directions: "north", "n", "northeast", "north-east", "ne"... */
function directionOf(word: string): ExploreDirection | null {
  const w = word.toLowerCase().replace(/[-\s]/g, '_');
  const short: Readonly<Record<string, ExploreDirection>> = {
    n: 'north',
    ne: 'north_east',
    e: 'east',
    se: 'south_east',
    s: 'south',
    sw: 'south_west',
    w: 'west',
    nw: 'north_west',
    northeast: 'north_east',
    southeast: 'south_east',
    southwest: 'south_west',
    northwest: 'north_west',
  };
  const parsed = ExploreDirectionSchema.safeParse(w);
  return parsed.success ? parsed.data : (short[w] ?? null);
}

function exploreCommand(args: readonly string[]): CommandParse {
  // "explore", "explore north", "explore 100", "explore north 100", "explore 100 north".
  let direction: ExploreDirection | null = null;
  let distance = EXPLORE_COMMAND_DISTANCE;
  for (const a of args) {
    if (NUMBER.test(a)) distance = Number(a);
    else {
      const d = directionOf(a);
      if (d === null || direction !== null) return usage('explore');
      direction = d;
    }
  }
  if (args.length > 2) return usage('explore');
  const parsed = OwnerCommandSchema.safeParse({ verb: 'explore', direction, distance });
  return parsed.success ? { ok: true, command: parsed.data } : usage('explore');
}

function tunnelCommand(args: readonly string[]): CommandParse {
  // "tunnel east", "tunnel east 20", "tunnel 20 east", "tunnel east 20 down" (stairs down).
  let direction: string | null = null;
  let length = TUNNEL_COMMAND_LENGTH;
  let slope: TunnelSlope = 'level';
  if (args.length === 0 || args.length > 3) return usage('tunnel');
  for (const a of args) {
    if (NUMBER.test(a)) length = Number(a);
    else if (a.toLowerCase() === 'down') slope = 'down';
    else if (direction !== null) return usage('tunnel');
    else {
      direction = directionOf(a);
      if (direction === null) return usage('tunnel');
    }
  }
  const parsed = OwnerCommandSchema.safeParse({ verb: 'tunnel', direction, length, slope });
  return parsed.success ? { ok: true, command: parsed.data } : usage('tunnel');
}

function goalCommand(
  verb: 'get' | 'mine',
  args: readonly string[],
  names: CommandNames,
): CommandParse {
  // "get 20 logs" or "get logs 20"; an item name may hold spaces ("Natura:N Crops").
  let count: string | undefined;
  let words: readonly string[];
  if (NUMBER.test(args[0] ?? '')) [count, words] = [args[0], args.slice(1)];
  else if (NUMBER.test(args.at(-1) ?? '')) [count, words] = [args.at(-1), args.slice(0, -1)];
  else return usage(verb);
  const n = Number(count);
  // "iron ore", "copper ores": a GregTech ore, mined for its raw ore (the caller's names).
  const text = words.join(' ');
  const ore = /\sores?$/i.test(text) ? (names.ore?.(text) ?? null) : null;
  const name = ore === null ? resolveItemName(text) : ore.item;
  if (!Number.isInteger(n) || name === null) return usage(verb);
  if (n < 1 || n > MAX_GOAL_COUNT) {
    return { ok: false, kind: 'usage', usage: `the count must be 1-${MAX_GOAL_COUNT}` };
  }
  const command =
    verb === 'get'
      ? { verb, count: n, item: name }
      : ore !== null
        ? { verb, count: n, block: ore.block, item: ore.item }
        : { verb, count: n, block: name, item: MINE_DROPS[name] ?? name };
  const parsed = OwnerCommandSchema.safeParse(command);
  return parsed.success ? { ok: true, command: parsed.data } : usage(verb);
}

function waypointCommand(args: readonly string[]): CommandParse {
  const first = (args[0] ?? '').toLowerCase();
  let command: unknown = null;
  if (args.length === 0 || (args.length === 1 && first === 'list')) command = { verb: 'waypoints' };
  else if (args.length === 2 && RESERVED_WAYPOINTS.has(first) && first !== 'list') {
    command = { verb: 'waypoint-delete', name: (args[1] ?? '').toLowerCase() };
  } else if (args.length === 1) command = { verb: 'waypoint', name: first };
  const parsed = OwnerCommandSchema.safeParse(command);
  return parsed.success ? { ok: true, command: parsed.data } : usage('waypoint');
}

/**
 * An item or block as an owner names it: an alias (logs, cobble...), a vanilla name without
 * its namespace (`sand` is `minecraft:sand`), or a full registry name as the inventory names
 * it (`BiomesOPlenty:food@8`, kept as typed: mod names are case-sensitive). Null when it is
 * none of these.
 */
export function resolveItemName(raw: string): string | null {
  const text = raw.trim();
  const alias = ITEM_ALIASES[text.toLowerCase()];
  // Vanilla's names are all lowercase, with no spaces; other mods' keep their case.
  const vanilla = !text.includes(':') || /^minecraft:/i.test(text);
  const name =
    alias ?? (vanilla ? `minecraft:${text.toLowerCase().replace(/^minecraft:/, '')}` : text);
  if (vanilla && name.includes(' ')) return null;
  return ItemNameSchema.safeParse(name).success ? name : null;
}

/** A coordinate as an owner would write it: a whole number as is, else one decimal. */
const coord = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** What a command asks for, in a few words (acknowledgements, status, the task's goal). */
export function describeCommand(c: OwnerCommand): string {
  switch (c.verb) {
    case 'stop':
      return 'stop';
    case 'pause':
      return 'pause autonomous play';
    case 'resume':
      return 'resume autonomous play';
    case 'status':
      return 'report status';
    case 'help':
      return 'list the commands';
    case 'come':
      return 'come to you';
    case 'follow':
      return c.player === null ? 'follow you' : `follow ${c.player}`;
    case 'goto':
      return `go to ${coord(c.x)} ${c.y === null ? '' : `${coord(c.y)} `}${coord(c.z)}`;
    case 'goto-waypoint':
      return `go to waypoint ${c.name}`;
    case 'explore':
      return `explore ${c.distance} blocks ${c.direction === null ? 'the way I have seen least' : c.direction.replace('_', '-')}`;
    case 'tunnel':
      return c.slope === 'down'
        ? `dig stairs ${c.length} blocks down, going ${c.direction}`
        : `dig a tunnel ${c.length} blocks ${c.direction}`;
    case 'home':
      return 'go home';
    case 'get':
      return `get ${c.item} until I have ${c.count}`;
    case 'mine':
      return c.block === c.item
        ? `mine ${c.block} until I have ${c.count}`
        : `mine ${c.block} until I have ${c.count} ${c.item}`;
    case 'sethome':
      return 'set home here';
    case 'quests':
      return `quests ${c.on ? 'on' : 'off'}`;
    case 'waypoint':
      return `save waypoint ${c.name}`;
    case 'waypoint-delete':
      return `delete waypoint ${c.name}`;
    case 'waypoints':
      return 'list the waypoints';
  }
}

/** True when the text is a stop in the structured form (the client stops the action at once). */
export function isStopText(text: string): boolean {
  const parsed = parseOwnerCommand(text);
  return parsed.ok && parsed.command.verb === 'stop';
}

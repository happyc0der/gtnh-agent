import { SENDER_NAME, type ChatMessage } from '../../domain/owner-commands.ts';

/**
 * Chat, read and written as narrowly as possible (owner commands: src/domain/owner-commands.ts).
 *
 * In: an S02 chat line is a 1.7.10 chat component (IChatComponent.Serializer's JSON). parseChat
 * attributes it to a sender only in the shapes vanilla builds, and fails closed: everything
 * else is 'other', which is never a command. Seen live on the test server (2026-10-03, the
 * agent's own client):
 *  - a whisper: {"italic":true,"color":"gray","translate":"commands.message.display.incoming",
 *    "with":["Rcon",{"extra":["hello"," ","from"," ","rcon"," ","whisper"],"text":""}]}: the
 *    sender a plain string (RCON) or, from a player, its name component (a "text" with a
 *    suggest_command "/msg <name> " click event: EntityPlayer.func_145748_c_), and the text
 *    word by word in `extra` (CommandBase builds it so);
 *  - `say` (chat.type.announcement) and `/me` (chat.type.emote): the same shape, never a
 *    command;
 *  - join messages as plain strings with formatting codes ("§lWelcome to GregTech: New
 *    Horizons §a2.8.4") and ServerUtilities' own translations: other.
 * Public chat (chat.type.text, [sender, message]) could not be captured yet; it is vanilla's
 * shape (NetHandlerPlayServer, the message from Forge's newChatWithLinks). A mod that formats
 * chat itself may send plain text "<Name> message": that is read too, only when nothing in it
 * is a translation.
 *
 * Out: a whisper to an owner (packets.ts outbound.whisper), with text sanitizeChatText made
 * plain and whisperLines cut to the server's line limit.
 */

/**
 * 1.7.10's limit for a chat line from a client: C01's string is read with
 * readStringFromBuffer(100), and a longer one disconnects the client.
 */
export const CHAT_LINE_MAX = 100;
/** Lines one reply may take; a longer reply is cut short. */
export const MAX_REPLY_LINES = 3;

/** Deepest component nesting read (vanilla nests two or three levels). */
const MAX_DEPTH = 8;
/** Longest text kept from one component. */
const MAX_TEXT = 1_000;
/** Longest message text a command may have. */
const MAX_MESSAGE = 256;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A component's plain text, and whether a translation is anywhere in it. */
interface Flat {
  text: string;
  translates: boolean;
}

/** A component (string, object or array) as plain text; null when it is too deep or odd. */
function flatten(component: unknown, depth: number): Flat | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof component === 'string') return { text: component, translates: false };
  if (typeof component === 'number' || typeof component === 'boolean') {
    return { text: String(component), translates: false };
  }
  const parts: unknown[] = Array.isArray(component) ? component : [];
  let text = '';
  let translates = false;
  if (isObject(component)) {
    if (typeof component['text'] === 'string') text += component['text'];
    if (typeof component['translate'] === 'string') {
      // Only for 'other' lines (a diagnostic): the key and its arguments.
      translates = true;
      const args = Array.isArray(component['with']) ? component['with'] : [];
      const flatArgs = args.map((a) => flatten(a, depth + 1)?.text ?? '?');
      text += `${component['translate']}(${flatArgs.join(', ')})`;
    }
    if (Array.isArray(component['extra'])) parts.push(...(component['extra'] as unknown[]));
  } else if (!Array.isArray(component)) {
    return null;
  }
  for (const part of parts) {
    const f = flatten(part, depth + 1);
    if (f === null) return null;
    text += f.text;
    translates ||= f.translates;
    if (text.length > MAX_TEXT) break;
  }
  return { text: text.slice(0, MAX_TEXT), translates };
}

/** Removes 1.7.10 formatting codes (§ and the character after it). */
export function stripFormatting(text: string): string {
  return text.replace(/§[\s\S]?/g, '');
}

/** A C0 or C1 control character, DEL, or half of a surrogate pair. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff);
}

/** The text with every control character (line breaks too) made a space. */
function withoutControls(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += ch.length > 1 || isControl(code) ? ' ' : ch;
  }
  return out;
}

/** The name a /msg click event of a name component suggests ("/msg DankAxon "), or null. */
function msgTarget(click: unknown): string | null {
  if (!isObject(click) || click['action'] !== 'suggest_command') return null;
  const value = click['value'];
  if (typeof value !== 'string') return null;
  const m = /^\/(?:msg|tell|w) ([A-Za-z0-9_]{1,16}) ?$/.exec(value);
  return m?.[1] ?? null;
}

/**
 * The sender a chat line names: a plain string (RCON's "Rcon"), or a name component. Its
 * text, without formatting, must be a player name, and its click event, when it has one,
 * must name the same player. A scoreboard team's prefix or suffix around the name
 * (ScorePlayerTeam.formatPlayerName) is accepted only when the server's own /msg click event
 * names a player whose name stands in the text. Null when the sender is not clear.
 */
function senderName(component: unknown): string | null {
  const flat = flatten(component, 1);
  if (flat === null || flat.translates) return null;
  const shown = stripFormatting(flat.text).trim();
  const click = isObject(component) ? msgTarget(component['clickEvent']) : null;
  if (SENDER_NAME.test(shown)) return click === null || click === shown ? shown : null;
  if (click !== null && shown.split(/[^A-Za-z0-9_]+/).includes(click)) return click;
  return null;
}

/** A message's plain text: no formatting, no control characters, spaces collapsed. */
function messageText(component: unknown): string | null {
  const flat = flatten(component, 1);
  if (flat === null || flat.translates) return null;
  const text = withoutControls(stripFormatting(flat.text)).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text.slice(0, MAX_MESSAGE);
}

const other = (text: string): ChatMessage => ({
  kind: 'other',
  sender: null,
  text: withoutControls(stripFormatting(text)).slice(0, MAX_MESSAGE),
});

/** The translation keys a sender's line comes with: a whisper to the bot, and public chat. */
const SENDER_LINES: Readonly<Record<string, 'whisper' | 'public'>> = {
  'commands.message.display.incoming': 'whisper',
  'chat.type.text': 'public',
};

/**
 * Reads one S02 chat line (its JSON) as a whisper to the bot, public chat, or 'other'. A
 * whisper or a public line needs exactly vanilla's shape: the translation key, two arguments
 * (the sender and the message), nothing appended; the sender a player name (senderName), the
 * message plain text. The echo of the bot's own whisper (commands.message.display.outgoing,
 * which names the RECIPIENT), announcements, emotes, deaths, joins and every mod's lines are
 * 'other'.
 */
export function parseChat(json: string): ChatMessage {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return other(json);
  }
  if (isObject(root) && typeof root['translate'] === 'string') {
    const kind = SENDER_LINES[root['translate']];
    const args = root['with'];
    if (
      kind !== undefined &&
      Array.isArray(args) &&
      args.length === 2 &&
      root['text'] === undefined &&
      root['extra'] === undefined
    ) {
      const sender = senderName(args[0]);
      const text = messageText(args[1]);
      if (sender !== null && text !== null) return { kind, sender, text };
    }
    return other(flatten(root, 0)?.text ?? '');
  }
  // A line a mod formats itself: "<Name> message", with no translation anywhere in it.
  const flat = flatten(root, 0);
  if (flat === null) return other('');
  if (flat.translates) return other(flat.text);
  const plain = withoutControls(stripFormatting(flat.text)).replace(/\s+/g, ' ').trim();
  const m = /^<([A-Za-z0-9_]{1,16})> (\S.*)$/.exec(plain);
  if (m === null) return other(plain);
  return { kind: 'public', sender: m[1] ?? '', text: (m[2] ?? '').slice(0, MAX_MESSAGE) };
}

// ---------------------------------------------------------------------------
// Out: the text of a whisper
// ---------------------------------------------------------------------------

/**
 * Why `text` may not follow `/tell <owner> ` on a chat line, or null: it must be plain
 * printable text (the server kicks a client for a § or a control character: "Illegal
 * characters in chat"), on one line, and not start with / (it would read as a command of its
 * own once split).
 */
export function chatTextProblem(text: string): string | null {
  if (text.trim() === '') return 'the text is empty';
  if (text.startsWith('/')) return 'the text starts with /';
  if (text !== text.trim()) return 'the text starts or ends with a space';
  if (text.includes('§')) return 'the text holds a formatting code (§)';
  for (const ch of text) {
    if (ch.length > 1 || isControl(ch.charCodeAt(0))) {
      return 'the text holds a control character, a line break or a surrogate';
    }
  }
  return null;
}

/** Plain text for a chat line: formatting codes and control characters out, one line. */
export function sanitizeChatText(text: string): string {
  return withoutControls(stripFormatting(text).replace(/§/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * A reply cut into the lines of a whisper to `owner`: each fits CHAT_LINE_MAX with
 * `/tell <owner> ` before it, cut at a space where it can be, never starting with /; at most
 * `maxLines`, the last ending in "..." when the reply is longer.
 */
export function whisperLines(owner: string, text: string, maxLines = MAX_REPLY_LINES): string[] {
  const room = CHAT_LINE_MAX - `/tell ${owner} `.length;
  const lines: string[] = [];
  const clean = (s: string): string => s.replace(/^[/\s]+/, '');
  let rest = clean(sanitizeChatText(text));
  while (rest !== '' && lines.length < maxLines) {
    if (rest.length <= room) {
      lines.push(rest);
      break;
    }
    if (lines.length === maxLines - 1) {
      lines.push(`${rest.slice(0, room - 3).trimEnd()}...`);
      break;
    }
    let cut = rest.lastIndexOf(' ', room);
    if (cut < room / 2) cut = room; // one long word: cut it
    lines.push(rest.slice(0, cut).trimEnd());
    rest = clean(rest.slice(cut));
  }
  return lines.filter((l) => chatTextProblem(l) === null);
}

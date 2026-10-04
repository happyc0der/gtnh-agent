import { describe, expect, it } from 'vitest';
import {
  CHAT_LINE_MAX,
  chatTextProblem,
  MAX_REPLY_LINES,
  parseChat,
  sanitizeChatText,
  stripFormatting,
  whisperLines,
} from '../../../src/bot/gtnh1710/chat.ts';
import { outbound } from '../../../src/bot/gtnh1710/packets.ts';
import { Reader } from '../../../src/bot/gtnh1710/wire.ts';

/**
 * Chat lines exactly as the live test server sent them to the agent's own client
 * (2026-10-03, captured by the lead): an RCON whisper, `say`, `/me`, a join message.
 */
const LIVE = {
  whisper:
    '{"italic":true,"color":"gray","translate":"commands.message.display.incoming","with":["Rcon",{"extra":["hello"," ","from"," ","rcon"," ","whisper"],"text":""}]}',
  say: '{"translate":"chat.type.announcement","with":["Rcon",{"extra":["hello"," ","everyone"],"text":""}]}',
  emote: '{"translate":"chat.type.emote","with":["Rcon",{"extra":["waves"],"text":""}]}',
  join: '"§lWelcome to GregTech: New Horizons §a2.8.4"',
};

/** A player's name component, as EntityPlayer.func_145748_c_ builds it in 1.7.10. */
const playerName = (name: string, shown = name) => ({
  clickEvent: { action: 'suggest_command', value: `/msg ${name} ` },
  text: shown,
});
/** A message as CommandBase builds it: the words in `extra`. */
const words = (text: string) => ({
  extra: text.split(' ').flatMap((w, i) => (i === 0 ? [w] : [' ', w])),
  text: '',
});
const line = (translate: string, sender: unknown, message: unknown, style = {}) =>
  JSON.stringify({ ...style, translate, with: [sender, message] });

describe('parseChat: lines the live server sends', () => {
  it('reads an RCON whisper (a plain string sender, the words in extra)', () => {
    expect(parseChat(LIVE.whisper)).toEqual({
      kind: 'whisper',
      sender: 'Rcon',
      text: 'hello from rcon whisper',
    });
  });

  it('announcements, emotes and join messages are never attributed', () => {
    expect(parseChat(LIVE.say)).toMatchObject({ kind: 'other', sender: null });
    expect(parseChat(LIVE.emote)).toMatchObject({ kind: 'other', sender: null });
    expect(parseChat(LIVE.join)).toEqual({
      kind: 'other',
      sender: null,
      text: 'Welcome to GregTech: New Horizons 2.8.4',
    });
    expect(
      parseChat(
        JSON.stringify({
          translate: 'serverutilities.lang.team.notification',
          with: ['DankAxon', { text: '!come' }],
        }),
      ),
    ).toMatchObject({ kind: 'other' });
  });
});

describe('parseChat: vanilla shapes from players', () => {
  it("reads a player's whisper and public chat (its name component and click event)", () => {
    const gray = { italic: true, color: 'gray' };
    expect(
      parseChat(
        line('commands.message.display.incoming', playerName('DankAxon'), words('come here'), gray),
      ),
    ).toEqual({ kind: 'whisper', sender: 'DankAxon', text: 'come here' });
    // Public chat: the message as Forge's newChatWithLinks makes it.
    expect(
      parseChat(line('chat.type.text', playerName('DankAxon'), { extra: ['!goto 1 2'], text: '' })),
    ).toEqual({ kind: 'public', sender: 'DankAxon', text: '!goto 1 2' });
    expect(parseChat(line('chat.type.text', 'DankAxon', '!stop'))).toEqual({
      kind: 'public',
      sender: 'DankAxon',
      text: '!stop',
    });
  });

  it('takes a team prefix around the name only when the /msg click event names the player', () => {
    expect(
      parseChat(line('chat.type.text', playerName('DankAxon', '§c[Admin] DankAxon§r'), '!come')),
    ).toMatchObject({ kind: 'public', sender: 'DankAxon' });
    // A name the click event contradicts, or one with neither: not attributed.
    expect(
      parseChat(line('chat.type.text', playerName('Mallory', 'DankAxon'), '!come')),
    ).toMatchObject({ kind: 'other' });
    expect(parseChat(line('chat.type.text', { text: '[Admin] DankAxon' }, '!come'))).toMatchObject({
      kind: 'other',
    });
  });

  it('never takes the echo of its own whisper (it names the recipient) for a command', () => {
    expect(
      parseChat(
        line('commands.message.display.outgoing', playerName('DankAxon'), words('OK: coming')),
      ),
    ).toMatchObject({ kind: 'other', sender: null });
  });

  it('is strict about the shape: two arguments, nothing appended, no translation inside', () => {
    const bad = [
      JSON.stringify({ translate: 'chat.type.text', with: ['DankAxon'] }),
      JSON.stringify({ translate: 'chat.type.text', with: ['DankAxon', 'a', 'b'] }),
      JSON.stringify({ translate: 'chat.type.text', with: ['DankAxon', '!come'], extra: ['!'] }),
      JSON.stringify({ translate: 'chat.type.text', with: [{ translate: 'x' }, '!come'] }),
      JSON.stringify({ translate: 'chat.type.text', with: ['DankAxon', { translate: 'x' }] }),
      JSON.stringify({ translate: 'chat.type.text', with: ['Dank Axon', '!come'] }),
      JSON.stringify({ translate: 'chat.type.text', with: ['DankAxon', '   '] }),
      'not json',
      '[[[[[[[[[["deep"]]]]]]]]]]',
    ];
    for (const json of bad) expect(parseChat(json).kind, json).toBe('other');
  });

  it('reads chat a mod formats itself, "<Name> message", only with no translation in it', () => {
    expect(parseChat('"<DankAxon> !follow"')).toEqual({
      kind: 'public',
      sender: 'DankAxon',
      text: '!follow',
    });
    expect(
      parseChat(
        JSON.stringify({ text: '', extra: [{ text: '<DankAxon>', color: 'gold' }, ' hi'] }),
      ),
    ).toEqual({ kind: 'public', sender: 'DankAxon', text: 'hi' });
    expect(
      parseChat(JSON.stringify({ text: '<DankAxon> ', extra: [{ translate: 'chat.x' }] })),
    ).toMatchObject({ kind: 'other' });
    expect(parseChat('"[Server] <DankAxon> !stop"')).toMatchObject({ kind: 'other' });
  });

  it('message text is plain: formatting and control characters out, spaces collapsed', () => {
    expect(parseChat(line('chat.type.text', 'DankAxon', '§a!goto\n 1\t 2'))).toMatchObject({
      kind: 'public',
      text: '!goto 1 2',
    });
    expect(stripFormatting('§lbold§r and §')).toBe('bold and ');
  });
});

describe('whispers out', () => {
  it('sanitizes a reply and cuts it into lines that fit /tell <owner>', () => {
    expect(sanitizeChatText('§cDone:\nI have\t20 logs\u0007')).toBe('Done: I have 20 logs');
    const lines = whisperLines('DankAxon', 'word '.repeat(80));
    expect(lines).toHaveLength(MAX_REPLY_LINES);
    for (const l of lines) {
      expect(`/tell DankAxon ${l}`.length).toBeLessThanOrEqual(CHAT_LINE_MAX);
      expect(chatTextProblem(l)).toBeNull();
    }
    expect(lines.at(-1)?.endsWith('...')).toBe(true);
    // Never a line that starts with "/": it would be a command of its own.
    expect(whisperLines('DankAxon', '/op Mallory')).toEqual(['op Mallory']);
    expect(whisperLines('DankAxon', '   ')).toEqual([]);
    expect(whisperLines('DankAxon', 'short')).toEqual(['short']);
  });

  it('C01 is only ever a whisper: /tell <player> <plain text>, within the line limit', () => {
    const p = outbound.whisper('DankAxon', 'OK: coming to you');
    expect(p.kind).toBe('whisper');
    const r = new Reader(p.frame);
    r.varInt(); // frame length
    expect(r.varInt()).toBe(0x01);
    expect(r.string()).toBe('/tell DankAxon OK: coming to you');
    const refused: Array<[string, string]> = [
      ['Dank Axon', 'hi'],
      ['DankAxon x', 'hi'],
      ['DankAxon', '/op Mallory'],
      ['DankAxon', '§chi'],
      ['DankAxon', 'two\nlines'],
      ['DankAxon', ' padded'],
      ['DankAxon', ''],
      ['DankAxon', 'x'.repeat(CHAT_LINE_MAX)],
    ];
    for (const [to, text] of refused) {
      expect(() => outbound.whisper(to, text), `${to}: ${text}`).toThrow(/refusing/);
    }
  });
});

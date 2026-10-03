import { commandTextOf, isStopText, type HeardCommand } from '../../../domain/owner-commands.ts';
import { errorMessage } from '../../../util/json.ts';
import { parseChat, whisperLines } from '../chat.ts';
import { outbound } from '../packets.ts';
import type { ClientCore } from './core.ts';
import { delay } from './shared.ts';

/** An owner's command as the client heard it in chat, and when. */
export interface OwnerMessage extends HeardCommand {
  at: Date;
}

/** Owner commands kept until the play loop takes them (the newest, when more arrive). */
const MAX_HEARD = 16;
/**
 * At most one chat line a second. 1.7.10 counts chat against spam (NetHandlerPlayServer: +20
 * a line, -1 a tick) and kicks a non-op past 200, so a line a second never comes near it.
 */
export const CHAT_LINE_INTERVAL_MS = 1_000;
/** Lines waiting to be sent at most (three replies of three lines); more are dropped. */
const MAX_OUTBOX = 9;

/**
 * Chat, the owners' way to command the bot (src/domain/owner-commands.ts), as narrowly as
 * possible:
 *  - in: every S02 line is read with chat.ts parseChat, and only an owner's command
 *    (commandTextOf: an owner's whisper to the bot, or public chat starting with ! or # or
 *    the bot's name) is kept, until the play loop takes it. A stop in the structured form
 *    stops the action in progress at once (ClientCore.interrupt), without waiting for the
 *    play loop. Nothing else of chat is kept here (the world model keeps the last raw lines
 *    for diagnostics);
 *  - out: whispers to an owner (MC_OWNERS) only, as outbound.whisper's `/tell <owner> <text>`:
 *    the text made plain and cut into at most three lines (chat.ts whisperLines), at most one
 *    line a second (CHAT_LINE_INTERVAL_MS).
 */
export class ChatActions {
  readonly #core: ClientCore;
  readonly #heard: OwnerMessage[] = [];
  readonly #outbox: Array<{ owner: string; line: string }> = [];
  #timer: NodeJS.Timeout | null = null;
  #lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(core: ClientCore) {
    this.#core = core;
  }

  /** One chat line from the server (its JSON). */
  onChat(json: string, at: Date): void {
    const { owners, username } = this.#core.opts.config;
    if (owners.length === 0) return;
    const heard = commandTextOf(parseChat(json), owners, username);
    if (heard === null) return;
    this.#heard.push({ ...heard, at });
    if (this.#heard.length > MAX_HEARD) this.#heard.shift();
    this.#core.log(`owner command from ${heard.sender} (${heard.via}): ${heard.text}`);
    if (isStopText(heard.text)) this.#core.interrupt(`stopped by ${heard.sender}`);
  }

  /** The owner commands heard since the last call, oldest first. */
  take(): OwnerMessage[] {
    return this.#heard.splice(0);
  }

  /** How many owner commands are waiting to be taken. */
  get waiting(): number {
    return this.#heard.length;
  }

  /**
   * Whispers `text` to `owner`, who must be one of MC_OWNERS: cut into at most three lines,
   * each sent a second after the last. Null when it is on its way, else why not.
   */
  whisper(owner: string, text: string): string | null {
    if (!this.#core.opts.config.owners.includes(owner)) {
      return `${owner} is not one of the bot's owners (MC_OWNERS)`;
    }
    if (this.#core.phase !== 'play') return 'not connected';
    const lines = whisperLines(owner, text);
    if (lines.length === 0) return 'nothing to whisper';
    if (this.#outbox.length + lines.length > MAX_OUTBOX) {
      this.#core.log(`reply to ${owner} dropped (too many waiting): ${text.slice(0, 120)}`);
      return 'too many replies are waiting';
    }
    for (const line of lines) this.#outbox.push({ owner, line });
    this.#pump();
    return null;
  }

  /** Sends the next line when its second has come. */
  #pump(): void {
    if (this.#timer !== null || this.#outbox.length === 0) return;
    const now = this.#core.opts.clock.now().getTime();
    const wait = Math.max(0, this.#lastSentAt + CHAT_LINE_INTERVAL_MS - now);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const next = this.#outbox.shift();
      if (next !== undefined && this.#core.phase === 'play') {
        try {
          this.#core.send(outbound.whisper(next.owner, next.line));
          this.#lastSentAt = this.#core.opts.clock.now().getTime();
          this.#core.log(`whispered to ${next.owner}: ${next.line}`);
        } catch (error) {
          this.#core.log(`whisper to ${next.owner} not sent: ${errorMessage(error)}`);
        }
      }
      this.#pump();
    }, wait);
  }

  /** Waits (at most `timeoutMs`) until every reply waiting has been sent. */
  async flush(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.#outbox.length > 0 && this.#core.phase === 'play' && Date.now() < until) {
      await delay(50);
    }
  }

  /** The connection closed: replies still waiting are dropped. */
  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#outbox.length = 0;
  }
}

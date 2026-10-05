import { describe, expect, it } from 'vitest';
import { whisperLines } from '../../src/bot/gtnh1710/chat.ts';
import { HELP_TEXT } from '../../src/domain/owner-commands.ts';

// An independent review, 2026-10-05: !help fitted three whisper lines only for short names.
describe('!help for every owner name length', () => {
  it('fits in three lines for names up to 16 characters', () => {
    const fits: Record<number, boolean> = {};
    for (let n = 3; n <= 16; n++) {
      const lines = whisperLines('x'.repeat(n), HELP_TEXT);
      fits[n] = lines.join(' ') === HELP_TEXT;
    }
    expect(Object.values(fits).every(Boolean)).toBe(true);
  });
});

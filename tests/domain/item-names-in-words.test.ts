import { describe, expect, it, vi } from 'vitest';
import type { CommandDeps } from '../../src/app/play/commands.ts';
import type { TravelStep } from '../../src/app/play/owner-travel.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayLimits } from '../../src/app/play/play.ts';
import { gtOreByName } from '../../src/goals/ore-names.ts';
import { cannotGet } from '../../src/goals/route-book.ts';
import { parseOwnerCommand, type HeardCommand } from '../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { createRepositories } from '../../src/persistence/repositories.ts';
import { systemClock } from '../../src/util/clock.ts';

// An independent review, 2026-10-05: names in words were joined by `_` after any get or mine, so
// plain requests ("get a stack of logs") parsed as gets of junk items (minecraft:stack_of_logs)
// and never reached the translator. Only two plain words in the `!` form are joined now.
const names = { ore: gtOreByName };

describe('the _ join and natural language', () => {
  it('multi-word natural language after get/mine is no item: the usage, for the translator', () => {
    const out = [
      'get me some wood for the house',
      'get a stack of logs',
      'get 10 logs and 5 sticks',
      'mine down to diamonds',
      'get the iron out of the chest',
      '!get a bunch of planks',
    ].map((t) => [t, parseOwnerCommand(t, names)]);
    for (const [, p] of out) expect(p).toMatchObject({ ok: false });
  });

  it('with a translator, "get a stack of logs" is translated (not a get of 1 stack_of_logs)', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [
      { sender: 'DankAxon', text: 'get a stack of logs', via: 'whisper' },
    ];
    const replies: string[] = [];
    const translate = vi.fn((_text: string) =>
      Promise.resolve({
        ok: true as const,
        command: { verb: 'get' as const, count: 64, item: 'minecraft:log' },
        latencyMs: 1,
      }),
    );
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void replies.push(text),
      clearInterrupt: () => undefined,
      translate,
      view: () => ({
        position: { x: 0.5, y: 64, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: {},
        playerAt: () => null,
      }),
      step: (): TravelStep => ({ kind: 'refused', reason: 'x' }),
      // As live-play.ts does (route-book.ts cannotGet).
      goalProblem: (item, count, anyKind) => cannotGet(item, count, {}, anyKind),
      owners: ['DankAxon'],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
    };
    const limits: PlayLimits = { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 };
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        session: () => Promise.reject(new Error('stop here')),
        sleep: () => Promise.resolve(),
        commands,
      },
      limits,
      { stopRequested: () => null },
    ).catch(() => undefined);
    expect(translate).toHaveBeenCalled();
  });
});

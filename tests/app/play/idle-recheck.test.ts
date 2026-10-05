import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps, StandbyCall } from '../../../src/app/play/commands.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayDeps } from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { OWNER_PAUSED_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Idle, home from a retreat, play looks again at once (a mob that followed sends it offline).
// An independent review, 2026-10-05, of that look: it ran after the retreat's walk had lost
// the connection (the look threw, and play ended without leave()), and going offline at once
// left a command whispered meanwhile unanswered.

const commandsWith = (
  heard: HeardCommand[],
  replies: string[],
  standby: () => Promise<StandbyCall | null>,
): CommandDeps => ({
  take: () => heard.splice(0),
  waiting: () => heard.length > 0,
  reply: (to, text) => void replies.push(`${to}: ${text}`),
  clearInterrupt: () => undefined,
  view: () => ({
    position: { x: 0.5, y: 64, z: 0.5 },
    dimension: 'overworld',
    health: 20,
    food: 20,
    inventory: {},
    playerAt: () => null,
  }),
  step: () => ({ kind: 'refused', reason: 'x' }),
  owners: ['DankAxon'],
  homeName: 'home',
  configLocations: new Map(),
  boundary: {
    min: { x: -256, y: 0, z: -256 },
    max: { x: 256, y: 255, z: 256 },
    allowedDimensions: ['overworld'],
  },
  standby,
});

/** A standby session: one retreat home, as `status`. */
const retreat =
  (status: 'succeeded' | 'failed', reasons: string[], before: () => void): PlayDeps['session'] =>
  (_limits, hooks) => {
    before();
    hooks.onCycle(
      {
        summary: `RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> ${status}`,
        status,
        decision: {
          decision: 'RETREAT_HOME',
          confidence: 0.95,
          reasonCodes: reasons,
          factsUsed: {},
          requiresHumanConfirmation: false,
          provider: 'test',
        },
        outcome: null,
      } as unknown as CycleResult,
      1,
    );
    const result: SessionResult = {
      cycles: [{ cycleId: 'c1', summary: status }],
      stopReason: `stopped after: RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> ${status}`,
      stopKind: status === 'failed' ? 'cycle-failed' : 'non-task-decision',
      taskId: 'owner-standby',
      taskStatus: 'active',
      elapsedMs: 1,
    };
    return Promise.resolve(result);
  };

const idleRepos = () => {
  const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
  repos.memory.setValue(OWNER_PAUSED_KEY, 'DankAxon said pause'); // play idles
  return repos;
};

describe('idle: the look right after a retreat', () => {
  it('not after the connection was lost: play ends on that, as before', async () => {
    let lost = false;
    let looks = 0;
    const result = runPlay(
      {
        repos: idleRepos(),
        inventory: () => Promise.resolve({}),
        listen: true,
        sleep: () => Promise.resolve(),
        commands: commandsWith([], [], () => {
          looks += 1;
          // The live standby observes: with the connection lost, observe() throws.
          if (lost) return Promise.reject(new Error('connection lost: kicked'));
          return Promise.resolve({ kind: 'reflex', text: 'RETREAT_HOME [HAZARD_NEARBY]' });
        }),
        session: retreat('failed', ['HAZARD_NEARBY'], () => {
          lost = true;
        }),
      },
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => (lost ? 'the connection is lost (kicked)' : null) },
    );
    await expect(result).resolves.toMatchObject({ stopReason: 'the connection is lost (kicked)' });
    expect(looks).toBe(1);
  });

  it('a mob that followed sends it offline, and a command whispered meanwhile hears why', async () => {
    const repos = idleRepos();
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let looks = 0;
    const result = await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        listen: true,
        sleep: () => Promise.resolve(),
        commands: commandsWith(heard, replies, () => {
          looks += 1;
          return Promise.resolve(
            looks === 1
              ? { kind: 'reflex', text: 'RETREAT_HOME [HOSTILES_NEARBY]' }
              : { kind: 'mob', reasons: 'HOSTILES_NEARBY, ALREADY_AT_SAFE_LOCATION' },
          );
        }),
        // Whispered while the bot walks home.
        session: retreat('succeeded', ['HOSTILES_NEARBY'], () => {
          heard.push({ sender: 'DankAxon', text: '!goto 20 64 0', via: 'whisper' });
        }),
      },
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => null },
    );
    expect(result.mobNearby).toBe('HOSTILES_NEARBY, ALREADY_AT_SAFE_LOCATION');
    // Kept for when it is back, and its sender told why it waits.
    expect(repos.commands.get(1)?.status).toBe('queued');
    expect(replies).toEqual(['DankAxon: A mob is near: I go offline a moment for it to leave']);
  });
});

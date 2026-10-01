import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { QUEST_BOOK_SYNC_PENDING } from '../bot/gtnh1710/better-questing.ts';
import type { ConnectionInfo, Gtnh1710Client } from '../bot/gtnh1710/gtnh-client.ts';
import type { AgentConfig } from '../config/env.ts';
import type { GameState } from '../domain/game-state.ts';
import type { Abilities } from '../goals/quest-goals.ts';
import { openDatabase } from '../persistence/database.ts';
import { createRepositories } from '../persistence/repositories.ts';
import type { PlannerProvider } from '../planner/planner-provider.ts';
import type { DecisionProvider } from '../system1/decision-provider.ts';
import { systemClock } from '../util/clock.ts';
import { randomIds } from '../util/ids.ts';
import { runQuestBookAction, syncConfigToDatabase, type AgentDeps } from './agent-loop.ts';
import { runSession } from './live-session.ts';
import { withLiveClient } from './live-agent.ts';
import { passProblem } from '../bot/gtnh1710/terrain.ts';
import { shelterStatus } from '../goals/shelter.ts';
import {
  runPlay,
  type FreeGoal,
  type PlayEvent,
  type PlayLimits,
  type PlayResult,
} from './play.ts';

/** How long to wait for Better Questing's quest book after login. */
const QUEST_BOOK_WAIT_MS = 30_000;

/**
 * Observes, waiting first (at most `timeoutMs`) for the quest book: Better Questing sends it
 * a moment after login, once the client has answered its main_sync.
 */
export async function observeWithQuestBook(
  client: Gtnh1710Client,
  timeoutMs = QUEST_BOOK_WAIT_MS,
): Promise<GameState> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const state = await client.observe();
    const pending = !state.questBook.known && state.questBook.reason === QUEST_BOOK_SYNC_PENDING;
    if (!pending || Date.now() >= until) return state;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Autonomous play against the live test server, on one connection: the play loop
 * (src/app/play.ts) with live inventory and quest-book reads and live sessions. The
 * decision maker and planner are passed in (models or the deterministic rules); neither
 * executes anything. Quest-book clicks are play's own (runQuestBookAction), and only when
 * MC_ENABLE_QUEST_BOOK is on. Ctrl+C halts the current walk and stops after the current
 * cycle; so does the stop file.
 */
export async function runLivePlay(
  config: AgentConfig,
  dbPath: string,
  input: {
    limits: PlayLimits;
    decisionProvider: DecisionProvider;
    planner: PlannerProvider | null;
    abilities?: Abilities;
    /** A goal outside the quest book (`play --needs`); play pursues it instead of the quests. */
    goal?: FreeGoal;
    onEvent: (event: PlayEvent) => void;
  },
  log?: (line: string) => void,
): Promise<PlayResult & { info: ConnectionInfo }> {
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    return await withLiveClient(
      config,
      async (client) => {
        let interrupted = false;
        const onInterrupt = (): void => {
          interrupted = true;
          client.halt('interrupted (Ctrl+C)');
        };
        process.once('SIGINT', onInterrupt);
        const stopFile = resolve(config.minecraft.movement.stopFile);
        const stopRequested = (): string | null =>
          interrupted
            ? 'interrupted (Ctrl+C)'
            : existsSync(stopFile)
              ? `the stop file ${stopFile} exists`
              : null;
        const agent: AgentDeps = {
          config,
          client,
          repos,
          decisionProvider: input.decisionProvider,
          planner: input.planner,
          clock: systemClock,
          newId: randomIds,
        };
        // When the agent can explore, play first scouts the area while little of it is known.
        const movement = config.minecraft.movement;
        const canExplore = movement.enabled && movement.mode === 'follow';
        try {
          const result = await runPlay(
            {
              repos,
              ...(input.abilities ? { abilities: input.abilities } : {}),
              ...(input.goal ? { goal: input.goal } : {}),
              ...(canExplore ? { scouting: { chunksSeen: () => repos.worldMemory.count() } } : {}),
              questBook: async () => {
                const state = await observeWithQuestBook(client);
                return { questBook: state.questBook, inventory: state.inventory };
              },
              ...(config.minecraft.questBook.enabled
                ? {
                    questAction: (spec, reason, taskId) =>
                      runQuestBookAction(agent, spec, reason, taskId),
                  }
                : {}),
              inventory: async () => {
                const state = await client.observe();
                return state.inventory.known ? state.inventory.value.items : null;
              },
              time: async () => {
                const state = await client.observe();
                return state.time.known ? state.time.value : null;
              },
              shelter: async () => {
                const state = await client.observe();
                const world = client.world.walkWorld();
                const feet = client.world.ownPosition;
                if (world === null || feet === null || !state.inventory.known) return null;
                const solid = {
                  solidAt: (x: number, y: number, z: number): boolean | undefined => {
                    const problem = passProblem(world, x, y, z);
                    return problem === 'chunk not loaded' ? undefined : problem !== null;
                  },
                };
                return shelterStatus(solid, feet, state.inventory.value.items);
              },
              session: (limits, hooks) => runSession(agent, limits, hooks),
            },
            input.limits,
            { stopRequested, onEvent: input.onEvent },
          );
          return { ...result, info: client.info() };
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
      log,
    );
  } finally {
    db.close();
  }
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConnectionInfo } from '../bot/gtnh1710/gtnh-client.ts';
import type { AgentConfig } from '../config/env.ts';
import type { Abilities } from '../goals/quest-goals.ts';
import { openDatabase } from '../persistence/database.ts';
import { createRepositories } from '../persistence/repositories.ts';
import type { PlannerProvider } from '../planner/planner-provider.ts';
import type { DecisionProvider } from '../system1/decision-provider.ts';
import { systemClock } from '../util/clock.ts';
import { randomIds } from '../util/ids.ts';
import { syncConfigToDatabase } from './agent-loop.ts';
import { runSession } from './live-session.ts';
import { withLiveClient } from './live-agent.ts';
import { runPlay, type PlayEvent, type PlayLimits, type PlayResult } from './play.ts';

/**
 * Autonomous play against the live test server, on one connection: the play loop
 * (src/app/play.ts) with live inventory reads and live sessions. The decision maker and
 * planner are passed in (models or the deterministic rules); neither executes anything.
 * Ctrl+C halts the current walk and stops after the current cycle; so does the stop file.
 */
export async function runLivePlay(
  config: AgentConfig,
  dbPath: string,
  input: {
    limits: PlayLimits;
    decisionProvider: DecisionProvider;
    planner: PlannerProvider | null;
    abilities?: Abilities;
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
        // When the agent can explore, play first scouts the area while little of it is known.
        const movement = config.minecraft.movement;
        const canExplore = movement.enabled && movement.mode === 'follow';
        try {
          const result = await runPlay(
            {
              repos,
              ...(input.abilities ? { abilities: input.abilities } : {}),
              ...(canExplore ? { scouting: { chunksSeen: () => repos.worldMemory.count() } } : {}),
              inventory: async () => {
                const state = await client.observe();
                return state.inventory.known ? state.inventory.value.items : null;
              },
              time: async () => {
                const state = await client.observe();
                return state.time.known ? state.time.value : null;
              },
              session: (limits, hooks) =>
                runSession(
                  {
                    config,
                    client,
                    repos,
                    decisionProvider: input.decisionProvider,
                    planner: input.planner,
                    clock: systemClock,
                    newId: randomIds,
                  },
                  limits,
                  hooks,
                ),
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

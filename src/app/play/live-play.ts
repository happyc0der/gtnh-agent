import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { QUEST_BOOK_SYNC_PENDING } from '../../bot/gtnh1710/better-questing.ts';
import type { ConnectionInfo, Gtnh1710Client } from '../../bot/gtnh1710/gtnh-client.ts';
import {
  continueNightPit,
  enclosedIn,
  planNightPit,
  planShelterExit,
  walledIn,
  type PitOptions,
  type PitSite,
} from '../../bot/gtnh1710/night-pit.ts';
import { HAZARD_SCAN_RADIUS } from '../../bot/gtnh1710/hazard-scan.ts';
import { playArea } from '../../bot/gtnh1710/play-area.ts';
import type { AgentConfig } from '../../config/env.ts';
import type { Decision } from '../../domain/decisions.ts';
import { diggableInfo } from '../../domain/dig-time.ts';
import { MEAL_HISTORY_LENGTH } from '../../domain/food.ts';
import type { GameState } from '../../domain/game-state.ts';
import { carriedHarvester } from '../../domain/tools.ts';
import type { Abilities } from '../../goals/quest-goals.ts';
import type { CommandTranslator } from '../../llm/ollama-command-provider.ts';
import { openDatabase } from '../../persistence/database.ts';
import { NIGHT_PIT_KEY } from '../../persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../persistence/repositories.ts';
import type { PlannerProvider } from '../../planner/planner-provider.ts';
import { assessStateReliability } from '../../safety/safety-policy.ts';
import type { DecisionProvider } from '../../system1/decision-provider.ts';
import { routeDecision } from '../../system1/deterministic-router.ts';
import { systemClock } from '../../util/clock.ts';
import { randomIds } from '../../util/ids.ts';
import { runQuestBookAction, type AgentDeps } from '../loop/agent-loop.ts';
import { buildSafetyContext, syncConfigToDatabase } from '../loop/agent-memory.ts';
import type { CommandDeps } from './commands.ts';
import { planTravelStep } from './owner-travel.ts';
import { foodStatusOf } from './food.ts';
import { runSession } from '../loop/live-session.ts';
import { withLiveClient } from '../commands/live-commands.ts';
import { passProblem } from '../../bot/gtnh1710/passable.ts';
import { shelterStatus, type ShelterStatus } from '../../goals/shelter.ts';
import {
  runPlay,
  type FreeGoal,
  type PlayEvent,
  type PlayLimits,
  type PlayResult,
} from './play.ts';

/** How long to wait for Better Questing's quest book after login. */
const QUEST_BOOK_WAIT_MS = 30_000;
/** How often a running play looks for a stop queued from the command line. */
const STOP_POLL_MS = 1_000;

const PitSiteSchema = z.strictObject({ x: z.int(), z: z.int(), groundY: z.int().min(0).max(255) });

/** Where the night pit the agent started is (agent memory), or null. */
function readPitSite(repos: Repositories): PitSite | null {
  const raw = repos.memory.getValue(NIGHT_PIT_KEY);
  if (raw === null) return null;
  try {
    const parsed = PitSiteSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The night shelter around the player, from the live world and with the client's own dig,
 * place and walk rules (src/bot/gtnh1710/night-pit.ts); null when the blocks, the position
 * or the inventory are unknown.
 *  - 'night': walled and roofed already: sheltered. In the pit the agent started (its site
 *    in agent memory, NIGHT_PIT_KEY): the rest of it. Else a new pit, in the player's column
 *    or one next to it; else the raised box where something already holds its roof
 *    (src/goals/shelter.ts); else why neither works (play then goes offline until sunrise).
 *  - 'morning': walled in, or still down in the night pit's column (an exit stopped half-way
 *    leaves a side open): the way out (the pit's roof and a staircase, or one wall of the
 *    box), planned with the same rules. Out of the pit's column, its site is forgotten.
 */
export function liveShelter(
  client: Gtnh1710Client,
  config: AgentConfig,
  repos: Repositories,
): (purpose?: 'night' | 'morning') => Promise<ShelterStatus | null> {
  return async (purpose = 'night') => {
    const state = await client.observe();
    const world = client.world.walkWorld();
    const feet = client.world.ownPosition;
    if (world === null || feet === null || !state.inventory.known) return null;
    const inventory = state.inventory.value.items;
    const walled = walledIn(world, feet);
    if (walled === null) return null;
    const site = readPitSite(repos);
    /** Down in the pit the agent started: in its column, at or below its ground layer. */
    const inPit =
      site !== null &&
      Math.floor(feet.x) === site.x &&
      Math.floor(feet.z) === site.z &&
      Math.floor(feet.y + 1e-6) <= site.groundY;
    const base: ShelterStatus = {
      kind: inPit ? 'pit' : 'box',
      sheltered: false,
      steps: [],
      needs: {},
      problem: null,
      walled,
      exit: [],
    };
    const fence = client.currentFence();
    const opts: PitOptions | null =
      fence === null
        ? null
        : {
            area: { fence, maxHeightAboveFence: config.minecraft.digging.maxHeightAboveFence },
            maxPathLength: config.minecraft.movement.maxPathLength,
            // Only digs a carried tool can harvest (the safety policy's own rule).
            canHarvest: (block) => {
              const rule = diggableInfo(block).harvest;
              if (rule === null) return null;
              const tool = carriedHarvester(inventory, rule);
              return tool.ok ? null : tool.reason;
            },
          };
    if (purpose === 'morning') {
      if (site !== null && !inPit) repos.memory.setValue(NIGHT_PIT_KEY, null);
      if (!walled && !inPit) return base;
      const stuck = { ...base, walled: true };
      if (opts === null) return { ...stuck, problem: 'there is no fence to dig or walk in' };
      const exit = planShelterExit(world, feet, opts);
      return exit.ok ? { ...stuck, exit: exit.steps } : { ...stuck, problem: exit.reason };
    }
    if (enclosedIn(world, feet) === true) return { ...base, sheltered: true };
    if (opts === null) return { ...base, problem: 'there is no fence to dig or build in' };
    const going = site === null ? null : continueNightPit(world, feet, inventory, site, opts);
    const pit = going ?? planNightPit(world, feet, inventory, opts);
    if (pit.ok) {
      repos.memory.setValue(NIGHT_PIT_KEY, JSON.stringify(pit.site));
      return {
        ...base,
        kind: 'pit',
        steps: pit.steps,
        needs: pit.roof === null ? {} : { [pit.roof]: 1 },
      };
    }
    // Already in a pit it started: no box from down there.
    if (going !== null) return { ...base, kind: 'pit', problem: pit.reason };
    const solid = {
      solidAt: (x: number, y: number, z: number): boolean | undefined => {
        const problem = passProblem(world, x, y, z);
        return problem === 'chunk not loaded' ? undefined : problem !== null;
      },
    };
    const box = shelterStatus(solid, feet, inventory);
    if (box.problem === null) return { ...box, walled };
    return { ...base, problem: `no pit (${pit.reason}); no box (${box.problem})` };
  };
}

/** System 1 decisions an idle bot stands by for (commands.ts idleFor): its reflexes. */
const STANDBY_DECISIONS: ReadonlySet<Decision> = new Set<Decision>([
  'RETREAT_HOME',
  'DEFEND',
  'EAT',
  'REST',
]);

/**
 * What System 1 would do on its own about `state` while the bot is idle, when it is one of
 * its reflexes (a retreat, a fight, a meal, a rest), or null: the rule router's decision on a
 * reliable observation. The standby session then runs it through the executor like any cycle.
 */
export function standbyReason(
  state: GameState,
  config: AgentConfig,
  repos: Repositories,
): string | null {
  const safety = buildSafetyContext(config, repos, systemClock.now());
  if (assessStateReliability(state, safety).length > 0) return null;
  const d = routeDecision(state, {
    safety,
    routing: config.routing,
    combatEnabled: config.minecraft.combat.enabled,
    eatingEnabled: config.minecraft.eating.enabled,
    recentMeals: repos.actions.recentMeals(MEAL_HISTORY_LENGTH),
  });
  return STANDBY_DECISIONS.has(d.decision) ? `${d.decision} [${d.reasonCodes.join(', ')}]` : null;
}

/**
 * The owners' commands on the live client (commands.ts CommandDeps): the commands it heard in
 * chat, whispered replies, the stop's interrupt, what the bot knows (its world model), travel
 * steps planned with its own walk rules on its own blocks (owner-travel.ts), and the standby
 * check.
 */
export function liveCommands(
  client: Gtnh1710Client,
  config: AgentConfig,
  repos: Repositories,
  translator: CommandTranslator | null,
  log?: (line: string) => void,
): CommandDeps {
  const movement = config.minecraft.movement;
  return {
    take: () => client.takeOwnerMessages(),
    waiting: () => client.ownerMessagesWaiting(),
    reply: (owner, text) => {
      const why = client.whisper(owner, text);
      if (why !== null) log?.(`reply to ${owner} not sent (${why}): ${text}`);
    },
    clearInterrupt: () => client.clearInterrupt(),
    ...(translator === null ? {} : { translate: (text: string) => translator.translate(text) }),
    view: () => ({
      position: client.world.ownPosition,
      dimension: client.world.dimension,
      health: client.world.health,
      food: client.world.food,
      inventory: client.world.inventoryItems(),
      playerAt: (name: string) => client.playerPosition(name),
    }),
    step: (target) =>
      planTravelStep({
        world: client.world.walkWorld(),
        area: playArea(movement, config.safety.boundary, client.world.ownPosition),
        feet: client.world.ownPosition,
        target,
        movement: {
          enabled: movement.enabled,
          canExplore: movement.enabled && movement.mode === 'follow',
          maxPathLength: movement.maxPathLength,
        },
        // The safety policy refuses a MOVE_TO whose surroundings the hazard scan has not covered.
        moveReach: Math.min(
          config.safety.maxMoveDistance,
          HAZARD_SCAN_RADIUS - config.safety.hazardAvoidanceRadius - 0.5,
        ),
        // The client's own walk policy, so a step plans as its MOVE_TO will walk.
        ...(() => {
          const path = client.walkOptions();
          return path === null ? {} : { path };
        })(),
      }),
    owners: config.minecraft.owners,
    homeName: config.routing.homeLocationName,
    configLocations: new Map(Object.entries(config.locations)),
    boundary: config.safety.boundary,
    standby: async () => standbyReason(await client.observe(), config, repos),
  };
}

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
 * (src/app/play/play.ts) with live inventory and quest-book reads and live sessions. The
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
    /**
     * Stay online for the owners' commands (cli play --listen): play waits instead of ending
     * when it has nothing to do, and ends when the connection is lost (the caller reconnects).
     */
    listen?: boolean;
    /** Translates the owners' natural language into commands (commands.translator), or none. */
    translator?: CommandTranslator | null;
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
        const listen = input.listen === true;
        const stopRequested = (): string | null =>
          interrupted
            ? 'interrupted (Ctrl+C)'
            : existsSync(stopFile)
              ? `the stop file ${stopFile} exists`
              : listen && client.info().closedReason !== null
                ? `the connection is lost (${client.info().closedReason ?? ''})`
                : null;
        const commands =
          config.minecraft.owners.length === 0
            ? undefined
            : liveCommands(client, config, repos, input.translator ?? null, log);
        // A stop queued from the command line stops the action in progress too, as a stop in
        // chat does (the client interrupts that one itself); the play loop then takes it.
        let lastStop = 0;
        const stopPoll =
          commands === undefined
            ? null
            : setInterval(() => {
                const stop = repos.commands.queuedVerb('stop', 'cli', lastStop);
                if (stop === null) return;
                lastStop = stop.id;
                client.interrupt(`stopped by ${stop.sender} from the command line`);
              }, STOP_POLL_MS);
        const agent: AgentDeps = {
          config,
          client,
          repos,
          decisionProvider: input.decisionProvider,
          planner: input.planner,
          clock: systemClock,
          newId: randomIds,
        };
        // When the agent can explore, play first scouts the area while little of it is known:
        // chunks seen near, every kind looked for (one far look from spawn sees a hundred chunks
        // of landmarks over open ground, and no trees: no look around).
        const movement = config.minecraft.movement;
        const canExplore = movement.enabled && movement.mode === 'follow';
        try {
          const result = await runPlay(
            {
              repos,
              ...(input.abilities ? { abilities: input.abilities } : {}),
              ...(input.goal ? { goal: input.goal } : {}),
              ...(canExplore
                ? { scouting: { chunksSeen: () => repos.worldMemory.count(undefined, 'near') } }
                : {}),
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
              shelter: liveShelter(client, config, repos),
              // Food trips only when the agent may eat (food it never eats is no use) and can
              // get some: dig a garden or hunt.
              ...(config.minecraft.eating.enabled &&
              (config.minecraft.digging.enabled || config.minecraft.combat.enabled)
                ? {
                    food: {
                      now: async () => foodStatusOf(await client.observe(), config, repos),
                      of: (state: GameState) => foodStatusOf(state, config, repos),
                    },
                  }
                : {}),
              session: (limits, hooks) => runSession(agent, limits, hooks),
              ...(commands === undefined ? {} : { commands }),
              ...(listen ? { listen } : {}),
            },
            input.limits,
            { stopRequested, onEvent: input.onEvent },
          );
          return { ...result, info: client.info() };
        } finally {
          if (stopPoll !== null) clearInterval(stopPoll);
          process.removeListener('SIGINT', onInterrupt);
        }
      },
      log,
    );
  } finally {
    db.close();
  }
}

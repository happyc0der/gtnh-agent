import dotenv from 'dotenv';
import { loadConfig } from '../config/env.ts';
import { IN_MEMORY } from '../persistence/database.ts';
import { plannerResponseJsonSchema } from '../planner/plan-schema.ts';
import { errorMessage } from '../util/json.ts';
import { parseCommandLine, type Cli } from './commands/cli-context.ts';
import {
  attackCommand,
  chestCommand,
  digCommand,
  exploreCommand,
  interactCommand,
  moveCommand,
  observeCommand,
  placeCommand,
  watchCommand,
} from './commands/cli-live.ts';
import {
  commandCommand,
  commandsCommand,
  historyCommand,
  layoutsCommand,
  placesCommand,
  planCommand,
  questsCommand,
  taskCommand,
  taskResumeCommand,
} from './commands/cli-records.ts';
import { onceCommand, playCommand, runCommand, scenariosCommand } from './commands/cli-runs.ts';
import { movementStatus, setMovementHalted } from './commands/live-commands.ts';

const USAGE = `gtnh-agent (single cycle, no autonomy; the live client only observes unless walking,
chests, crafting, digging, placing, block windows or fighting are explicitly enabled)

Usage:
  node src/app/cli.ts once [--scenario <name>] [--db <path> | --memory] [--full]
      Run ONE observe/decide/validate/execute/verify cycle against the mock world.
  node src/app/cli.ts once --live [--db <path> | --memory] [--full] [--verbose]
      Run ONE cycle against the configured private GTNH test server (read-only).
  node src/app/cli.ts observe --live [--radius N] [--verbose]
      Connect, print what the agent can observe (and a map of the movement fence), disconnect.
      --radius widens the diagnostic entity (and, above 32, hazard) lists; the agent's own
      scans stay at 16 m (entities) and 32 m (hazards).
  node src/app/cli.ts watch --live [--seconds 60] [--every 5]
      Stay connected (read-only) and print what the agent sees every few seconds: to compare
      with what you see in-game. The bot stands still and is visible to other players.
  node src/app/cli.ts move --live --to <x,y,z | location> [--tolerance N] [--dry-run] [--db <path>]
      WALK the player (needs MC_ENABLE_MOVEMENT=true and a fence). One action, validated,
      executed and verified like the agent's own; Ctrl+C stops it. --dry-run only plans it
      and draws the path on a map of the fence.
  node src/app/cli.ts explore --live --toward <north|north_east|...|x,z> [--distance 64] [--db <path>]
      EXPLORE (needs MC_ENABLE_MOVEMENT=true and MC_MOVEMENT_MODE=follow): walk over land toward
      a direction or a point, in hops, at most --distance blocks (8-96), in daylight only, as a
      checked user action; prints what it saw and what world memory knows. Ctrl+C stops it.
  node src/app/cli.ts places [--at x,z] [--db <path>]
      What world memory knows, as the planner gets it (chunks seen, places per resource,
      biomes, how far each direction is seen), from --at or the last observed position.
  node src/app/cli.ts chest --live --container <id> [--withdraw <item> | --deposit <item>] [--count N]
      Open a configured vanilla chest (needs MC_ENABLE_CONTAINERS=true) and optionally move
      exactly N items, as checked user actions; prints the chest and inventory afterwards.
  node src/app/cli.ts dig --live --at <x,y,z> [--db <path>]
      BREAK one allowlisted block (logs, leaves, dirt, grass, sand, gravel, clay) inside the
      fence with an empty hand (needs MC_ENABLE_DIGGING=true and a fence), as a checked user
      action; prints the diggable blocks and the inventory afterwards. Ctrl+C stops it.
  node src/app/cli.ts place --live --at <x,y,z> --item <item> [--db <path>]
      PLACE one allowlisted block the player carries (dirt, cobblestone, sand, gravel,
      sandstone, planks, logs) into an empty cell inside the fence (needs
      MC_ENABLE_PLACING=true and a fence), as a checked user action; prints the placeable
      cells and the inventory afterwards.
  node src/app/cli.ts interact --live --at <x,y,z> [--smelt <item> --count N --fuel <item> --fuel-count M | --take <item>]
      OPEN a block with an interaction profile (furnace, crafting table, chest, Iron Chests...)
      or one on the observe-only allowlist (needs MC_ENABLE_INTERACT=true) with an empty hand,
      and print its window; optionally put items to smelt and fuel into a furnace, or take
      its output. Checked user actions, like dig and chest.
  node src/app/cli.ts layouts [--db <path>]
      Window layouts learned from blocks the agent opened (per block): the material for a
      new interaction profile (docs/architecture.md, "Interacting with blocks").
  node src/app/cli.ts attack --live --entity <id> [--db <path>]
      STRIKE one creature inside the fence for a short burst (needs MC_ENABLE_COMBAT=true and
      a fence): an identified hostile or an unowned farm animal (observe --live lists ids),
      with an allowlisted axe from the hotbar or a bare hand, as a checked user action. The
      player does not move. Ctrl+C stops it.
  node src/app/cli.ts run --live [--max-cycles N] [--max-minutes M] [--db <path>] [--verbose]
      BOUNDED auto-run of the current task on one connection: ordinary cycles back to back,
      stopping when the task is done or anything needs you (a pause, rejection, failure,
      approval, a non-task decision), at the limits (default 20 cycles / 10 minutes), the
      stop file (pnpm cli halt) or Ctrl+C.
  node src/app/cli.ts play --live [--needs item=count,...] [--listen] [--minutes 30] [--max-cycles 20] [--db <path>] [--verbose]
      AUTONOMOUS PLAY through the Age 0 quest book: the agent picks its next quest, the
      configured decision maker and planner (AGENT_DECISIONS / AGENT_PLANNER, e.g. ollama)
      choose what to do, and every action is validated, executed and verified as always.
      Quests count only as the server's quest book records them; with
      MC_ENABLE_QUEST_BOOK=true play also claims rewards, ticks checkboxes and submits
      finished quests itself (decided in code, never by a model).
      Stops when no doable quest is left, when anything needs you, after 3 sessions without
      progress on a quest, at the time limit, the stop file (pnpm cli halt) or Ctrl+C.
      --needs pursues your own goal instead (e.g. --needs minecraft:diamond=100): the planner
      gets its route the same way, and play ends when the items are held.
      The owners (MC_OWNERS) command it in chat (!come, !follow, !goto x y z, !get 20 logs,
      !stop, !help...) or with \`command\`; their commands come before quests. --listen keeps
      it online for commands when nothing else is to do (or play is paused), and reconnects
      when the connection drops, until the stop file, Ctrl+C or the time limit.
  node src/app/cli.ts command "<text>" [--db <path>]
      Queue an owner command as if the first owner (MC_OWNERS) had whispered it, e.g.
      command "!goto 120 64 -40"; a running play --live picks it up between cycles.
  node src/app/cli.ts commands [--limit N] [--db <path>]
      Recent owner commands (chat and command line): what each asked, its status and reply.
  node src/app/cli.ts quests [--live] [--db <path>]
      The Age 0 quest book (GTNH "Tier 0 - Stone Age") AS THE SERVER RECORDS IT (Better
      Questing): chapter progress, completed and active quests, unclaimed rewards, due
      quest-book clicks and the next goal. --live reads it from the server first (it clicks
      nothing); without --live it shows the last observation.
  node src/app/cli.ts halt [--reason <text>] / unhalt / movement
      Create / remove the stop file (nothing walks, uses chests, digs, places or fights while it
      exists) / show movement, digging, placing and combat settings.
  node src/app/cli.ts scenarios            List mock scenarios.
  node src/app/cli.ts history [--limit N] [--db <path>]
                                           Show recent logged actions.
  node src/app/cli.ts task-resume --task <id> [--db <path>]
                                           Mark a paused/blocked task active again.
  node src/app/cli.ts task-add --task <id> --goal <text> [--needs item=count,...] [--plan <plan.json>] [--machines <ids>] [--db <path>]
                                           Add a task and make it the live agent's current task,
                                           with an optional plan you wrote (validated like a
                                           planner's). Each once --live then runs one step.
                                           --machines gt:x.y.z,...: wait while one is busy,
                                           pause if one is switched off.
  node src/app/cli.ts task-complete --task <id> / task-list [--db <path>]
  node src/app/cli.ts plan-show [--task <id>] [--db <path>]
                                           Show a task's latest plan, or every open plan.
  node src/app/cli.ts plan-approve --task <id> [--plan <n>] [--db <path>]
                                           Approve the plan waiting for approval (and resume
                                           the task it paused). Nothing runs until the next
                                           cycle, which executes one validated step.
  node src/app/cli.ts plan-reject --task <id> [--plan <n>] [--reason <text>] [--db <path>]
                                           Reject the task's open plan.
  node src/app/cli.ts plan-schema          Print the planner output JSON Schema.
  node src/app/cli.ts config               Print the validated configuration.
`;

/**
 * Parses the command line and runs the command. Each command family is handled in
 * src/app/commands/: the live server (cli-live.ts), the agent's runs and the mock scenarios
 * (cli-runs.ts), and what the agent keeps (cli-records.ts).
 */
async function main(argv: string[]): Promise<number> {
  dotenv.config({ quiet: true });
  const { positionals, values } = parseCommandLine(argv);
  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  const { config, configFile } = loadConfig();
  const dbPath = values.memory ? IN_MEMORY : (values.db ?? config.database.path);
  const print = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };

  const log = values.verbose
    ? (line: string): void => {
        process.stderr.write(`[gtnh1710] ${line}\n`);
      }
    : undefined;
  const cli: Cli = {
    command,
    args: positionals.slice(1),
    values,
    config,
    configFile,
    dbPath,
    print,
    log,
  };

  switch (command) {
    case 'observe':
      return observeCommand(cli);
    case 'once':
      return onceCommand(cli);
    case 'move':
      return moveCommand(cli);
    case 'explore':
      return exploreCommand(cli);
    case 'places':
      return placesCommand(cli);
    case 'watch':
      return watchCommand(cli);
    case 'play':
      return playCommand(cli);
    case 'run':
      return runCommand(cli);
    case 'chest':
      return chestCommand(cli);
    case 'dig':
      return digCommand(cli);
    case 'place':
      return placeCommand(cli);
    case 'interact':
      return interactCommand(cli);
    case 'layouts':
      return layoutsCommand(cli);
    case 'attack':
      return attackCommand(cli);
    case 'halt':
      print(setMovementHalted(config, true, values.reason));
      return 0;
    case 'unhalt':
      print(setMovementHalted(config, false));
      return 0;
    case 'movement':
      print(movementStatus(config));
      return 0;
    case 'scenarios':
      return scenariosCommand();
    case 'history':
      return historyCommand(cli);
    case 'command':
      return commandCommand(cli);
    case 'commands':
      return commandsCommand(cli);
    case 'task-resume':
      return taskResumeCommand(cli);
    case 'quests':
      return questsCommand(cli);
    case 'task-add':
    case 'task-complete':
    case 'task-list':
      return taskCommand(cli);
    case 'plan-show':
    case 'plan-approve':
    case 'plan-reject':
      return planCommand(cli);
    case 'plan-schema':
      print(plannerResponseJsonSchema());
      return 0;
    case 'config':
      print({ configFile, config });
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);

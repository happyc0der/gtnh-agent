# gtnh-agent

A local-first, **safety-first** agent foundation for GregTech: New Horizons (GTNH) on a
**private** server you control.

**Status:** one human-triggered observe → decide → validate → execute → verify cycle, against a
simulated world or a private GTNH 2.8.4 test server. On the test server the agent observes,
**walks inside a fenced pen**, **moves exact amounts to and from configured chests**, can **dig
allowlisted natural blocks** (logs, leaves, dirt, sand, gravel, clay) and **place allowlisted
plain blocks** (dirt, cobblestone, sand, gravel, sandstone, planks, logs) inside the pen. It works on
**live tasks**: a task you add, with a plan you write, runs one validated step per `once --live`,
or back to back in a **bounded auto-run** (`run --live`) that stops as soon as anything needs you.
No open-ended loop. **Local models are opt-in** (off by default, no GPU use unless enabled).

**Local models (2026-09-30):** a local Ollama model can make the System 1 decisions
(`AGENT_DECISIONS=ollama`) and write plans (`AGENT_PLANNER=ollama`). Models only propose: a
decision passes the safety-first wrapper (the router's safety decisions and pauses win; invalid
output pauses), and every plan step is validated and executed by code like any other. On the mock
scenarios, qwen3:14b agrees with the rule router on every decision and its plans pass validation;
qwen2.5:0.5b does not. See [docs/local-llm-integration.md](docs/local-llm-integration.md).

**System 1 at decision points (2026-10-01):** the System 1 model (about 2 s a decision) decides
only where something changed: a session's first cycle, after a failed action, when a plan ended
or none is open, or on a new condition (the router's reasons, a mob or hazard, low health or
food, the task, the time of day, a nearly full inventory). In between, the router's decision
continues the open plan at once: a 54-sand GATHER (61 cycles) asks the model once.
`AGENT_DECISION_CADENCE=every-cycle` asks it every cycle. Each cycle's System 1 line shows who
decided, and each session ends with a count. See
[docs/architecture.md](docs/architecture.md#system-1-who-decides-each-cycle).

**Live connection (2026-09-30):** the agent's own 1.7.10 + Forge client (`src/bot/gtnh1710/`) joins
the test server and observes position, dimension, health, food, a named inventory, nearby
entities (vanilla and modded mobs; unidentified modded types count as hostile) and lava, fire,
harmful fluids, damaging blocks and void within 32 m, plus nearby GregTech machines (type, and
whether each is enabled and running, from GregTech's own network channel; stored power is not sent).
With everything critical observable, a live cycle pauses only because the agent has no task. Mineflayer cannot connect to GTNH (it rejects
1.7.10). See [docs/gtnh-compatibility.md](docs/gtnh-compatibility.md).

**Interacting with blocks (2026-09-30, fake server only so far):** with interacting enabled,
`INTERACT_BLOCK`, `SMELT` and `TAKE_OUTPUT` open blocks the agent has an interaction profile for
(furnaces, crafting tables, chests, Iron Chests chests, Thaumcraft hungry chests, Tinkers' crafting
stations), smelt in furnaces and take their output. Each profile is data checked in the server's
jars; blocks without one are only looked at, and only if you list them. Found chests and crafting
tables also work with the chest and crafting actions. See
[Interacting with blocks](#interacting-with-blocks).

**Walking and chests (2026-09-30):** with movement explicitly enabled and a fence configured,
`MOVE_TO` and `RETURN_TO_SAFE_LOCATION` walk the player on one level inside the fence (no jumping,
climbing, falling or block changes). With containers enabled, `OPEN_CONTAINER`, `WITHDRAW_ITEM` and
`DEPOSIT_ITEM` work on configured vanilla chests, moving exact amounts. With crafting enabled,
`CRAFT_ITEM` crafts early-game recipes in the 2x2 grid or at a configured crafting table (fake
server only so far). With digging enabled, `DIG_BLOCK` breaks one allowlisted block inside the
fence, holding the best verified tool the player carries (a wooden shovel for sand, dirt, gravel,
grass and clay; a vanilla axe for logs) or an empty hand. With placing enabled, `PLACE_BLOCK` puts
one allowlisted plain block the player carries into an empty cell inside the fence (fake server
only so far). With combat enabled, `ATTACK_ENTITY` strikes one listed hostile (or a farm animal,
for a task) in a short burst, and System 1 decides `DEFEND` when retreating is impossible or worse
(fake server only so far). The remaining world-changing actions return `NOT_IMPLEMENTED`. See
[Walking in the test pen](#walking-in-the-test-pen), [Chests](#chests), [Crafting](#crafting),
[Digging](#digging), [Placing](#placing) and [Combat](#combat).

**Walking through leaves (2026-10-01, fake server only so far):** with digging enabled too, a
`MOVE_TO` over terrain breaks up to 4 leaves in its way, as a person punches through a bush (seen
live: logs walled in by leaf bushes in a Hot Forest were out of every walk's reach, and the agent
gave up on the forest). Each break is checked and dug like `DIG_BLOCK` and costs the walker its
dig time, so it still walks round a bush when that is only a little longer. See
[Digging](#digging).

**Spiders in daylight (2026-10-01, fake server only so far):** a vanilla spider looks for a
player only in the dark (light 11 or less), so a person ignores one in daylight (seen live:
one sent the agent 108 blocks back to its spawn). The client now keeps the light the chunk data
carries and the weather, and computes the light at a spider as the server does: in light 12 or
more, farther than its 6-block leap, with the player not hurt in the last 15 s, and never seen
in the dark near the player (or hurt) on this connection, a spider is **calm**: listed, but no
threat, and never attacked. Special Mobs' spiders never are (some are rolled always hostile).
See [Combat](docs/architecture.md#combat).

**Night pit (2026-10-01, fake server only so far):** at dusk, play digs a pit three blocks
straight down under the player (`DIG_DOWN`, the only dig of the ground underfoot, allowed only
as code's own night-shelter step) and roofs it in the ground layer it dug through; in the
morning it digs the roof and a staircase out before the day's goal. Code plans and runs both as
known safe steps; the planner is not asked. See [The night pit](#the-night-pit).

**Exploring (2026-09-30, fake server only so far):** with `MC_MOVEMENT_MODE=follow` the walk/dig
fence becomes a play area that moves with the player, inside the safety boundary. `EXPLORE` walks
toward a direction or a point in checked hops, in daylight only, and the agent remembers what it
has seen per chunk (biome, logs, dirt, sand, gravel, clay, water, stone, ores; only what a player could
see). The planner gets the known places, and play scouts the area once before the quests. See
[Exploring and world memory](#exploring-and-world-memory).

**Quest book (2026-09-30, fake server only so far):** the agent reads GTNH's quest book (Better
Questing) over the mod's own channel, so the "Finish Age 0" benchmark (the 92-quest
"Tier 0 - Stone Age" chapter) counts only what the SERVER records as completed, exactly as for a
player using the quest book. Goals cover the chapter and the 14 quests it needs from other
chapters, and follow Better Questing's rules (prerequisite logic incl. XOR, task logic OR,
crafting counted only while a quest is active). With `MC_ENABLE_QUEST_BOOK=true`, play also
submits finished quests, ticks checkboxes and claims rewards itself, decided in code. See
[Quest book](#quest-book).

## Requirements

- Node.js ≥ 22.18 (developed on 24.21). `.ts` files run directly via Node's type stripping.
- pnpm 12 via corepack (pinned in `package.json` → `packageManager`).
- No compiler toolchain: `better-sqlite3` ships prebuilt binaries.

## Setup

```bash
corepack enable pnpm
pnpm install
```

Without `corepack enable`, prefix each command with `corepack`, e.g. `corepack pnpm install`.

Optional local configuration (neither file is committed; no secrets are needed):

```bash
cp .env.example .env
cp agent.config.example.json agent.config.json
```

## Commands

| Task                                         | Command                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Unit + integration tests                     | `pnpm test`                                                                               |
| Lint (incl. architectural boundaries)        | `pnpm lint`                                                                               |
| Type check (strict)                          | `pnpm typecheck`                                                                          |
| Format check / fix                           | `pnpm format:check` / `pnpm format`                                                       |
| Build to `dist/`                             | `pnpm build`                                                                              |
| Everything                                   | `pnpm check`                                                                              |
| **One mock agent cycle**                     | `pnpm agent:once`                                                                         |
| One cycle of a named scenario                | `pnpm agent:once --scenario hungry`                                                       |
| Scenario list                                | `pnpm cli scenarios`                                                                      |
| Throwaway in-memory DB                       | `pnpm agent:once --memory`                                                                |
| Full cycle result                            | `pnpm agent:once --full`                                                                  |
| Recent action log                            | `pnpm cli history --limit 20`                                                             |
| Resume a paused/blocked task                 | `pnpm cli task-resume --task task-action-fails`                                           |
| Planner output JSON Schema                   | `pnpm cli plan-schema`                                                                    |
| Open plans / one task's latest plan          | `pnpm cli plan-show [--task <id>]`                                                        |
| Approve a plan waiting for approval          | `pnpm cli plan-approve --task <id> --plan <n>`                                            |
| Reject a task's open plan                    | `pnpm cli plan-reject --task <id> --reason ...`                                           |
| Show validated config                        | `pnpm cli config`                                                                         |
| **Observe the live test server (read-only)** | `pnpm cli observe --live`                                                                 |
| One agent cycle against the live server      | `pnpm cli once --live`                                                                    |
| Plan a walk and draw it (no movement)        | `pnpm cli move --live --to home --dry-run`                                                |
| **Walk** (to `x,y,z` or a named location)    | `pnpm cli move --live --to=-0.5,200,-11.5`                                                |
| Stop all walking and chest use / allow again | `pnpm cli halt` / `pnpm cli unhalt`                                                       |
| Add a live task with your plan / list tasks  | `pnpm cli task-add --task <id> --goal <text> --plan <file>` / `pnpm cli task-list`        |
| Bounded auto-run of the current task         | `pnpm cli run --live [--max-cycles 20] [--max-minutes 10]`                                |
| Age 0 quest book as the server records it    | `pnpm cli quests [--live]`                                                                |
| Autonomous play (quests, or your own goal)   | `pnpm cli play --live [--needs minecraft:diamond=100] [--minutes 30]`                     |
| Open a chest (and move exact amounts)        | `pnpm cli chest --live --container chest.pen --withdraw minecraft:cobblestone --count 10` |
| Open a block (furnace, Iron Chests chest...) | `pnpm cli interact --live --at=-6,200,-8`                                                 |
| Take a furnace's output                      | `pnpm cli interact --live --at=-6,200,-8 --take <item>`                                   |
| Window layouts learned from opened blocks    | `pnpm cli layouts`                                                                        |
| **Dig** one allowlisted block in the pen     | `pnpm cli dig --live --at=-8,200,-11`                                                     |
| **Place** one allowlisted block in the pen   | `pnpm cli place --live --at=-7,200,-11 --item minecraft:cobblestone`                      |
| **Explore** toward a direction or a point    | `pnpm cli explore --live --toward south --distance 64`                                    |
| What world memory knows (known places)       | `pnpm cli places [--at x,z]`                                                              |
| **Fight** one mob in the pen (by its id)     | `pnpm cli attack --live --entity 1234`                                                    |
| Test-server operator tool (RCON)             | `node scripts/test-server-admin.ts pen show`                                              |
| Mineflayer/minecraft-protocol comparison     | `pnpm spike:connect`                                                                      |
| Entity survey (what the server announces)    | `node scripts/entity-survey.ts --seconds 20`                                              |
| GregTech machine survey (channel + states)   | `node scripts/gt-machine-survey.ts --seconds 10`                                          |
| One mock cycle with local models (Ollama)    | `AGENT_DECISIONS=ollama AGENT_PLANNER=ollama pnpm agent:once --scenario needs-planner`    |
| Evaluate local models on the mock scenarios  | `node scripts/llm-eval.ts --decision-model qwen3:14b --planner-model qwen3:14b`           |

`agent:once` persists to `./data/agent.sqlite` by default (`AGENT_DB_PATH` or `--db` override).
Try `pnpm agent:once --scenario action-fails` three times: two failures, then the third attempt is
refused with `REPEATED_FAILURE` and the task stays blocked until `task-resume`.

Plans are stored and run **one validated step per cycle**: `pnpm agent:once --scenario needs-planner`
runs step 1 of a two-step plan, and running it again runs step 2 without asking the planner again.
`--scenario planner-needs-approval` stores a plan that needs approval and pauses. Nothing runs until
you approve it: `plan-show`, then `plan-approve` (which also resumes the paused task).

Example output (abridged):

```json
{
  "scenario": "nominal",
  "status": "succeeded",
  "needsUserAttention": false,
  "decision": {
    "decision": "EXECUTE_KNOWN_SAFE_STEP",
    "confidence": 0.8,
    "reasonCodes": ["KNOWN_SAFE_STEP"]
  },
  "action": {
    "type": "INSPECT_MACHINE",
    "args": { "machineId": "machine.macerator.1" },
    "origin": "deterministic-router"
  },
  "validation": { "ok": true, "violations": [], "preconditionFailures": [] },
  "execution": "OK: inspected machine.macerator.1",
  "verification": {
    "verified": true,
    "checks": ["PASS execution-ok: …", "PASS observation-fresh: …", "PASS machine-inspected: …"]
  },
  "summary": "EXECUTE_KNOWN_SAFE_STEP -> INSPECT_MACHINE -> succeeded"
}
```

## Design in one paragraph

A `MinecraftClient` (mock today) produces a Zod-validated `GameState` in which anything unobservable
is explicitly `unknown`. A pure-code **safety policy** decides whether the state is trustworthy
(unknown/stale/inconsistent → pause). A deterministic **System 1 router** picks one of nine bounded
decisions (opt-in, a local model picks at decision points, and the router's safety decisions
still win), which becomes exactly **one** allowlisted action (or a planner request answered by a
fixture-driven mock planner). The single **ActionExecutor** validates the action (schema, safety,
preconditions), persists it, executes it with a token only it can mint, re-observes, verifies the
code-derived postcondition, and persists the outcome to SQLite. See [docs/architecture.md](docs/architecture.md)
and [docs/action-contract.md](docs/action-contract.md).

## Safety defaults

- Localhost/private addresses only. Public IPs and non-allowlisted hostnames are rejected at config
  load, and `MC_ENABLE_LIVE_CONNECTION` defaults to `false`. The same applies to the model server
  (`OLLAMA_URL`).
- A ±256-block boundary in the overworld; lava/void avoidance radius 6 (1.5 for cacti and other
  blocks that hurt only on contact); retreat below 10 health;
  eat below 14 food; at most 2 failures per action per task.
- Only 23 action types exist (3 of them quest-book clicks that only the play loop makes, and
  `DIG_DOWN`, the night pit's dig under the player's own feet, that only code's night-shelter
  blueprint makes). No dropping, lava, network/multiblock changes or rare-item use. The action
  that breaks blocks, `DIG_BLOCK`, only breaks vanilla logs, leaves, dirt, grass, sand, gravel
  and clay (`DIG_DOWN`: dirt, grass, sand, gravel or clay under the feet); the
  one that places blocks, `PLACE_BLOCK`, only places vanilla dirt, cobblestone, sand, gravel,
  sandstone, planks and logs; `EXPLORE` only walks, in hops, inside the boundary and only in
  daylight. Blocks are opened only by `INTERACT_BLOCK`, `SMELT` and `TAKE_OUTPUT`, and only
  blocks with an interaction profile or on the observe-only list. The only combat is
  `ATTACK_ENTITY`, on one listed hostile or farm animal.
- Walking is off unless `MC_ENABLE_MOVEMENT=true` **and** a fence is set; it stays on one level
  inside the fence and stops at the first sign of trouble (see below). With digging on too, a
  `MOVE_TO` over terrain may break up to 4 leaves in its way, each checked and dug like
  `DIG_BLOCK`; nothing else is ever broken by a walk.
- Exploring is off unless walking is on **and** `MC_MOVEMENT_MODE=follow`; it never leaves the
  safety boundary (at most 2048 blocks per side in that mode), walks at most 96 blocks per
  `EXPLORE`, only in daylight, and stops for threats like any walk.
- Chests are off unless `MC_ENABLE_CONTAINERS=true`; only chests listed in the config are used,
  and only if the block is a plain `minecraft:chest` (see below).
- Crafting is off unless `MC_ENABLE_CRAFTING=true`; only crafting tables listed in the config or
  found inside the fence are used, and a result is taken only if the server shows exactly what the
  recipe table expects.
- Interacting with blocks is off unless `MC_ENABLE_INTERACT=true`. Only blocks with an interaction
  profile are used; others only if you list them, and then only looked at. Trapped chests, levers,
  doors, drawers, barrels and ender chests are never right-clicked. Furnaces get only approved
  fuels, never lava (see below).
- Digging is off unless `MC_ENABLE_DIGGING=true` **and** the fence is set. It only breaks
  allowlisted blocks inside the fence, never the floor, and never anything touching water, a
  chest, a machine or any other non-plain block (see below).
- The one dig of the ground under the player, `DIG_DOWN` (approved 2026-10-01), is for the night
  pit only. The safety policy allows it only as code's own next step of the night-shelter
  task's blueprint, in the evening, at night or in the last 4 minutes before night; never from
  a plan or a command. The client digs only the block under the feet, with the player centred
  on it, when the block under that is a plain full block (no cave, fluid or plant: the drop is
  exactly one block), with nothing but air, plants and plain blocks around the dug block, the
  landing and the body (no water, lava, fire or other hazard, nothing unloaded), and needs
  walking on and a fence with a height range (never the pen). Before digging a pit, code checks
  that its walls are natural ground and that a way out exists for the morning.
- Placing is off unless `MC_ENABLE_PLACING=true` **and** the fence is set. It only fills empty
  cells inside the fence, never one the player's body or an entity is in, only by clicking a
  plain full block (never a chest or machine, which would open), never next to water, a chest
  or a machine, never sand or gravel where it could fall, and never during danger (see below).
- Combat is off unless `MC_ENABLE_COMBAT=true` **and** the fence is set. It strikes only
  identified zombies, spiders, skeletons and witches (and their Special Mobs variants), or a
  grown, unnamed cow, pig, sheep or chicken for a task. Never players, villagers, golems, pets,
  creepers, endermen, pigmen, a calm spider or anything unidentified. It refuses with health below 14 or food
  below 8, more than 2 hostiles near, or anything that may explode within 16 blocks
  (`safety.combat`), and stops at the first damage it takes (see below).
- Eating is off unless `MC_ENABLE_EATING=true`. `EAT_FOOD` eats only an approved food
  (`safety.approvedFoods`), moved into the hotbar if need be and used in the air. Right after a
  join, GTNH's AngerMod keeps the player invulnerable, and an invulnerable player cannot eat;
  the client ends that protection first with one empty-handed right-click on the plain ground
  underfoot (grass, dirt, sand, stone...), which uses, places and opens nothing.
- Quest-book clicks are off unless `MC_ENABLE_QUEST_BOOK=true`. They are made only for the Age 0
  quests the server lists as active (claims: completed), never hand in a protected item, and
  claim rewards only with room for them in the inventory (Better Questing drops the rest).
- Protected items are never consumed or moved.

## Project notes

- `pnpm-workspace.yaml` sets `nodeLinker: hoisted` because pnpm 12's symlinked layout was not
  resolvable by Node on this Windows machine, and it denies `better-sqlite3`'s optional build script
  (prebuilt binaries are used).
- TypeScript is pinned to 6.0.x because `typescript-eslint` 8.70 supports TypeScript < 6.1.
- Local models (Ollama) are opt-in; how to enable them and how they did on the mock scenarios:
  [docs/local-llm-integration.md](docs/local-llm-integration.md).

## Private GTNH test server

The live commands target a local test server in `~/Projects/gtnh-test-server` (outside this repo):
the official GTNH 2.8.4 Java 17-25 server pack on Temurin 21, bound to `127.0.0.1:25570`, offline
mode, whitelist on, throwaway world `agent-test`. Start it with `start-test-server.bat` in that
folder and stop it by typing `stop` in its window. The client retries while Forge still reports
"Server is still starting!" (about 30 s after "Done").

Live commands need three settings (for example in a local `.env`, which is gitignored):

```ini
MC_PORT=25570
MC_ENABLE_LIVE_CONNECTION=true
MC_SERVER_MARKER=gtnh-agent-test
```

The client refuses to log in unless the host is private and the server's status ping shows that
MOTD marker, Forge, GregTech and 1.7.10. Add `--verbose` to see the connection trace.

### Walking in the test pen

The first world-changing ability is walking, tested in a glass **pen** built in the throwaway
world: a 9 x 9 glass floor at y=199 with 3-high glass walls, 200 blocks up (nothing on the
ground is within range, and mobs cannot spawn on glass).

1. The test server has RCON on `127.0.0.1:25571` (`server.properties`: `enable-rcon=true`,
   `rcon.port`, `rcon.password`). GTNH's Hodgepodge runs RCON commands on the main server thread
   (`fixRconThreading`), so they are as safe as console commands. `allow-flight=false`, so the
   server itself would kick a player that floats.
2. Settings in `.env`: `TEST_SERVER_DIR` (the server folder; the RCON password is read from its
   `server.properties` and is not stored here), `TEST_PEN_CENTER=-5,200,-8` and `TEST_PEN_RADIUS=4`.
3. `node scripts/test-server-admin.ts pen build` builds (or resets) the pen, and
   `pen tp --wait 60` teleports the agent's player into it while it is online (for example during
   `pnpm cli observe --live`). `pen show` prints the matching agent settings: the fence and safety
   boundary for `.env`, and a `home` safe location for `agent.config.json`.
4. With `MC_ENABLE_MOVEMENT=true` and the fence set, `pnpm cli move --live --to home` walks.
   Coordinates starting with `-` need the `=` form: `--to=-0.5,200,-11.5`.

A walk is ONE user-requested action through the same executor as the agent's own: validated
(schema, safety policy, preconditions), executed, re-observed and verified. The walker plans with
A* inside the fence and re-checks every 0.2-block step just before sending it. A walk stops on:

- a server correction (the server moved the player back);
- a health drop;
- a hostile (not a calm spider, one in daylight) or unidentified entity within 10 blocks (for
  `MOVE_TO`; a retreat keeps going);
- anything blocked, unloaded, floorless or dangerous touching the way ahead;
- the stop file (`pnpm cli halt`, which also works from another terminal or over SSH);
- Ctrl+C;
- a lost connection.

Four GregTech test machines float just east of the pen at x=3, y=200, z=-9..-3: two LV macerators,
a steam macerator, and a macerator that is switched off. `observe` lists them with their state.

`pnpm cli observe --live` and `move` draw a top-down map of the fence. To watch in-game, join
`127.0.0.1:25570` with a GTNH 2.8.4 client as a whitelisted player.

### Chests

The second world-changing ability: moving exact amounts between the player and a configured
vanilla chest. The test chest sits in the pen three blocks south of the centre, at (-5, 200, -5).
It holds 128 cobblestone, 3 diamonds (a protected item) and 16 bread.

- `node scripts/test-server-admin.ts pen chest` places it, but only where there is no chest: in
  1.7.10 any `setblock` over a chest drops its contents into the world. `pen build` never
  touches that block.
- Settings: `MC_ENABLE_CONTAINERS=true`, and the chest in `agent.config.json` under
  `minecraft.containers.chests` (`pen chest` prints the entry).
- `pnpm cli chest --live --container chest.pen [--withdraw <item> | --deposit <item>] --count N`
  runs `OPEN_CONTAINER`, then the move, as checked user actions in one connection. Both sides are
  verified: player inventory and chest.

How it stays safe (see [docs/architecture.md](docs/architecture.md#chests)):

- The chest is right-clicked only with an empty hand (the client switches to an empty hotbar
  slot first), and only if the block really is a `minecraft:chest`. Trapped chests are refused
  because they emit redstone.
- Only predictable clicks are used: pick up a stack, put a stack into an empty slot, or place
  one item at a time. Items are never merged into existing stacks.
- Every click waits for the server's confirmation.
- The cursor is never left holding items. A rejected click is re-synced, and the cursor is put
  back into an empty slot.
- Protected items never move, and neither do stacks with NBT data.

### Crafting

The third world-changing ability: `CRAFT_ITEM` crafts a recipe from the agent's small table of
early (Age 0) recipes (`src/domain/recipes.ts`: planks, sticks, torches, crafting table, chest,
wooden shovel, wooden axe), each as GTNH 2.8.4 has it (e.g. 2 planks give 2 sticks; the crafting
table is two flint above two logs). It crafts in the player's own 2x2 grid, or for 3x3 recipes at
a crafting table you configure (the agent cannot place one). It has only run against the fake
server so far (see [docs/gtnh-compatibility.md](docs/gtnh-compatibility.md#crafting-2026-09-30)).

- Settings: `MC_ENABLE_CRAFTING=true`, and for 3x3 recipes the table in `agent.config.json` under
  `minecraft.crafting.tables` (`{ "table.pen": { "name": "...", "position": { "x": .., "y": .., "z": .. } } }`).
- Use it as a plan step, e.g.
  `{ "type": "CRAFT_ITEM", "args": { "recipe": "planks_oak", "times": 4, "craftingTableId": null } }`.

How it stays safe (see [docs/architecture.md](docs/architecture.md#crafting)):

- GTNH changes many recipes (e.g. a log gives 2 planks, not 4), so the table only says what to put
  where. A result is taken only if the server shows exactly the expected item and count.
  Otherwise every ingredient goes back and the action fails with what the server showed.
- The server drops whatever is left in a crafting grid or on the cursor when a window closes or
  the player leaves. So the grid only ever holds one craft's worth of items, every failure puts
  them back first, and the agent never closes window 0.
- Only predictable clicks are used, each confirmed by the server, and results always go into an
  empty slot.
- Protected items are never used as ingredients, and neither are stacks with NBT data.

### Interacting with blocks

GTNH has thousands of blocks that open a window, each different. `INTERACT_BLOCK`, `SMELT` and
`TAKE_OUTPUT` use only blocks the agent has an interaction profile for: data that says how the
block opens, what each slot of its window is for, and what the agent may do there
(`src/domain/interactions.ts`). Profiles today:

- furnaces;
- crafting tables;
- chests (never trapped chests);
- Iron Chests chests (all 11 types);
- Thaumcraft hungry chests;
- Tinkers' crafting stations (looked at only).

Every fact was checked in the server's jars, and it has run against the fake server only (see
[docs/gtnh-compatibility.md](docs/gtnh-compatibility.md#interacting-with-blocks-2026-09-30), which
also surveys GTNH's storage blocks).

- Settings: `MC_ENABLE_INTERACT=true`. A block without a profile can be looked at if you list it:
  `MC_INTERACT_OBSERVE_ONLY=appliedenergistics2:*` (exact names or whole mods).
- `pnpm cli interact --live --at=x,y,z` opens a block and prints its window. To use a furnace, add
  `--smelt minecraft:sand --count 8 --fuel minecraft:coal --fuel-count 1` (items and fuel in), or
  `--take <item>` (its output out).
- `observe --live` lists the blocks the agent may use, with a furnace's contents as last seen.
  `pnpm cli layouts` lists the windows learned from blocks the agent opened.
- In a plan: `SMELT` (`position`, `input`, `quantity`, `fuel`, `fuelQuantity`), then other steps
  or `WAIT`, then `TAKE_OUTPUT` (`position`, `item`).
- Found storage blocks work with `OPEN_CONTAINER`, `WITHDRAW_ITEM` and `DEPOSIT_ITEM` as
  `<profile>:<x>.<y>.<z>` (with `MC_ENABLE_CONTAINERS=true` too). Found crafting tables work with
  `CRAFT_ITEM` as `crafting_table:<x>.<y>.<z>`.

How it stays safe (see [docs/architecture.md](docs/architecture.md#interacting-with-blocks)):

- Only a block the observation lists, with a profile that allows the action, can be asked for. A
  listed block without a profile is only looked at: its window is recorded and closed at once,
  and nothing inside is clicked.
- Never right-clicked: trapped chests (redstone), levers, doors, buttons, beds..., drawers and
  barrels (a right-click can move the player's items), and ender chests (a window the client cannot
  recognise).
- An empty hand, and only a window that is exactly the profile's. Predictable clicks only, each
  confirmed by the server; the cursor is never left holding items.
- Only approved fuels, never lava. Protected items are never smelted, burned or taken.
- What a furnace makes is up to the server (GTNH changes smelting), so the agent takes only what
  the output slot shows, and every count is verified exactly.

### Digging

The third world-changing ability: breaking ONE block, for gathering. It only breaks
`minecraft:log`, `log2`, `leaves`, `leaves2`, `dirt`, `grass`, `sand`, `gravel` and `clay`, inside the
pen. It has been tested against the fake server only; the live test is next.

- `node scripts/test-server-admin.ts pen resources` places test blocks in the pen, each only where
  there is air:
  - dirt, sand, gravel and clay along the west side, plus a grass block;
  - a two-log tree with (never-decaying) leaves on top in the east.
- Settings:
  - `MC_ENABLE_DIGGING=true` (it also needs the movement fence);
  - `SAFETY_BOUNDARY_MAX` with y = 205, so the blocks above the feet level are inside the work
    area (`pen show` prints it);
  - optionally `minecraft.digging.maxHeightAboveFence` (default 4) in `agent.config.json`.
- `pnpm cli dig --live --at=-8,200,-11` digs one block as a checked user action, and prints the
  diggable blocks and the inventory afterwards. To collect the drop, stand next to the block
  first, e.g. `pnpm cli move --live --to=-6.5,200,-10.5`.
- `observe --live` lists the diggable blocks the agent sees.
- `examples/plans/dig-pen.json` is a task plan that walks there and digs the dirt and the grass.

How it stays safe (see [docs/architecture.md](docs/architecture.md#digging)):

- Only a block the observation lists as allowlisted can be asked for.
- The client re-checks it on the server's own block data before and during the dig. It refuses:
  - anything outside the fence's columns, below its level or more than 4 blocks above it;
  - anything under the player (only `DIG_DOWN`, for [the night pit](#the-night-pit), digs the
    block underfoot), or sand or gravel over its head;
  - any block touching something other than air, an allowlisted block or a plain full block
    (water, a torch, a chest, a machine...);
  - a block with sand or gravel on top;
  - a block next to lava, fire or other hazards.
- It holds the best verified tool the player carries for the block, or an empty hand
  (`src/domain/tools.ts`, [evidence](docs/gtnh-compatibility.md#tools-2026-09-30)):
  - a wooden shovel for dirt, grass, sand, gravel and clay (sand: 12 ticks instead of 21);
  - a vanilla axe for logs (77 ticks by hand, 40 with a wooden axe, 21 with a stone one).
  - The other vanilla shovels dig nothing on GTNH. GregTech and TConstruct tools keep their wear
    in NBT data the agent does not read, so it never holds them.
  - It never holds a protected tool, one with NBT data, or one whose next use would break it (a
    wooden tool: 59 uses). A tool in the main inventory is first moved into the hotbar with two
    confirmed clicks. The result reports the tool and its uses left.
- It waits 1.25 x the vanilla dig time (at the tool's speed) + 2 ticks: well past the 70% the
  server requires.
- Every tick it re-checks. It cancels on the stop file, Ctrl+C, a server correction, a health
  drop, a nearby threat, any change to the block, or a change to the tool in hand.
- Success needs the server's own block change to air, with no re-send. The result reports
  whether the drop reached the inventory.
- A `MOVE_TO` over terrain may break up to 4 leaves in its way, the same way: before a move
  that needs it, the walk stops and digs each one with these checks (leaves only), the dig time
  and the server's confirmation, the upper block first. A break refused or not confirmed stops
  the walk, and the agent re-plans. Each costs the walker its dig time (3.2 blocks of walking),
  so a way round that is not much longer wins. The result says what it broke and what the
  leaves dropped. Retreats, `EXPLORE` and the walk to a drop never break anything.

### Placing

The newest world-changing ability (approved 2026-09-30, so the agent can seal itself into a pit
for the night, and later place a crafting table, furnace and coke oven): putting ONE block the
player carries into an empty cell. Only `minecraft:dirt`, `cobblestone`, `sand`, `gravel`,
`sandstone`, `planks` and `log`/`log2` are placed. It has been tested against the fake server
only; the live test is next.

- Settings: `MC_ENABLE_PLACING=true` (it also needs the movement fence), and optionally
  `minecraft.placing.maxHeightAboveFence` (default 4) in `agent.config.json`.
- `pnpm cli place --live --at=-7,200,-11 --item minecraft:cobblestone` places one as a checked
  user action, and prints the placeable cells and the inventory afterwards.
- `observe --live` lists the cells a block could be placed into, and the blocks it saw placed.
- Use it as a plan step, e.g.
  `{ "type": "PLACE_BLOCK", "args": { "position": { "x": -7, "y": 200, "z": -11 }, "item": "minecraft:dirt" } }`.

How it stays safe (see [docs/architecture.md](docs/architecture.md#placing)):

- Only a cell the observation lists as placeable can be asked for, and only with an allowlisted
  item the player carries.
- The client re-checks it on the server's own block data just before the click. It refuses:
  - anything outside the fence's columns, below its level or more than 4 blocks above it;
  - a cell that is not air, tall grass or a dead bush (water, lava, a flower, a block);
  - a cell the player's body is in (the server itself would allow that), or that any entity
    may be in;
  - a cell touching anything but air, plants and plain full blocks (a chest, a machine, water,
    a torch...), or with a hazard within one block;
  - sand or gravel with no plain full block under it, or over the player's head.
- It clicks only a plain full block next to the cell. The server activates the clicked block
  first, so clicking a chest or machine would open it instead of placing.
- Success needs the server's own block change to the placed block after its answer to the
  click, with nothing else for 250 ms, and the held stack one item smaller.
- It is refused during danger, like digging: placing a block is not an escape. Shelters are
  built while it is safe.

### The night pit

Approved 2026-10-01: a raised box cannot be roofed from inside (the walls' tops are above the
eyes, and nothing touches the roof cell; seen live), so the agent shelters the way a
first-night player does on flat ground. Tested against the fake server only; the live test is
next.

- **At dusk** (2 real minutes before night), standing at feet level y, play digs the block
  under the feet three times (`DIG_DOWN`), falling one block each time, to feet at y-3. Then it
  places the roof in the y-1 cell, the ground layer it dug through, against the natural ground
  beside it: dirt or a log, which it can dig again (the digs themselves drop dirt).
- **In the morning** it digs the roof and a staircase out (the upper block of each step first;
  the terrain walker climbs one block at a time), then walks onto open ground and plays on.
- **Code plans both** with the live client's own rules (`src/bot/gtnh1710/night-pit.ts`) and
  runs them as known safe steps (`src/app/known-steps.ts`): each step is still validated,
  executed and verified by the executor; the planner is not asked. Code picks the player's
  column or one next to it, and refuses a spot unless the 3 x 3 columns around are natural
  ground down to y-3 (sand and gravel only on solid ground), every dig down passes the client's
  checks, the roof can be placed, and a way out exists for the morning.
- **Otherwise** a raised box where something already touches its roof cell (a cliff, a tree
  trunk), and with neither, play goes offline until sunrise, as before.
- Settings: digging, placing and walking enabled, with a fence that has a height range (the
  play area in `MC_MOVEMENT_MODE=follow`, or a terrain fence); the pen's one-level fence keeps
  its floor.

### Exploring and world memory

The fourth ability: leaving the first spot. The test world spawns the agent in a desert, and
GTNH's early quests want wood, gravel "near water", clay on "the riverbanks" and stone. It has
been tested against the fake server only (a streamed world with a desert, a forest, a river and
the boundary); the live test is next.

- Settings:
  - `MC_ENABLE_MOVEMENT=true` and `MC_MOVEMENT_MODE=follow`: walks and digs then use a play area
    centred on the player (`minecraft.movement.area`, default 64 x 64 blocks and 32 levels),
    instead of the fixed fence;
  - `SAFETY_BOUNDARY_MIN` / `MAX`: the exploration area. The play area never leaves it, and an
    EXPLORE toward a point outside it is refused. Keep it to a few hundred blocks around spawn
    (at most 2048 per side in this mode), e.g. `-256,0,-256` to `256,255,256`.
- `pnpm cli explore --live --toward south --distance 64` explores once as a checked user action
  (`--toward north_east`, or a point: `--toward=120,-40`). It prints how far it got, why it
  stopped and what world memory now knows. Ctrl+C or `pnpm cli halt` stops it at its next step.
- `pnpm cli places` prints what world memory knows, as the planner gets it: per resource the
  nearest place seen (and a much richer one), the biomes seen, and how far each direction has
  been seen.
- `pnpm cli play --live` in this mode first scouts the area (one session, while fewer than 50
  chunks are known), then plays the quests; the planner explores when a quest needs a block
  that is not nearby.

How it stays safe (see [docs/architecture.md](docs/architecture.md#exploring-and-world-memory)):

- Every hop is an ordinary walk: planned on the server's blocks, every 0.2-block step re-checked
  just before it is sent, never into water, lava, unloaded chunks or next to a hazard, drops of at
  most 2 blocks; a hostile (not a calm spider) or unidentified entity within 10 blocks stops it.
- The body passes only through air and plants checked in the code the server runs (2026-10-01):
  vanilla grass, flowers, sugar cane, vines and a single snow layer; Biomes O' Plenty's
  foliage, flowers, plants, mushrooms and vines; Natura's wild crops; HarvestCraft's gardens.
  Harmful variants (poison ivy, deadbloom, burning blossom, thorns, BOP's small cactus) are told
  apart by block metadata and never entered; anything else, or a plant whose metadata is not
  known, is a wall ([evidence](docs/gtnh-compatibility.md#walking-through-plants-2026-10-01)).
- At most 96 blocks walked per EXPLORE, 12 hops and 3 minutes; it stops when stuck, at the
  boundary, at water or cliffs it cannot route around, and when it gets dark. It is refused in the
  evening, at night and when the time is unknown.
- The way back: a retreat (`RETURN_TO_SAFE_LOCATION`, e.g. `move --to home`) to a location
  beyond the play area travels in the same checked hops. Threats do not stop a retreat, at any
  time of day: it is the escape.
- World memory records only what a player could see: blocks near the surface with a face
  touching air, in a clear line of sight from the eyes, in daylight. Ores are recorded as "ore",
  never by material.

### Combat

`ATTACK_ENTITY` engages ONE mob the observation lists, for a short burst, and System 1 decides
`DEFEND` (which becomes `ATTACK_ENTITY`) when a hostile is close and retreating is impossible or
worse. It has been tested against the fake server only; the live test is next (see
[docs/gtnh-compatibility.md](docs/gtnh-compatibility.md#combat-2026-09-30) for the server rules
it is built on).

- Settings: `MC_ENABLE_COMBAT=true` (it also needs the movement fence and presence ticks), and
  optionally `safety.combat` in `agent.config.json` (`minHealthToFight` 14, `minHungerToFight` 8,
  `maxHostilesToFight` 2, `creeperFleeRadius` 16).
- `pnpm cli observe --live` prints every nearby entity with its id, health and whether the agent
  may attack it. `pnpm cli attack --live --entity <id>` runs one burst as a checked user action
  and prints what happened (swings, hits, kill, damage taken).

How it stays safe (see [docs/architecture.md](docs/architecture.md#combat)):

- Only identified mobs that fight in melee or at range, and farm animals only for a task and
  never with hostiles near. Creepers (and every mob that might be one), endermen, pigmen,
  silverfish, players, villagers, golems, pets, named or baby animals are never attacked.
- It fights only when the moment is safe (enough health and food, few hostiles, nothing that may
  explode near), and DEFEND prefers retreating home unless the mob is already in reach and dies
  in a few hits.
- The player never moves. It strikes with the best vanilla axe in the hotbar, or an empty hand
  (GTNH's swords deal no damage), one full hit per 12 ticks, at most 8 swings or 5 seconds.
- A killing blow waits while GTNH's 10% "kamikaze" explosion of a killed mob could hurt the
  player too much.
- Every tick it stops on any damage taken (System 1 decides again), a creeper or an unidentified
  mob appearing, the target leaving, the stop file, Ctrl+C or a server correction.

### Quest book

GTNH's quest book is Better Questing 3.7.15-GTNH. The agent reads it like the game's own client
does (its `BQ_NET_CHAN` channel), so `pnpm cli quests --live` shows the Age 0 quest book as the
server records it: chapter progress, completed and active quests, unclaimed rewards, the clicks
that are due and the next goal. It clicks nothing. Without `--live` it shows the last
observation. Tested against the fake server only; the live test is next.

- Settings: `MC_ENABLE_QUEST_BOOK=true` lets `pnpm cli play --live` make the quest book's clicks
  itself (off by default): submit a quest whose items are held (handing in the items of a
  consume task), tick a checkbox when that finishes the quest, and claim the rewards of
  completed quests (a choice reward takes the item an unfinished quest needs). Presence ticks
  (`MC_PRESENCE_TICKS`) must be on: the server's quest loop runs on the player's ticks.
- The goals: `src/goals/age0-quests.ts` is generated from the world's own quest database
  (`node scripts/extract-quests.ts`, needs `TEST_SERVER_DIR`): the 92 chapter quests and the 14
  they need from other chapters. The first quest is "Your First Night" (8 dirt); the first one
  the agent cannot do yet is "Where's the Flint?" (flint is crafted from gravel in GTNH, a recipe
  the agent does not have).

How it stays safe (see [docs/gtnh-compatibility.md](docs/gtnh-compatibility.md#quest-book-better-questing-2026-09-30)):

- Only four message types can be sent on the channel: the main_sync answer that reading needs,
  quest_action (submit or claim), task_checkbox and choice_reward; editing messages and the
  random "forced" claim cannot be expressed.
- Each click is an ordinary action: validated by the safety policy (Age 0 quests only, active
  and unlocked on the server, never a protected item handed in, never in danger), re-checked
  by the client against the server's quest book, and verified by the server's next sync (the
  quest completed, the box ticked, the rewards claimed and exactly those items received).
- Plans never contain clicks: only the play loop chooses them, from the server's records.

### Live tasks

A task you add becomes the live agent's current task. Each `pnpm cli once --live` is then one
normal cycle: its own decision logic first (dangers, food, upkeep), then the next step of the
task's plan, validated, executed and verified.

```bash
pnpm cli task-add --task fetch-cobble --goal "Fetch 10 cobblestone from the pen chest" --plan examples/plans/fetch-cobblestone.json
pnpm cli once --live
pnpm cli task-list
```

- **The plan is yours.** `examples/plans/fetch-cobblestone.json` walks next to the pen chest, opens
  it and withdraws 10. It is validated exactly like a planner's plan (schema, step limit, every
  step's static safety), so a plan that would, for example, take a protected item is refused and
  nothing is stored. Set `requiresUserApproval` to review it with `plan-approve` first.
- **Tasks can wait for machines:** `--machines gt:3.200.-1,...` (the ids `observe` prints). While
  one is busy, or not seen yet, the agent waits (`WAIT_FOR_MACHINE`). If one is switched off, it
  pauses. Otherwise the plan goes on.
- **Finishing the plan finishes the task**; the next cycle pauses with `NO_ACTIVE_TASK`. Use
  `pnpm cli task-complete --task <id>` to close a task early.
- **Chest memory.** Each cycle is a new connection, so a chest opened in one cycle is closed in the
  next. The agent remembers what it saw for `memory.containerContentsMaxAgeMs` (10 minutes), for
  the "enough in the chest" check. The client still re-reads the live chest before clicking
  anything.
- **Only the live server gets the current task.** Mock scenario runs share the database and never
  see it.

Verified live on 2026-09-30:

1. The walk (1 block).
2. Opening the chest.
3. The withdrawal in the next connection, from memory (verified 0→10 for the player, 128→118 for
   the chest).
4. A pause once the task was complete.

### Bounded auto-run

`pnpm cli run --live` runs the current task's cycles back to back on ONE connection, so a chest
opened in one cycle is still open in the next. Every cycle is the same `runSingleCycle`, with the
same decision logic, validation, execution and verification. The run only decides whether to
start another cycle. It stops:

- when the task is completed, or there is none;
- after any cycle that did not succeed or asks for attention: a pause, rejection, failure,
  verification failure, approval or error;
- after any cycle whose decision was not plain task progress, such as a safety retreat, eating or
  upkeep, so you see why the agent turned aside;
- at `--max-cycles` (default 20, at most 200) or `--max-minutes` (default 10, at most 60);
- at the stop file (`pnpm cli halt`, also from another terminal or over SSH) or Ctrl+C, checked
  before every cycle. A walk in progress halts at its next step.

Each cycle prints its System 1 line, whose provider says who decided (with
`AGENT_DECISIONS=ollama`: the model's name at a decision point, `continuing(deterministic-router)`
when the plan simply went on), then its summary. A run with a model ends with a count of model
decisions (and their median time), continued cycles and binding router decisions.

Verified live on 2026-09-30:

- the fetch task ran in 3 cycles (1.8 s) and stopped with "the task is completed";
- with `--machines` on a macerator busy with a 30 s recipe, it waited 6 times (30 s), then walked,
  opened the chest and withdrew (33 s in all);
- a corner-walking task stopped when `pnpm cli halt` ran mid-walk: the walk halted, then the run
  stopped.

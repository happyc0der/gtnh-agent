# gtnh-agent

A local-first, **safety-first** agent foundation for GregTech: New Horizons (GTNH) on a
**private** server you control.

**Status:** one human-triggered observe → decide → validate → execute → verify cycle, against a
simulated world or a private GTNH 2.8.4 test server. On the test server the agent observes,
**walks inside a fenced pen**, **moves exact amounts to and from configured chests** and can **dig
allowlisted natural blocks** (logs, leaves, dirt, sand, gravel, clay) inside the pen. It works on
**live tasks**: a task you add, with a plan you write, runs one validated step per `once --live`,
or back to back in a **bounded auto-run** (`run --live`) that stops as soon as anything needs you.
No open-ended loop. **Local models are opt-in** (off by default, no GPU use unless enabled).

**Local models (2026-09-30):** a local Ollama model can make the System 1 decisions
(`AGENT_DECISIONS=ollama`) and write plans (`AGENT_PLANNER=ollama`). Models only propose: a
decision passes the safety-first wrapper (the router's safety decisions and pauses win; invalid
output pauses), and every plan step is validated and executed by code like any other. On the mock
scenarios, qwen3:14b agrees with the rule router on every decision and its plans pass validation;
qwen2.5:0.5b does not. See [docs/local-llm-integration.md](docs/local-llm-integration.md).

**Live connection (2026-09-30):** the agent's own 1.7.10 + Forge client (`src/bot/gtnh1710/`) joins
the test server and observes position, dimension, health, food, a named inventory, nearby
entities (vanilla and modded mobs; unidentified modded types count as hostile) and lava, fire,
harmful fluids, damaging blocks and void within 32 m, plus nearby GregTech machines (type, and
whether each is enabled and running, from GregTech's own network channel; stored power is not sent).
With everything critical observable, a live cycle pauses only because the agent has no task. Mineflayer cannot connect to GTNH (it rejects
1.7.10). See [docs/gtnh-compatibility.md](docs/gtnh-compatibility.md).

**Walking and chests (2026-09-30):** with movement explicitly enabled and a fence configured,
`MOVE_TO` and `RETURN_TO_SAFE_LOCATION` walk the player on one level inside the fence (no jumping,
climbing, falling or block changes). With containers enabled, `OPEN_CONTAINER`, `WITHDRAW_ITEM` and
`DEPOSIT_ITEM` work on configured vanilla chests, moving exact amounts. With crafting enabled,
`CRAFT_ITEM` crafts early-game recipes in the 2x2 grid or at a configured crafting table (fake
server only so far). With digging enabled, `DIG_BLOCK` breaks one allowlisted block inside the
fence with an empty hand. With combat enabled, `ATTACK_ENTITY` strikes one listed hostile (or a
farm animal, for a task) in a short burst, and System 1 decides `DEFEND` when retreating is
impossible or worse (fake server only so far). The remaining world-changing actions return
`NOT_IMPLEMENTED`. See [Walking in the test pen](#walking-in-the-test-pen), [Chests](#chests),
[Crafting](#crafting), [Digging](#digging) and [Combat](#combat).

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
| The agent's Age 0 quest book and next goal   | `pnpm cli quests [--live]`                                                                |
| Open a chest (and move exact amounts)        | `pnpm cli chest --live --container chest.pen --withdraw minecraft:cobblestone --count 10` |
| **Dig** one allowlisted block in the pen     | `pnpm cli dig --live --at=-8,200,-11`                                                     |
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
decisions, which becomes exactly **one** allowlisted action (or a planner request answered by a
fixture-driven mock planner). The single **ActionExecutor** validates the action (schema, safety,
preconditions), persists it, executes it with a token only it can mint, re-observes, verifies the
code-derived postcondition, and persists the outcome to SQLite. See [docs/architecture.md](docs/architecture.md)
and [docs/action-contract.md](docs/action-contract.md).

## Safety defaults

- Localhost/private addresses only. Public IPs and non-allowlisted hostnames are rejected at config
  load, and `MC_ENABLE_LIVE_CONNECTION` defaults to `false`. The same applies to the model server
  (`OLLAMA_URL`).
- A ±256-block boundary in the overworld; lava/void avoidance radius 6; retreat below 10 health;
  eat below 14 food; at most 2 failures per action per task.
- Only 14 action types exist. No block placing, dropping, lava, network/multiblock changes or
  rare-item use. The one action that breaks blocks, `DIG_BLOCK`, only breaks vanilla logs,
  leaves, dirt, grass, sand, gravel and clay.
- Walking is off unless `MC_ENABLE_MOVEMENT=true` **and** a fence is set; it stays on one level
  inside the fence and stops at the first sign of trouble (see below).
- Chests are off unless `MC_ENABLE_CONTAINERS=true`; only chests listed in the config are used,
  and only if the block is a plain `minecraft:chest` (see below).
- Crafting is off unless `MC_ENABLE_CRAFTING=true`; only crafting tables listed in the config are
  used, and a result is taken only if the server shows exactly what the recipe table expects.
- Digging is off unless `MC_ENABLE_DIGGING=true` **and** the fence is set. It only breaks
  allowlisted blocks inside the fence, never the floor, and never anything touching water, a
  chest, a machine or any other non-plain block (see below).
- Combat is off unless `MC_ENABLE_COMBAT=true` **and** the fence is set. It strikes only
  identified zombies, spiders, skeletons and witches (and their Special Mobs variants), or a
  grown, unnamed cow, pig, sheep or chicken for a task. Never players, villagers, golems, pets,
  creepers, endermen, pigmen or anything unidentified. It refuses with health below 14 or food
  below 8, more than 2 hostiles near, or anything that may explode within 16 blocks
  (`safety.combat`), and stops at the first damage it takes (see below).
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
- a hostile or unidentified entity within 10 blocks (for `MOVE_TO`; a retreat keeps going);
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
early (Age 0) recipes (`src/domain/recipes.ts`: planks, sticks, torches, crafting table, chest). It
crafts in the player's own 2x2 grid, or for 3x3 recipes at a crafting table you configure. It has
only run against the fake server so far (see
[docs/gtnh-compatibility.md](docs/gtnh-compatibility.md#crafting-2026-09-30)).

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
  - anything under the player, or sand or gravel over its head;
  - any block touching something other than air, an allowlisted block or a plain full block
    (water, a torch, a chest, a machine...);
  - a block with sand or gravel on top;
  - a block next to lava, fire or other hazards.
- It digs with an empty hand, so no tool or item can do anything special.
- It waits 1.25 x the vanilla dig time + 2 ticks: well past the 70% the server requires.
- Every tick it re-checks. It cancels on the stop file, Ctrl+C, a server correction, a health
  drop, a nearby threat, or any change to the block.
- Success needs the server's own block change to air, with no re-send. The result reports
  whether the drop reached the inventory.

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

Verified live on 2026-09-30:

- the fetch task ran in 3 cycles (1.8 s) and stopped with "the task is completed";
- with `--machines` on a macerator busy with a 30 s recipe, it waited 6 times (30 s), then walked,
  opened the chest and withdrew (33 s in all);
- a corner-walking task stopped when `pnpm cli halt` ran mid-walk: the walk halted, then the run
  stopped.

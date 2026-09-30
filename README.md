# gtnh-agent

A local-first, **safety-first** agent foundation for GregTech: New Horizons (GTNH) on a
**private** server you control.

**Status:** one human-triggered observe → decide → validate → execute → verify cycle, against a
simulated world or a private GTNH 2.8.4 test server, where the agent observes and can **walk inside
a fenced pen** (its only world-changing ability). No autonomous loop, no model and no GPU use.

**Live connection (2026-09-30):** the agent's own 1.7.10 + Forge client (`src/bot/gtnh1710/`) joins
the test server and observes position, dimension, health, food, a named inventory, nearby
entities (vanilla and modded mobs; unidentified modded types count as hostile) and lava, fire,
harmful fluids, damaging blocks and void within 32 m. With everything critical observable, a
live cycle pauses only because the agent has no task. Mineflayer cannot connect to GTNH (it rejects
1.7.10). See [docs/gtnh-compatibility.md](docs/gtnh-compatibility.md).

**Walking (2026-09-30):** with movement explicitly enabled and a fence configured, `MOVE_TO` and
`RETURN_TO_SAFE_LOCATION` walk the player on one level inside the fence: no jumping, climbing,
falling or block changes. Every other world-changing action still returns `NOT_IMPLEMENTED`. See
[Walking in the test pen](#walking-in-the-test-pen).

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

| Task                                         | Command                                         |
| -------------------------------------------- | ----------------------------------------------- |
| Unit + integration tests                     | `pnpm test`                                     |
| Lint (incl. architectural boundaries)        | `pnpm lint`                                     |
| Type check (strict)                          | `pnpm typecheck`                                |
| Format check / fix                           | `pnpm format:check` / `pnpm format`             |
| Build to `dist/`                             | `pnpm build`                                    |
| Everything                                   | `pnpm check`                                    |
| **One mock agent cycle**                     | `pnpm agent:once`                               |
| One cycle of a named scenario                | `pnpm agent:once --scenario hungry`             |
| Scenario list                                | `pnpm cli scenarios`                            |
| Throwaway in-memory DB                       | `pnpm agent:once --memory`                      |
| Full cycle result                            | `pnpm agent:once --full`                        |
| Recent action log                            | `pnpm cli history --limit 20`                   |
| Resume a paused/blocked task                 | `pnpm cli task-resume --task task-action-fails` |
| Planner output JSON Schema                   | `pnpm cli plan-schema`                          |
| Open plans / one task's latest plan          | `pnpm cli plan-show [--task <id>]`              |
| Approve a plan waiting for approval          | `pnpm cli plan-approve --task <id> --plan <n>`  |
| Reject a task's open plan                    | `pnpm cli plan-reject --task <id> --reason ...` |
| Show validated config                        | `pnpm cli config`                               |
| **Observe the live test server (read-only)** | `pnpm cli observe --live`                       |
| One agent cycle against the live server      | `pnpm cli once --live`                          |
| Plan a walk and draw it (no movement)        | `pnpm cli move --live --to home --dry-run`      |
| **Walk** (to `x,y,z` or a named location)    | `pnpm cli move --live --to=-0.5,200,-11.5`      |
| Stop all walking / allow it again            | `pnpm cli halt` / `pnpm cli unhalt`             |
| Test-server operator tool (RCON)             | `node scripts/test-server-admin.ts pen show`    |
| Mineflayer/minecraft-protocol comparison     | `pnpm spike:connect`                            |
| Entity survey (what the server announces)    | `node scripts/entity-survey.ts --seconds 20`    |

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
(unknown/stale/inconsistent → pause). A deterministic **System 1 router** picks one of eight bounded
decisions, which becomes exactly **one** allowlisted action (or a planner request answered by a
fixture-driven mock planner). The single **ActionExecutor** validates the action (schema, safety,
preconditions), persists it, executes it with a token only it can mint, re-observes, verifies the
code-derived postcondition, and persists the outcome to SQLite. See [docs/architecture.md](docs/architecture.md)
and [docs/action-contract.md](docs/action-contract.md).

## Safety defaults

- Localhost/private addresses only. Public IPs and non-allowlisted hostnames are rejected at config
  load, and `MC_ENABLE_LIVE_CONNECTION` defaults to `false`.
- A ±256-block boundary in the overworld; lava/void avoidance radius 6; retreat below 10 health;
  eat below 14 food; at most 2 failures per action per task.
- Only 11 non-destructive action types exist. No block placing/breaking, dropping, combat, lava,
  network/multiblock changes or rare-item use.
- Walking is off unless `MC_ENABLE_MOVEMENT=true` **and** a fence is set; it stays on one level
  inside the fence and stops at the first sign of trouble (see below).
- Protected items are never consumed or moved.

## Project notes

- `pnpm-workspace.yaml` sets `nodeLinker: hoisted` because pnpm 12's symlinked layout was not
  resolvable by Node on this Windows machine, and it denies `better-sqlite3`'s optional build script
  (prebuilt binaries are used).
- TypeScript is pinned to 6.0.x because `typescript-eslint` 8.70 supports TypeScript < 6.1.
- Local LLM integration is designed but not implemented: [docs/local-llm-integration.md](docs/local-llm-integration.md).

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

`pnpm cli observe --live` and `move` draw a top-down map of the fence. To watch in-game, join
`127.0.0.1:25570` with a GTNH 2.8.4 client as a whitelisted player.

# gtnh-agent

A local-first, **safety-first** agent foundation for GregTech: New Horizons (GTNH) on a
**private** server you control.

**Status:** one human-triggered observe → decide → validate → execute → verify cycle, against a
simulated world or, **read-only**, against a private GTNH 2.8.4 test server. No autonomous loop, no
model and no GPU use.

**Live connection (2026-09-30):** the agent's own 1.7.10 + Forge client (`src/bot/gtnh1710/`) joins
the test server and observes position, dimension, health, food, a named inventory, nearby
entities (vanilla and modded mobs; unidentified modded types count as hostile) and lava, fire,
harmful fluids, damaging blocks and void within 32 m. It cannot change the world: every
world-changing action returns `NOT_IMPLEMENTED`. With everything critical observable, a live cycle
now pauses only because the agent has no task. Mineflayer cannot connect to GTNH (it rejects
1.7.10). See [docs/gtnh-compatibility.md](docs/gtnh-compatibility.md).

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

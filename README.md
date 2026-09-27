# gtnh-agent

A local-first, **safety-first** agent foundation for GregTech: New Horizons (GTNH) on a
**private** server you control.

**Milestone 1 status:** mock-only. One human-triggered observe → decide → validate → execute →
verify cycle against a simulated world. There is no autonomous loop, no model, no GPU use, and no real
server connection. GTNH compatibility of Mineflayer is **unverified and likely blocked**; see
[docs/gtnh-compatibility.md](docs/gtnh-compatibility.md).

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

| Task                                  | Command                                         |
| ------------------------------------- | ----------------------------------------------- |
| Unit + integration tests              | `pnpm test`                                     |
| Lint (incl. architectural boundaries) | `pnpm lint`                                     |
| Type check (strict)                   | `pnpm typecheck`                                |
| Format check / fix                    | `pnpm format:check` / `pnpm format`             |
| Build to `dist/`                      | `pnpm build`                                    |
| Everything                            | `pnpm check`                                    |
| **One mock agent cycle**              | `pnpm agent:once`                               |
| One cycle of a named scenario         | `pnpm agent:once --scenario hungry`             |
| Scenario list                         | `pnpm cli scenarios`                            |
| Throwaway in-memory DB                | `pnpm agent:once --memory`                      |
| Full cycle result                     | `pnpm agent:once --full`                        |
| Recent action log                     | `pnpm cli history --limit 20`                   |
| Resume a paused/blocked task          | `pnpm cli task-resume --task task-action-fails` |
| Planner output JSON Schema            | `pnpm cli plan-schema`                          |
| Show validated config                 | `pnpm cli config`                               |

`agent:once` persists to `./data/agent.sqlite` by default (`AGENT_DB_PATH` or `--db` override).
Try `pnpm agent:once --scenario action-fails` three times: two failures, then the third attempt is
refused with `REPEATED_FAILURE` and the task stays blocked until `task-resume`.

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

# Action contract

Every in-game action is **typed, allowlisted, precondition-checked, logged, executed through one
controlled executor, and verified against its expected postcondition.**

## Lifecycle

```
proposal ──► validation ──► persistence ──► execution ──► observation ──► verification ──► persistence
  (router,     (schema,       (action_logs    (perform()    (observe())     (postcondition   (status +
  planner,     safety,        status =        only with                     vs new state)    event)
  user, test)  preconditions) proposed |      a minted
                              rejected)       token)
```

| Stage        | Where                                                        | Fails closed when                                                                                    |
| ------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Proposal     | `createAction()` in `src/domain/actions.ts`                  | Spec is not in the allowlist or args are out of bounds (throws).                                     |
| Validation   | `validateCandidate()` in `src/executor/action-executor.ts`   | Anything is wrong: schema, safety, preconditions. Invalid input is still logged.                     |
| Persistence  | `SqliteActionLog.recordProposal()`                           | – (one transaction: action row, PROPOSAL + VALIDATION events, violations).                           |
| Execution    | `MinecraftClient.perform(ValidatedAction)`                   | Client throws or reports failure → status `failed`.                                                  |
| Verification | `verifyPostcondition()` in `src/executor/action-verifier.ts` | Any check fails, a needed value is unknown, or there is no post-observation → `verification_failed`. |

### Action statuses (`action_logs.status`)

`proposed` → `executing` → `succeeded` | `failed` | `verification_failed`, or `rejected` straight from validation.

### Required fields

Every action has `actionId`, `type`, bounded `args`, `reason`, `origin`
(`deterministic-router` | `planner` | `user` | `test`), `timestamp`, `expectedPostcondition`, and
`taskId` (nullable). The postcondition is **derived in code** from the type and args
(`expectedPostconditionFor`). An action whose declared postcondition differs is rejected with
`INVALID_POSTCONDITION`, so a proposer cannot weaken it.

## Allowlist

| Action                    | Bounded args                                   | Preconditions (feasibility)                                      | Key safety checks                                                                                                                                                                 | Postcondition (verified)                                       |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `OBSERVE_STATE`           | none                                           | none                                                             | always permitted                                                                                                                                                                  | Fresh observation exists.                                      |
| `MOVE_TO`                 | target (world-border bounded), tolerance 0.5–5 | player position known                                            | target inside boundary; ≥ `hazardAvoidanceRadius` from known lava/void; target + avoidance radius inside the hazard scan; distance ≤ `maxMoveDistance`; not allowed during danger | Player within `tolerance` of target.                           |
| `WAIT`                    | 50–60,000 ms                                   | none                                                             | not allowed during danger                                                                                                                                                         | Observed time advanced ≥ duration.                             |
| `EAT_FOOD`                | item id                                        | item in inventory; not full                                      | approved food, not protected; allowed during low-vitals danger                                                                                                                    | Item count −1 and food level not lower.                        |
| `RETURN_TO_SAFE_LOCATION` | location name                                  | location resolvable; position known                              | location is a known `safe` location, inside boundary, same dimension, clear of hazards, ≤ `maxRetreatDistance`; allowed during danger (not when outside work area)                | Player within reach of the location.                           |
| `OPEN_CONTAINER`          | container id                                   | container known and within reach                                 | container is a known storage container                                                                                                                                            | `openContainerId` equals the container.                        |
| `DEPOSIT_ITEM`            | container, item, 1–2304                        | within reach; enough items                                       | item not protected; container is known storage (not a machine)                                                                                                                    | Player inventory −qty exactly; container +qty when observable. |
| `WITHDRAW_ITEM`           | container, item, 1–2304                        | within reach; container contents known and sufficient; free slot | item not protected                                                                                                                                                                | Player inventory +qty exactly; container −qty when observable. |
| `INSPECT_MACHINE`         | machine id                                     | machine known and within reach                                   | machine is known                                                                                                                                                                  | Machine `lastInspectedAt` ≥ action time.                       |
| `REFUEL_KNOWN_GENERATOR`  | generator, fuel, 1–64                          | generator known and within reach; enough fuel                    | fuel approved, not protected, and in that generator's `acceptedFuels`                                                                                                             | Fuel left inventory (−qty) and generator not `out_of_fuel`.    |
| `CRAFT_ITEM`              | recipe id, 1–64 times, table id or null        | enough ingredients; 3x3 needs a known table within reach         | no ingredient kind the recipe may use is protected; the table is known                                                                                                            | Result +count×times, ingredients −cells×times, nothing else.   |
| `PAUSE_AND_ASK_USER`      | question ≤ 500 chars                           | none                                                             | always permitted                                                                                                                                                                  | Client acknowledged. The loop marks the task `paused`.         |

**Not in the allowlist, by design:** lava interaction, dropping items, combat, placing or breaking
blocks, wrenching, cable/energy-network changes, multiblock changes, and rare-item consumption.

**On the live GTNH client**, `OPEN_CONTAINER`, `DEPOSIT_ITEM` and `WITHDRAW_ITEM` work on
configured vanilla chests when `MC_ENABLE_CONTAINERS=true` (otherwise `NOT_IMPLEMENTED`). A
withdrawal's "container contents known" precondition may use contents the agent saw within
`memory.containerContentsMaxAgeMs`. The client re-reads the live contents before any click. They are
refused (`REFUSED`, before any click) for an unconfigured chest, a block that is not a plain
`minecraft:chest`, no empty hotbar slot, or an amount that cannot be moved exactly. A rejected click
fails the action (`FAILED`) after the cursor has been emptied back into the window. See
[architecture: chests](architecture.md#chests). `MOVE_TO` and `RETURN_TO_SAFE_LOCATION` are walks. They need
`MC_ENABLE_MOVEMENT=true` and a fence; without them they return `NOT_IMPLEMENTED`. A walk is
refused (`REFUSED`, nothing sent) when the target is off the fence's level, outside the fence or
unreachable over walkable blocks. It stops (`FAILED`) on a server correction, a health drop, a
hostile or unidentified entity within `threatRadius` (`MOVE_TO` only), a blocked or dangerous way
ahead, the stop file, `halt()` or a lost connection. See [architecture: walking](architecture.md#walking).

`CRAFT_ITEM` works when `MC_ENABLE_CRAFTING=true` (otherwise `NOT_IMPLEMENTED`): 2x2 recipes in
the player's own grid, 3x3 recipes at a crafting table listed in `minecraft.crafting.tables`. The
recipe table (`src/domain/recipes.ts`) only says what to put where; the server decides:

- It is refused (`REFUSED`, before any click) for an unconfigured table, a block that is not a
  `minecraft:crafting_table`, no empty hotbar slot, or crafts that cannot all finish exactly (too
  few NBT-free ingredients, or no empty slot for a result).
- If the server's result is not exactly the expected item and count, nothing is taken: every
  ingredient goes back and the action fails (`FAILED`) with what the server showed.
- A rejected or unanswered click fails it (`FAILED`) after the grid and the cursor are emptied
  back into the inventory. If that cannot be done, it is `ERROR` and the message starts with
  "ITEMS MAY BE LEFT IN THE CRAFTING GRID OR ON THE CURSOR".
- `halt()` and the stop file stop it between crafts.

See [architecture: crafting](architecture.md#crafting). The other world-changing actions return
`NOT_IMPLEMENTED`.

## Global rules applied to every action

1. **Unsupported/malformed** (not a schema-valid allowlisted action) → `UNSUPPORTED_ACTION`, pause.
   Types matching the destructive-keyword denylist (`PLACE`, `BREAK`, `WRENCH`, `CABLE`, `MULTIBLOCK`,
   `LAVA`, `DROP`, `ATTACK`, `SHELL`, …) → `FORBIDDEN_MODIFICATION`, pause.
2. **Unreliable state** (critical field unknown, older than `maxStateAgeMs`, from the future, or
   internally inconsistent) → refused, pause. Only `PAUSE_AND_ASK_USER` and `OBSERVE_STATE` remain available.
3. **Danger gate.** Outside the boundary/dimension, nothing but pause/observe. Near lava, fire,
   harmful fluids, damaging blocks (cactus, spikes, ...) or void,
   hostile mobs or **unidentified entities** (fail closed: an entity type the agent cannot classify
   counts as hostile), only `RETURN_TO_SAFE_LOCATION`. With low health/hunger only, also `EAT_FOOD`.
4. **Coverage.** Observations declare how far they looked (`nearbyThreats.scanRadius`,
   `environmentHazards.scanRadius`). If the entity scan is smaller than `hostileThreatRadius`, or
   the hazard scan smaller than `hazardAvoidanceRadius`, the state is treated as unknown (pause).
5. **Protected items** can never be eaten, deposited, withdrawn, burned or crafted with (every
   kind a recipe may use counts). `ns:item` also protects every `ns:item@meta` variant. Config
   items are copied into the database and never silently removed.
6. **Repeated failures.** Once an identical action (type + canonical args) chosen by the agent
   has failed `maxFailuresPerActionPerTask` (default 2) times for the same task, the next attempt is
   refused with `REPEATED_FAILURE` (pause) and the task is blocked until a human resumes it
   (`node src/app/cli.ts task-resume --task <id>`). An action a human requested directly (origin
   `user`, e.g. `cli move`) is the human's decision each time: this rule does not apply to it, and
   its failures do not count against the agent's own attempts. Every other rule still applies.

## How unsupported actions fail closed

- The executor's input type is `unknown`. Validation parses it with the strict Zod union; unknown
  types, extra fields and out-of-range values fail.
- A rejected candidate is still persisted (`action_logs` with status `rejected`, plus a
  `safety_violations` row), and the client is never called.
- Any rejection sets the task to `blocked` and the cycle reports `needsUserAttention: true`.
- A client that does not implement an action returns `NOT_IMPLEMENTED`, which is an execution failure.
  The Mineflayer skeleton does this for every world-changing action.

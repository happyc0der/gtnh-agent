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

| Action                    | Bounded args                                                    | Preconditions (feasibility)                                      | Key safety checks                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Postcondition (verified)                                                                             |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `OBSERVE_STATE`           | none                                                            | none                                                             | always permitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fresh observation exists.                                                                            |
| `MOVE_TO`                 | target (world-border bounded), tolerance 0.5–5                  | player position known                                            | target inside boundary; ≥ `hazardAvoidanceRadius` from known lava/void; target + avoidance radius inside the hazard scan; distance ≤ `maxMoveDistance`; not allowed during danger                                                                                                                                                                                                                                                                                               | Player within `tolerance` of target.                                                                 |
| `EXPLORE`                 | toward: a compass direction or a point (x, z); maxDistance 8–96 | player position known; a point at least 2 blocks away            | a point inside the boundary (`OUT_OF_BOUNDS`); daylight only (`NOT_DAYTIME` in the evening or at night; an unknown time is `STATE_UNKNOWN`); not allowed during danger                                                                                                                                                                                                                                                                                                          | At least 1 block farther along the heading, at most maxDistance from the start (`EXPLORED`).         |
| `WAIT`                    | 50–60,000 ms                                                    | none                                                             | not allowed during danger                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Observed time advanced ≥ duration.                                                                   |
| `EAT_FOOD`                | item id                                                         | item in inventory; not full                                      | approved food, not protected; allowed during low-vitals danger                                                                                                                                                                                                                                                                                                                                                                                                                  | Item count −1 and food level not lower.                                                              |
| `RETURN_TO_SAFE_LOCATION` | location name                                                   | location resolvable; position known                              | location is a known `safe` location, inside boundary, same dimension, clear of hazards, ≤ `maxRetreatDistance`; allowed during danger (not when outside work area)                                                                                                                                                                                                                                                                                                              | Player within reach of the location.                                                                 |
| `OPEN_CONTAINER`          | container id                                                    | container known and within reach                                 | container is a known storage container                                                                                                                                                                                                                                                                                                                                                                                                                                          | `openContainerId` equals the container.                                                              |
| `DEPOSIT_ITEM`            | container, item, 1–2304                                         | within reach; enough items                                       | item not protected; container is known storage (not a machine)                                                                                                                                                                                                                                                                                                                                                                                                                  | Player inventory −qty exactly; container +qty when observable.                                       |
| `WITHDRAW_ITEM`           | container, item, 1–2304                                         | within reach; container contents known and sufficient; free slot | item not protected                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Player inventory +qty exactly; container −qty when observable.                                       |
| `INSPECT_MACHINE`         | machine id                                                      | machine known and within reach                                   | machine is known                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Machine `lastInspectedAt` ≥ action time.                                                             |
| `REFUEL_KNOWN_GENERATOR`  | generator, fuel, 1–64                                           | generator known and within reach; enough fuel                    | fuel approved, not protected, and in that generator's `acceptedFuels`                                                                                                                                                                                                                                                                                                                                                                                                           | Fuel left inventory (−qty) and generator not `out_of_fuel`.                                          |
| `DIG_BLOCK`               | block position (integers, y 0–255)                              | block within reach of the eyes; a free inventory slot            | an observed, allowlisted diggable block (`NOT_DIGGABLE`); whole block inside boundary; clear of known hazards; not under the player or a falling block over its head or one with sand/gravel on top (`UNSAFE_DIG`); not allowed during danger (but see the danger gate: a garden for the food task)                                                                                                                                                                             | The block is observed turning into air (`BLOCK_REMOVED`).                                            |
| `PLACE_BLOCK`             | cell position (integers, y 0–255), allowlisted item             | cell within reach of the eyes; the item in the inventory         | an observed placeable cell (`NOT_PLACEABLE`); whole cell inside boundary; clear of known hazards; item not protected; never a cell the player's body is in, never sand/gravel in the player's columns or where nothing holds it up (`UNSAFE_PLACE`); not allowed during danger                                                                                                                                                                                                  | The cell is observed turning into the block, and the item −1 exactly (`BLOCK_PLACED`).               |
| `CRAFT_ITEM`              | recipe id, 1–64 times, table id or null                         | enough ingredients; 3x3 needs a known table within reach         | no ingredient kind the recipe may use is protected; the table is known                                                                                                                                                                                                                                                                                                                                                                                                          | Result +count×times, ingredients −cells×times, nothing else.                                         |
| `INTERACT_BLOCK`          | block position                                                  | block within reach of the eyes                                   | an observed block with a profile that may be opened, or on the observe-only allowlist (`NOT_INTERACTABLE`); whole block inside boundary; not allowed during danger                                                                                                                                                                                                                                                                                                              | Its window was seen; profile matches; observe-only closed.                                           |
| `SMELT`                   | furnace position, input, 1–64, fuel, 0–64                       | furnace within reach; enough input and fuel (counted together)   | a listed furnace (`NOT_INTERACTABLE`); fuel approved (`NOT_APPROVED_FUEL`), never lava; input and fuel not protected; inside boundary; not allowed during danger                                                                                                                                                                                                                                                                                                                | Inventory −input −fuel exactly; furnace open with the input.                                         |
| `TAKE_OUTPUT`             | furnace position, item                                          | furnace within reach; an empty inventory slot                    | a listed furnace (`NOT_INTERACTABLE`); item not protected; inside boundary; not allowed during danger                                                                                                                                                                                                                                                                                                                                                                           | Inventory + the count taken, exactly; nothing else changed.                                          |
| `ATTACK_ENTITY`           | entity id (a Java int)                                          | position known; the entity listed and within 8 blocks            | listed (`TARGET_GONE`) and attackable (`NOT_ATTACKABLE`); inside boundary; a safe moment (`UNSAFE_ATTACK`); farm animals only for a task, never near hostiles; no protected weapon carried; in danger only when hostiles are the only danger                                                                                                                                                                                                                                    | Seen dying, health lower, or seen hurt (`ENTITY_ATTACKED`).                                          |
| `PAUSE_AND_ASK_USER`      | question ≤ 500 chars                                            | none                                                             | always permitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Client acknowledged. The loop marks the task `paused`.                                               |
| `SUBMIT_QUEST`            | quest id (two signed 64-bit halves)                             | listed in the quest book, not completed; inventory known         | a quest of the Age 0 closure the server has (`UNKNOWN_TARGET`), active and unlocked there (`QUEST_NOT_ACTIVE`); no protected item could be handed in to a consume task, and none at all for an ore-dictionary entry (`PROTECTED_ITEM`); not allowed during danger                                                                                                                                                                                                               | The server records it completed; only consume items left (`QUEST_COMPLETED`).                        |
| `CHECK_QUEST_BOX`         | quest id, task index 0–1023                                     | an unticked checkbox task of a quest not completed               | a listed quest (`UNKNOWN_TARGET`), active and unlocked on the server (`QUEST_NOT_ACTIVE`); not allowed during danger                                                                                                                                                                                                                                                                                                                                                            | The server records the task, or the quest, as complete (`QUEST_TASK_CHECKED`).                       |
| `CLAIM_QUEST_REWARD`      | quest id, choice index or null                                  | completed, unclaimed; a valid choice; room for every reward      | a listed quest (`UNKNOWN_TARGET`); not allowed during danger                                                                                                                                                                                                                                                                                                                                                                                                                    | Claimed on the server; exactly the reward items arrived (`QUEST_REWARD_CLAIMED`).                    |
| `DIG_DOWN`                | block position (integers): the block under the feet             | position known; a free inventory slot                            | the night pit only (`NIGHT_PIT_ONLY`): origin `deterministic-router`, the night-shelter task, exactly its blueprint's next known step, in the evening, at night or ≤ 4 min before night; exactly the block the player stands on, observed (`nearbyBlocks.underFeet`) as dirt, grass, sand, gravel or clay (`NOT_DIGGABLE`) over a landing that holds the player (`UNSAFE_DIG`); whole block inside boundary; clear of known hazards; not allowed during danger; never in a plan | The block is observed turning into air and the feet stand in its cell, one block lower (`DUG_DOWN`). |

**Not in the allowlist, by design:** lava interaction, dropping items, breaking any block that
is not on `DIG_BLOCK`'s allowlist, digging the ground under the player except `DIG_DOWN` for the
night pit, placing any block that is not on `PLACE_BLOCK`'s allowlist,
attacking anything `ATTACK_ENTITY` does not allow, wrenching, cable/energy-network changes,
multiblock changes, and rare-item consumption.

**`ATTACK_ENTITY`** engages one entity of the observation's `nearbyEntities` for a short burst
(`src/domain/combat.ts`, `src/safety/combat-checks.ts`):

- **Whom:** an identified hostile that fights in melee or at range (zombies, spiders, skeletons,
  witches, and their Special Mobs variants), or a cow, pig, sheep or chicken whose metadata says
  it is grown and has no name tag (or saddle). Never a player, villager, golem, wolf, horse, any
  other animal, anything unidentified, a creeper or anything else that explodes, an enderman,
  zombie pigman, silverfish or boss (`NOT_ATTACKABLE`, pause). Never a calm spider (a vanilla
  spider in the light: `nearbyEntities[].calm`), since a blow would make it fight
  (`NOT_ATTACKABLE`, block: it may be fought once it is not calm). An entity no longer listed
  is a stale step (`TARGET_GONE`): a planner's plan is re-made, not halted.
- **When** (`UNSAFE_ATTACK`, block; the same rules System 1 uses for DEFEND): health at least
  `safety.combat.minHealthToFight` (14) and food at least `minHungerToFight` (8, the server's
  HungerOverhaul heals no lower); at most `maxHostilesToFight` (2) hostiles within the threat
  radius; nothing that explodes, or might (an unidentified entity), within `creeperFleeRadius`
  (16); no unidentified entity within the threat radius. Farm animals only for a task (or a
  person's own request), and never while hostiles are near. Every allowlisted weapon the player
  carries must be unprotected (the client picks one from the hotbar, and striking wears it).
- **During danger** it is the one action besides retreating: allowed only when hostiles are the
  only danger (not near lava, not with an unidentified entity, not with low health or food).

**DEFEND** (a System 1 decision, `src/system1/defend.ts`) turns into `ATTACK_ENTITY` on the
nearest hostile the agent may fight, only with `MC_ENABLE_COMBAT=true`, when hostiles are the
only danger, the moment is safe (above), and retreating is impossible or worse: with a home to
retreat to, only when that hostile is within striking distance and dies in at most 3 full hits
(its health is known); with no home (or already home), when it is within striking distance or a
melee mob is coming within 8 blocks. A creeper or a crowd is fled (`CREEPER_NEARBY`,
`TOO_MANY_HOSTILES` join the retreat's reasons); a skeleton at range is not chased (pause).
DEFEND carries `HOSTILES_NEARBY`, so a model's decision never overrules it.

**`DIG_BLOCK`** breaks one of `minecraft:log`, `log2`, `leaves`, `leaves2`, `dirt`, `grass`,
`sand`, `gravel` or `clay`, Biomes O' Plenty's leaves or HarvestCraft's land gardens; or, only
with a carried pickaxe that harvests it, one of `minecraft:stone`, `cobblestone`,
`mossy_cobblestone`, `sandstone`, `netherrack`, `hardened_clay`, `stained_hardened_clay`,
`emerald_ore`, `gregtech:gt.blockgranites`, `gt.blockstones` or `gt.blockores`
(`src/domain/blocks.ts`); nothing else. The block must be listed in the observation's
`nearbyBlocks.resources`. Only allowlisted blocks at or above the player's feet level are
listed there, so the ground it stands on is never a target. Its drop is reported
(`dropCollected`), not required: leaves usually drop nothing, and a drop that lands out of
pickup range stays where it fell.

The client chooses what to hold; the action names only the block. It holds the fastest
allowlisted tool the player carries for that block (`src/domain/tools.ts`): the wooden shovel
for dirt, grass, sand, gravel and clay, a vanilla axe for logs, a pickaxe for stone and ores,
or a Tinkers' Construct pickaxe, shovel, hatchet or mattock (read from its NBT data, from the
hotbar only). Otherwise it digs with an empty hand, except stone and ores: it digs those only
with a tool that harvests that very block (its kind, and its level, a GT ore's from its
metadata), and refuses otherwise (`REFUSED`, nothing sent). It never holds a protected tool, a
vanilla tool with NBT data, or one that one more use would break. The result reports `tool`
(null for an empty hand), `toolUsesLeft` and, when tools were passed over, `toolNote`. A tool
wears by one per block, which renames a vanilla one in the inventory
(`minecraft:wooden_shovel@1`); a Tinkers' tool's wear is in its NBT data.

**`PLACE_BLOCK`** places one of `minecraft:dirt`, `cobblestone`, `sand`, `gravel`, `sandstone`,
`planks` (any of the six wood types, `@1`-`@5`) or `log`/`log2` (any wood type) that the player
carries (`src/domain/blocks.ts`); nothing else, nothing modded. The cell must be listed in the
observation's `nearbyBlocks.placeable`: empty (air, tall grass or a dead bush), within reach,
clear of the player's body and of every entity, next to a plain full block to place it against.
Sand and gravel go only where `takesFalling` says they stay put: on a plain full block, never
in a column the player stands in. It is refused during danger like every world action: placing
a block is not treated as an escape (a single block is no shelter, sealing one with a mob in
reach can wall the agent in with it, and a creeper's blast opens it), so shelters are built
while the state is safe.

**`DIG_DOWN`** (approved 2026-10-01, for the night pit only) digs the block the player stands on
and drops the player exactly one block, onto the block under it. It is not a mining ability:

- **Only code proposes it, only for the night pit.** Plans never contain it (`validatePlan`
  refuses it, and planners are not offered it). The safety policy allows it only with origin
  `deterministic-router`, while the current task is the night-shelter task, as exactly that
  task's next known step (`knownRecipeState.nextKnownSafeStep`, from the code-made blueprint
  in agent memory), and in the evening, at night or in the last 4 real minutes before night
  (`NIGHT_PIT_ONLY`, pause; an unknown time is `STATE_UNKNOWN`). A human's command (origin
  `user`) is refused too.
- **The observation must show the ground** under the player (`nearbyBlocks.underFeet`, reported
  only while its body stands in one column on a block top): the block is dirt, grass, sand,
  gravel or clay (`NOT_DIGGABLE` otherwise), and its landing holds the player (a plain full
  block; under sand or gravel another one), else `UNSAFE_DIG`.
- **The client checks the blocks** (`checkDigDown`, before the dig and every tick): a fence with
  a height range (never the pen), the landing level inside it; exactly the block under the feet,
  the body (with the server's 0.0625 margin) in that one column; the landing a plain full block
  (no cave, fluid or plant under it), sand or gravel only on another; only air and plain blocks
  touching the dug block, and no sand or gravel beside it with nothing under it; every cell of
  the 3 x 3 columns from the landing's level to the head's air, plants the walker passes (by
  their metadata) or plain blocks (no water), loaded and named, with no hazard there or one
  level lower. It needs
  `MC_ENABLE_DIGGING=true` (else `NOT_IMPLEMENTED`) and walking enabled, since the fall is a
  move (else `REFUSED`).
- **The dig and the fall.** The dig is `DIG_BLOCK`'s (tool or empty hand, the dig time, every
  tick re-checked, success only on the server's change to air). Then the client falls with
  vanilla gravity (5 position packets for one block, on the ground only at the last) after
  `checkSupport` shows nothing holds the player and the floor is exactly one block down, and
  waits 5 ticks for a server correction. The result reports the new feet (`feetX/Y/Z`) and the
  drop (it lands in the hole with the player).

**On the live GTNH client**, `OPEN_CONTAINER`, `DEPOSIT_ITEM` and `WITHDRAW_ITEM` work on
configured vanilla chests when `MC_ENABLE_CONTAINERS=true` (otherwise `NOT_IMPLEMENTED`). A
withdrawal's "container contents known" precondition may use contents the agent saw within
`memory.containerContentsMaxAgeMs`. The client re-reads the live contents before any click. They are
refused (`REFUSED`, before any click) for an unconfigured chest, a block that is not a plain
`minecraft:chest`, no empty hotbar slot, or an amount that cannot be moved exactly. A rejected click
fails the action (`FAILED`) after the cursor has been emptied back into the window. See
[architecture: chests](architecture.md#chests). `MOVE_TO` and `RETURN_TO_SAFE_LOCATION` are walks. They need
`MC_ENABLE_MOVEMENT=true` and a fence (in `MC_MOVEMENT_MODE=follow`, the play area around the
player); without them they return `NOT_IMPLEMENTED`. A walk is
refused (`REFUSED`, nothing sent) when the target is off the fence's level, outside the fence or
unreachable over walkable blocks. It stops (`FAILED`) on a server correction, a health drop, a
hostile (not a calm spider) or unidentified entity within `threatRadius` (`MOVE_TO` only), a blocked or dangerous way
ahead, the stop file, `halt()` or a lost connection. See [architecture: walking](architecture.md#walking).
In `MC_MOVEMENT_MODE=follow`, a `RETURN_TO_SAFE_LOCATION` beyond the play area travels in hops
first, like `EXPLORE` but not stopped by threats and at any time of day (it is the escape).

**A `MOVE_TO` may break leaves in its way** (2026-10-01): over terrain, with
`MC_ENABLE_DIGGING=true` too, the walk may break up to 4 `minecraft:leaves` or `leaves2` blocks
that stand in its body's way, on straight moves only, the upper block first, when a way round
is more than about 3 blocks longer per leaf (each break costs its dig time). Each break is a
`DIG_BLOCK` dig in all but name: `checkWalkBreak` (leaves only, every rule of `checkDig`, inside
the safety boundary) on the server's blocks just before the dig and every tick, an empty hand,
the dig time, C07 start and finish, success only on the server's change to air. A break refused
or not confirmed stops the walk (`FAILED`, with the reason; the agent re-plans). The result says
what it broke (`broken`, and `drops`: what the leaves dropped, picked up before the walk
reports); the postcondition is unchanged (the player near the target). The observation's stand
spots (`standAt`) count such walks, so a log walled in by leaves gets one. Retreats, `EXPLORE`
and the walk to a dig's drop never break.

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

`EXPLORE` needs `MC_ENABLE_MOVEMENT=true` (otherwise `NOT_IMPLEMENTED`) and the play area that
follows the player, `MC_MOVEMENT_MODE=follow`, inside the exploration boundary (the safety
boundary).

- **Refused** (`REFUSED`, nothing sent): with a fixed fence; in the evening, at night or with the
  time unknown; on the stop file or `halt()`; while another walk runs; when no first hop gets
  closer to the goal.
- **Succeeds** (`OK`) after at least one hop, at least a block closer, when it reaches the goal
  (a direction's goal is maxDistance away, pulled in to the boundary), has walked maxDistance,
  finds no hop that gets closer (water, a cliff, a wall), is stuck (two hops gaining less than a
  block), gets dark, or reaches 12 hops or 3 minutes. The message and `data` say how far it got
  (`walked`, `hops`, `progress`, `stoppedBecause`) and what it saw (`chunksSeen`, biomes, counts).
- **Fails** (`FAILED`, with the same data) on anything that stops a walk: a hostile or
  unidentified entity within `threatRadius`, a server correction, a health drop, the stop file,
  `halt()` or a lost connection; or with less than a block of progress.

See [architecture: exploring and world memory](architecture.md#exploring-and-world-memory).

`INTERACT_BLOCK`, `SMELT` and `TAKE_OUTPUT` need `MC_ENABLE_INTERACT=true` (otherwise
`NOT_IMPLEMENTED`). They use only blocks with an interaction profile, or blocks on the operator's
observe-only list (`MC_INTERACT_OBSERVE_ONLY`), which are only looked at
([architecture: interacting with blocks](architecture.md#interacting-with-blocks)):

- **Refused** (`REFUSED`, nothing clicked) when the block is not loaded, has no profile and is not
  on the observe-only list, or is never opened (a trapped chest, a lever or door, drawers,
  barrels, ender chests...). Also when it is out of 4.5 blocks' reach from the eyes, outside the
  fence's columns or heights, with no empty hotbar slot, while a walk, dig, chest or crafting
  operation runs, or after `halt()` or with the stop file.
  - `SMELT`, also: not a furnace, lava, a fuel with no known burn time, more items than the
    inventory has or a slot can take (stacks with NBT data never count), or a slot that already
    holds another item.
  - `TAKE_OUTPUT`, also: not a furnace, an empty output, another item or NBT data there, or no
    empty inventory slot.
- **Opening** is an empty-hand right-click. The window must be exactly one the profile knows;
  otherwise it is closed and the action fails (`FAILED`). An observe-only window is recorded
  (`cli layouts`) and closed at once; nothing in it is ever clicked.
- **`SMELT`** puts the fuel in first, then the input, with predictable clicks only, and plans both
  before the first click. A furnace may light and use an item between two clicks: the server then
  rejects the click and re-sends the window, and the client finishes from the player's own counts,
  so exactly the asked amounts leave the inventory.
- **`TAKE_OUTPUT`** takes the whole output stack into an empty inventory slot and reports how many
  arrived.
- The window stays open so the executor can verify it, and the furnace's contents show in the
  observation. The next dig, chest, crafting or window action closes it first (never with a full
  cursor). A furnace keeps its items.

Blocks the observation found also work with the older actions: `CRAFT_ITEM` with
`crafting_table:<x>.<y>.<z>` (a vanilla crafting table inside the fence, with
`MC_ENABLE_CRAFTING=true`), and `OPEN_CONTAINER`, `DEPOSIT_ITEM` and `WITHDRAW_ITEM` with
`<profile>:<x>.<y>.<z>` (a chest, an Iron Chests chest or a hungry chest, with
`MC_ENABLE_CONTAINERS=true` and `MC_ENABLE_INTERACT=true`). Nothing is ever put into an Iron Chests
dirt chest.

`DIG_BLOCK` needs `MC_ENABLE_DIGGING=true` and the movement fence (otherwise `NOT_IMPLEMENTED`).
The same dig breaks the leaves a `MOVE_TO` breaks on its way (above), with the same checks.

- **Refused** (`REFUSED`, nothing sent) when the block:
  - is outside the fence's columns, or outside its level up to `maxHeightAboveFence`;
  - is not loaded, is not allowlisted, or is out of 4.5 blocks' reach;
  - is under the player, or is sand or gravel over its head;
  - touches anything but air, allowlisted blocks and plain full blocks (water, a torch, a
    chest...);
  - has sand or gravel on top, or has a hazard within one block.
    It is also refused while a walk or chest operation runs, or when there is no usable tool in
    the hotbar and no empty hotbar slot (to move a tool into, or to dig with an empty hand).
- **Fails** (`FAILED`, after C07 cancel if it had started) on:
  - a tool that could not be moved into the hotbar (a click not accepted; the cursor is put
    back first; `ERROR` if that fails too);
  - any server update for the block while digging (a refusal), or the block becoming unsafe;
  - the tool in hand changing while digging;
  - the stop file, `halt()`, a server correction, a health drop or a nearby threat;
  - a re-send after the finish (judged too early, or the break was cancelled), or no block
    change at all.

`PLACE_BLOCK` needs `MC_ENABLE_PLACING=true` and the movement fence (otherwise
`NOT_IMPLEMENTED`).

- **Refused** (`REFUSED`, no C08 sent) when the cell:
  - is outside the fence's columns, or outside its level up to `maxHeightAboveFence`;
  - is not loaded, out of 4.5 blocks' reach, or holds anything but air, tall grass or a dead
    bush (water, lava, a flower, a block);
  - is in the player's body, or may hold an entity (each counted as 2 wide and 3 tall);
  - touches anything but air, plants and plain full blocks (a chest, a machine, water, a
    torch...), or has a hazard within one block;
  - has no plain full block beside it whose face looks at the player within the server's
    reach (nothing to click);
  - would let sand or gravel fall, or is over the player's head for them.
    It is also refused with no stack of the item it can hold (none in the hotbar and no empty
    hotbar slot to move one into), or while a walk, chest operation or dig runs.
- **Fails** (`FAILED`, after the click) when the server's answer for the cell is not the placed
  block (an entity it knew of, out of its reach, a protected spot, a mod cancelling it, or the
  block falling), or a window opens instead (it is closed again). A placed block whose stack
  did not shrink is reported (`stackUsed: false`) and fails verification.

`ATTACK_ENTITY` needs `MC_ENABLE_COMBAT=true` (otherwise `NOT_IMPLEMENTED`), the movement
fence and presence ticks. The player never moves.

- **Refused** (`REFUSED`, nothing sent) when the target is not tracked, may never be attacked,
  is outside the fence or more than 8 blocks away; when the player is outside the fence; when
  something that may explode is within 16 blocks or an unidentified entity within the threat
  radius; with no allowlisted weapon and no empty hotbar slot; or while a walk, chest, crafting
  or dig operation runs, or another fight.
- **The burst:** it holds the best allowlisted weapon in the hotbar (vanilla axes; never a
  sword, which deals nothing on GTNH, never a stack with NBT data), else an empty hand. It
  strikes whenever the target is within reach (a bare hand 2.2 blocks; a weapon 2.9, or 4.5
  when no block can be in the way), one full hit per 12 ticks, for at most 8 swings or 5 s. A
  blow that may kill is held back while GTNH's kill explosion (power 1.5) would leave the player
  under 4 health.
- **Stops** on the target dying or leaving (gone, out of the fence, beyond 8 blocks), ANY damage
  taken (so System 1 decides again), something that may explode or an unidentified entity
  appearing, and (`FAILED`) the stop file, `halt()`, a server correction or a lost connection.
- **Reports** swings, hits seen, kills, the target's health before and after, the damage the
  player took and the blows held back. With no hit landed it fails (`FAILED`).

**The quest-book clicks** (`SUBMIT_QUEST`, `CHECK_QUEST_BOX`, `CLAIM_QUEST_REWARD`) are the
GUI's own clicks in Better Questing's quest book (see
[gtnh-compatibility: quest book](gtnh-compatibility.md#quest-book-better-questing-2026-09-30)).
They need `MC_ENABLE_QUEST_BOOK=true` (otherwise `NOT_IMPLEMENTED`) and presence ticks, and
are refused while a walk, chest operation, dig or placement runs, or under `halt()` or the stop
file. Only the play loop chooses them, deterministically from the server's records (origin
`deterministic-router`); the planner is not offered them and `validatePlan` refuses any plan
step that is one. The client checks the server's quest book again just before it sends
anything, and judges the click by the server's next sync:

- **Refused** (`REFUSED`) when the quest is not one the agent tracks or the server has not
  synced it, or (submit, checkbox) the server does not list it as active and unlocked, or
  (claim) it is not completed or already claimed, the choice does not fit its rewards, or the
  inventory has no room for them.
- **Fails** (`FAILED`) when the server does not record the result in time: the quest completed
  (8 s after a submit: its quest loop runs every 3 s of the player's ticks), the box ticked or
  the rewards claimed (5 s), the choice acknowledged (3 s).

The other world-changing actions return `NOT_IMPLEMENTED`. See
[architecture: walking](architecture.md#walking), [digging](architecture.md#digging) and
[combat](architecture.md#combat).

## Plan steps that are not actions: GATHER

A plan may contain one kind of step that is not an action:
`{"type":"GATHER","args":{"block":"minecraft:sand","count":54}}`. It is not in the allowlist,
is never sent to a client and is never logged as an action. While it is the plan's current
step, code turns it, one cycle at a time, into ordinary `DIG_BLOCK` and `MOVE_TO` actions with
origin `planner`, and everything above applies to each of them unchanged: schema, safety
policy, preconditions, execution, verification, the log and the repeated-failure rule.
See [architecture: GATHER](architecture.md#gather-gathering-in-one-plan-step).

- **Args:** `block`, one of `DIG_BLOCK`'s allowlisted blocks; `count`, 1 to 256 of what that
  block drops (sand gives sand, grass gives dirt, clay gives 4 clay balls, gravel gives gravel
  or flint, logs give logs, stone gives cobblestone, a GT ore its raw ore); optionally `item`,
  the one drop that counts (only blocks that can drop it are dug). A GT ore's material is in
  its tile entity, so `{"block":"gregtech:gt.blockores","item":"<raw ore>","count":16}` digs
  the GT ores in view until 16 of that raw ore are held. An `item` the block never drops ends
  the step at once.
- **Plan validation:** the schema only. GATHER names no position to check; every action it
  becomes is checked when it runs (stone and ores: a carried pickaxe that harvests them).
- **Each cycle:** the nearest listed block of that kind with a stand spot. Within reach (4.5
  from the eyes) it is dug; otherwise the agent walks to its stand spot (tolerance 0.5). Code
  proposes only an action the executor's validation would accept now (a dry run; for a walk,
  also of the dig from the stand spot), so a block the policy would refuse is passed over
  rather than refused.
- **Ends:** when the inventory holds `count` more of the drops than at the start (the step is
  verified); when no such block is left in view (a stale step: the plan fails, and the next
  cycle asks the planner); when one of its actions does not succeed (the plan's own failure
  handling; that block is not tried again); or at 64 actions or 5 minutes (a checkpoint: the
  plan ends, and the next cycle asks the planner).
- **Accepting a plan** drops every step after its first `EXPLORE`, and after a `GATHER` the
  first step that names a position or a creature together with the steps after it (they were
  planned from a view the plan itself replaces); see
  [architecture: accepting a plan](architecture.md#accepting-a-plan).

## Code-made blueprints: known safe steps

The night shelter (the pit's digs down and its roof, or the raised box's blocks) and the way
out of it in the morning are planned by code, not by the planner, and run as **known safe
steps** (`src/app/loop/known-steps.ts`). The blueprint is a list of ordinary action specs kept in
agent memory (`task_steps:<taskId>`) with how many are done.

- Its next step becomes the state's `knownRecipeState.nextKnownSafeStep`, so System 1's rule 6
  decides `EXECUTE_KNOWN_SAFE_STEP` and the step runs with origin `deterministic-router`. If a
  model decides `REQUEST_PLANNER` instead, the next step runs anyway: the planner is not asked
  while a blueprint has steps left. System 1's safety rules (dangers, vitals) still come first.
- Each step is validated, executed and verified like any action; the repeated-failure rule
  applies.
- A verified step advances the blueprint; the last one completes its task. A step that does not
  succeed stays next, the cycle fails and the play loop plans again from what it then sees. A
  step refused only as stale (`NOT_PLACEABLE`, `NOT_DIGGABLE`, preconditions) does not block the
  task; any other refusal does, as usual.

## Global rules applied to every action

1. **Unsupported/malformed** (not a schema-valid allowlisted action) → `UNSUPPORTED_ACTION`, pause.
   Types matching the destructive-keyword denylist (`PLACE`, `BREAK`, `DIG`, `MINE`, `WRENCH`,
   `CABLE`, `MULTIBLOCK`, `LAVA`, `DROP`, `ATTACK`, `KILL`, `FIGHT`, `HUNT`, `SHELL`, …) →
   `FORBIDDEN_MODIFICATION`, pause. The operator allows exactly four exceptions, `DIG_BLOCK`,
   `PLACE_BLOCK` and `ATTACK_ENTITY` (2026-09-30) and `DIG_DOWN` (2026-10-01, the night pit
   only), matched character for character: `BREAK_BLOCK`, `MINE_ORE`, `DIG_AREA`, `dig_block`,
   `dig_down`, `DIG_DOWN_MANY`, `PLACE_BLOCKS`, `PLACE_TNT`, `place_block`, `ATTACK_PLAYER`,
   `KILL_ENTITY` or `attack_entity` stay forbidden.
2. **Unreliable state** (critical field unknown, older than `maxStateAgeMs`, from the future, or
   internally inconsistent) → refused, pause. Only `PAUSE_AND_ASK_USER` and `OBSERVE_STATE` remain available.
3. **Danger gate.** Outside the boundary/dimension, nothing but pause/observe. Near lava, fire,
   harmful fluids or void (within `hazardAvoidanceRadius`), right next to a block that hurts on
   contact (cactus, spikes, ...: within 1.5 blocks; walks never stand next to one),
   hostile mobs or **unidentified entities** (fail closed: an entity type the agent cannot classify
   counts as hostile), only `RETURN_TO_SAFE_LOCATION`. With low health/hunger only, also `EAT_FOOD`.
   `PLACE_BLOCK` and `DIG_DOWN` are deliberately not escapes (the night shelter is made before
   dark, while the state is safe). With hostiles as the only danger, also `ATTACK_ENTITY` (on a
   hostile). With low hunger as the only danger, also the actions that get food, for the play
   loop's food task (`get-food`) by day only: `MOVE_TO`, `EXPLORE`, and `DIG_BLOCK` of a listed
   HarvestCraft garden (`getsFood`; a pause would only starve, nothing heals offline).
4. **Coverage.** Observations declare how far they looked (`nearbyThreats.scanRadius`,
   `environmentHazards.scanRadius`). If the entity scan is smaller than `hostileThreatRadius`, or
   the hazard scan smaller than `hazardAvoidanceRadius`, the state is treated as unknown (pause).
5. **Protected items** can never be eaten, deposited, withdrawn, burned, smelted, taken from a
   furnace, crafted with (every kind a recipe may use counts), placed, handed in to a quest (a
   submit is refused while any protected item could match a consume task) or worn out as a
   weapon (no fight while a protected allowlisted weapon is carried). `ns:item` also protects
   every `ns:item@meta` variant. Config items are copied into the database and never silently
   removed.
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

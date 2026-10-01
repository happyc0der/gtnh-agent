# GTNH compatibility

**Status (2026-09-30): observation of every safety-critical field, and walking inside a fence,
work on a private GTNH 2.8.4 test server.** The agent's own client (`src/bot/gtnh1710/`,
`Gtnh1710Client`) joins via the Forge handshake and reports position, dimension, health, food, a
fully named inventory, nearby entities (vanilla and modded) and lava/void/damaging blocks. A live
agent cycle has no state violations; it pauses only because it has no task. With movement enabled
it walks on one level inside a fence (see "Walking"). GregTech machines are observed through
GregTech's own channel: type, position, enabled and running (see "Machines"); stored energy and
held-item durability are not observable (except for the agent's allowlisted tools, see "Tools").
Digging one allowlisted block (see "Digging"), with an empty hand or a verified tool (see
"Tools"), placing one (see "Placing") and fighting one mob (see "Combat") are built on the
server's own code, checked in its jars, and tested against the fake server. Digging sand has
run live (2026-09-30, the play runs); placing and fighting have not yet. The quest book is read
from Better Questing's own channel, and its submit, checkbox and claim clicks are typed actions
(see "Quest book"); built from the mod's bytecode and the world's quest database, tested
against the fake server, not run live yet. Mineflayer cannot connect at all. Every claim below
is labelled as _verified_ (observed or checked in installed code) or _assumption_ (to be
tested).

## Test server results (2026-09-30)

Setup: official `GT_New_Horizons_2.8.4_Server_Java_17-25.zip` on Temurin 21, fresh RWG world,
`server-ip=127.0.0.1`, port 25570, `online-mode=false`, whitelist on (`gtnh_agent`, owner). Server
folder: `~/Projects/gtnh-test-server` (outside this repo). Commands: `pnpm spike:connect`
(the mineflayer/minecraft-protocol comparison) and `pnpm cli observe --live` (the agent's client);
raw spike results are written to `data/spike/` (gitignored).

| Test                                                  | Result (verified)                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server identity (1.7 status ping)                     | FML server, **287 mods**: Forge 10.13.4.1614, `gregtech`, `dreamcraft` 2.7.268, `lwjgl3ify` 2.1.16, **`neid` 2.1.10** (NotEnoughIDs changes block/chunk packet formats).                                                                                                                                                     |
| Right after "Done"                                    | For ~30 s the server answers every connection with _"Server is still starting! Please wait before reconnecting."_ Adapters must retry.                                                                                                                                                                                       |
| `minecraft-protocol` `ping()` with version 1.7.10     | Uses the legacy pre-1.7 ping, so no mod list; replaced by `src/bot/gtnh1710/status-ping.ts`.                                                                                                                                                                                                                                 |
| Plain client (minecraft-protocol, no Forge handshake) | Login succeeds, server sends `REGISTER` + `FML\|HS` ServerHello, then only keep-alives. **Never receives Join Game**; no kick message.                                                                                                                                                                                       |
| **Mineflayer 4.39** via `MineflayerClient`            | **Refused by mineflayer itself:** `Server version '1.7.10' is not supported. Oldest supported version is '1.8.8'.` (hard check in `mineflayer/lib/loader.js`).                                                                                                                                                               |
| **Raw 1.7.10 client + FML handshake** (first spike)   | **Joined.** Handshake done in ~110 ms by echoing the server's mod list; Join Game (survival, hard, dimension 0, `RWG`); spawned at (-4.5, 106.0, -7.5); server logged `gtnh_agent … logged in` / `left the game` with no warnings. Stayed 10 s, sent nothing but keep-alive and handshake replies.                           |
| Registry                                              | The handshake's `ModIdData` (485,837 bytes, larger than a vanilla plugin message, sent with Forge's extended length) maps **10,987 items and 4,038 blocks**, e.g. `gregtech:gt.metaitem.01` = 7495, `dreamcraft:item.EngravedQuantumChip` = 5717. IDs are assigned **per world**: read them at every login, never hard-code. |
| Health/food                                           | **No health packet in 10 s.** Likely because 1.7.10 only ticks a player when the client sends movement packets (to verify). The bot must send position packets, which means doing its own gravity/collision physics (1.7.10 movement is client-side).                                                                        |
| Plugin traffic                                        | ~2,300 plugin messages in 10 s, 2,070 of them on the `GregTech` channel. Possible source of machine state; needs research.                                                                                                                                                                                                   |

**Implications for the adapter:**

1. **Mineflayer is out for GTNH.** Its version gate, vanilla-only parsers, lack of Forge's extended
   plugin-message length and NotEnoughIDs changes all break on this server. `MineflayerClient`
   stays a disabled skeleton.
2. **A small custom 1.7.10 protocol client is feasible**, and is now implemented read-only (below).
3. **Machine/power state** may need a server-side helper mod; GregTech's own plugin traffic is a
   possible alternative (research).
4. **Movement is the hard part**: client-authoritative physics with modded collision boxes.

## Read-only live client (`Gtnh1710Client`, 2026-09-30)

Live `pnpm cli observe --live` on the test server (verified):

| Field          | Result                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Position       | (-4.5, 106, -7.5), identical to the server log's login position.                                                    |
| Dimension      | `overworld` (1.7.10 numeric IDs are mapped; unknown IDs become `dim_<id>`).                                         |
| Health / food  | 20 / 20, but only once the client acknowledges the server's placement (see presence below).                         |
| Inventory      | `1 x questbook:ItemQuestBook`: the starter quest book GTNH gives new players, named through the per-world registry. |
| Held item      | Empty hand, or one of the agent's allowlisted tools with its durability (see "Tools"); any other item is unknown.   |
| Threats        | Tracked (see "Entity tracking" below); lava/void still unknown.                                                     |
| Machines/power | GregTech machines: type, enabled, running (see "Machines"). Power (EU) unknown.                                     |

Findings while building it (verified):

- **GTNH item stacks are not vanilla.** ModularUI (`modularui` 1.2.20) patches `PacketBuffer` so every
  non-empty item stack is followed by its full stack size as a VarInt (vanilla sends a byte, capped at
  127). Confirmed by disassembling its `PacketBufferMixin` (injected after `writeNBTTagCompoundToBuffer`)
  and by live bytes (`18 60 01 00 00 ff ff 01` for one quest book). The client enables this decoding
  only when the server's mod list contains `modularui`.
- **Registry names are not all `[A-Za-z0-9_.-]`:** 274 of 15,025 contain `|` (`BuildCraft|Core:...`),
  spaces (`Natura:N Crops`) or apostrophes. `ItemNameSchema` accepts exactly these; all 15,025 pass.
- **Presence:** in 1.7.10 the server only updates a player (health/food packets, hunger, damage) when
  the client sends player packets. With `presenceTicks` (default on) the client echoes the server's
  own position packet once (the server logs no "moved wrongly") and then sends idle ticks. It never
  sends any other position. While connected the bot is an ordinary player: it can be hurt and gets hungry.
- **Undecodable packets degrade instead of disconnecting:** a bad inventory packet marks the inventory
  (and held item/armor) unknown until the next full inventory refresh; the connection stays up.
- **Clean disconnect:** the client closes with a TCP FIN, so the server logs `Disconnected`, not
  `Connection reset`.

What the client can send is fixed in `packets.ts` (`outbound`): handshake, status request, login
start, keep-alive, plugin messages on `REGISTER`/`FML|HS` only, idle ticks, echoes of
server-assigned positions, walking steps, the window packets chests and crafting need
(empty-hand block activation, hotbar selection, normal clicks, confirmations, and closing a
window other than window 0), digging start/cancel/finish, a block placement with the held
block, and the cosmetic head look and arm swing. `perform()` supports `OBSERVE_STATE`, `WAIT`
and `PAUSE_AND_ASK_USER`, plus walks, chests, crafting, digs and placements when each is
enabled; every other action returns `NOT_IMPLEMENTED` without sending anything (tested).

## Walking (2026-09-30)

The first world-changing ability, tested in a glass pen at y=200 in the throwaway world (9 x 9
interior; see README "Walking in the test pen").

How 1.7.10 movement works, and what the walker does about it:

- **The client reports positions; the server checks them.** All of these checks are in this
  server's player network handler (`nh.class` in `minecraft_server.1.7.10.jar`; its messages were
  found in the jar, _verified_). The thresholds are vanilla 1.7.10's (_assumption_: a GTNH mod could
  patch them at run time).
  - It resets ("moved too quickly") any packet more than 10 blocks from the last position.
  - It moves its own copy of the player with block collisions. If the result differs from the
    reported position by more than 0.25 blocks horizontally, it resets the player ("moved
    wrongly") with an S08 placement.
  - It kicks for a stance (head minus feet) outside 0.1–1.65 and, with `allow-flight=false`, for
    floating more than 80 ticks.
  - The walker sends one C06 (position + look) per tick. Each step is at most 0.2 blocks, the
    stance is exactly 1.62 and the player is always on the ground. Any S08 during a walk stops it.
- **After an S08, the server ignores movement until the client echoes the exact position.** The
  client echoes every placement at once.
- **`/tp` in 1.7.10 adds 0.5 to any coordinate written without a decimal point**, so
  `tp player -4.5 200 -7.5` put the feet at y=200.5, floating (_verified_). The operator tool
  always sends decimals. The walker refuses to start unless the feet are exactly on a block top.
- **RCON:** vanilla 1.7.10 runs RCON commands on the RCON thread. GTNH's Hodgepodge moves them to the
  main thread (`fixRconThreading=true`; the server log shows `[Server thread/INFO]: [Rcon: ...]`).
  RCON binds to `server-ip`, here 127.0.0.1 (_verified_ with `Get-NetTCPConnection`).

Live results (_verified_, 2026-09-30):

| Test                                                    | Result                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Diagonal walk, centre to corner (5.66 blocks, 29 steps) | Succeeded and verified 0.00 blocks from the target; the next login was at the walk's end, per the server log. |
| Around an inner wall through its only gap               | Planned around it; 10.12 blocks in 51 steps, verified.                                                        |
| RCON teleport during a walk (a server correction)       | Stopped at once ("the server corrected the position"); the echo was accepted.                                 |
| `cli halt` from another process during a walk           | Stopped after 49 of 72 steps; new walks refused until `unhalt`.                                               |
| Target outside the pen                                  | Rejected by the safety policy (`OUT_OF_BOUNDS`); nothing sent.                                                |
| Target one level up                                     | Refused by the walker ("walking stays on level y=200").                                                       |
| Lava in a sealed glass box in the pen                   | Seen by the hazard scan; the walker routed around every block touching it; home refused (`HAZARD_PROXIMITY`). |

No test produced a server warning (moved wrongly, moved too quickly, floating, illegal stance).

## Chests (2026-09-30)

Vanilla chests, tested with the chest in the pen (-5, 200, -5). Protocol facts (_verified_ from
1.7.10's `NetHandlerPlayServer.processClickWindow` and `Container.slotClick` behaviour, and live):

- Right-clicking a block is C08 with the held item. The client selects an empty hotbar slot (C09)
  first, so the click can only open the chest.
  - The server answers with S2D (window id, type 0 = chest, 27 or 54 slots), then S30 (chest
    slots plus the player's 36).
- Each click is C0E (window, slot, button, action number, mode 0) with the stack the client
  believes was in the slot. The server applies the click, then compares.
  - Match: S32 accepted, and NO slot updates.
  - Mismatch: S32 rejected, plus an immediate full re-sync (S30, then the cursor as S2F window −1
    slot −1). Further clicks are ignored until the client acknowledges with C0F.
- **Items on the cursor are dropped into the world** when the window closes (C0D) or the player
  disconnects.
- **`setblock` over an existing chest drops its contents** in 1.7.10 with Forge: breakBlock runs
  even when only the block's metadata changes. The operator tool checks with `testforblock`
  first.

Live results (_verified_, 2026-09-30):

| Test                                    | Result                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Open `chest.pen`                        | Contents read exactly: 128 cobblestone, 3 diamonds, 16 bread.                        |
| Withdraw 10 cobblestone                 | 12 clicks (pick up 64, place 10, put 54 back); player 0→10, chest 128→118, verified. |
| Deposit 10 back                         | 2 clicks; player 10→0, chest 118→128, verified.                                      |
| Withdraw 100 / deposit 100 (two stacks) | 50 clicks / 4 clicks; all deltas verified.                                           |
| Withdraw a diamond (protected)          | Refused by the safety policy (`PROTECTED_ITEM`); nothing clicked.                    |
| Withdraw 500 (more than there is)       | Refused as a precondition; nothing clicked.                                          |

No item entity appeared near the pen afterwards (nothing was dropped), and the server logged no
warnings.

**Live task** (_verified_, 2026-09-30): `task-add fetch-cobble` with
`examples/plans/fetch-cobblestone.json`, then four `once --live` cycles, each its own connection:

1. The walk to the chest (1 block).
2. `OPEN_CONTAINER`.
3. `WITHDRAW_ITEM` 10, validated from remembered contents while the chest was closed, then 11
   clicks against the live chest; verified 0→10 and 128→118.
4. `NO_ACTIVE_TASK`: the task was completed with its plan.

**Bounded auto-run** (_verified_, 2026-09-30):

- `run --live` did the same task in 3 cycles on one connection (1.8 s) and stopped with "the task
  is completed".
- In a corner-walking task, `cli halt` from another process halted the second walk mid-way, and
  the run stopped after that cycle.
- A task with `--machines gt:3.200.-1`, on a macerator placed mid-recipe (600 ticks, 0 EU/t),
  waited 6 cycles while the macerator was busy, then ran its plan: 9 cycles, 33 s, completed.

Two things this found (_verified_, fixed):

- **Right after connecting, a required machine may not have been seen yet.** The router used to
  send such a machine to the planner, and an operator plan carried on. An unseen required
  machine now means wait.
- **WAIT has to wait for observed time.** A live state is timestamped with the arrival of the last
  server packet, so it lags the clock by up to one packet interval. A clock-exact 5000 ms wait
  showed 4990 ms of observed time and failed verification. The live WAIT now also waits until
  the observed time has advanced by the full duration. Rejected clicks and cursor recovery are covered by the fake server's faithful 1.7.10
  click simulation (tests), not live.

## Crafting (2026-09-30)

`CRAFT_ITEM` crafts in the player's own 2x2 grid (window 0) or at a configured crafting table
(3x3). Everything below was checked in the installed code (_verified_), not live: the shared test
server was not used. The sources:

- `minecraft_server.1.7.10.jar`, with Forge 10.13.4.1614's server binpatches applied the way FML's
  `ClassPatchManager` does (`binpatches.pack.lzma` from the Forge universal jar). Forge patches
  `ContainerPlayer`, `SlotCrafting`, `EntityPlayerMP` and `NetHandlerPlayServer`; it leaves
  `Container`, `ContainerWorkbench`, `InventoryCrafting` and `InventoryCraftResult` alone. Names
  come from FML's own `deobfuscation_data-1.7.10.lzma`.
- Every mixin and class transformer in the 211 mod jars that names these classes or their methods
  (see "Mods that touch crafting" below).

**Window layouts:**

| Window                                  | Slots                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0, the player's own (`ContainerPlayer`) | 0 result, 1-4 the 2x2 grid (column + 2 x row), 5-8 armor, 9-35 main, 36-44 hotbar, and 45 Backhand's off-hand (46 in all).    |
| Crafting table (`ContainerWorkbench`)   | S2D type 1, title "Crafting", announcing **9** slots. The window has 0 result, 1-9 the grid (column + 3 x row), 10-45 player. |

**The server never sends the result slot on its own:**

- `EntityPlayerMP.sendSlotContents` returns at once for a `SlotCrafting` slot, and sends nothing at
  all while `isChangingQuantityOnly` is set. `processClickWindow` sets that flag around the
  `detectAndSendChanges` that follows an accepted click.
- `onCraftMatrixChanged` recomputes the result on the server only. A vanilla client works out the
  result itself, from its own recipes.
- Only a full window sync carries slot 0: S30 when a window opens (`addCraftingToCrafters`, also at
  login for window 0), or S30 followed by the cursor (S2F -1/-1) after a rejected click.
- So the agent **syncs** with a click that changes nothing: a left-click on an EMPTY slot with an
  empty cursor. `slotClick` returns null for it, so the agent claims a 1-item stack, which cannot
  match. The server answers S32 rejected plus the full window, result included. The agent
  acknowledges (C0F) and compares every other slot with its prediction.

**Taking the result** (left-click on slot 0, empty cursor):

- `SlotCrafting.decrStackSize` calls `InventoryCraftResult.decrStackSize`, which hands over the
  WHOLE stack whatever the button.
- Forge's `onPickupFromSlot` fires the crafting event and takes one item from every non-empty grid
  slot.
- An ingredient with a container item (e.g. a bucket) puts it into the player's inventory, or the
  grid slot if that is empty, or **drops** it. The agent's recipes use no such ingredients.
- With a stack of the result already on the cursor, the result merges into it only while it fits
  the item's stack limit. The agent never does this: it takes results with an empty cursor.

**Grid items are DROPPED, never returned:**

- C0D closes whatever window is open, whatever id it names. With none open, it closes the
  inventory container itself.
- `ContainerPlayer.onContainerClosed` drops the cursor and the 2x2 grid;
  `ContainerWorkbench.onContainerClosed` drops the cursor and the 3x3 grid.
- On logout, `playerLoggedOut` saves the player first, then removes the entity:
  `EntityPlayer.setDead` closes both containers, so grid and cursor items are dropped after the
  save (lost).
- The server also closes a table window by itself when the block is gone or the player is more
  than 8 blocks away (`canInteractWith`), dropping its grid.
- `displayGUIWorkbench` does not close the window that was open before.

**GTNH 2.8.4 recipes** (from the jars; the agent still checks every result against the server):

| Recipe             | On this server                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planks from a log  | Shapeless, **2** planks (GregTech `ProcessingLog`; `nerfedWoodPlank=true` in the test server's `GregTech.cfg`). Vanilla gives 4; a saw in the grid gives 4.                                                                                                                                                                            |
| Sticks             | Plank above plank: **2** sticks. GregTech's `CraftingRecipeLoader` removes the vanilla recipe (4) and adds `P/P` → 4/2 while `nerfedWoodPlank` is on; a saw above the planks gives 4.                                                                                                                                                  |
| Torch              | Coal above a stick: **3**; charcoal: **2** (NewHorizonsCoreMod `ScriptMinecraft`, `ShapedUniversalRecipe`).                                                                                                                                                                                                                            |
| Chest              | 3x3: logs in the corners, planks on the sides, **flint** in the middle (`ScriptMinecraft`).                                                                                                                                                                                                                                            |
| Crafting table     | **2x2: two flint above two logs** (any `logWood`). `RecipeRemover` removes every recipe that outputs `minecraft:crafting_table`, then `ScriptMinecraft.craftingRecipes` adds this one; `MainRegistry.CompleteLoad` runs the remover first. A 4-element `ShapedUniversalRecipe` is a 2x2 grid. The quest "Crafting Time" says the same. |
| Wooden shovel, axe | Vanilla `RecipesTools` (`afk`): shovel `X / # / #`, axe `XX / X# / _#`, X = any planks, # = stick; 3x3, so at a crafting table. Kept: see "Tools".                                                                                                                                                                                     |
| Flint              | Shapeless, **3 gravel** → 1 flint (IguanaTweaks `addFlintRecipe`, `gravelPerFlint=3`). Gravel never drops flint (`removeFlintDrop=true`). Not in the agent's table yet.                                                                                                                                                                |

The agent cannot place blocks, so the crafting table recipe is of no use to it: it crafts 3x3
recipes only at tables an operator placed (`minecraft.crafting.tables`), and the planner is not
told about the table recipe.

**Mods that touch crafting** (checked; none changes the behaviour above on this server):

- Hodgepodge:
  - `FIX_BUKKIT_PLAYER_CONTAINER` would send the result slot, but it loads only on Bukkit hybrid
    servers.
  - `FIX_LAG_ON_INVENTORY_SYNC` skips setting an already empty grid slot.
  - `MixinContainer_FixShiftRecursion` handles shift-clicks only.
- Backhand adds the off-hand slot (45) to window 0. Its click hooks act only on windows opened
  with the off-hand.
- Et Futurum's click hooks are for spectators only, and BogoSorter's are client-side.
- NotEnoughItems patches `ContainerWorkbench.transferStackInSlot` (shift-clicks) only.

**Not verified:** a live run (crafting has only run against the fake server, which simulates the
behaviour above). As with chests, spawn protection would stop a non-operator from opening a
crafting table near spawn.

## Knowledge base (2026-09-30)

The route planner's GTNH data ([architecture: knowledge base](architecture.md#knowledge-base))
comes from the running test server, read-only: four CraftTweaker list commands over RCON, two
mod jars and the configs. Everything below is _verified_ in those files unless marked otherwise.

**CraftTweaker 3.4.2 dumps** (`/minetweaker oredict`, `recipes`, `recipes furnace`, `names`,
`mods`; their code checked in `MineTweakerImplementationAPI`, `MCRecipeManager`,
`RecipeConverter` and `MCItemStack`). Each appends to the server's `minetweaker.log` and replies
to the sender (RCON works: `RconPlayer`).

- `recipes` writes every `IRecipe` as ZenScript: 53,822 recipes (47,873 shaped, 5,951 shapeless).
  2,781 are "unknown recipe type" (custom recipe classes: 2,304 are Et Futurum's shulker-box
  dyeing, the rest AE2, Blood Magic, BartWorks and the like) and 2 have an unknown ingredient.
- **Output stack sizes are never written** (`MCItemStack.toString` prints `<id:damage>` and the
  NBT only), in either dump.
- For a Forge `ShapedOreRecipe` the width is taken as floor(sqrt(size)), so 2x1, 3x1 and 3x2
  recipes are dumped as 1x2, 1x3 and 2x3 with cells moved. Ingredients, counts per craft and the
  2x2-or-3x3 decision stay right; the data flags these shapes.
- GTNH pads many recipes to 3x3 with empty cells (torches: coal above a stick in the top-left
  of a 3x3 grid). Forge matches a 3x3 recipe only at the grid's top-left, so such a recipe fits
  the player's 2x2 grid exactly when its filled cells are in the first two rows and columns.
- `oredict`: 22,006 entries (`*` = any damage); `recipes furnace`: 6,132 recipes; `names`:
  10,987 registered items (every name in the data is checked against it).

**Output counts** come from GTNewHorizonsCoreMod 2.7.268's recipe scripts
(`com/dreammaster/scripts/Script*.class`): each `addShapedRecipe`, `addShapelessRecipe` or
`GTModHandler.addCraftingRecipe` whose output is `getModItem(mod, name, count, meta)`. 3,128
such recipes; 3,096 match a dumped recipe (same output, same ingredients as multisets), which
gives 3,237 dumped recipes their count. Examples: crafting table 1, furnace 1 (6 cobblestone,
3 flint, 3x3), chest 1, torches 3 (coal), 2 (charcoal), 1 (lignite), 5 (coke), ladders 2/4/8
(by screw), Natura sticks 2 (4 with a saw). Three more sources, each marked in the data:

- The agent's hand-verified table (`src/domain/recipes.ts`): 14 recipes, only tool-free ones (a
  hand recipe never gives its count to a recipe that also needs a saw).
- GregTech's own code, read with `javap` (5.09.51.482): `ProcessingLog` adds "a saw above a log"
  making the vanilla planks count (4) while `nerfedWoodPlank=true` (5/4 of it when off), and the
  log alone half of it (2); `CraftingRecipeLoader` adds "a saw above two plankWood" making 4
  sticks (2 without the saw). 7 recipes.
- Vanilla's count, for 54 recipes whose grid is exactly vanilla's (no tool) and that no script
  counts: stairs, walls, dyes and the like. Marked `vanilla`: GTNH may differ, but these look like
  vanilla's own registrations left in place.

Other recipes' counts are unknown.

**GT ore generation** (`gregtech-5.09.51.482.jar`: `OreMixes` and `SmallOres`, builder chains
read from their static initializers; `config/GregTech/WorldGeneration.cfg` holds only the
general switches, so the code's values generate):

- 79 vein types, all enabled; 56 small ores. **Vanilla ore generation is disabled**
  (`disableVanillaOres=true`): no vanilla iron, coal or diamond ore in new chunks.
- Diamond: vein `ore.mix.diamond`, y 5-20, weight 40, density 1, size 16, Overworld and the
  Twilight Forest (plus space bodies): graphite (primary, secondary), **diamond (in-between)**,
  coal (sporadic). Small diamond ore: y 5-15, 2 per chunk, Overworld.
- Iron: vein `ore.mix.iron`, y 10-40: brown limonite, yellow limonite, banded iron (in-between),
  malachite (sporadic). Coal: vein y 30-80; small coal ore y 120-250.

**Ore drops** (`TileEntityOres.getDrops`; `GregTech.cfg` `oredropbehavior=FortuneItem`):

- A world-generated vein ore drops its **raw ore** (`rawOre<Material>`, e.g. raw diamond ore
  `gregtech:gt.metaitem.03@5500`): 1 without fortune (doubled for nether and end ores). Silk
  touch drops the ore block. Raw ores smelt (raw diamond ore -> diamond, raw iron ore -> iron
  ingot).
- A small ore drops max(1, m + rand(1 + m)/2) items (m: the material's ore multiplier, mostly 1),
  each picked from a weighted list: exquisite gem 1, flawless gem 2, gem 12, flawed gem 5 (else
  crushed ore), crushed ore 10, chipped gem 5 (else impure dust), impure dust 10. A small diamond
  ore gives a plain diamond 12 times in 45.

**Harvest levels:**

- GT ores (`TileEntityOres.getHarvestData` and `BlockOresAbstract.getHarvestLevel`,
  `activateHarvestLevelChange=false`): the block's world metadata is max(base, min(7, tool
  quality, minus 1 for a small ore)), base 3 in black and red granite and 0 elsewhere; the
  harvest level (a pickaxe) is that metadata, except 5 and 6 give 2. Tool quality comes from
  `MaterialsInit1`: diamond 4 (vein ore 4, small ore 3), coal 1 (1 / 0), brown limonite 1,
  yellow limonite and banded iron 2, copper 1, tin 3. IguanaTweaks' `BlockDefaults.cfg` lists
  `gt.blockores` metas 5 and 6 as levels 5 and 6 (defaults Forge's config keeps), but Forge asks
  GT's method.
- IguanaTweaks (`HarvestLevelTweaks=true`): stone and cobblestone pickaxe 0, obsidian 5. Tools:
  wooden, stone and golden pickaxe 0, **iron 3**, diamond 5. Tinkers' Construct tools take the
  level of their head material: wood and stone 0, flint and bone 1, copper 2, iron 3,
  **bronze 4**, steel 5. Level names: Stone, Copper, Iron, Bronze, Steel, Obsidian, Ardite,
  Cobalt, Manyullyn.
- GTNH's GregTech has no pickaxe, shovel or axe (`IDMetaTool01` starts at the saw).

**What follows for planning** (from the data): with crafting-table recipes alone, a wooden
pickaxe (level 0) digs stone, lignite (vein ore) and the small ores of copper (y 60-180), zinc
(y 80-210), coal (y 120-250) and lapis (y 10-50): enough for brass tools (a hammer, a file) by way
of the flint mortar. Iron ores need level 1 or 2 (small iron, gold, silver, nickel and redstone
ores level 1). The craftable pickaxes above level 0 that the data lists, vanilla iron (3) and
AE2's quartz pickaxes (3), **mine nothing** here (IguanaTweaks, see "Tools"), so the route book
leaves them out; the diamond pickaxe is disabled too (and needs a diamond plate). GTNH's early
pickaxes are Tinkers' Construct tools (Part Builder and Tool Station), which are not in the
data, so a route to iron or diamonds ends at "needs a pickaxe level >= N: none known to make".

_Assumptions:_ furnace outputs are 1 item; crafting counts the scripts do not give are at least 1;
stone drops cobblestone (vanilla; no GTNH drop handler checked); dig-time estimates.

### Vanilla 1.7.10, and what GTNH changes (2026-09-30)

The knowledge base also holds vanilla Minecraft 1.7.10 as its base layer, and a table of every
difference it can show: **[GTNH 2.8.4 vs vanilla 1.7.10](gtnh-vs-vanilla.md)** (generated, 255
entries: 239 recipes, 5 smelting recipes, gravel, 2 tool rules, 6 ores, hunger). The planner gets
the entries that concern its route ([architecture: knowledge base](architecture.md#knowledge-base)).

**Vanilla sources** (_verified_ in the files):

- The server's `minecraft_server.1.7.10.jar`, read by the build script (obfuscated: classes are
  found by what they contain). `CraftingManager` and the recipe classes it calls (tools, weapons,
  armour, food, dyes, ingots, crafting blocks): 312 crafting recipes with their counts.
  `FurnaceRecipes`: 21 smelting recipes. `Item.ToolMaterial` and `Item.registerItems`: 5 materials
  and 25 tools. `BiomeDecorator`: ore generation. The drop methods of gravel and a few other
  blocks.
- minecraft-data 3.117.0 (PrismarineJS, MIT), `data/pc/1.7`: 303 items (names, stack sizes,
  durability), 176 blocks (hardness, material, harvest tools), 27 foods, tool speeds by material,
  50 mobs (names and categories), 40 biomes, enchantments and effects. Its 1.7 recipes are 1.8's
  and its 1.7 block drops are empty, so those come from the jar.

**How a change is decided** (`scripts/knowledge/changes.ts`):

- A vanilla recipe is unchanged when the dump has a GTNH recipe with exactly its ingredients, no
  crafting tool, and the same or an unknown count. Otherwise the entry says that the same
  ingredients make another count (and what a saw in the grid makes), that the same ingredients
  need a crafting tool, that vanilla's recipe is gone and what GTNH's is (the one sharing most of
  vanilla's ingredients), or that no crafting recipe makes the item. "No crafting recipe" means
  none in the dump: among the 2,781 recipes of unknown type the only vanilla outputs are iron
  ingots and diamonds, and the 151 with no fixed output are dynamic ones (dyeing armour, copying
  maps).
- A vanilla smelting recipe is changed when its input no longer gives that output in the dump.

**Verified changes that matter early:**

| Change                | Vanilla 1.7.10                                     | GTNH 2.8.4                                                                                                                                         | Verified in                                                                                          |
| --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Gravel                | flint 1 time in 10 (1 in 7, 4, 1 with Fortune)     | never flint; 3 gravel craft 1 flint (shapeless, 2x2)                                                                                               | the jar's `BlockGravel`; IguanaTweaks `FlintHandler`, `flintTweaks` and `main.cfg`; the dump         |
| Vanilla pickaxes      | dig by material                                    | stone, iron, golden and diamond pickaxes and shovels mine nothing; wooden ones and every axe work; GregTech and Tinkers' tools are not `ItemTool`s | `main.cfg`; `javap` of `IguanaTweaks.findToolsFromConfig` and `VanillaToolNerfHandler.isUselessTool` |
| Vanilla swords        | 4 + material damage                                | **unchanged**: `disableRegularSwords=true` cancels hits only of listed swords (BOP, Natura, ProjectRed, AE2), and no vanilla sword is listed       | `main.cfg`; `javap` of `VanillaSwordNerfHandler.isUselessWeapon`                                     |
| Wooden tools          | 59 uses                                            | 64 uses                                                                                                                                            | `GregTech.cfg` `changedWoodenVanillaTools` (see "Tools")                                             |
| Ores                  | vanilla ore veins by height                        | no vanilla ores; GT veins and small ores                                                                                                           | `WorldGeneration.cfg`; GregTech's jar                                                                |
| Healing               | while food >= 18                                   | while food >= 8, slower at low health; foods fill less                                                                                             | `HungerOverhaul.cfg`                                                                                 |
| Smelting              | sand, clay balls, logs, netherrack                 | none of these in a furnace (no glass, brick, charcoal or nether brick)                                                                             | the dump's 6,132 furnace recipes                                                                     |
| Planks, sticks        | 1 log -> 4 planks; 2 planks -> 4 sticks            | 2 and 2; 4 and 4 with a saw in the grid                                                                                                            | the dump; GregTech's `ProcessingLog` and `CraftingRecipeLoader` (`javap`); the hand-verified table   |
| Torches               | 4                                                  | 3 from coal, 2 from charcoal                                                                                                                       | the dump; GTNewHorizonsCoreMod's `ScriptMinecraft`                                                   |
| Table, chest, furnace | 4 planks; 8 planks; 8 cobblestone                  | 2 flint over 2 logs (2x2); 4 logs, 4 planks, 1 flint; 6 cobblestone, 3 flint                                                                       | the dump; `ScriptMinecraft`                                                                          |
| Storage blocks, tools | 9 ingots <-> a block; tools and armour from ingots | no block crafting either way; GTNH's tools and armour need plates and GT crafting tools; no stone tools                                            | the dump                                                                                             |

_Not verified, or not covered:_ Hunger Overhaul's per-food values (only its switches are read);
recipe counts marked `vanilla` (54) and unknown counts; disabled tools of a listed mod are found
by name, not by class; block drops other than gravel's are not compared (stone still assumed to
drop cobblestone); mob stats and drops are not read.

## Digging (2026-09-30)

`DIG_BLOCK` breaks one block. Everything below is _verified_ in the test server's own jars, not
assumed from memory of vanilla:

- **Vanilla:** `javap` on `minecraft_server.1.7.10.jar`: `nh` (NetHandlerPlayServer), `mx`
  (ItemInWorldManager), `mw` (EntityPlayerMP), `yz` (EntityPlayer), `aji` (Block), `awt`
  (Material), `ji` (C07), `eq` (packet ids), `lt` (DedicatedServer).
- **Forge as it really runs:** Forge 10.13.4.1614 patches these classes at load time from
  `binpatches.pack.lzma` in its universal jar. That file was unpacked (LZMA, then Pack200 with the
  Commons Compress copy that ships in `lwjgl3ify-forgePatches.jar`), and its GDiff patches were
  applied to the vanilla classes. Every source checksum matched. `ForgeHooks` comes from the
  universal jar.
- **Mods:** all 211 mod jars were scanned for mixins on, references to and event handlers for the
  digging code (see "GTNH mods" below).

**The packet.** C07 (id 0x07, `eq`): u8 status, i32 x, u8 y, i32 z, u8 face. Status 0 starts,
1 cancels, 2 finishes. Statuses 3 and 4 drop the held item or stack, and 5 releases a used item
(a bow, food). `outbound.digBlock` cannot express them.

**Reach.** Forge's `processPlayerDigging` accepts a block whose centre is within
`getBlockReachDistance() + 1` of (feet x, feet y + 1.5, feet z). The reach distance defaults to
5.0, so that is 6 blocks, plus y below 256. The server does not check line of sight or where the
player looks. The agent only digs blocks within 4.5 of its eyes.

**Start (status 0).**

- `DedicatedServer.isBlockProtected` (spawn protection) re-sends the block instead of digging
  when all of these hold:
  - the block is in the overworld;
  - `ops.json` is not empty;
  - the player is not an op;
  - the block is within `spawn-protection` blocks of the world spawn (Chebyshev distance).
- The test server has `spawn-protection=1` and an empty `ops.json`, so nothing is protected.
  Adding any op makes the 3 x 3 columns around the world spawn undiggable for the bot.
- Otherwise `ItemInWorldManager.onBlockClicked` runs:
  - Forge posts `PlayerInteractEvent` (LEFT_CLICK_BLOCK). If it is cancelled, the block is
    re-sent.
  - Fire on the clicked face is put out.
  - The current tick is remembered (`curblockDamage`).
  - A block whose progress per tick is already 1 or more breaks at once (none on the allowlist).

**Progress per tick** is `ForgeHooks.blockStrength`: dig speed / hardness / 30 when the player
can harvest the block, / 100 when it cannot (and then nothing drops).

- A material that needs no tool is always harvestable. In 1.7.10 only rock, iron, anvil, snow
  and crafted snow need one (`awt`'s static block).
- `EntityPlayer.getBreakSpeed` gives an empty hand speed 1. Haste and Mining Fatigue change it.
- It is divided by 5 in water (without Aqua Affinity), and by 5 when the player is not on the
  ground. The server takes "on the ground" from the client's C03, which the agent always sends
  as true.
- Last, Forge's `PlayerEvent.BreakSpeed` lets mods change the speed, or cancel it (speed 0).
- The dig timer advances once per server tick, in `EntityPlayerMP.onUpdate`, not per packet.

**Finish (status 2).** `uncheckedTryHarvestBlock` only acts on the block of the last start.

- If progress per tick x (ticks since the start + 1) is at least **0.7**, the block is
  harvested.
- If not, it remembers the finish (`receivedFinishDiggingPacket`), and `processPlayerDigging`
  re-sends the block (S23) at once. Then `updateBlockRemoving` **breaks the block on its own once
  the progress reaches 1.0**. A cancel (status 1) does not clear that.

**Harvest** (`tryHarvestBlock`):

- `ForgeHooks.onBlockBreakEvent` first sends the digging player S23 **air** (for a block without
  a tile entity), then posts `BlockEvent.BreakEvent`. If a mod cancels it, the block is re-sent
  right after.
- Otherwise the block is removed and the world's change goes to everyone watching the chunk (a
  second S23, or S22).
- The drop (`Block.dropBlockAsItem_do`, gamerule `doTileDrops`) is an item entity 0.15-0.85 into
  the block's cell on each axis. It can be picked up after 10 ticks.

**Pickup.** `EntityPlayer.onLivingUpdate` runs for every C03 the player sends, so it needs the
agent's idle ticks.

- It picks up items whose box touches the player's box grown by 1.0 sideways and 0.5 up and
  down.
- `InventoryPlayer` first fills a matching stack with room, then the first empty slot, **hotbar
  first**. The agent's own empty hand slot is often where the first drop lands.
- A drop from a block next to the player, at its feet or head level (or falling down to its
  feet), is picked up. A drop two or more blocks away is not.

Hardness and dig times (empty hand; ticks of 50 ms):

| Block               | Hardness | Vanilla client | Server accepts from | Agent waits |
| ------------------- | -------- | -------------- | ------------------- | ----------- |
| `log`, `log2`       | 2.0      | 60             | 41                  | 77          |
| `grass`             | 0.6      | 18             | 12                  | 25          |
| `gravel`, `clay`    | 0.6      | 18             | 12                  | 25          |
| `dirt`, `sand`      | 0.5      | 15             | 10                  | 21          |
| `leaves`, `leaves2` | 0.2      | 6              | 4                   | 10          |

The agent waits the vanilla time x 1.25 + 2 ticks. That is about twice what the server needs (1.9x
for logs), so a server running at little more than half speed still accepts it.

**GTNH mods** (all 211 jars scanned):

- **Mixins on the digging code:**
  - Backhand skips the finish only while the player uses its offhand (never the agent).
  - ServerUtilities only affects vanished players.
  - NotEnoughIDs changes how the break effect sent to other players encodes the block.
  - ArchaicFix and Et Futurum touch block placement, elytra and spectators only.
  - Hodgepodge changes nothing here.
- **`BreakSpeed` handlers** (26 classes) all depend on a held tool, armor, enchantments, special
  blocks or a dimension. For an empty hand only IguanaTweaks' `ExtraHarvestLevelHandler` could
  matter: it cancels the speed for a no-tool block with harvest level above 0. The test server's
  `config/IguanaTinkerTweaks/BlockDefaults.cfg` gives every allowlisted block level 0, and
  `BlockOverride.cfg` overrides nothing. GregTech's handler only applies to GregTech tools.
- **Claims and protection:** ServerUtilities chunk claims are off on the test server
  (`chunk_claiming=false`, `spawn_radius=0`).
- GTNH's own quest book talks about punching trees with bare hands.

**What the client does** (`src/bot/gtnh1710/digging.ts`, `Gtnh1710Client`): see
[architecture: digging](architecture.md#digging). A re-send at any point fails the dig. That
includes the start (spawn protection, a cancelled interact event), after the finish (too early,
or a cancelled BreakEvent) and air followed by the block. If the cause was "too early", vanilla
still breaks the block itself shortly afterwards. The fake server simulates exactly this
(`tests/bot/gtnh1710/fake-digging.ts`).

_Assumptions, to check live:_

- that no mod in this pack changes a bare hand's speed on these blocks beyond what the scan
  found;
- that the S23 order (Forge's early "air", then the world change) arrives as read from the code;
- that the player is never under a potion effect that slows digging (effects are not observed
  yet).

## Tools (2026-09-30)

Which tools an early player can make and use on this server, and what they change. Everything
below was checked in the test server's jars, configs and logs (_verified_), not live. Sources:
the Forge-patched vanilla classes (as in "Digging"; names from FML's `deobfuscation_data`), the
mod jars (`javap`), the server's `config/` files, and its `logs/` from the current run.

**What a held tool changes, server side** (vanilla 1.7.10 + Forge 10.13.4.1614):

- **Speed.** `EntityPlayer.getBreakSpeed` asks the held item's `getDigSpeed(stack, block, meta)`
  (an empty hand: 1). Forge's `ItemTool.getDigSpeed` returns the material's efficiency when
  `ForgeHooks.isToolEffective` (the tool class matches the block's harvest tool), else
  `func_150893_a`: the efficiency for blocks in the tool's own set, else 1.
  - `ItemSpade` (`ady`): grass, dirt, sand, gravel, snow layer, snow, clay, farmland, soul sand,
    mycelium. Tool class "shovel".
  - `ItemAxe` (`abf`): planks, bookshelf, log, log2, chest, pumpkins, and any block of material
    wood, plants or vine. Leaves are none of these: an axe digs them at 1.
  - Efficiency enchantment adds level² + 1 (only with NBT data, which the agent never uses).
  - Progress per tick is then speed / hardness / 30, as in "Digging".
- **Materials** (`Item$ToolMaterial`, `adc.<clinit>`): harvest level, uses, efficiency.
  - WOOD 0, 59, 2; STONE 1, 131, 4; IRON 2, 250, 6; EMERALD (diamond) 3, 1561, 8; GOLD 0, 32, 12.
  - `Item.registerItems`: the wooden_shovel ... golden_shovel are `ItemSpade`s of these
    materials, the axes `ItemAxe`s. The `ItemTool` constructor copies the efficiency and sets
    the maximum damage to the uses.
  - minecraft-data 1.7 (`materials.json`, installed with mineflayer) gives the same speeds.
- **Wear.** `ItemTool.onBlockDestroyed` damages the tool by 1 for every block with hardness ≠ 0
  (all allowlisted blocks).
  - `ItemStack.attemptDamageItem` adds the damage and reports a break when the damage is then
    above `getMaxDamage`. `damageItem` then shrinks the stack, and
    `ItemInWorldManager.tryHarvestBlock` destroys the held item when it is empty.
  - That happens before the block is removed. The block still breaks and drops as usual.
  - The new damage reaches the client as an ordinary slot update (the damage value of the stack).
- **One block.** `tryHarvestBlock` harvests one block. Only `Item.onBlockStartBreak` could do
  more (TConstruct's lumber axe, hammer and excavator use it). `Item` returns false and the vanilla
  tools do not override it. No mod's `BreakEvent` handler looks at a vanilla axe or shovel
  (searched all 211 jars).

**What GTNH changes** (all three found by searching every jar for the vanilla tool classes,
fields and names):

- **IguanaTweaks disables most vanilla shovels.**
  - The config (`IguanaTinkerTweaks/main.cfg`): `disableRegularTools=true`,
    `exclusionType=blacklist`, and a `tools` list with the stone, iron, golden and diamond
    shovels and pickaxes (and some modded tools).
  - `IguanaTweaks.findToolsFromConfig` whitelists every `ItemTool` whose name and mod are not
    on the lists. `VanillaToolNerfHandler.breakSpeed` sets the speed to **0** for any other
    `ItemTool` in hand, on every block.
  - So the **wooden shovel and every vanilla axe work**, and the other vanilla shovels dig
    nothing. GregTech and TConstruct tools are not `ItemTool`s and are not affected.
  - Log line: "Sticks and stones may break my bones, but your pickaxes and axes will break no
    blocks."
- **GregTech** `changedWoodenVanillaTools=true` (`GregTech.cfg`):
  - `GTPostLoad.changeWoodenVanillaTools` sets the maximum damage of the wooden sword, pickaxe,
    shovel, axe and hoe to **64**. `GregTech.log`: "GTMod: Updating Vanilla Wooden Tools".
  - Its mixin that would raise wood's efficiency to 4 (`ItemToolMaterialMixin`) is **not
    loaded**: `fml-server-latest.log` lists it under "Not loading the following EARLY mixins".
    Its condition reads the GregTech config before GTNHLib has loaded it, while the field still
    has Java's default, false. So wood keeps efficiency 2.
- **Recipes:**
  - NewHorizonsCoreMod's `RecipeRemover` removes the stone and diamond tool recipes.
  - TConstruct would remove the vanilla tool recipes only with "Remove Vanilla Tool Recipes"
    (false), or set their durability to 1 with "Remove Vanilla Tool Effectiveness" (false).
  - The other jars that name the wooden shovel or axe use them as an ingredient (Et Futurum
    boats, EMT tools), as loot, or in tooltips and slot filters.
- **Harvest levels** (IguanaTweaks `ToolDefaults.cfg`; level names Stone 0, Copper 1, Iron 2,
  Bronze 3, ...):
  - wooden shovel, wooden, stone and golden axe: 0; iron axe: 3; diamond axe: 5.
  - The allowlisted blocks are level 0 (`BlockDefaults.cfg`: dirt, grass, sand, gravel and clay
    under `blocks_shovel`, the logs under `blocks_axe`), and their materials need no tool.
  - `ExtraHarvestLevelHandler` ignores level-0 blocks. Harvest levels matter for ores, not here.
- **The 26 `BreakSpeed` handlers** (see "Digging") were checked again with a vanilla tool in hand.
  None applies: each needs its own item, armor, accessory, enchantment, potion, dimension, block,
  hover or spectator mode. The exceptions are IguanaTweaks' nerf (above) and GregTech's, which
  handles only GregTech tools.

**Early tools on this server:**

| Tool                                | How an early player gets it                                                                                                                                                   | Speed on its blocks                                                                                            | Max. damage               | Agent                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------- |
| Wooden shovel                       | Vanilla 3x3 at a crafting table: 1 plank above 2 sticks. The quest "Tools" asks for it.                                                                                       | 2 (dirt, grass, sand, gravel, clay)                                                                            | 64 (the agent assumes 59) | Uses it               |
| Wooden axe                          | Vanilla 3x3: 3 planks, 2 sticks                                                                                                                                               | 2 (logs)                                                                                                       | 64 (59)                   | Uses it               |
| Stone axe                           | No recipe (removed)                                                                                                                                                           | 4                                                                                                              | 131                       | Uses it if it has one |
| Iron, golden axe                    | Not early (their GTNH recipes were not checked)                                                                                                                               | 6, 12                                                                                                          | 250, 32                   | Uses them             |
| Diamond axe                         | No recipe (removed)                                                                                                                                                           | 8                                                                                                              | 1561                      | Uses it               |
| Stone, iron, golden, diamond shovel | Stone and diamond recipes removed                                                                                                                                             | **0** (IguanaTweaks)                                                                                           |                           | Never                 |
| GregTech tools                      | There is **no** GregTech shovel, axe, pickaxe, sword or hoe in 5.09.51.482 (`MetaGeneratedTool01` starts at the saw). The quests describe a flint knife: flint above a stick. | see below                                                                                                      | in NBT (`GT.ToolStats`)   | Never (NBT)           |
| TConstruct flint shovel, hatchet    | The quest "Your First Tool": Part Builder, stencil table and Tool Station (placed blocks).                                                                                    | about 4 (flint's mining speed is 400 in IguanaTweaks' `MaterialDefaults.cfg`; durability 113, harvest level 1) | in NBT (`InfiTool`)       | Never (NBT)           |

GregTech's `MetaGeneratedTool.getDigSpeed` is the tool's speed multiplier × its primary
material's `mToolSpeed`, on blocks the tool can mine. TConstruct's `AbilityHelper.calcToolSpeed`
averages the `InfiTool` `MiningSpeed` values / 100, times the tool's break-speed modifier, plus
the Stonebound bonus; `HarvestTool.getDigSpeed` gives 0.1 once the tool is broken.

**What the agent does** (`src/domain/tools.ts`, [architecture: digging](architecture.md#digging)):

- It may hold only the wooden shovel and the vanilla axes, each only on the blocks it digs faster.
- It uses each tool's speed above as a lower bound: 2 for wood (4 if GregTech's mixin were
  loaded). The maximum damage it assumes for wooden tools is 59 (64 here): a server with
  GregTech's option off has 59. Being slower or more careful than the server is always safe.
- It never uses a tool when one more use would take it past that maximum, nor one with NBT data,
  more than one in a stack, or a protected item.

Dig times with a tool (ticks of 50 ms; empty hand for comparison):

| Block                     | Tool          | Vanilla client | Server accepts from | Agent waits |
| ------------------------- | ------------- | -------------- | ------------------- | ----------- |
| `sand`, `dirt`            | empty hand    | 15             | 10                  | 21          |
| `sand`, `dirt`            | wooden shovel | 8              | 5                   | 12          |
| `grass`, `gravel`, `clay` | empty hand    | 18             | 12                  | 25          |
| `grass`, `gravel`, `clay` | wooden shovel | 9              | 6                   | 14          |
| `log`, `log2`             | empty hand    | 60             | 41                  | 77          |
| `log`, `log2`             | wooden axe    | 30             | 20                  | 40          |
| `log`, `log2`             | stone axe     | 15             | 10                  | 21          |
| `log`, `log2`             | iron axe      | 10             | 6                   | 15          |
| `log`, `log2`             | diamond axe   | 8              | 5                   | 12          |
| `log`, `log2`             | golden axe    | 5              | 3                   | 9           |

So 128 sand takes 128 × 21 ticks (134 s) of digging by hand, or 128 × 12 (77 s) with wooden
shovels. Three shovels are needed: each lasts 59 digs.

Prior art: mineflayer-tool and Baritone's `ToolSet` also choose the item that breaks a block
fastest, and Baritone can stop using a tool just before it breaks. The agent uses the same idea
with this server's verified numbers. No code from either is used (Baritone is LGPL-3.0).

_Not verified:_ a live run with a tool. It would show the faster dig accepted and the damage
going up by one per block.

## Placing (2026-09-30)

`PLACE_BLOCK` places one block (approved by the owner on 2026-09-30: sealing a pit for the
night now; crafting tables, furnaces and the coke oven later). Everything below is _verified_
in the test server's own jars, the same way as digging: `javap` on `minecraft_server.1.7.10.jar`
with Forge 10.13.4.1614's binpatches applied (every source checksum matched), `ForgeHooks` from
the Forge universal jar, and all 211 mod jars. It has not been run live yet.

**The packet.** C08 (id 0x08, `jo`): i32 x, u8 y, i32 z, u8 face, the held item stack (with
ModularUI's trailing VarInt size, like every stack), then u8 cursor x, y, z (read as
`byte / 16.0`). The position and face name the block that is CLICKED. Face 255 means "use the
held item in the air"; `outbound.placeBlock` cannot send it.

**What the server does with it** (`nh.a(jo)`, processPlayerBlockPlacement):

1. A clicked y at or above the build limit − 1 (256 here) with face 1, or above the limit:
   "build.tooHigh" in chat.
2. Otherwise, only when the player has confirmed its position (`hasMoved`), the clicked block's
   centre is closer than `getBlockReachDistance() + 1` = 6 to the player, and the spot is not
   spawn-protected: `ItemInWorldManager.activateBlockOrUseItem`.
   - GTNH moves the point the reach is measured from: ArchaicFix (`fixPlacementFlicker=true`,
     a `ModifyArg`, y − 1.5) and Hodgepodge (`fixWrongBlockPlacementDistanceCheck=true`, a
     `WrapOperation`, y − 0.5) both lower the y they pass to `getDistanceSq`, which is the same
     as measuring from up to 2 above the feet. The agent keeps the clicked block within 5.5 of
     both the feet and the point 2 above them.
3. Then, whatever happened: S23 for the clicked block, then S23 for the cell next to its face,
   each as the world holds it now.
4. Then the held slot: emptied at size 0; `detectAndSendChanges` runs with
   `isChangingQuantityOnly` set (so it sends nothing); then S2F for the held slot of the open
   window if the held stack differs from the one the client claimed, or the placement failed.
   So: placed → S2F with one item fewer; refused inside `activateBlockOrUseItem` → S2F with the
   stack unchanged; out of reach or too high → no S2F (nothing changed, the claim matched).

**`activateBlockOrUseItem`** (`mx`, Forge-patched):

- Forge's `PlayerInteractEvent` (RIGHT_CLICK_BLOCK); cancelled → S23 for the clicked block,
  nothing placed.
- **The clicked block is activated first** unless the player sneaks with an item in hand:
  `Block.onBlockActivated`. A chest, crafting table, furnace or GregTech machine opens its
  window and nothing is placed. The default returns false. The agent never sneaks, and only
  clicks blocks in `CLICKABLE_SUPPORTS` (the walker's full blocks and the dig allowlist): none
  of their classes overrides `onBlockActivated` or `isReplaceable`, or has a tile entity
  (`javap` on every class in each chain: `aji`, `anv`, `alh`, `akl`, `aom`, `amm`, `ami`,
  `anh`, `ali`, `ani`, `alf`, `anq`, `anw`, `aka`, `ajy`, `all`, `amk`, `anm`, `any`, `aoo`,
  `amx`, `aml`, `amh`, `amd`). The chest (`ajx`), crafting table (`ake`) and furnace (`ale`)
  do.
- Then `ItemStack.tryPlaceItemIntoWorld`, which on a server is
  `ForgeHooks.onPlaceItemIntoWorld`: it captures block snapshots and calls `Item.onItemUse`.
  On success it posts `BlockEvent.PlaceEvent` with the stack put back to its old size; if a
  mod cancels it, every snapshot is restored and the placement fails. Otherwise the new size is
  kept, `onBlockAdded` runs (where sand and gravel schedule their fall check) and
  `markAndNotifyBlock` sends the change to everyone watching the chunk.

**`ItemBlock.onItemUse`** (`abh`, Forge-patched):

- Where the block goes: into the clicked cell if that is a thin snow layer, a vine, tall grass,
  a dead bush or any replaceable block; otherwise into the cell next to the clicked face. The
  agent always clicks a plain full block, so it is always the cell next to the face.
- Refused with an empty stack, a player who may not edit (adventure mode), a solid block at
  y 255, or when `World.canPlaceEntityOnSide` says no:
  - The new block's box (a full cube) must not overlap any entity that is alive and has
    `preventEntitySpawning`, **except the placing player**: the server passes the placer, and
    `checkNoEntityCollision` skips it. Only a vanilla client's own pre-check
    (`func_150936_a`, which passes null) refuses the player's own body. So the server would
    put a block inside the agent; the agent checks its body itself.
  - `preventEntitySpawning` is set by living entities, boats, minecarts, primed TNT, ender
    crystals and falling blocks (their constructors); not by dropped items, XP orbs, arrows,
    item frames or paintings.
  - The cell must be replaceable: the material's flag. Air, water, lava, fire, `Material.vine`
    (tall grass, dead bush, vine) and snow layers below 7 are; `Material.plants` (flowers,
    saplings, double plants) and every solid block are not. So a flower stops a placement; the
    agent places only into air, tall grass and dead bushes.
- `placeBlockAt` (Forge): `setBlock(..., 3)`, then `onBlockPlacedBy` and `onPostBlockPlaced`;
  one item is taken. A log's metadata is its wood type plus its axis from the clicked face
  (`BlockRotatedPillar.onBlockPlaced`: faces 2 and 3 → 8, 4 and 5 → 4).
- The server checks neither where the player looks nor the line of sight.

**Sand and gravel** (`BlockFalling`): `onBlockAdded` schedules an update in 2 ticks; it falls
when the block below is air, fire, water or lava. The agent places them only on a plain full
block (not leaves, which decay), and never into a column the player's body stands in.

**GTNH mods** (mixin targets read from each class's `@Mixin` annotation, not grepped):

- Mixins on this path: ArchaicFix and Hodgepodge (the reach point, above); Backhand (only while
  the off-hand is used: `getCurrentItem` returns the off-hand item only when the selected slot
  is its off-hand slot, which a C09 of 0-8 never selects); ServerUtilities (vanished players
  only); StructureLib (a notification after `markAndNotifyBlock`; it never cancels).
- `PlaceEvent` handlers: ServerUtilities cancels in claimed chunks (`chunk_claiming=false` here)
  and re-sends the inventory; BlockLimiter's block list is empty on the test server; Thaumcraft
  cancels near an active boss; Et Futurum (trapdoors), GalaxySpace (the Moon), Gadomancy and
  Botany (their own blocks) do not touch plain blocks.
- `PlayerInteractEvent` handlers that look at RIGHT_CLICK_BLOCK together with held or vanilla
  blocks: GregTech (flint and steel only), Witchery (vampires, werewolves, one potion), Hunger
  Overhaul (crops and seeds), Battlegear (its off-hand mode and flags), Twilight Forest (its own
  dimension). None acts on a plain block item clicked on a plain block.
- No mod substitutes the vanilla blocks or items the agent places (`addSubstitutionAlias`: no
  hits).

**What the client does** (`src/bot/gtnh1710/placing.ts`, `Gtnh1710Client`): see
[architecture: placing](architecture.md#placing). The verdict: the clicked block's S23 is the
acknowledgement, cell updates before it are stale, and every cell update after it must be the
placed block over a quiet 250 ms; then the S2F with one item fewer (reported as `stackUsed`).
That acknowledgement and clicking the centre of the face follow mineflayer's `placeBlock` and
`_genericPlace` (MIT, © 2015 Andrew Kelley; mineflayer 4.39.0 is a dependency).
mineflayer-pathfinder (MIT, © 2020 Karang) sneaks when it must click an interactable block;
the agent never clicks one instead. No code was copied, and no LGPL code (Baritone) was used.
The fake server simulates all of the above (`tests/bot/gtnh1710/fake-placing.ts`).

_Assumptions, to check live:_

- the S23 and S2F order, and where the reach is measured from with both GTNH mixins applied;
- that no other `PlayerInteractEvent` or `PlaceEvent` handler cancels a plain placement;
- metadata is not compared: the block change carries it, but the client keeps only block ids
  (a placed plank's wood type and a log's axis are not checked).

## Machines (2026-09-30)

GregTech sends machine state to clients on its own plugin channel, `GregTech`. Each message is a
packet type byte, then the packet. _Verified_ with `javap` against `gregtech-5.09.51.482.jar`
(`GTNetwork`, `GTPacketTypes`, `GTPacketTileEntity`, `GTPacketBlockEvent`, `BaseMetaTileEntity`)
and GTNHLib 0.7.10 (`CoordinatePacker`):

- **TILE_ENTITY (type 0):** x:i32, y:i16, z:i32, mID:i16, six cover ids (i32), then common, update,
  redstone and colour bytes. It is sent for every machine (and pipe) when its chunk is sent.
- **The common byte** is `BaseMetaTileEntity`'s texture data: facing (bits 0–2) | active 8 |
  redstone 16 | upgrade lock 32 | works 64 | muffler 128.
  - "Active" means processing a recipe. "Works" means enabled, not switched off with a mallet.
  - For basic machines the facing is the output side (the opposite of the front).
- **BLOCK_EVENT (type 2):** dimension:i32, count:i32, then `count` coordinates as i64 and `count`
  shorts of (eventId << 8 | value).
  - Coordinates are packed x (26 bits) << 38 | z (26 bits) << 12 | y (12 bits), all signed.
  - When the common byte changes, the server sends event 0 (`CHANGE_COMMON_DATA`) with the new
    byte.
- **Pipes and cables send the same TILE_ENTITY packet**, but their common byte means connections.
  Only ids in GregTech's `MetaTileEntityIDs` enum are machines. `src/bot/gtnh1710/gt-machine-ids.ts`
  holds its 1,905 entries, extracted from the jar. It applies only when the server reports
  `gregtech_nh` 5.09.51.482; otherwise no GregTech block is treated as a machine (fail closed).
- **Stored energy, progress, recipe and inventory are not sent.** Power stays unknown.

The agent reports machines within 32 blocks as `gt:<x>.<y>.<z>` with the enum name:

| GregTech flags           | Status                                   |
| ------------------------ | ---------------------------------------- |
| works and active         | `busy`                                   |
| works, not active        | `idle`                                   |
| not works (switched off) | `error` (a human must switch it back on) |

Live test (_verified_, `node scripts/gt-machine-survey.ts`). Machines were placed over RCON with
`setblock x y z gregtech:gt.blockmachines 0 replace {mID:301,...}`. Note that `mWorks` is saved
inverted, so `mWorks:1b` means switched off.

| Placed                                                     | Seen                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| LV macerator, `mFacing:4s`                                 | common 69: works, facing 5 (the output side); `idle`                       |
| Steam macerator                                            | common 64; `idle`                                                          |
| LV macerator, `mWorks:1b`                                  | common 0; `error`                                                          |
| LV macerator mid-"recipe" (`mMaxProgresstime:400`, 0 EU/t) | common 72 (`busy`) at placement; 20 s later block event 0 with 64 → `idle` |

GregTech also sends one ORES packet (type 3) per GT ore block in range: 2,597 in 8 s on the test
world. These are not decoded yet.

## Interacting with blocks (2026-09-30)

`INTERACT_BLOCK`, `SMELT` and `TAKE_OUTPUT` right-click a block and work in its window.
`CRAFT_ITEM`, `OPEN_CONTAINER`, `DEPOSIT_ITEM` and `WITHDRAW_ITEM` can also use blocks the
observation found. What the agent knows about each kind of block is data: an interaction profile
in `src/domain/interactions.ts` ([how profiles work](architecture.md#interacting-with-blocks)).

Everything below was checked in the installed code (_verified_), not live: the shared test server
was not used. The fake server simulates it (`tests/bot/gtnh1710/gtnh-interact.test.ts`). The
sources are:

- the 1.7.10 server jar with Forge 10.13.4.1614's binpatches applied (as for crafting);
- Forge's universal jar;
- the mod jars in `mods/` (read with `javap`).

Block ids are this world's (`agent-test/level.dat`, FML `ItemData`).

**How windows open:**

- **A vanilla window** opens with S2D (window id, inventory type, title, slot count, whether the
  title is literal), then S30 with every slot:

  | Block          | S2D type | Title               | Slot count announced                  |
  | -------------- | -------- | ------------------- | ------------------------------------- |
  | Chest          | 0        | `container.chest`   | 27 or 54                              |
  | Crafting table | 1        | `Crafting`          | 9 (the window has 10 container slots) |
  | Furnace        | 2        | `container.furnace` | 3                                     |

- **A mod GUI** opens with Forge's OpenGui message instead. It comes on channel `FML`,
  discriminator 1: int window id, the mod id (VarInt length + UTF-8), int GUI id, then int x, y
  and z.
  - `FMLNetworkHandler.openGui` takes the next window id, then **closes the open container first**
    (`EntityPlayerMP.closeContainer`, so an open crafting table drops its grid).
  - It then sends OpenGui, then the slots (S30).
  - OpenGui carries no slot count and no title. The client takes the size from S30, and what
    each slot is for from the profile.
- **S31 Window Property:** u8 window id, i16 property, i16 value. The value is signed, so larger
  values wrap.
- **A profile accepts only a window it knows:** the exact opener (S2D type and announced count, or
  FML mod id and GUI id) and the exact slot count (its container slots + the player's 36). Any
  other window is closed again and the action fails.

**Furnace** (`minecraft:furnace` 61, `minecraft:lit_furnace` 62; server jar unless noted):

| Fact                                                                                                                                                                                         | Evidence                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Both are `BlockFurnace`. Lighting or going out swaps the block and keeps the tile entity, so `lit_furnace` means "burning" without opening it.                                               | `BlockFurnace.updateFurnaceBlockState`             |
| An empty-hand right-click sends S2D (type 2, `container.furnace` unless renamed, 3 slots).                                                                                                   | `EntityPlayerMP.displayGUIFurnace` (Forge-patched) |
| Slots: 0 input, 1 fuel, 2 output, 3-29 player main, 30-38 hotbar. Forge does not patch `ContainerFurnace`.                                                                                   | `ContainerFurnace`                                 |
| No `onContainerClosed` override: the furnace keeps its items when the window closes or the player leaves.                                                                                    | `ContainerFurnace`                                 |
| The fuel slot is a plain `Slot`, so the server accepts anything there. The agent puts only approved fuels.                                                                                   | `ContainerFurnace`                                 |
| `SlotFurnace.isItemValid` is false: nothing can be put into the output. Taking from it gives experience.                                                                                     | `SlotFurnace`                                      |
| S31 properties: 0 = ticks the current item has cooked (done at 200), 1 = burn ticks left, 2 = total burn ticks of the fuel item burning now. Sent when the window opens and on every change. | `ContainerFurnace.detectAndSendChanges`            |
| 200 ticks per item. A fuel item is lit only while something can smelt, the next one as soon as the current one ends. Cooking resets when the fire goes out.                                  | `TileEntityFurnace.updateEntity`                   |

**Furnace fuels** (`TileEntityFurnace.getItemBurnTime`, Forge-patched):

- GTNH's `MinetweakerFurnaceFix` (GTNewHorizonsCoreMod) lets any fuel handler's positive value win.
  About twenty mods add fuel handlers or `FuelBurnTimeEvent` subscribers. None changes the vanilla
  fuels the agent uses: GregTech's handler gives `gemCoal` and `gemCharcoal` 1600, as vanilla.
- So, per item (`furnaceFuelTicks`):

  | Fuel                                | Burn ticks | Items smelted |
  | ----------------------------------- | ---------- | ------------- |
  | Coal, charcoal (`minecraft:coal@1`) | 1600       | 8             |
  | Planks, logs                        | 300        | 1.5           |
  | Wooden slabs                        | 150        | 0.75          |
  | Sticks, saplings                    | 100        | 0.5           |
  | Coal block                          | 16000      | 80            |
  | Blaze rod                           | 2400       | 12            |

  Once a fuel burns, property 2 shows the server's own value.

- GTNH's CustomFuels (`config/GTNewHorizons/CustomFuels.xml`) makes **diamonds** burn: 102,400
  ticks, diamond blocks 1,024,000. That is more than the S31 short holds, so their timers would
  show wrapped. Diamonds are protected in the default config, and only approved fuels go in.
- Lava buckets are never used: the policy refuses any lava interaction.
- The default `approvedFuels` lists `minecraft:charcoal`, which is not a 1.7.10 item. Charcoal is
  `minecraft:coal@1`.

**What a furnace makes is decided by the server.** For example, GregTech removes log-to-charcoal
smelting (`ProcessingLog` calls `removeFurnaceSmelting` for each log whose result is charcoal), and
ores are processed in GregTech machines. The agent has no smelting table: `TAKE_OUTPUT` takes only
the item the output slot shows. The planner is told never to assume a result it has not seen.

**Mods that touch furnaces** (checked; none changes the above):

- GregTech's mixin on `TileEntityFurnace` only adds pollution.
- EnderCore's `ContainerFurnace` transformer changes shift-clicks, which the agent never uses.
- Et Futurum changes the furnace's sounds.

**The other profiles:**

| Profile            | Block (id)                          | Opener                                   | Window                                                                                                     |
| ------------------ | ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `crafting_table`   | `minecraft:crafting_table` (58)     | S2D type 1, `Crafting`, 9                | 0 result, 1-9 grid; the grid is dropped on close ([Crafting](#crafting-2026-09-30)).                       |
| `chest`            | `minecraft:chest` (54)              | S2D type 0, 27 or 54                     | Storage. Verified live ([Chests](#chests-2026-09-30)).                                                     |
| `trapped_chest`    | `minecraft:trapped_chest` (146)     | as a chest                               | Never opened (see below).                                                                                  |
| `iron_chest`       | `IronChest:BlockIronChest` (1222)   | FML `IronChest`, GUI id = the chest type | Storage; the size depends on the type (see below).                                                         |
| `hungry_chest`     | `Thaumcraft:blockChestHungry` (250) | S2D type 0, `Hungry Chest`, 27           | Storage.                                                                                                   |
| `crafting_station` | `TConstruct:CraftingStation` (524)  | FML `TConstruct`, GUI 11                 | 0 result, 1-9 grid, player 10-45, then the slots of an adjacent chest, if any. Looked at only (see below). |

- **Trapped chest:** `BlockChest` type 1 provides power, and its weak power is the tile entity's
  `numPlayersUsing`, which opening raises. Opening one emits a redstone signal, so it is never
  opened.
- **Iron Chests 6.1.6:**
  - `BlockIronChest.onBlockActivated` calls `openGui(IronChest, type.ordinal(), ...)`. Nothing opens
    when the block above is solid underneath, or an ocelot sits on it.
  - Sizes by GUI id: 0 IRON 54, 1 GOLD 81, 2 DIAMOND 108, 3 COPPER 45, 4 STEEL 72, 5 CRYSTAL 108,
    6 OBSIDIAN 108, 7 DIRTCHEST9000 1, 8 NETHERITE 135, 9 DARKSTEEL 135, 10 SILVER 72.
  - `ContainerIronChest` lays out the chest slots (`ValidatingSlot`), then the player's 27 and 9.
    It keeps the items when closed.
  - The dirt chest's one slot takes only dirt, so the agent only ever takes from it.
- **Thaumcraft 4.2.3.5a hungry chest:** `BlockChestHungry.onBlockActivated` calls
  `displayGUIChest(TileChestHungry)`: a plain chest window, items kept. It also swallows item
  entities that touch it; the agent never drops items.
- **Tinkers' crafting station** (TConstruct 1.13.57-GTNH; in the Age 0 quest book as "A Better
  Crafting Table"):
  - `CraftingStationBlock` opens `openGui(TConstruct, 11, ...)` unless the player sneaks.
  - The grid lives in the station: `InventoryCraftingStation.getStackInSlotOnClosing` returns
    null, so closing keeps it there, and it may already hold another player's items.
  - An adjacent chest adds its slots after the player's 36.
  - So `INTERACT_BLOCK` only looks at it for now. Crafting there needs both handled, and is next.

**Room for later, not built:**

- **Mod payloads.** Some GUIs need a packet besides clicks: Tinkers' stencil table chooses its
  pattern on channel `TConstruct`. A profile has `modPayloads` for such typed actions; none uses
  it, and the client cannot send any.
- **State from tile-entity data.** A Tinkers smeltery's contents come from tile-entity data, not
  slots. Profiles have `stateSource: 'window'` today.
- **Profiles by metadata or GregTech machine id.** Profiles are chosen by block name only.

### Storage blocks in GTNH 2.8.4

How the server's storage blocks are opened and used, and what the agent does with each. Ids are
this world's.

| Blocks (id)                                                                                                                                                                                                                                                                                                                                                                                                                           | How they are used (_verified_ in the jars unless "not checked")                                                                                                                                                                                                                                                                                                                                                                                                                                             | Agent                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minecraft:chest` (54), `IronChest:BlockIronChest` (1222), `Thaumcraft:blockChestHungry` (250)                                                                                                                                                                                                                                                                                                                                        | Window with plain storage slots (above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **Profiles.** Listed in `GameState.storage`; usable with the container actions.                                                                                                     |
| `minecraft:trapped_chest` (146)                                                                                                                                                                                                                                                                                                                                                                                                       | Chest window, but opening emits redstone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Known, never opened.                                                                                                                                                                |
| `gregtech:gt.blockmachines` (2693): super chests (machine ids 135-139), quantum chests (125-129), super tanks (130-134), quantum tanks (120-124)                                                                                                                                                                                                                                                                                      | One block for every GregTech machine; GregTech's TILE_ENTITY packet says which machine it is ([Machines](#machines-2026-09-30)). Right-click opens a ModularUI 1 window (`MTEDigitalChestBase.addUIWidgets`), through FML OpenGui with mod `modularui`. Its GUI id is handed out at start-up (`InternalUIMapper.register`), so it is not a constant. Only an input and an output slot are real slots. The stored count (up to 2^31) is synced by ModularUI's own packets (`clientItemCount`), not by slots. | **Next.** Needs a profile keyed by machine id, ModularUI window matching, and ModularUI's sync decoded for the count. Not listed as storage.                                        |
| `StorageDrawers:fullDrawers1/2/4` (3954-3956), `halfDrawers2/4`, `fullCustom1/2/4`, `halfCustom2/4`, `controller` (3959), `controllerSlave`, and the `StorageDrawersBop`, `…Forestry`, `…Natura`, `…Misc` variants                                                                                                                                                                                                                    | Not a window. `BlockDrawers.onBlockActivated`: on the front face only, the drawer under the cursor (`getDrawerSlot`, by hit position) takes the held item. A second right-click within 10 ticks puts **every matching item of the inventory** in (`TileEntityDrawers.interactPutItemsIntoSlot`). A left-click takes items out, sent by the client as the mod's own packet (`BlockClickMessage`). An empty-hand sneak-click opens a GUI. The contents come in the tile entity's S35 update (its whole NBT).  | **Next:** its own interaction kind (facing, hit position, held item, a mod packet to take out, contents from S35). Never right-clicked now, not even on the observe-only allowlist. |
| `JABBA:barrel` (3652)                                                                                                                                                                                                                                                                                                                                                                                                                 | Not a window. Right-click: `TileEntityBarrel.rightClick`. With an empty hand it calls `manualStackAdd` (items from the player's inventory go in); sneaking toggles the lock; held upgrades and tools configure it. Left-click (`leftClick`) takes items out.                                                                                                                                                                                                                                                | **Next**, like drawers. Never right-clicked now.                                                                                                                                    |
| `EnderStorage:enderChest` (4084)                                                                                                                                                                                                                                                                                                                                                                                                      | Shared by colour frequency (`EnderItemStorage`). Its window opens through CodeChickenCore's `ServerUtils.openSMPContainer` with its own packet: neither S2D nor OpenGui.                                                                                                                                                                                                                                                                                                                                    | **Next** (needs that packet decoded). Never right-clicked now: the client would not recognise the window, and the server would keep it open.                                        |
| `appliedenergistics2:tile.BlockDrive` (606), `tile.BlockChest` (607), `tile.BlockInterface` (608), `tile.BlockController` (604); terminals are parts on `tile.BlockCableBus` (603)                                                                                                                                                                                                                                                    | FML OpenGui (`Platform.openGUI`, mod `appliedenergistics2`). The GUI id encodes the GUI type and the clicked side. The ME drive's window has 10 cell slots + 36. A network's items are synced by AE2's own packets, not slots.                                                                                                                                                                                                                                                                              | **Observe-only** (`MC_INTERACT_OBSERVE_ONLY=appliedenergistics2:*`): opened, recorded, closed. Nothing inside is clicked.                                                           |
| `TConstruct:CraftingStation` (524)                                                                                                                                                                                                                                                                                                                                                                                                    | Above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Profile**, looked at only.                                                                                                                                                        |
| Backpacks (items): `Forestry:minerBag`, `foresterBag`, `hunterBag`, `builderBag`, `adventurerBag`, `lepidopteristBag` (and T2), `Backpack:backpack`, `adventurebackpack:adventureBackpack`, `Railcraft:backpack.*`, `MagicBees:backpack.*`                                                                                                                                                                                            | Opened by using the item in hand, not a block (not checked further).                                                                                                                                                                                                                                                                                                                                                                                                                                        | **Next.** The agent clicks only with an empty hand.                                                                                                                                 |
| `Railcraft:machine.beta` (1069)                                                                                                                                                                                                                                                                                                                                                                                                       | One block for many machines, told apart by metadata. They include the void chest (`TileChestVoid`, destroys what goes in) and the metals chest (`TileChestMetals`, converts nuggets, ingots and blocks).                                                                                                                                                                                                                                                                                                    | **Never a storage profile by block name.** It would need a profile by metadata.                                                                                                     |
| `minecraft:ender_chest` (130), `minecraft:hopper` (154), dispensers and droppers                                                                                                                                                                                                                                                                                                                                                      | Not checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | No profile yet.                                                                                                                                                                     |
| `Forestry:apicultureChest` (1021), `Forestry:lepidopterology` (1047), `Forestry:arboriculture` (1041, by metadata), `ExtraUtilities:chestFull` (441), `chestMini` (440), `filing` (469), `trashcan` (478), `BiblioCraft:tile.BiblioFramedChest` (1669) and shelves, `avaritiaddons:InfinityChest` (1667), `cookingforblockheads:fridge` (4091), `ProjRed\|Exploration:projectred.exploration.barrel`, `TConstruct:CraftingSlab` (525) | Not checked. By its name, `ExtraUtilities:trashcan` destroys items.                                                                                                                                                                                                                                                                                                                                                                                                                                         | No profile yet. Each needs its own check before a profile.                                                                                                                          |
| `irontank:*Tank` (3642-3651)                                                                                                                                                                                                                                                                                                                                                                                                          | Fluid tanks, not item storage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Not handled.                                                                                                                                                                        |

**Credit:** the window model (a block's slots, then the player's inventory range, plus a result
slot) follows the ideas of [prismarine-windows](https://github.com/PrismarineJS/prismarine-windows)
and Mineflayer's furnace and crafting plugins (both MIT). No code was copied. Their numbers are for
later Minecraft versions (Mineflayer's furnace properties are 1.8's), so every number here was
checked in the 1.7.10 and GTNH jars.

**Not verified:** any of this live. Iron Chests chests, hungry chests and the crafting station
were only checked in their jars and the fake server. As with chests, spawn protection would stop
a non-operator from opening blocks near spawn.

## Entity tracking (2026-09-30)

Verified with `scripts/entity-survey.ts` (20 s of live traffic) and `pnpm cli observe --live --radius 64`:

- **Most hostile mobs in GTNH are modded.** _Special Mobs_ replaces vanilla monsters with variants
  (24 type IDs seen in 20 s); EnderZoo and Et Futurum add more. They are announced on Forge's
  `FML` channel, not with the vanilla Spawn Mob packet. Vanilla packets still carry vanilla mobs
  (creepers, skeletons, spiders, zombies, bats, cows, squid) and objects (dropped items).
- **FML entity messages** (channel `FML`, verified layout): discriminator 2 = spawn
  (`int entityId, string modId, int modEntityTypeId, int x/y/z` in 1/32 blocks, then rotation,
  DataWatcher and spawn data, which the agent does not need); 3 = position adjust
  (`int entityId, int x/y/z`). Afterwards modded entities move with the vanilla move/teleport
  packets. 43 spawns and 17 adjusts in 20 s, zero parse errors.
- **Forge sends only a mod and a number for modded entities** (e.g. `etfuturum#3`), never the
  entity's name. Numbers are fixed by each mod's code (not per world), but mods assign them
  through wrappers and loops, so there is no simple table. The server's TRACE log lists
  registrations by name and order, without the numbers.
- **Classification (fail closed):** vanilla mob IDs use an exact table; `SpecialMobs` is hostile
  as a whole mod; every other modded type is **unclassified and treated like a hostile** until
  it is identified. Only exact, verified entries may mark a modded type passive
  (`MODDED_ENTITIES` in `src/bot/gtnh1710/entity-types.ts`, empty for now). Example today:
  `etfuturum#3` (11 of them, probably rabbits) counts as unidentified.
- **Entities arrive after their chunks.** The server sends a chunk's entities in the same tick as
  the chunk, streaming chunks nearest-first (5 per tick; all 9 chunks under a 16 m radius within
  ~0.2 s, all 252 within ~2.5 s). Before this was handled the client reported "0 threats" 85 ms
  before the first chunk arrived. Threats are now reported only once every chunk overlapping the
  scan radius has arrived plus 250 ms; `connect()` waits for that (bounded by
  `initialStateGraceMs`), and an unloaded nearby chunk makes threats unknown again.
- **NotEnoughIDs** did not change the Map Chunk Bulk header (column count, data length,
  sky light, per-column metadata; parsed with 0 bytes left over). Block data is not decoded yet.
- **Coverage is declared:** the entity scan radius is 16 m; if `hostileThreatRadius` is
  configured larger, the state is treated as unknown rather than "no hostiles".

**Identifying modded entity types** (`scripts/identify-entities.ts`): Forge never sends names,
but the server saves every entity with its registry name and position. The tool keeps the
read-only client connected, snapshots where it sees each entity, reads the chunks the server
saves (region files: header timestamps, zlib NBT, `Level.Entities[].id/Pos`), and counts a vote
when a saved entity's nearest live entity (within 1.5 blocks, within 3 s of the save) is a modded
one. Two runs (150 s + 600 s): 4,750 saved entities read, 206 matches, **no conflicting votes**. `etfuturum#3` = `etfuturum.rabbit` (175/175 votes; now passive), and 13 Special Mobs types named (e.g. `#24` FireCreeper, `#64` GiantSkeleton, `#89` ToughSpider). Results go into `MODDED_ENTITY_TABLE` (`src/bot/gtnh1710/entity-types.ts`) with their evidence and the mod
version they were verified with; an entry applies only when the server runs that exact version.
A `passive` entry needs at least 10 votes, all agreeing (enforced by a test).

## Combat (2026-09-30)

`ATTACK_ENTITY` and System 1's `DEFEND` (see [architecture: combat](architecture.md#combat)) are
built on the server's own code, checked with `javap` in the test server's jars the same way as
digging: vanilla `minecraft_server.1.7.10.jar` with Forge 10.13.4.1614's binary patches applied,
and the mod jars below. They are tested against the fake server's combat simulation
(`tests/bot/gtnh1710/fake-combat.ts`); **they have not been run live yet.** Classes: `nh`
(NetHandlerPlayServer), `ja`/`jb` (C02 and its action), `yz` (EntityPlayer), `mw`
(EntityPlayerMP), `sv` (EntityLivingBase), `te` (DataWatcher), `gt` (S19), `hw` (S1C), `fz`
(S0F), `mn`/`my` (EntityTracker and its entries), `agw` (Explosion), `aeh` (ItemSword), `acg`
(ItemTool), `abf` (ItemAxe), `adc` (ToolMaterial), `ro`/`rp` (DamageSource).

**The packet** (_verified_). C02 Use Entity (serverbound 0x02): i32 entity id, then a byte read
as `values()[b % 2]`: 0 interact, 1 attack. The agent only ever sends 1 (`outbound.attackEntity`).

**What the server checks** (`processUseEntity`, _verified_):

- The target must be in the player's world and closer than **6 blocks (distance² < 36) if the
  player can see it**, otherwise **3 (< 9)**. Both distances are feet to feet. "Can see" is a
  block ray trace from the player's eyes to the target's eyes.
- No rate limit, and no check of where the player looks. The agent still looks first (C05) and
  swings its arm (C0A), as a player's client does.
- Attacking a dropped item, an experience orb, an arrow or the player itself **kicks the
  player** ("Attempting to attack an invalid entity"). The agent never attacks objects.

**The blow** (`EntityPlayer.attackTargetEntityWithCurrentItem`, _verified_):

- Forge posts `AttackEntityEvent` (mods may cancel it), then the held item's `onLeftClickEntity`
  (it may skip the attack). That is why the agent strikes only with an empty hand or an
  allowlisted plain tool.
- Damage is the player's attack damage attribute: **1.0 for a bare hand**. A held tool adds its
  modifier: an axe 3 plus its material's bonus (wood 0, stone 1, iron 2, diamond 3, gold 0), so
  4, 5, 6, 7 and 4 in all; a sword 4 plus the bonus. A critical hit needs falling, which the
  agent never does.
- The held item's modifiers take effect only after the server's next player tick (the next C03),
  so the first swing waits two ticks after selecting a weapon.
- A hit wears the weapon (a tool 2, a sword 1) and costs 0.3 exhaustion.

**Damage and hurt resistance** (`EntityLivingBase.attackEntityFrom`, _verified_): a full hit sets
the hurt-resistance timer to 20 ticks; while it is above 10, a new hit only deals what exceeds
the last one. So one full hit per 10 ticks; the agent swings every 12. A full hit sends **S19
Entity Status 2** (hurt) to everyone tracking the target and knocks it back (0.4). Death runs
Forge's `LivingDeathEvent` first, then sends **S19 status 3**; the body is removed 20 ticks later
(S13). The new health goes out in **S1C Entity Metadata**, DataWatcher index 6 (float), the same
tick it changes.

**DataWatcher** (_verified_, `te`): entries are a header byte (type << 5 | index), ending with
0x7F; types 0 byte, 1 short, 2 int, 3 float, 4 string, 5 item stack, 6 three ints. The indices
the agent reads: 6 health; 10 custom name (a name tag); 12 age (EntityAgeable, negative for a
baby); 16 a pig's saddle. S0F Spawn Mob carries the full DataWatcher after the velocity, and
FML's modded spawn message carries it after the three rotation bytes. A DataWatcher the client
cannot read leaves health, owner and age unknown (never a crash), and an unknown owner or age
makes a farm animal unattackable.

**Knockback never moves the agent:** `processPlayer` re-applies the player's last position before
the client's own move, so the server moves the player only with an explicit correction (S08),
which stops the burst.

**GTNH mods** (all mod jars were scanned for `AttackEntityEvent`, `LivingAttackEvent`,
`LivingHurtEvent` and `LivingDeathEvent` handlers and for mixins on the attack code):

- **Battlegear 2** (`battlegear2-1.5.9-backhand`): cancels a **bare-hand** attack beyond
  4.5 − 2.2 = **2.3 blocks**. The agent strikes bare-handed only within 2.2.
- **IguanaTweaks** (`IguanaTweaksTConstruct-2.6.6`, `disableRegularSwords=true` on the server):
  cancels the damage of every vanilla sword (the hurt status is still sent, so a sword hit looks
  like a hit and does nothing). **Swords are not weapons for the agent**: only vanilla axes are.
  Its vanilla tool nerf only slows digging (`BreakSpeed`), not damage.
- **AngerMod** (`AngerMod-0.9.0`, `KamikazeChance=10`): when a player (not a fake player) kills
  any living entity, there is a **10% chance of an explosion of power 1.5** where it died
  (no block damage), unless the held item is on the mod's blacklist (GregTech's knife and
  butchery knife, `gt.metatool.01` 34 and 36, among others). Attacking also ends the mod's
  90-second spawn protection. The agent holds back a blow that may kill while that explosion
  could leave it under 4 health (see below). A GregTech knife would prevent the explosion, but
  GregTech tools keep their stats in NBT data, and the agent never strikes with such a stack
  (yet). The server's `angermod.cfg` also enables
  `FriendlyMobRevenge`: eating a food whose name contains chicken, egg, beef, pork or mutton
  makes that kind of animal within 16 blocks angry or flee (not examined further; the agent does
  not track it).
- **Explosion damage** (`agw`, Forge-patched, _verified_): the radius is doubled, and an entity
  at distance `d` takes `floor(((1 − r)² + (1 − r)) / 2 × 16 × power + 1)` with `r = d / (2 ×
power)` and full exposure, × 1.5 for a player on Hard (the test server's difficulty 3). Power
  1.5: 37.5 at 0 blocks, 15 at 1.5, 9 at 2, 1.5 at 3, nothing beyond. A vanilla creeper (power 3)
  reaches 6 blocks; **Special Mobs' Death and Gravity creepers explode with power 5** (10 when
  charged: 20 blocks). The agent fights nothing that explodes, backs off within 16 blocks, and
  treats every unidentified mob as a possible creeper.
- **Special Mobs** (`SpecialMobs-3.6.3`): type numbers follow the mod's registration order
  (12 kinds, each "Special<Mob>" then its variants, then two projectiles; 108 in all, creepers
  16–30). The derived table (`src/bot/gtnh1710/special-mobs.ts`) matches all 13 types
  identified live, and applies only to 3.6.3. Every creeper variant explodes; pigmen,
  endermen, silverfish and ghasts are never attacked.
- **Infernal Mobs** (`InfernalMobs-1.10.3-GTNH`, `eliteRarity=20`): about 1 mob in 20 is an elite
  with modifiers (e.g. Vengeance reflects half the damage dealt). Nothing in the vanilla packets
  shows it. The mod answers a client's question on its own channel `AS_IF` (`MobModsPacket`:
  byte, short length + UTF-16 player name, i32 entity id), but **the agent does not ask**
  (untested). Every fight stops at the first damage the agent takes, which also covers reflected
  damage.
- **Hunger Overhaul** (`minHungerToHeal=8`): no natural healing below food 8, so the agent does
  not fight below food 8.
- **Backhand** (`backhand-1.7.7`) only changes off-hand attacks. **ServerUtilities** checks chunk
  claims (off on the test server). **Et Futurum** only adds sounds. **ArchaicFix** lets a click
  on a block without a collision box (grass, flowers) hit the entity behind it; the agent sends
  no block clicks while fighting.
- **OpenBlocks graves** (from `config/OpenBlocks.cfg`, not checked in code): if the agent dies,
  its items go into a grave block where it died (`storeContents=true`), and graves now and then
  spawn skeletons around them (`spawnSkeletons=true`). The agent cannot recover a grave; a death
  needs a human.
- **Server settings:** `difficulty=3` (Hard), `pvp=true`.

_Assumptions, to check live:_

- that no other mod changes axe damage, reach or hurt resistance (the scan found none that applies
  to a vanilla axe or a bare hand);
- that FML's modded spawn message carries the DataWatcher where the code says (the vanilla
  layout is covered by tests; a parse failure only leaves health unknown);
- that the server keeps up with the 12-tick swing rhythm (at low TPS some hits are absorbed by
  hurt resistance; they are then not counted as hits);
- the line-of-sight check counts every non-air block as an obstacle, so behind glass or leaves the
  agent uses the shorter 2.9-block reach.

## Lava, void and damaging blocks (2026-09-30)

- **NotEnoughIDs (`neid` 2.1.10) changes the block data format.** Verified from its mixins
  (`Constants`: 20,480 bytes per section, 327,936 per full column; `getBlockData()` writes the
  16-bit ids through a default, big-endian `ByteBuffer`; the add/MSB arrays are removed) and on
  252 live columns, every inflated byte accounted for. Per column: all sections' u16 ids, then
  u16 metadata, block light, sky light, biomes.
- **Block changes are NEID-format too:** Block Change (0x23) metadata is a short; Multi Block
  Change (0x22) records are 6 bytes (u16 position, u16 id, u16 metadata). Verified live (flowing
  water/lava updates parsed with 0 bytes left over).
- **Hazard table** (`src/bot/gtnh1710/block-hazards.ts`): built by reviewing every GTNH 2.8.4
  block name matching burning/fluid/poison/contact-damage keywords (252 candidates). Kinds:
  `lava` (lava, molten metals, magma, pyrotheum, hot coolant, steam), `fire`, `harmful_fluid`
  (flux goo, liquid death, poison, sludge, acid), `damaging_block` (cactus, thorns, brambles,
  spikes, bear traps, berry bushes). Decorative look-alikes are excluded (fireproof wood,
  firefly jars, lava tanks, lavastone, wall markings). Conservative: when unsure, listed.
- **Void** = a column with no block at all from y=0 up to the player's feet (a drop into the void).
- **Scan:** sphere of 32 m for blocks, circle of 32 m for void columns; only exposed hazard blocks
  (a face not touching another hazard) and void-area edges are listed, since the nearest hazard
  to any outside point is always one of those. At most 256 are listed; beyond that the declared
  `scanRadius` shrinks to what the list completely covers. Fail closed: any column in range that
  has not arrived, could not be decoded, or contains a block id missing from the registry makes
  hazards unknown; a lost block-change packet makes them unknown for the session.
- **Live cross-check:** a 90 m diagnostic scan (23 ms) found 199 cacti (desert around spawn, the
  nearest at 33.6 m, just outside the agent's 32 m scan) and exposed lava at (-56, 55, 34),
  (-56, 53, 32), ...: the same blocks an independent probe found.
- A bug caught by tests before it reached the agent: the first void check looked at the whole
  16x16 layer of a chunk section instead of the single column, so it could never report void.

## Biomes and world memory (2026-09-30)

- **Biome ids arrive with the chunk data.** A ground-up column (every Map Chunk Bulk column,
  and Chunk Data with ground-up set) ends with 256 bytes: one biome id per column, index
  `z << 4 | x`, as vanilla 1.7.10 stores them. NotEnoughIDs 2.1.10 does not touch them (its
  mixins change block ids and metadata only), and the decoder's length check already counted
  these 256 bytes on the 252 live columns above. `decodeChunkColumnWithBiomes` /
  `decodeChunkBulk` now keep them; an id of 255 means "not set".
- **Ids are numbers only.** Forge's registry handshake names blocks and items, never biomes,
  so names come from a table (`src/bot/gtnh1710/biomes.ts`): vanilla 1.7.10 plus the ids in
  the test server's config (BiomesOPlenty `ids.cfg`, Realistic World Gen `RWG.cfg` (the world
  generator), Thaumcraft, BuildCraft, GT++, AE2). Unknown ids show as `biome #<id>`.
- **Checked against the world itself** (read-only, the test world's region files, 654 chunks):
  spawn (0, 64, 0) is in 230 Hot Desert (RWG), with 229 Hot Forest to the south (from about
  z=32), 43 Bamboo Forest (BOP) to the south-east, and 211 River Oasis, 49 Canyon, 209 Wet River,
  190 Eerie and 207 Hot River further out. Every id found is in the table.
- **What the survey sees on real chunks** (`world-survey.ts` run on those region files, eyes at
  ground level): at spawn, 24 chunks of Hot Desert/Hot Forest with 832 sand and 39 leaves in
  view; in the forest at (40, 78, 72), 23 logs, 352 leaves, 70 sand and 6 stone; in the Bamboo
  Forest at (140, 64, 90), only leaves (BOP bamboo and BOP logs are not vanilla logs, so not
  counted). 17-52 ms per 25-chunk survey. Forest floors there are dense with leaf bushes and
  BOP foliage: the line of sight lets sight through plants and at most 2 leaf blocks.
- **Limits:** the walker passes only the plants checked in their code (BOP foliage, flowers,
  plants and vines among them since 2026-10-01: [Walking through plants](#walking-through-plants-2026-10-01));
  every other modded block (BOP bamboo, say) is a wall. Ores count only when seen; GregTech
  keeps an ore's material in a tile entity the client does not read, so the memory says
  "ore", never which.

## Walking through plants (2026-10-01)

Seen live: on a "Hot Forest" hillside the walker could not reach logs 7 blocks away. The
straight line to them was blocked three times by `BiomesOPlenty:foliage` at feet level (and by
leaf bushes and a cactus), because the walker took every block it did not list for a wall.
It now passes the plants below (`src/bot/gtnh1710/passable.ts`). Each was _verified_ in the
code the test server runs: `javap` on the vanilla server jar's classes (named through Forge's
`deobfuscation_data-1.7.10.lzma`), Forge 1.7.10's patches to them, and the jars in `mods/`.
A block is passable when:

- it has no collision box: `getCollisionBoundingBoxFromPool` (`func_149668_a`) returns null,
  and nothing overrides `addCollisionBoxesToList` (`func_149743_a`), where the server's
  `moveEntity` gets boxes from (`Block`'s adds that one box, or none);
- nothing happens on contact: `onEntityCollidedWithBlock` (`func_149670_a`), which
  `Entity.doBlockCollisions` calls for every block the body overlaps, is `Block`'s empty one,
  or acts only on variants not listed;
- nothing changes either: Forge's patches to these classes add plant types, shearing, drops,
  placement rules and (vines) `isLadder`; the mixins in all mod jars that touch them hook growth (AppleCore,
  `updateTick`), drops and shearing (bugtorch), the snow layer's client-side rendering
  (bugtorch) or rendering (GregTech's pollution).

| Block (metadata passed)                                                                                                                    | Class (jar)                                                                                                                                                                    | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minecraft:tallgrass`, `yellow_flower`, `red_flower`, `double_plant`, `deadbush`, `sapling`, `brown_mushroom`, `red_mushroom` (any)        | `BlockTallGrass` (`anz`), `BlockFlower` (`alc`), `BlockDoublePlant` (`ako`), `BlockDeadBush` (`akh`), `BlockSapling` (`anj`), `BlockMushroom` (`amc`), all `BlockBush` (`ajr`) | `BlockBush`'s box method is `aconst_null; areturn`; none overrides it or the contact method                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `minecraft:reeds` (any)                                                                                                                    | `BlockReed` (`ane`)                                                                                                                                                            | box null; no contact method                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `minecraft:vine` (any)                                                                                                                     | `BlockVine` (`aoh`)                                                                                                                                                            | box null; no contact method. Forge makes it a ladder (`isLadder` true): a vanilla client in it walks at most 0.15 blocks a tick and climbs at a wall. The server's movement check (`nh`, processPlayer, as Forge patches it) undoes the player's own tick, where a ladder would act (`mw.i()`, then the last position back with `mw.a(DDDFF)`), then re-runs `moveEntity` (`mw.d(DDD)`) with the move and compares; it never calls `isOnLadder` (`sv.h_`), nor does any mixin on it. So the agent's 0.2-block ground steps through hanging vines are accepted |
| `minecraft:snow_layer` (0)                                                                                                                 | `BlockSnow` (`ann`)                                                                                                                                                            | box `(meta & 7) * 0.125` high: flat for one layer, at the top of the block under it, so the feet stay on a block top; a thicker layer would lift them                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BiomesOPlenty:foliage` (all but 7)                                                                                                        | `BlockBOPFoliage` → `BOPBlockWorldDecor` → `BlockBush` (BiomesOPlenty 2.1.0.2308)                                                                                              | 0-15: duckweed, short grass, medium grass, flax (lower), bush, sprout, flax (upper), poison ivy, berry bush, shrub, wheat grass, damp grass, koru, clover patch, leaf pile, dead leaf pile. Contact: 7 (poison ivy) poisons a living entity for 100 ticks; a player only when it lacks boots or leggings (`poisonIvyEffects`)                                                                                                                                                                                                                                 |
| `BiomesOPlenty:flowers` (all but 2)                                                                                                        | `BlockBOPFlower`                                                                                                                                                               | contact: 2 (deadbloom) withers for 200 ticks unless the player wears leather boots and leggings                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `BiomesOPlenty:flowers2` (0-8 but 2)                                                                                                       | `BlockBOPFlower2` (9 variants)                                                                                                                                                 | contact: 2 (burning blossom) sets a player on fire (`setFire(1)`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BiomesOPlenty:plants` (all but 5, 12)                                                                                                     | `BlockBOPPlant`                                                                                                                                                                | contact: 5 (thorn) and 12 (cactus) deal cactus damage unless the player wears leather boots and leggings                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `BiomesOPlenty:mushrooms`; `ivy`, `willow`, `treeMoss`, `flowerVine`, `moss` (any)                                                         | `BlockBOPMushroom` → `BlockBush`; `BlockIvy`, `BlockWillow`, `BlockTreeMoss`, `BlockFlowerVine`, `BlockMoss` → `BlockVine`                                                     | no override (the vines are ladders, as above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Natura:N Crops`, `Natura:Bluebells` (any)                                                                                                 | `CropBlock` → `BlockBush`, `FlowerBlock` → `BlockFlower` (Natura 2.8.9)                                                                                                        | no override; AppleCore overwrites only `CropBlock.updateTick`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `harvestcraft:berrygarden` and the other 11 gardens (desert, grass, gourd, ground, herb, leafy, mushroom, stalk, textile, tropical, water) | `BlockGarden` → `BlockFlower` (HarvestCraft 1.3.2-GTNH)                                                                                                                        | no override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Registry names are the mods' own: BOP registers each block under its `setBlockName` name
(`BOPBlocks.registerBlock`), Natura and HarvestCraft name theirs in `GameRegistry.registerBlock`.

**Metadata.** BOP's variants share one block id, so the client now keeps block metadata:
vanilla's nibble per block, and NotEnoughIDs' 16-bit value (`MixinExtendedBlockStorage`
writes its `short[]` big-endian and reads it back as `meta & 0xFFFF`; Block Change's short
(`MixinS23PacketBlockChange`) and Multi Block Change's u16 (`MixinS22PacketMultiBlockChange`)
are read unsigned the same way). A variant passes only at a listed metadata the client knows;
unknown metadata, or a variant not listed, is a wall.

**Not hazards.** The harmful variants hurt only a body inside their cell (they have no box to
touch from beside), so they are not in the hazard table: the walker never enters them, and
may stand next to them.

**Left out:** BOP bamboo (it has a box), leaves (full boxes), cobwebs (they slow: the server's
`moveEntity` would not match the client's steps), farmland crops (HarvestCraft's and vanilla's
grow on farmland, which the walker never stands on), and every block not checked.

## Quest book (Better Questing) (2026-09-30)

The "Finish Age 0" benchmark is scored from the quest book's OWN records: the quests Better
Questing records as completed for the agent's player, exactly as when a player completes them
through the GUI. The agent reads those records over Better Questing's own channel and makes the
GUI's clicks (submit, checkbox, reward choice, claim) as typed actions. Everything below is
_verified_ with `javap` in the test server's `mods/BetterQuesting-3.7.15-GTNH.jar` (it holds
`bq_standard` too) and in the test world's quest database. It is tested against the fake server
(`tests/bot/gtnh1710/fake-better-questing.ts`) and has **not** been run live yet.

| Fact                                                                                                                                                                                                                                                                                                                  | Evidence (class, method)                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One Forge channel, `BQ_NET_CHAN`, with one message type, `PacketQuesting`, discriminator 0 in both directions.                                                                                                                                                                                                        | `betterquesting.core.BetterQuesting.preInit`: `newSimpleChannel("BQ_NET_CHAN")`, `registerMessage(PacketQuesting$HandleClient, PacketQuesting, 0, CLIENT)` and `(PacketQuesting$HandleServer, PacketQuesting, 0, SERVER)`.                                                                                     |
| The body is one NBT compound written with `ByteBufUtils.writeTag` (i16 length, gzip'd NBT).                                                                                                                                                                                                                           | `PacketQuesting.toBytes` / `fromBytes`.                                                                                                                                                                                                                                                                        |
| Every message is sliced: the gzip'd payload goes out in slices of at most 20,480 bytes, each `{size: int, index: int, end: byte, data: byte[]}`; the payload's String `ID` names the handler.                                                                                                                         | `PacketAssembly.bufSize = 20480`, `splitPacket`, `assemblePacket` (keys `size`, `index`, `end`, `data`); `PacketSender.sendTo*` put `ID`.                                                                                                                                                                      |
| At login the server sends `betterquesting:main_sync {reset: true, respond: true}`. A client answers with an EMPTY main_sync, and only that answer makes the server send the database: settings, `quest_sync` (configs and this player's progress), `chapter_sync`, names, parties, and `cache_sync` (the active set). | `handlers.EventHandler.onPlayerJoin` → `NetBulkSync.sendReset(player, true, true)`; `NetBulkSync.onClient` (`respond` → `sendToServer(new QuestingPacket(ID, new NBTTagCompound()))`); `NetBulkSync.onServer` → `sendSync` → `NetQuestSync.sendSync`, `NetChapterSync.sendSync`, ..., `NetCacheSync.sendSync`. |
| `betterquesting:quest_action {action, questIDs}`: 0 claims (if `canClaim`), 1 detects (the GUI's submit button), 2 claims "forced". No reach, GUI-open or rate check.                                                                                                                                                 | `NetQuestAction.onServer` (`tableswitch` 0-2 → `claimQuest` / `detectQuest` → `IQuest.detect` / `forceClaimQuest`).                                                                                                                                                                                            |
| `bq_standard:task_checkbox {questID, taskID}` completes a checkbox task, with no unlock or active check (a locked quest's box can be ticked; the agent never does).                                                                                                                                                   | `bq_standard.network.handlers.NetTaskCheckbox.onServer`: `instanceof TaskCheckbox` → `ITask.setComplete`, `QuestCache.markQuestDirty`.                                                                                                                                                                         |
| `bq_standard:choice_reward {questID, rewardID, selection}` sets a choice reward's selection; the server echoes it to the client.                                                                                                                                                                                      | `NetRewardChoice` (server and client handlers).                                                                                                                                                                                                                                                                |
| Quests complete in the quest loop: every 60 of the player's ticks (3 s; `ticksExisted`, which only advances while the client sends movement packets), each quest in the player's ACTIVE set that is unlocked and can be submitted is updated, and completes when its tasks satisfy its task logic.                    | `handlers.EventHandler.onLivingUpdate`: `ticksExisted % 60`, `QuestCache.getActiveQuests`, `IQuest.isUnlocked`, `canSubmit`, `update`.                                                                                                                                                                         |
| Prerequisites (`questLogic`) and tasks (`taskLogic`) combine by `EnumLogic.getResult(n, total)`: AND n ≥ total, NAND n < total, OR n > 0, NOR n = 0, XOR n = 1, XNOR n = total − 1.                                                                                                                                   | `api.enums.EnumLogic$1` (`tableswitch`), called from `QuestInstance.isUnlocked`, `update` and `detect`.                                                                                                                                                                                                        |
| Retrieval: a detect counts the whole inventory; consume tasks take the items (`decrStackSize`); an inventory change re-detects only `!consume \|\| autoConsume` tasks. Optional retrieval is `ignored` (counts as done).                                                                                              | `bq_standard.tasks.TaskRetrieval.detect` and `$Detector.run`, `TaskRetrieval.onInventoryChange`, `TaskOptionalRetrieval.ignored` (returns true).                                                                                                                                                               |
| Crafts and inventory changes reach only the player's active quests: crafting counts only while the quest is active, unless `allowCraftedFromStatistics` (2 of the 44 Age 0 crafting tasks) lets a detect read the player's craft statistics.                                                                          | `bq_standard.handlers.EventHandler.onItemCrafted` and `onServerTick` → `ParticipantInfo.getSharedQuests` → `TaskCrafting.onItemCraft` / `ITaskInventory.onInventoryChange`; `TaskCrafting.detect` (`allowCraftedFromStatistics`).                                                                              |
| Rewards wait for a claim; reward items go into the inventory and what does not fit is DROPPED on the ground.                                                                                                                                                                                                          | `QuestInstance.claimReward`; `bq_standard.rewards.RewardItem.claimReward`: `InventoryPlayer.func_70441_a` (addItemStackToInventory), else `EntityPlayer.func_71019_a` (drop).                                                                                                                                  |
| The world's `betterquesting/QuestDatabase.json` is what the server runs; `DefaultQuests` only seed a world that has none.                                                                                                                                                                                             | `handlers.SaveLoadHandler.loadConfig`.                                                                                                                                                                                                                                                                         |

**What the agent reads** (`src/bot/gtnh1710/better-questing.ts`, `QuestBookModel`). When the
server lists `betterquesting`, the client adds `BQ_NET_CHAN` to its REGISTER, reassembles the
slices, decodes main_sync, quest_sync, cache_sync, chapter_sync and the choice echo, and answers
main_sync exactly as the stock client does (an empty main_sync; the only quest-book message sent
without `MC_ENABLE_QUEST_BOOK`). `GameState.questBook` lists the agent's Age 0 closure (106
quests): completed, claimed, active and unlocked, each task with the server's completion and
counts (while the quest is active), and the rewards still to claim. It is unknown until the full
sync and the active set have arrived (live play waits up to 30 s after login), and for the rest
of the connection once any message cannot be decoded.

**What the agent may click** (`MC_ENABLE_QUEST_BOOK=true`, off by default): `SUBMIT_QUEST`
(quest_action 1), `CHECK_QUEST_BOX` (task_checkbox) and `CLAIM_QUEST_REWARD` (choice_reward
when the quest has a choice, then quest_action 0). The forced claim (quest_action 2, which
picks a random choice) and every editing message cannot be expressed. The rules (code, not a
model; see docs/action-contract.md):

- only quests of the Age 0 closure that the server's quest book has;
- submit and checkbox only while the server lists the quest as active and unlocked
  (`QUEST_NOT_ACTIVE`); never while the player is walking, digging, placing or using a chest,
  never without presence ticks (the quest loop runs on the player's ticks), never in danger;
- a submit hands in items only for consume tasks, and is refused while a protected item could
  be one of them: the same registry name, or ANY protected item when the task names an ore
  dictionary entry, whose members the agent cannot list (`PROTECTED_ITEM`);
- a claim only for a completed, unclaimed quest, with a valid choice, and only with room for
  every reward (Σ⌈count/16⌉ + 2 free slots), because Better Questing drops what does not fit;
- verified against the server's next sync: the quest completed (within 8 s: the loop runs every
  3 s) and only consume items left the inventory; the box (or the quest) done; the rewards
  claimed and exactly the reward items (the chosen one) in the inventory.

The play loop makes these clicks itself, decided in code from the server's records
(`questBookSteps`; see docs/architecture.md, "Quest goals"). Plans never contain them: the
planner is not offered them and `validatePlan` refuses them.

**The Age 0 chapter is not self-contained.** In the world's database, the 92 quests of
"Tier 0 - Stone Age" need 14 quests from other chapters, all now in
`src/goals/age0-quests.ts` (never assumed done):

- the 10-quest "And So, It Begins" chain, from the very first quest, "Your First Night" (8 dirt):
  "Sticks 'n Stones" (gravel and logs, then 2 logs handed in: a consume task), "Where's the
  Flint?" (craft 3 flint), "Crafting Time" (craft a crafting table), "Main Quests and Secondary
  Quests" (a checkbox), "Tools", "Monster Hunter", "Soft Mallet Adventure", "Fluffy and Red" (6
  wool) and "SO...TIRED...MUST...SLEEP..." (a bed), which "Ready, Set, Go!" needs;
- the smeltery, in "Multiblock Goals": "You Are Not Prepared!!!" (build it) and "You Are Not
  Prepared... But They Are" (have its parts, and tick) are XOR with each other (completing one
  locks the other), and "You Are Now Prepared, Hopefully!" accepts either (OR);
- "Trigger: Loot Game", a hidden quest (no chapter) for LootGames dungeon blocks.

Of the 44 crafting tasks in the closure, only 2 accept crafts from the player's statistics
("Where's the Flint?", "Crafting Time"); 19 quests have `lockedProgress` (their tasks progress
while locked). GTNH's gravel never drops flint (IguanaTweaks `removeFlintDrop`; see "Crafting"):
flint comes from the 3-gravel recipe, which the agent does not have yet, so "Where's the
Flint?" is the first quest it cannot do.

**Not verified yet:** everything live (the sync's real size and timing, the server's answers to
the clicks); parties (the agent assumes it plays alone, so `getSharedQuests` is its own active
set); and that reward items arrive before the sync that records the claim (the client waits
for both).

## What was verified (from installed packages, 2026-09-26)

| Fact                                                                                                                                                      | Source                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| GTNH runs on **Minecraft 1.7.10 with Forge**.                                                                                                             | Public GTNH project information; not re-verified here.                   |
| The installed **mineflayer 4.39.0** lists **1.8.8** as its oldest tested version. 1.7.10 is not in `testedVersions`.                                      | `node_modules/mineflayer/lib/version.js`                                 |
| The installed **minecraft-protocol** lists `'1.7'` among its supported packet versions.                                                                   | `node_modules/minecraft-protocol/src/version.js`                         |
| minecraft-protocol's `src/` contains **no Forge/FML handshake** code. A Forge 1.7.10 server normally requires the FML handshake before a client can join. | `grep -ri "forge\|FML" node_modules/minecraft-protocol/src` (no matches) |

**Consequence:** a plain `mineflayer.createBot()` is **not expected to join a GTNH server**. The
`MineflayerClient` is therefore a skeleton that refuses to connect unless explicitly enabled, and
even then implements no world-changing action.

## Why vanilla Mineflayer support does not imply GTNH support

Mineflayer's knowledge comes from `minecraft-data` / `prismarine-*`, which describe **vanilla**
Minecraft. GTNH adds hundreds of mods. None of the following is guaranteed to work:

| Area                     | Risk                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connection**           | FML handshake and mod-list negotiation (see above).                                                                                                                                                                  |
| **Blocks and items**     | Modded blocks/items use IDs outside the vanilla registry. They may have no name, a wrong name, or wrong metadata in Mineflayer. The adapter marks the whole inventory **unknown** if any item lacks a registry name. |
| **NBT**                  | GT tools, machines and fluid containers keep essential state in NBT (durability, charge, fluid amounts). Vanilla parsing may be incomplete.                                                                          |
| **GUIs / windows**       | GT machine GUIs, AE2 terminals, Iron Chests and other modded containers use custom window types and slot layouts. Deposit/withdraw into them is **not** assumed to work.                                             |
| **Recipes**              | `prismarine-recipe` knows vanilla recipes only. GTNH recipes (GT machines, assembly lines, custom crafting changes) are not available through Mineflayer.                                                            |
| **Machines and power**   | Machine progress, EU/t, voltage tier and multiblock state are server-side tile-entity data, not exposed through the vanilla protocol. `GameState.power.availableEUt` is always `unknown` for now.                    |
| **Movement and physics** | Modded blocks can have non-vanilla collision boxes, slabs, covers and pipes; pathfinding may misjudge them.                                                                                                          |
| **Dimensions**           | 1.7.10 uses numeric dimension IDs; GTNH adds many dimensions (Galacticraft, Twilight Forest, …). The adapter maps only 0/-1/1 to names.                                                                              |
| **Hostile mobs**         | Modded mobs may not be classified as hostile by Mineflayer's entity data.                                                                                                                                            |

## Unverified assumptions in the current code

1. ~~Item identifiers~~ **Verified:** names come from the per-world FML registry; `@damage` is
   appended when non-zero (GT meta-items encode their sub-type there; for tools it is wear).
2. ~~A "container" can be opened and have items moved by a generic window API~~ **Verified for
   vanilla chests** (see "Chests"). False for many GTNH containers (drawers, barrels, GregTech's
   digital chests, ender chests: see "Storage blocks in GTNH 2.8.4"), which is why only blocks
   with a checked interaction profile are used (see "Interacting with blocks").
3. A generator's accepted fuels and fuel level are knowable. In reality this may need GUI scraping,
   a server-side helper mod, or manual configuration.
4. ~~Machine `status` can be observed~~ **Partly verified** (see "Machines"): GregTech machines
   report enabled and running through GregTech's own channel. Power, progress and inventories are
   not sent, so `powered` stays unknown, and "enabled but not running" (`idle`) does not say why.
5. Food level and health semantics match vanilla (GTNH includes Spice of Life / hunger changes).
   Thresholds are configurable for this reason.
6. ~~`RETURN_TO_SAFE_LOCATION` works by walking~~ **Verified** inside a fence on one level (see
   "Walking"); no teleport commands are used. Longer routes (steps, slopes, doors) are not
   supported yet.

## Future testing protocol (private GTNH test world only)

Run on a **disposable copy** of a world on a server you control, in creative-disabled survival,
with backups, never on a public server.

1. **Connectivity spike (read-only). DONE 2026-09-30:** a raw Node client with a hand-written
   FML handshake joins; mineflayer does not. See "Test server results" above.
2. **Observation only. MOSTLY DONE 2026-09-30:** position, dimension, health, food and inventory work
   (see "Read-only live client"). Still to do: compare against the in-game F3/NEI view in at least 10
   situations (including GT meta-items and big stacks). Nearby entities: done (see "Entity
   tracking"); modded entity identification and lava/void are next.
3. **Registry mapping. DONE for inventory names** (per-world registry). Still to test: protected-item
   matching with real GT items.
4. **Movement in a fenced area. DONE 2026-09-30** (see "Walking"): our own walker (never digs,
   places, jumps or enters fluids) inside a glass pen. Boundary, lava, server-correction and stop
   checks all verified live.
5. **One container type at a time. Vanilla chest DONE 2026-09-30** (see "Chests"): exact deltas
   verified live on both sides. Next: each modded container, one at a time, kept on the
   allowlist only after it passes the same checks. **Crafting** (2x2 and crafting table) is
   built against the fake server (see "Crafting"); a live run in the pen is next: planks from
   logs in the 2x2 grid, then a chest at a table, checking that nothing is dropped.
6. **Machines (read-only). DONE 2026-09-30** for GregTech machines' enabled/running state (see
   "Machines"). Still open: power and machine contents (GUI read or a helper mod) before
   `INSPECT_MACHINE` can do more than look.
7. **Digging allowlisted blocks. BUILT 2026-09-30, live test pending** (see "Digging"): in the
   pen, after `node scripts/test-server-admin.ts pen resources`, dig each test block with
   `pnpm cli dig --live --at=...`. Check that the block turns to air and the drop arrives. Then
   check the refusals: a block next to the chest or water, sand on top, outside the fence, and
   the stop file. Watch the server log for warnings.
8. **Placing allowlisted blocks. BUILT 2026-09-30, live test pending** (see "Placing"): in the
   pen, with cobblestone in the inventory, place it with
   `pnpm cli place --live --at=... --item minecraft:cobblestone` on the floor next to the
   player, then against a wall block, then over the player's head. Check the block appears,
   the stack shrinks by one, and nothing opens. Then the refusals: next to the chest, inside
   the player, sand over the head, an entity in the cell. Watch the server log for warnings.
9. **Combat. BUILT 2026-09-30, live test pending** (see "Combat"): in the pen, with
   `MC_ENABLE_COMBAT=true`, summon one zombie, then a cow (over RCON, by an operator), and run
   `pnpm cli attack --live --entity <id>` with the ids `observe` prints, first bare-handed, then
   with a wooden axe. Check the hits, the death, that the FML DataWatcher of a Special Mobs zombie
   decodes (health known), and the refusals: a villager, a creeper in the pen, low health, the
   stop file. Watch the server log for kicks.
10. **Soak test.** Run single cycles repeatedly (still human-triggered) and review `agent_events`
    and `safety_violations` for false positives/negatives before any continuous loop is considered.

## What is mocked today

Everything in-game. `MockMinecraftClient` simulates the player, inventory, one chest, one
generator with fuel, one machine, one crafting table (and server recipes that differ from the
agent's table), a few diggable blocks, the blocks it places, hazards, hostiles, mobs with health
that can be fought, and a clock, with injectable failures and "reports success but changes
nothing" behaviour. Furnaces in the mock cook on the clock (200 ticks per item, vanilla fuel
times) from a placeholder smelting table, and observe-only blocks open a fixed window. All item
and machine names in the mock are
placeholders, not verified GTNH identifiers.

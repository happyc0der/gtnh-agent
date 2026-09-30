# GTNH compatibility

**Status (2026-09-30): read-only observation of every safety-critical field works on a
private GTNH 2.8.4 test server.** The agent's own client (`src/bot/gtnh1710/`, `Gtnh1710Client`)
joins via the Forge handshake and reports position, dimension, health, food, a fully named
inventory, nearby entities (vanilla and modded) and lava/void/damaging blocks. A live agent cycle
now has no state violations; it pauses only because it has no task. Machines, power and held-item
durability are not observable yet. Mineflayer cannot connect at all. Every claim below is labelled
as _verified_ (observed or checked in installed code) or _assumption_ (to be tested).

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
| Held item      | Unknown: the durability of modded items is not known yet.                                                           |
| Threats        | Tracked (see "Entity tracking" below); lava/void still unknown.                                                     |
| Machines/power | Unknown/empty.                                                                                                      |

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
start, keep-alive, plugin messages on `REGISTER`/`FML|HS` only, idle ticks, and echoes of
server-assigned positions. `perform()` supports only `OBSERVE_STATE`, `WAIT` and `PAUSE_AND_ASK_USER`;
every other action returns `NOT_IMPLEMENTED` without sending anything (tested).

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

Still to do: identify modded entity types (so passive animals stop counting as threats).

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
2. A "container" can be opened and have items moved by a generic window API. This is likely false
   for many GTNH containers.
3. A generator's accepted fuels and fuel level are knowable. In reality this may need GUI scraping,
   a server-side helper mod, or manual configuration.
4. Machine `status` (idle/busy/unpowered/error) can be observed. It probably cannot be without
   server-side help, which is why unknown statuses route to the planner or a pause and never to action.
5. Food level and health semantics match vanilla (GTNH includes Spice of Life / hunger changes).
   Thresholds are configurable for this reason.
6. `RETURN_TO_SAFE_LOCATION` works by walking. No teleport commands are used.

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
4. **Movement in a fenced area.** Enable `MOVE_TO` with a pathfinder configured to never dig,
   place, parkour or enter fluids, inside a small walled test area with a lava pit outside the
   boundary. Verify that boundary and hazard checks stop it.
5. **One container type at a time.** Vanilla chest first, then each modded container. Verify
   exact inventory deltas; keep a container on the allowlist only after it passes.
6. **Machines (read-only).** Determine whether machine status is observable at all; if not,
   document the chosen mechanism (helper mod, GUI read, manual) before implementing `INSPECT_MACHINE`.
7. **Soak test.** Run single cycles repeatedly (still human-triggered) and review `agent_events`
   and `safety_violations` for false positives/negatives before any continuous loop is considered.

## What is mocked today

Everything in-game. `MockMinecraftClient` simulates the player, inventory, one chest, one
generator with fuel, one machine, hazards, hostiles and a clock, with injectable failures and
"reports success but changes nothing" behaviour. All item and machine names in the mock are
placeholders, not verified GTNH identifiers.

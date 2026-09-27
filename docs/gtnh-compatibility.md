# GTNH compatibility

**Status: unverified.** Nothing in this repository has been tested against a GregTech: New
Horizons server. Every claim below is labelled as _verified_ (checked in this repo's installed
dependencies) or _assumption_ (to be tested).

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

1. Item identifiers are `namespace:name[@meta]` strings (`ItemNameSchema`). The adapter may need a
   mapping table from raw numeric IDs.
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

1. **Connectivity spike (read-only).** With `MC_ENABLE_LIVE_CONNECTION=true` against a local
   GTNH server: can any Node client complete the FML handshake? Evaluate a Forge-capable transport
   (for example a community FML-handshake plugin for node-minecraft-protocol), or a thin server-side
   helper mod that exposes state over a local socket. Record the result here.
2. **Observation only.** Implement and verify `observe()` field by field: position, dimension,
   health, food, inventory (including a GT meta-item), nearby hostiles and lava. For each field,
   compare against the in-game F3/NEI view in at least 10 situations. Anything unreliable stays `unknown`.
3. **Registry mapping.** Build and test a mapping from raw IDs/metadata to stable item names for the
   items the agent will touch. Protected-items matching must be tested with real GT items.
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

# gtnh-agent and Baritone

The owner's bar (2026-10-03): the bot should be "at least as strong as Baritone", the
Minecraft pathfinding bot. Baritone (LGPL-3.0) inspired the ideas below; no code was copied.
This table compares what Baritone does with what gtnh-agent does today, and says how each was
checked: **live** on the GTNH 2.8.4 test server, or only against the repository's **fake
server** and mock world.

Baritone runs inside a game client with real physics and knows only vanilla Minecraft.
gtnh-agent is its own protocol client for a modded 1.7.10 server; local models decide and plan,
and code checks every action against a safety policy. So some rows compare unlike things;
where gtnh-agent goes further for GTNH, the last section says so.

## Movement and pathfinding

| Baritone                                                       | gtnh-agent                                                                                                                                     | Checked                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A\* over movements with costs in ticks                         | Yes: `src/bot/gtnh1710/pathing/` (binary heap, packed nodes, node and time limits); costs from 1.7.10 physics                                  | live (walks of up to 19 blocks)                          |
| Walk, diagonal, ascend, descend                                | Yes                                                                                                                                            | live                                                     |
| Fall (3 blocks without damage, deeper into water)              | Yes: falls up to 3; into still water only from heights the server's fall accounting does not hurt                                              | fake server                                              |
| Break blocks in the way (`allowBreak`)                         | Yes: natural blocks by the dig rules, with the best tool held (stone only with a pickaxe that harvests it); never ores, never a player's build | live (leaves, sand, grass)                               |
| Place blocks: pillar up, bridge (`allowPlace`, throwaway list) | Yes: cobblestone, netherrack or dirt (4 dirt kept for the night's roof); never within 3 blocks of another player                               | live: pillar (test pen, 2026-10-03); bridge: fake server |
| Parkour (`allowParkour`)                                       | Yes: gaps of 1-2 walking, 3 sprinting; only over gaps safe to fall into unless enabled otherwise                                               | live (test pen: a 1-block gap, 2026-10-03)               |
| Sprint (`allowSprint`)                                         | Yes (C0B), off by default: HungerOverhaul makes it cost food                                                                                   | fake server                                              |
| Long paths in segments (best-so-far partial paths)             | Yes: EXPLORE and long travel walk partial-path hops, re-planned as chunks arrive                                                               | fake server                                              |
| Swimming                                                       | Wading in calm one-deep water only (off by default); deeper water is avoided                                                                   | fake server                                              |
| Doors and fence gates                                          | Yes: wooden doors and gates in the way are opened with a right-click and closed again behind (left as found); iron doors never                 | live (test pen, 2026-10-04: a door and a gate)            |
| Ladders, vines                                                 | No: avoided                                                                                                                                    |                                                          |
| Chunk cache to path through unloaded chunks                    | Partly: world memory keeps what was seen per chunk (resources, biomes, places), not walkable blocks; paths stay inside loaded chunks           | live                                                     |
| Avoid mobs                                                     | Different: walks stop for threats nearby; retreats home, flees, or fights back (System 1 decides); no path costs near mobs                     | live                                                     |

## Processes and commands

| Baritone                                   | gtnh-agent                                                                                                                                                                                                                                                                                                         | Checked                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `#goto x y z`, `#goto x z`                 | `!goto x y z`, `!goto x z`                                                                                                                                                                                                                                                                                         | live                          |
| `#goto <waypoint>`, `#waypoint`, `#home`   | `!waypoint <name>`, `!goto <name>`, `!waypoints`, `!sethome`, `!home`                                                                                                                                                                                                                                              | live (waypoint, goto)         |
| `#come`                                    | `!come`                                                                                                                                                                                                                                                                                                            | live                          |
| `#follow <player>`                         | `!follow [player]` (owners only), keeps about 3 blocks                                                                                                                                                                                                                                                             | live                          |
| `#mine <block> [count]`                    | `!mine <count> <block>` and `!get <count> <item>`; GregTech ores by name (`!mine 16 iron ore`), only ores of that material (GregTech tells a client the material of an exposed ore; never x-ray); pickaxes and harvest levels honoured; with none in view or remembered, it explores on toward ground not seen yet | live (dirt, logs); ores: fake |
| `#explore`                                 | EXPLORE (the planner's step), toward a direction or a point                                                                                                                                                                                                                                                        | live                          |
| `#stop`, `#cancel`, `#pause`, `#resume`    | `!stop` (stops the action in progress at its next tick), `!pause`, `!resume`                                                                                                                                                                                                                                       | live                          |
| `#proc`, `#eta`                            | `!status`                                                                                                                                                                                                                                                                                                          | live                          |
| Chat commands from the player using it     | Whispers or `!` chat from its owners only (`MC_OWNERS`); plain English translated by a local model into the same commands                                                                                                                                                                                          | live                          |
| `#farm`                                    | No                                                                                                                                                                                                                                                                                                                 |                               |
| `#build <schematic>`                       | No                                                                                                                                                                                                                                                                                                                 |                               |
| `#tunnel`, `#surface`, `#axis`, `#thisway` | No (a walk may tunnel through what is in its way)                                                                                                                                                                                                                                                                  |                               |
| `#invert` (run away)                       | Fleeing from threats (code, not a command)                                                                                                                                                                                                                                                                         | live                          |

## Beyond Baritone, for GTNH

- Plays the quest book's Age 0 by itself: reads Better Questing's records, submits, ticks
  checkboxes, claims rewards (live).
- Plans from a route that code calculates over GTNH's own recipes and drops (the server's
  CraftTweaker dumps), and crafts 19,786 of its 52,400 crafting-table recipes (2x2 live;
  3x3 at a placed table: fake server).
- Tools by GTNH's rules: Tinkers' Construct tools read from their data, IguanaTweaks' harvest
  levels, no dig that would drop nothing.
- Food: eats approved food, fetches more from gardens and animals when hungry (live).
- Nights: digs a pit three blocks down (walking up to 12 blocks to good ground) and roofs it,
  or builds a box; digs out in the morning, or climbs out through the roof on a pillar when no
  wall may be dug (live).
- Inventory: a full hotbar swaps a stack in from the main inventory to place, dig with a tool or
  eat (live); a crafting table goes only where the client's own check says it is out of the
  way (live: the Tools quest's table).
- Drops: walks to where a dig's or a kill's drop landed; fells trees from the base (live).
- Safety: every action through one executor and a safety policy; players' builds remembered
  and never broken; nothing broken or placed near another player.

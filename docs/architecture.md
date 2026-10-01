# Architecture

A typed, safety-first agent core that runs one observe → decide → validate → execute → verify
cycle against a mock Minecraft world or a private test server (and bounded runs of such cycles).
Local models (Ollama) can make the decisions and write plans, opt-in; they only ever propose
(see [local-llm-integration.md](local-llm-integration.md)).

## Components

```mermaid
flowchart TD
    subgraph World["Minecraft boundary (src/bot)"]
        MC["MinecraftClient interface"]
        MOCK["MockMinecraftClient<br/>(full simulation)"]
        MF["MineflayerClient<br/>(skeleton; cannot join GTNH)"]
        G17["Gtnh1710Client<br/>(1.7.10 + Forge: observes; walks, explores, uses chests,<br/>crafts, digs, places, uses block windows and fights<br/>inside a fence or a moving play area)"]
        MC --- G17
        MC --- MOCK
        MC --- MF
    end

    subgraph Core["Agent core"]
        LOOP["Agent loop<br/>(src/app/loop/agent-loop.ts)<br/>ONE cycle, then stop"]
        SAFE["Safety policy<br/>(src/safety)<br/>pure code"]
        S1["System 1<br/>DeterministicRouter<br/>(src/system1)"]
        PROP["Decision → one action<br/>(action-proposer)"]
        EXEC["ActionExecutor<br/>(src/executor)<br/>the ONLY path to perform()"]
        VER["Postcondition verifier"]
    end

    subgraph Models["Optional local models (src/llm, Ollama; off by default)"]
        S1M["OllamaDecisionProvider<br/>(DecisionProvider)"]
        LLM["OllamaPlannerProvider<br/>(PlannerProvider)"]
    end

    PLAN["MockPlannerProvider<br/>(fixtures)"]
    DB[("SQLite<br/>(src/persistence)")]

    MC -- "observe(): GameState" --> LOOP
    LOOP -- "state reliability" --> SAFE
    LOOP -- "GameState" --> S1
    S1M -. "at decision points, wrapped by SafetyFirstDecisionProvider" .-> S1
    S1 -- "Decision (9 values)" --> PROP
    PROP -- "REQUEST_PLANNER" --> PLAN
    LLM -. "same PlannerProvider contract" .-> PLAN
    PLAN -- "Plan | Escalation (Zod-validated)" --> PROP
    PROP -- "one Action" --> EXEC
    EXEC -- "schema + safety + preconditions" --> SAFE
    EXEC -- "perform(ValidatedAction)" --> MC
    EXEC --> VER
    LOOP & EXEC --> DB
```

## Roles

| Component                                                        | Role                                                                                                                                                                                                                                    | Authority                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MinecraftClient** (`src/bot`)                                  | The only boundary to the game. `observe()` returns a normalized `GameState`; `perform()` takes a `ValidatedAction` token.                                                                                                               | Performs actions, but only ones minted by the executor (runtime-checked).                                                                                   |
| **Safety policy** (`src/safety`)                                 | Pure functions: state reliability, dangers, per-action rules, protected items, boundaries, forbidden-modification denylist, repeated-failure cap.                                                                                       | **Veto over everything.** No model can override it.                                                                                                         |
| **Deterministic router** (`src/system1/deterministic-router.ts`) | System 1: prioritized, transparent rules that map a state to one of 9 bounded decisions, with confidence, reason codes and facts.                                                                                                       | Chooses _what kind_ of step; cannot execute.                                                                                                                |
| **System-1 model** (`src/llm/ollama-decision-provider.ts`)       | Opt-in (`decisions.provider: ollama`): a local model picks one of the 9 decisions from facts computed by code, by default only at decision points (see [System 1](#system-1-who-decides-each-cycle)).                                   | Always wrapped in `SafetyFirstDecisionProvider`: the router's safety decisions and every pause win, invalid output becomes PAUSE.                           |
| **Action proposer** (`src/system1/action-proposer.ts`)           | Turns one decision into exactly one allowlisted action (approaching a target first if it is out of reach).                                                                                                                              | Proposes only.                                                                                                                                              |
| **LLM planner** (`src/llm/ollama-planner-provider.ts`)           | Opt-in (`planner.provider: ollama`): returns a strict `Plan` or an `Escalation`. Called only for `REQUEST_PLANNER`, and only when the task has no open plan.                                                                            | **None.** Plans are validated and stored; one step per cycle goes through the executor like any other action. Plans that ask for approval wait for a human. |
| **ActionExecutor** (`src/executor`)                              | The single controlled path: schema → safety → preconditions → persist → execute → observe → verify → persist.                                                                                                                           | Sole minter of `ValidatedAction` (lint-enforced).                                                                                                           |
| **Persistence** (`src/persistence`)                              | SQLite (better-sqlite3): tasks, checkpoints, plans with their progress, state snapshots, action logs, an append-only event log, safety violations, named locations, protected items, world memory (what the agent has seen, per chunk). | Audit trail; failure history feeds the repeated-failure rule.                                                                                               |

## One cycle

1. Observe (or receive) a `GameState`; reject it if it fails schema validation.
2. Overlay agent memory (a paused/blocked task stays halted; last action) and persist a snapshot.
3. Hard safety check of the _state_: unknown, stale or inconsistent → forced `PAUSE_AND_ASK_USER`,
   whatever any decision provider says.
4. Ask the `DecisionProvider` (the deterministic router, or a model inside
   `SafetyFirstDecisionProvider`, asked only at decision points by default) for one decision
   (see [System 1](#system-1-who-decides-each-cycle)).
5. Convert it to exactly one proposed action. For `REQUEST_PLANNER`: run the next step of the
   task's active plan (for a `GATHER` step, the action code chooses for it this cycle); or, if
   its plan still waits for approval, pause; or else ask the planner for a new plan (see
   [Plans across cycles](#plans-across-cycles)).
   If deciding or planning took so long (a model) that the observation is now stale, observe
   again: the action is validated against the new observation (a second snapshot, logged as a
   `STATE` event marked `reobserved`). The executor always checks freshness against the clock at
   execution time.
6. Validate the action (schema, safety policy, preconditions) and persist the result.
7. Execute through `MinecraftClient.perform()` only if validation passed.
8. Observe again and verify the action's postcondition.
9. Persist the outcome; pause or block the task if needed. **Stop.**

## System 1: who decides each cycle

System 1 chooses the kind of step each cycle, one of the ten decisions
(`decisions.provider`, built in `src/app/providers.ts`):

- **The rule router** (`deterministic`, the default): `routeDecision`
  (`src/system1/deterministic-router.ts`), a pure, prioritized rule list over the observation.
- **A local model** (`ollama`): `OllamaDecisionProvider` picks a decision from facts computed by
  code, always inside `SafetyFirstDecisionProvider`. The router's binding decisions (safety,
  every pause) win without asking it, invalid output pauses, and a pause, retreat, meal, rest or
  fight the facts rule out is overruled (see [local-llm-integration.md](local-llm-integration.md)).

Low health with nothing threatening the player and the food bar high enough to heal
(`minHungerToHeal`, 8: HungerOverhaul stops natural healing below it) is `REST`: a `WAIT` of
`restMs` (30 s) where it stands, again until health is back above `minHealth`. Too hungry to
heal, it retreats or pauses as before; during the night-shelter task the shelter's steps come
first (the pit is where resting is safe). Seen live: at 8 health with no food, the retreat
home was 100 blocks through a forest, and the pause there healed nothing (nothing heals
offline).

A retreat (`RETREAT_HOME`) from a creature goes back along the agent's own trail when that
is nearer than home (`src/app/loop/trail.ts`): the agent remembers where it stood out of danger
lately (a point every 4 blocks, the last 48, never in a night task), and the newest point 8 to
48 blocks back, on the far side of the player from the nearest creature and clear of every one
by the threat radius plus 4, becomes the safe location `trail` for that cycle. Two failed
retreats along the trail from the same block send it home instead. Seen live: one spider sent
the agent 108 blocks back to its spawn. That spider was in daylight, where a spider leaves a
player alone: such a calm spider is no threat at all now (see
[Combat](#combat)), and trail points stay 10 blocks from one (its leap, 6, plus 4).

### A model at decision points

On live runs the router decided what qwen3:14b decided on 88 of 89 decisions, and the model
took 2.2 s a decision (median; 10 s at worst). So since 2026-10-01 the model decides only at
**decision points** (`decisions.modelCadence: decision-points`, the default;
`AGENT_DECISION_CADENCE`). Every other cycle continues the open plan at once with the
router's decision: usually `REQUEST_PLANNER`, which runs the plan's next step (or a GATHER's
next dig) with no planner call either. `ModelCadenceProvider` (`src/system1/model-cadence.ts`,
itself a `SafetyFirstDecisionProvider`) does this each cycle:

1. The router decides. A binding decision (safety, any pause) wins, and nobody else is asked.
2. `decisionPoint`, a pure function, compares this cycle with the session's previous one
   (`cycleView`: the router's decision, the dangers, the plan, the last action...). The model is
   asked when:
   - it is the session's first cycle (`cli once`, `cli run`, each session of `cli play`);
   - the previous cycle's action failed, was rejected or not verified, or paused;
   - the model decided the previous cycle and chose otherwise than the router: going on with
     the router's decision would undo its choice, so it decides until it agrees again;
   - the task's plan ended since the previous cycle began (completed, failed, superseded), or
     the router asks for the planner and no plan is open to continue: the model decides before
     the planner is asked for a new plan;
   - a condition changed: the router's decision or reason codes, the dangers (a mob, a hazard,
     low health or food), hunger, the task, the time of day (day, evening, night, dawn), or the
     inventory became nearly full (or has room again).
3. Otherwise the router's decision goes on (provider `continuing(deterministic-router)`).

The agent loop gives System 1 the task's latest plan (`RouterContext.plan`, `taskPlanFacts`);
the rules ignore it. A binding cycle is a previous cycle too, so the cycle after a detour (a
retreat from a mob, a meal) asks the model: the mob is the router's to handle, what comes after
it the model's. In `run` and `play` such a detour ends the session anyway, and the next one
starts with the model. `modelCadence: every-cycle` asks the model on every cycle the router
does not decide alone, as before.

Every decision records which way it went in `factsUsed` (in the DECISION event):

- `cadence`: `model`, `continuing` or `binding`;
- `cadenceWhy`: why the model was or was not asked, e.g. "plan #1 ended (completed); no open
  plan to continue", "the previous DIG_BLOCK failed" or "nothing changed since the previous
  cycle: plan #1 step 1/1 (GATHER) goes on";
- `modelMs`: the model call's time.

`cli play` and `cli run` print each cycle's System 1 line with the provider: the model's name
(`ollama:qwen3:14b`) when it decided, `continuing(deterministic-router)` when the plan went on,
`safety-first(...)` for a binding decision. Each session ends with a stats line, e.g. "System 1
over 20 cycle(s): 1 model decision(s) (median 2.1 s), 19 continued without the model, 0 binding
router decision(s)", and `cli play`'s summary has the total.

Measured on the mock world with a fake model (`tests/app/loop/decision-points.test.ts`): a GATHER of
54 sand takes 61 cycles (54 digs, 7 walks) and asks the model once, at its start. With the two
plans after it, that is 3 model decisions in 63 cycles; `every-cycle` makes 63.

## Live tasks

The live server knows nothing about the agent's tasks, so they come from agent memory
(`src/persistence/memory-repository.ts`, migration 003):

- `cli task-add` stores a task and makes it the **current task** (`agent_state.current_task`).
  Only live observations (`source: gtnh1710`) get it filled in. Mock scenarios share the database
  and never see it. A completed or failed task is never filled in.
- A plan the human wrote (`--plan`) goes through `validatePlan` exactly like a planner's plan. It
  is stored with planner `operator`, and when it completes it completes the task.
- Machines the task depends on (`--machines`, table `task_machines`) become the live state's
  `knownRecipeState.requiredMachineIds`, so System 1's machine rules apply:
  - busy or **not seen** → `WAIT_FOR_MACHINE`;
  - switched off (`error`) → pause;
  - unpowered → the planner;
  - otherwise the plan goes on.
    An unseen machine is never assumed ready. Right after connecting, GregTech's machine packets
    may not have arrived yet.
- **Container memory:** the loop records every container whose contents it sees (before and after
  each action). A later cycle, in a new connection with the chest closed, gets those contents back
  for `memory.containerContentsMaxAgeMs`, but only for the executor's feasibility checks. The live
  client re-reads the real contents before it clicks anything, and verification compares the
  remembered "before" with the live "after", so a chest changed by someone else shows up as a
  verification failure.

### Bounded auto-run

`src/app/loop/live-session.ts` (`cli run --live`) runs ordinary cycles back to back on one connection
for the current task. It adds no decision logic and no checks of its own. It only decides whether
to start another cycle, and it continues only while each cycle:

- succeeded;
- asked for no attention;
- decided `REQUEST_PLANNER`, `EXECUTE_KNOWN_SAFE_STEP` or `WAIT_FOR_MACHINE` (task progress).

Anything else stops it: a finished task, a safety retreat, eating, upkeep, a pause, a failure,
the cycle or time cap, the stop file, Ctrl+C or a lost connection. There is still no open-ended
loop: every run is started by a human and bounded.

## Quest goals and autonomous play

The agent's goals come from GTNH's own quest book, like a new player's, and **progress is what
the server's quest book records**, never the agent's own judgement. The benchmark is "Finish
Age 0": every quest of the 92-quest "Tier 0 - Stone Age" chapter (37 main quests) completed in
the server's Better Questing records for the agent's player.

### Quest goals

- **The data.** `scripts/extract-quests.ts` reads the world's own quest database
  (`<world>/betterquesting/QuestDatabase.json`, what the server runs) into
  `src/goals/age0-quests.ts`: the chapter's 92 quests and the 14 quests it needs from other
  chapters (its prerequisites, recursively: the closure, 106 in all). Per quest: the exact 64-bit
  id, prerequisites with their logic (AND/OR/XOR...), task logic (AND/OR), main flag, chapter,
  lockedProgress, tasks (index, type, consume, items with ore dictionary names, whether crafts
  from the player's statistics count) and rewards (which one is a choice).
- **The server's records.** The live client reads the quest book over Better Questing's own
  channel (`src/bot/gtnh1710/better-questing.ts`; see gtnh-compatibility.md, "Quest book") into
  `GameState.questBook`: for each closure quest, completed, claimed, active and unlocked, each
  task's completion and the server's count, and the rewards still to claim. It is unknown until
  the server's sync after login has arrived.
- **The logic** (`src/goals/quest-goals.ts`, pure) follows Better Questing:
  - a quest unlocks by its prerequisite logic over completed quests (XOR: the two smeltery
    quests exclude each other, and the next one accepts either, OR);
  - it completes in the server's quest loop once its tasks satisfy the task logic: AND, or OR
    (one task is enough); optional retrieval counts as done;
  - retrieval tasks count what is held (a met count stays); consume tasks count what a submit
    handed in; crafting tasks count only the server's count of crafts made while the quest was
    active (holding the item never counts); checkboxes are ticked in the quest book.
- **The next goal** is the shallowest quest the server lists as active and unlocked, that the
  agent's abilities can finish (hunting, locations and unknown crafts cannot), and that clicks
  alone do not finish; main quests first, then quest-book layout. Its task's subgoal lists the
  quest's remaining tasks by the server's count. Its requirements (the planner's route) name
  exactly what to have: held ore-dictionary items under their own names (birch logs for
  `logWood`), and for a crafting task what is held plus the crafts still to make.
- **Quest-book clicks** (`questBookSteps`), decided in code, never by a model: claims of
  completed quests' rewards (only with room in the inventory; a choice reward takes the first
  item an unfinished quest asks for), checkbox ticks (when the tick, plus a submit, completes
  the quest), and submits (items to hand in, or items held from before the quest was active,
  which the server has not counted). A quest whose tasks are all done is left to the server's
  quest loop; play waits a few seconds for it when nothing else is left.
- The last observation of the server's records is kept in agent memory
  (`quests.age0.server`), so `cli quests` shows it without a connection.

### Routes, nights and the play loop

**Routes: the planner takes stock before it plans.** A task can name the items its goal
needs (quests do; `cli task-add --needs item=count,...` for any goal). For those,
`src/goals/route.ts` calculates in code, from the agent's recipes and gathering sources
(`src/goals/route-book.ts`) and the places it has seen, exactly what the goal still needs:
have vs need per item, the raw materials to gather in total, every gather and craft step in
order (ingredients before what they make), the best known place for each material (the
nearest with enough seen: blocks in view now, and places world memory remembers from
exploring, marked "remembered"), where a player would look when no place is known (the
nearest seen biome where it is common, e.g. grass in a forest, never in a desert; for gravel,
clay and sand, the shore of the nearest water seen), and a rough time. The planner gets the
route in its request and plans along it; the model still makes every decision. The route is
general: smelting, tools, mob drops and exported recipe data
are new book entries, not new planner logic. The book holds GTNH's real recipes, ore veins
and harvest levels (see [Knowledge base](#knowledge-base)).

**Any goal, not only quests.** `cli play --live --needs item=count,...` makes play pursue a
goal of the player's own (task `goal-...`) exactly like a quest: the planner gets its route,
sessions and the journal work the same way, and play ends when the items are held. How
far a goal can be routed depends on the route book: items it cannot make or find yet are
listed as such, and the planner escalates rather than guessing; a material that only has
no known place yet is explored for, not escalated.

**Storage in the stocktake.** Containers whose contents the agent knows (seen now, or
remembered) count as "stored": the route fetches from them, nearest first, before it
gathers or crafts (withdraw steps), and the planner sees what each container holds.

**Nights.** Two real minutes before night (and at night), play turns to a shelter. Code plans
it and runs it, step by step, as known safe steps (see
[Code-made blueprints](#code-made-blueprints-known-safe-steps)); the planner is not asked
(seen live on 2026-10-01: a planner skipped the blueprint's order and tried the roof first).

- **The night pit** (first choice; [Digging down](#digging-down-the-night-pit)), as a
  first-night player digs one on flat ground: from feet level y, three `DIG_DOWN`s, falling a
  block each time, to feet at y-3; then the roof, placed in the y-1 cell (the ground layer it
  dug through) against the natural ground beside it, whose inner faces look at the eyes
  (y-1.38). The roof is dirt or a log, which the agent digs again in the morning (the digs
  themselves give dirt). Code picks the spot (the player's column, or one next to it the
  walker reaches) and checks before digging, with the live client's own rules on a what-if copy
  of the world (`src/bot/gtnh1710/night-pit.ts`): every dig down (exactly one block, no fluid,
  hazard or unloaded block near), natural walls (the 3 x 3 columns around plain full blocks
  down to y-3, sand and gravel only on solid ground), the roof's placement, and a way out for
  the morning. The pit's spot is kept in agent memory (`night_pit`), so a pit interrupted
  half-way is finished, not started again.
- **The raised box** (second choice, `src/goals/shelter.ts`): four walls at feet level and four
  at head level around the player, then the roof. From inside it no wall's top face looks at
  the eyes, and nothing touches the roof cell, so the box works only where something solid
  already touches the roof cell from the side or above (a cliff, a trunk); on open ground it
  cannot be roofed (the old roof support was never placeable, seen live).
- **Neither** (stone underfoot, water near, no roof block...): play stops before dark with the
  reasons, and `cli play` waits offline until sunrise.

Enclosed, the agent waits for sunrise. In the morning, walled in, code plans the way out with
the same rules (`planShelterExit`): from the pit, the roof and a staircase (two digs for each
step up, the upper block first), then a walk onto open ground; from the box, one wall (head
level first) and a walk out. Play runs it as known steps before the day's goal, and the goal's
journal says the walls are open again. Walled in with no way out, play stops and says why.

**A mob near home.** When System 1 pauses only because a mob is near (`HOSTILES_NEARBY` or
`UNCLASSIFIED_ENTITY_NEARBY`) and the agent is already home or has no home, play does not hand
the pause to a person: it sets the task active again, notes it in the journal, and `cli play`
waits offline for 30 s (an offline player cannot be hurt) and plays on, at most 6 times in a
row (`MOB_WAIT_MS`, `MAX_MOB_WAITS` in `src/app/play/play.ts`). Every new session re-checks the
state from scratch, so a mob that is still there pauses it again.

**Food** (`src/app/play/food.ts`, `src/domain/food.ts`; approved 2026-10-01). Seen live: food 9/20
with nothing to eat, its only apple eaten. Below food 6 with no food System 1 retreats or
pauses, so within a game day or two the agent would starve its own play. GTNH's quest "Sticks
'n Stones" sends a new player to Pam's HarvestCraft gardens. So, as play turns to a shelter at
dusk, it turns to food by day:

- **When.** Hungry (below `hungerEatThreshold`, 14) with nothing carried that would restore
  anything, play makes `get-food` the current task and runs bounded sessions on it until the
  agent carries `FOOD_TRIP_POINTS` (10 hunger points, about a day of food); then the quest goes
  on where it stopped. A quest session ends as soon as an observation shows the agent hungry
  with nothing to eat. At dusk the shelter comes first, and the trip goes on in the morning.
- **What counts.** Food is counted in hunger points as this server gives them:
  HungerOverhaul's own values (most foods restore 1; seen live, an apple took food from 8 to
  9), scaled by Spice of Life for how often the food was eaten among the last 20 meals and
  rounded down (a 1-point food eaten 5 times lately restores nothing). The agent's meals come
  from its action log (`recentMeals`). System 1 eats the carried food that restores the most
  now; a food that would restore nothing counts as none, so none is eaten for nothing. Values
  and sources: [GTNH compatibility: food](gtnh-compatibility.md#food-2026-10-01).
- **The route is code's.** The food task's route (`foodRouteForPlanner` in
  `src/planner/planner-provider.ts`) counts the food carried against what the trip brings back,
  then lists the sources code sees, each with the `GATHER` step that gets it: HarvestCraft
  gardens in view (one dig breaks one at once and drops 3 of its produce); grown, unowned cows,
  pigs and sheep in view (raw beef, porkchop and mutton are approved), only with combat on and
  while the moment allows a fight; with none of those, a remembered garden (`EXPLORE` toward it
  first), else where gardens grow (the nearest seen biome like that, or new ground). The
  planner (the model) chooses; code turns its `GATHER` into checked walks, digs and strikes
  ([GATHER](#gather-gathering-in-one-plan-step)).
- **Starving is no reason to stop getting food.** Below `minHunger` (6) with no food, System 1
  goes on with the food task by day instead of retreating home (no food there) or pausing (a
  pause only starves: nothing heals offline, and on Hard a food bar at 0 starves the player to
  death). The safety policy still refuses everything else while the food bar is that low; for
  the food task by day it lets only the actions that get food run: walks, `EXPLORE`s, and the
  dig of a listed garden (`getsFood` in `src/safety/safety-policy.ts`), also with low health,
  since health lost to an empty food bar comes back only with food (seen live: at food 0 the
  trip's walks cost health, it fell below `minHealth` while the planner planned, and the
  `EXPLORE` toward the garden it had seen was refused). Hostiles, hazards, the night or leaving
  the work area still stop it. At food 0 a walk or dig does not stop for a drop in health (it is
  hunger's, every few seconds); threats still stop it. Hunting keeps its own limits (food 8 and
  health 14: no healing below food 8 here, and a kill may explode), so a starving agent's route
  offers gardens only, and says why.
- **No food and no food trip** (the evening, the night): System 1 pauses where the player
  stands. It never walks home for hunger: walking burns food, and home has none (seen live: at
  food 2 the retreat home walked 143 blocks at dusk, and the food bar reached 0).
- **Death.** A player that dies stays dead until its client asks to respawn, and whoever logs
  in next finds it dead. The live client asks once, a second after its health comes as 0, as a
  player clicks Respawn, and logs "THE PLAYER DIED" with where. Its items lie where it died; it
  comes back at the spawn point with full health and the food HungerOverhaul gives a respawned
  player on Hard (12). Seen live once, 2026-10-01: starved on Hard after the food bar reached 0.
- **Stuck.** A food session that got no food, filled no food bar and saw no new ground is
  stuck; after `maxStuckSessions` in a row play stops and says so.

Not covered yet: cooking (a furnace needs cobblestone, so a pickaxe), fishing and farming.

**Checkpoints and compaction.** Long work is done in chunks. The planner plans only the next
one or two route steps; when they are done the agent checkpoints and asks again with fresh
stock. Each task keeps a journal written by code at every checkpoint: a plan made, done or
failed (and why), the planner escalating, a quest completed, an interruption (a mob, the
night, a stuck session). Like a long conversation, it is compacted: past 16 lines the oldest
are folded into one "earlier" summary (counts and the latest failures). The planner reads the
journal instead of a raw log, continues where the task stopped and avoids repeating failures.
Interruptions (mobs, hunger, lava, night) are still handled first by System 1's reflexes;
a step that no longer fits the world is refused and replanned.

`src/app/play/play.ts` (`runPlay`) is the play loop. Each round it reads the server's quest book and
the inventory, records the quests the server now lists as completed (closing their tasks), and
makes the quest-book clicks that are due, one per round. Each click is an ordinary action run by
the executor (`runQuestBookAction`: schema, safety policy, preconditions, execution, and
verification against the server's next sync), and only when `MC_ENABLE_QUEST_BOOK` is on; a
click that fails or is refused twice in a row waits until a session has run (the danger that
refused it may be gone). Then it makes the next quest the current
task (`quest-<id>`) and runs one bounded session on it (`runSession`), which ends as soon as an
observation shows the quest completed or ready for a click. In the session the configured
decision maker and planner choose what to do, and every action is still validated, executed and
verified like any other. Play stops, and says why, when:

- no doable quest is left (the reason names clicks that are due but off or failing), or the
  inventory or the server's quest book cannot be read;
- a session asks for a human (an approval, a safety stop), or the quest's task was paused,
  blocked or closed (play never resumes those);
- the same quest shows no fewer missing items for `maxStuckSessions` sessions in a row, measured
  from the server's count and the inventory, not from what a session claims;
- the time or session limit, the stop file or Ctrl+C.

A failed action or a safe detour (retreating, eating) does not stop play by itself: that is part
of playing, and the planner sees it in its recent history. Play is still started by a human and
bounded in time (at most 8 hours).

## Knowledge base

Routes can only plan what the book knows. The book is built from a **generated GTNH 2.8.4
knowledge base**: `src/goals/knowledge/gtnh-2.8.4.json.gz` (about 730 KiB, 6.8 MiB of JSON),
loaded once on first use by `src/goals/knowledge.ts`. Item names follow the inventory's naming
(registry name, `@damage` when not 0). What it holds, and where each part comes from (details
and evidence in [GTNH compatibility: knowledge base](gtnh-compatibility.md#knowledge-base-2026-09-30)):

| Part                      | Count    | Source on the test server                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crafting recipes          | 53,821   | CraftTweaker's `/minetweaker recipes` dump: shaped and shapeless, ore-dictionary ingredients, 2x2 or 3x3, crafting tools marked                                                                                                                                                                                                                                                                          |
| Output counts             | 3,312    | Not in the dump. Each row says where its count comes from (`countFrom`): GTNewHorizonsCoreMod's recipe scripts (its jar, matched to the dumped recipes: 3,237), the hand-verified table (14), GregTech's saw recipes for planks and sticks (7, read with `javap`), or vanilla's count where GTNH kept vanilla's exact recipe (54, marked `vanilla`). Other counts are unknown (`0`; the route assumes 1) |
| Furnace recipes           | 6,128    | `/minetweaker recipes furnace` (output counts not dumped: 1 assumed)                                                                                                                                                                                                                                                                                                                                     |
| Ore dictionary            | 22,006   | `/minetweaker oredict` (`:*` wildcards expanded to every damage value seen)                                                                                                                                                                                                                                                                                                                              |
| Item names                | 27,050   | Every name is checked against `/minetweaker names` (the item registry) and the agent's `ItemName` format                                                                                                                                                                                                                                                                                                 |
| GT ore veins / small ores | 79 / 55  | GregTech's jar (`OreMixes`, `SmallOres`): heights, weights, density, size, dimensions, the four ores of each vein                                                                                                                                                                                                                                                                                        |
| GT materials              | 801      | GregTech's jar (`MaterialsInit1`): id and tool quality, which set an ore's harvest level                                                                                                                                                                                                                                                                                                                 |
| Ore drops                 |          | GT's code: a vein ore drops its raw ore (`FortuneItem` in `GregTech.cfg`); a small ore drops a weighted mix of gems, crushed ore and impure dust                                                                                                                                                                                                                                                         |
| Harvest levels, tools     | 60 / 199 | `config/IguanaTinkerTweaks` (block levels, tool levels, Tinkers' material levels, level names); GT ores use GT's own rule                                                                                                                                                                                                                                                                                |
| Disabled tools / swords   | 48 / 12  | IguanaTweaks' `disableRegularTools` / `disableRegularSwords` with its blacklist (`main.cfg`): the listed (or listed mods') pickaxes, shovels and axes mine nothing, the listed swords do no damage. Only `ItemTool`s and `ItemSword`s are affected (`javap`), so GregTech's listed tool item is not disabled, and no vanilla sword is listed                                                             |
| Vanilla 1.7.10 layer      | 312 / 21 | The base layer under GTNH's data: the 1.7.10 server jar (crafting recipes with counts, furnace recipes, tool materials and tools, ore generation, block drops) and minecraft-data 3.117.0 (PrismarineJS, MIT: items, blocks, foods, tool speeds, mobs, biomes, enchantments, effects)                                                                                                                    |
| Changes from vanilla      | 255      | The vanilla layer compared with GTNH's: recipes, smelting, drops, tools, ores and hunger, each side with its source; generated as [GTNH 2.8.4 vs vanilla](gtnh-vs-vanilla.md)                                                                                                                                                                                                                            |

**Regenerating it** (the server must be running; the dump commands are read-only lists):

```sh
node scripts/test-server-admin.ts rcon minetweaker oredict
node scripts/test-server-admin.ts rcon minetweaker recipes        # replies "timed out": it keeps running
node scripts/test-server-admin.ts rcon minetweaker recipes furnace
node scripts/test-server-admin.ts rcon minetweaker names
node scripts/test-server-admin.ts rcon minetweaker mods
node scripts/build-knowledge.ts            # needs TEST_SERVER_DIR (or --server, --log, --out)
```

Each dump appends to the server's `minetweaker.log`; the build reads the last of each. A full
recipe dump pauses the server for a few seconds. `scripts/build-knowledge.ts` reads only files in
the server folder: the log, `config/GregTech/*.cfg`, `config/IguanaTinkerTweaks/*.cfg`,
`config/HungerOverhaul/HungerOverhaul.cfg`, two mod jars and the vanilla server jar
(`minecraft_server.1.7.10.jar`), which it parses itself (`scripts/knowledge/jvm.ts`: a zip
reader, a class-file parser, a symbolic interpreter for straight-line code such as GT's data
tables, and a small executor for the vanilla recipe classes' loops; the lint forbids spawning
`javap`), plus minecraft-data from `node_modules`. The vanilla jar is obfuscated, so its classes
are found by what they contain (e.g. `CraftingManager` by its recipe registrations), not by
name. The data records each source file's size and SHA-256 (`sources`) and the caveats
(`notes`). The build also writes [docs/gtnh-vs-vanilla.md](gtnh-vs-vanilla.md); run
`corepack pnpm exec prettier --write docs/gtnh-vs-vanilla.md` afterwards.
`tests/goals/knowledge.test.ts` checks its integrity and known facts.

**Two layers.** Vanilla 1.7.10 is the base layer (`vanilla`: what the game does before any mod)
and everything else is GTNH's, which wins wherever it says something: GTNH's recipes are the
dump's, GT's veins replace vanilla ore generation, IguanaTweaks' rules decide which tools work,
Hunger Overhaul's config decides healing. The vanilla layer fills in where GTNH's data is silent
(a recipe GTNH kept exactly takes vanilla's count, marked `vanilla`; dig yields not changed by
GTNH, `VANILLA_DIG_YIELDS` in `route-book.ts`, apply as they are). Every fact says its layer and
source. minecraft-data's 1.7 recipes are 1.8's, so recipes come from the jar; minecraft-data
gives the item, block, food, mob, biome, enchantment and effect tables (credited in
`scripts/knowledge/vanilla.ts`).

**What GTNH changes.** `changes` compares the layers, one entry per difference: the vanilla
value and the GTNH value, each with its source, the items it concerns (`keys`), and one plain
line of what changed (e.g. "Gravel never drops flint; craft flint from 3 gravel (shapeless,
2x2)", "Wooden Planks: the same ingredients make 2, not 4 (4 with a saw in the grid)"). A
vanilla recipe counts as changed when no GTNH recipe has its exact ingredients (replaced or
removed), when one does but needs a crafting tool too, or when its known count differs.
`src/goals/gtnh-changes.ts` picks the entries that concern the current route and sends them to
the planner as `request.gtnhChanges` (at most 8 lines): a recipe change for an item the route
makes (the goal first), drops, tools and ores for what it digs or the tool kinds it needs,
smelting for what it smelts, then what the player holds (food: Hunger Overhaul). The planner
prompt tells the model to trust these and the route over its memory of vanilla.

**How routes use it.** `src/goals/route-book.ts` builds the book once (`ROUTE_BOOK` is lazy;
`HAND_BOOK` is the hand-verified book alone):

- Recipes: the generated crafting recipes (station `2x2` or `crafting_table`; ore-dictionary
  ingredients as `anyOf` lists; `ore:craftingTool*` ingredients as tools, used but not consumed),
  furnace recipes (station `furnace`) and the hand-verified recipes of `src/domain/recipes.ts`.
  A hand-verified recipe replaces the generated recipe it matches (same output and ingredient
  sets), keeping its verified count and taking the wider ingredient lists.
- Sources: bare-hand digs (`DIG_YIELDS`), digs that need a tool (stone gives cobblestone, with
  the IguanaTweaks level), and GT ores that generate in the Overworld: a vein ore gives its raw
  ore (pickaxe level from GT's rule, where: the vein and its height range), a small ore gives
  its average drops.
- Tools (item, kind, level) and the item that provides each station. Tools IguanaTweaks
  disables are left out: a vanilla iron pickaxe is no pickaxe here, held or to make.

`src/goals/route.ts` stays general (nothing in it is GTNH-specific):

- **Fast with thousands of recipes.** Recipes are indexed by output, and the book becomes an
  AND/OR graph once. Per route, a cost table estimates every item's cheapest way (seconds of
  digging, crafting and smelting) with Knuth's generalization of Dijkstra: items settle cheapest
  first, an option counts once each of its requirements is met, and cycles (ingot to plate to
  ingot) cannot make an item look impossible. A deep GTNH route takes well under a second.
- **Choosing.** For each item the route weighs every way to get it with what is held: a held
  ingredient is free, a missing crafting tool or dig tool is a one-time cost, a station nobody
  knows of costs a little, and a machine station (no item to make it) rules a recipe out. Ties go
  to hand-verified recipes. Output counts the data does not know are taken as 1 and shown as
  `>=N`.
- **Tools.** A gather leg whose blocks need a tool the inventory lacks gets the cheapest fitting
  tool first, expanding its recipe tree; its steps are marked `[for: tool: ...]`. If the tool
  needs the item it will dig (a pickaxe made of what it mines), the route gets those items
  another way first. Held tools match by kind and level (worn vanilla tools by base name);
  Tinkers' Construct tools take their level from NBT, so they count as fitting with a warning.
- **Stations.** `planRoute(..., stations)` takes the stations the agent can use; each needed one
  is listed as available, held (place it), missing (with how to make its item), or, when the
  caller does not say, as needed. The route never places anything.
- **What it cannot do.** Unresolved items carry a reason, e.g. "digging
  gregtech:gt.blockores@16500 (GT small ore Diamond: y 5-15) needs a pickaxe level >= 3: none
  held, none known to make". When nothing completes, the route still expands the recipe that
  gets closest, so the planner sees what it can already do and exactly what is missing.

Not in the knowledge base (open gaps): GT machine recipes (no read-only dump exists; recipes
whose station is a machine would simply be skipped), Tinkers' Construct tool building (Part
Builder and Tool Station are not crafting-table recipes, yet they make GTNH's only early
pickaxes above level 0: the vanilla iron pickaxe mines nothing here, so a route to iron or
diamonds says it cannot make the pickaxe), the output counts of recipes not registered by the
coremod scripts, mob stats and drops (minecraft-data's 1.7 mobs carry names and categories only;
the jar's entity classes are not read), Hunger Overhaul's per-food values (only its switches
are read), and where GT ores are in the world (the agent's chunk scan sees
`gregtech:gt.blockores` with the harvest level as metadata; the ore's material lives in its
tile entity).

## Plans across cycles

A validated plan is stored in the `plans` table with its progress, so a multi-step plan advances one
step per cycle instead of being re-planned (and restarted) every cycle. A task has at most one open
plan; a newer plan supersedes it.

| Status             | Meaning                                                             | Next                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending_approval` | The plan set `requiresUserApproval`. Nothing has run.               | The cycle pauses the task and asks. `plan-approve --task <id> --plan <n>` makes it `active` and resumes the task; `plan-reject` rejects it. Resuming the task alone does not approve it.                                                                                                                                                                                                                                       |
| `active`           | Approved or not needing approval.                                   | Each cycle that reaches `REQUEST_PLANNER` proposes the next step; the executor validates it against the current state.                                                                                                                                                                                                                                                                                                         |
| `completed`        | Every step executed and verified.                                   | The next `REQUEST_PLANNER` asks the planner again.                                                                                                                                                                                                                                                                                                                                                                             |
| `failed`           | A step was rejected, or failed more than `maxRetriesPerStep` times. | Rejected step: the task is blocked, unless a planner's step failed only preconditions (stale: out of reach, too few items, block gone) with no safety violation; then the task goes on and the next cycle replans. Exhausted retries: `REPLAN` leaves the task active (the next cycle asks the planner, with the failure history); `PAUSE_AND_ASK_USER` and `RETREAT_HOME` pause the task (there is no retreat directive yet). |
| `rejected`         | A human rejected it.                                                | After `task-resume`, the planner is asked for a new plan.                                                                                                                                                                                                                                                                                                                                                                      |
| `superseded`       | Replaced by a newer plan for the same task.                         | Nothing.                                                                                                                                                                                                                                                                                                                                                                                                                       |

Safety does not depend on the stored plan: every step is validated again, against the state of the
cycle that runs it, and the repeated-failure rule still applies across plans (a `REPLAN` that proposes
the same failing action is refused with `REPEATED_FAILURE`). Dangers, vitals and upkeep are routed
before the planner, so a plan simply waits while System 1 handles them.

### GATHER: gathering in one plan step

Gathering used to be planned block by block: the planner wrote an 8-step plan of `DIG_BLOCK`
(and `MOVE_TO`) steps every 8 blocks, about 16 s per plan with qwen3:14b. Now it writes ONE
step, `{"type":"GATHER","args":{"block":"minecraft:sand","count":54}}`, and code expands it,
one cycle at a time, into the same checked actions. `src/planner/gather.ts` chooses each
action; `src/app/loop/gather-step.ts` keeps the step's progress. The idea is Baritone's mine process
(pick the nearest known target, walk to it, mine it, repeat until the count is held), written
anew: no code was taken from Baritone (LGPL-3.0).

- **A plan step, not an action.** `GATHER` is not in `ACTION_TYPES`; it exists only in plans
  (`PlanActionSchema`), so it never reaches the executor or a client. The safety policy sees
  exactly the `DIG_BLOCK` and `MOVE_TO` actions it becomes, each validated, executed, verified
  and logged as before (origin `planner`). Its block must be on `DIG_BLOCK`'s allowlist, and
  its count (1 to 256) is of what the block drops, from the route book's dig yields: clay
  gives 4 clay balls, grass gives dirt, gravel gives gravel or flint.
- **A block, or a farm animal.** `{"animal":"minecraft:Cow","count":3}` hunts (for food: see
  Food in [Routes, nights and the play loop](#routes-nights-and-the-play-loop)). Code walks next
  to the nearest grown, unowned animal of that kind (`MOVE_TO`, tolerance 1) and strikes it once
  it is within reach (`ATTACK_ENTITY`: 2.2 blocks with a bare hand, less 0.3 as it moves). A
  struck animal runs off for a few seconds (EntityAIPanic), so after 3 walks in a row to the
  same one it is passed over. The count is of its drops (a cow: 1-3 raw beef and 0-2 leather),
  which the live client walks to and picks up after the kill, as a dig picks up its drop. Each
  strike is dry-run like a dig: an animal the policy would not let it attack now (food or health
  below the fighting limits, a hostile near) is passed over, and the step ends saying why.
- **None in view, but remembered.** A `GATHER` of a block with none of it in view heads for the
  nearest place world memory remembers it at (an `EXPLORE` toward its x and z), then digs there
  as usual. Animals wander, and world memory keeps no animals: a hunt has no such trip.
- **Each cycle** while it is the plan's current step, System 1 decides first, as always
  (dangers, vitals, upkeep). When it decides `REQUEST_PLANNER`, code picks the action from the
  fresh observation, without a model:
  - from the listed blocks of that kind that have a stand spot (`standAt`: one a walk reaches,
    perhaps by breaking leaves on its way, see [Walking](#walking)), minus the ones the step has
    skipped;
  - one within reach (4.5 from the eyes) is dug (`DIG_BLOCK`), nearest first; otherwise the
    agent walks to the nearest stand spot (`MOVE_TO`, tolerance 0.5);
  - only an action the executor would accept now: code dry-runs the real validation (schema,
    safety policy, preconditions, the repeated-failure rule; for a walk, also the dig from the
    stand spot). A block the policy would refuse (sand over the head or on top, a hazard near,
    outside the boundary, a dig that already failed twice) is passed over, so a GATHER never
    proposes a refused dig that would block the task.
- **It ends:**
  - when the inventory holds `count` more of the block's drops than when the step started: the
    step is verified and the plan advances (an operator's plan then completes its task);
  - when no listed block of that kind is left, or none may be dug: the plan fails as a stale
    step and the next cycle asks the planner, which can `EXPLORE`;
  - when one of its actions does not succeed: the plan's own failure handling applies
    (`maxRetriesPerStep` failures in a row, then `REPLAN` or a pause). The block is not tried
    again in this step, and a verified action starts the count of failures in a row again;
  - at 64 actions or 5 minutes: a checkpoint. The plan ends and the planner is asked again,
    with fresh stock.

  When it ends before choosing an action, nothing runs that cycle; the summary is
  `REQUEST_PLANNER -> GATHER:<done|bound|no-target> -> succeeded`. A plan the planner has just
  made whose `GATHER` has nothing to dig is `rejected` instead, like a first step refused as
  stale: the task goes on.

- **Progress** (the drops held at the start, actions, digs, skipped blocks) is kept in agent
  memory (`task_gather:<taskId>`), so a `GATHER` goes on across cycles, sessions and
  interruptions without asking the planner. A bounded auto-run (`run --live`) stops at its
  `--max-cycles` (default 20); the next run continues the same step.
- **The task journal** gets a line when it starts, every 16 blocks dug, and when it ends, with
  why: the planner reads it next time.

A gather of 54 sand on the mock world: one planner call, then 61 cycles (54 digs and 7 walks
to stand spots). Before, the same took about 7 plans, one planner call each. With a model
deciding System 1 at decision points, the 61 cycles ask it once, at the start
([System 1](#a-model-at-decision-points)).

### Accepting a plan

A planner's plan is made from one observation. When one is accepted, code drops the steps
that observation cannot plan (`trimStaleSteps` in `src/planner/plan-validator.ts`):

- every step after the first `EXPLORE`, which walks up to 96 blocks into new ground. Seen live:
  `EXPLORE`, `EXPLORE`, `DIG_BLOCK`; after the walks the dig target was 7.3 blocks away and was
  refused as stale, which cost a failed cycle and a 16 s replan;
- after a `GATHER`, which walks from block to block, the first step that names a position or a
  creature (`MOVE_TO`, `DIG_BLOCK`, `PLACE_BLOCK`, `INTERACT_BLOCK`, `SMELT`, `TAKE_OUTPUT`,
  `ATTACK_ENTITY`), and everything after it. Steps that name none stay: crafting what it
  gathered, another `GATHER`, a container or a named location.

The plan's explanation and the journal (`new plan #N: ... (k steps; code dropped steps ...)`)
say what was dropped, and the next plan starts from what the agent then sees. The whole plan
is validated before anything is dropped, so an unsafe step anywhere still rejects it. A plan a
human wrote (`cli task-add --plan`) is never trimmed.

Then code dry-runs the plan's start on the current observation (`refusedFirstStep` in
`src/app/loop/agent-loop.ts`): its leading `GATHER` steps as they will run (one with nothing to dig
is skipped), and the first other step through the executor's own checks (`validateCandidate`:
schema, safety policy, preconditions, the repeated-failure rule). When that step would be
refused for a reason a new plan can change, or every `GATHER` would find nothing to dig, the
planner is asked once more with why (a journal line of at most 300 characters, the request's
limit); should that answer not do, the first plan stands. Danger and an unreliable observation
are System 1's, not the plan's, and never asked again about. Seen live: the same `EXPLORE`
toward an unreachable tree a third time, `EXPLORE` toward the forest the agent stood in (1.6
blocks away), and "GATHER logs, GATHER gravel" again and again with neither in reach. The
model often answers the same plan when told: what changes its answer is what the request
offers (see [The planner and play](#the-planner-and-play)).

### Code-made blueprints: known safe steps

Some work is planned by code, not by the planner: the night shelter and the way out of it in
the morning (see [Nights](#routes-nights-and-the-play-loop)). Code writes the steps as
ordinary action specs, with one line each; `src/app/loop/known-steps.ts` keeps them in agent memory
(`task_steps:<taskId>`, with how many are done), and the play loop stores them when it starts
the session (the lines also stay the task's blueprint, the planner's route, as before).

- `overlayAgentMemory` makes the next step the state's `knownRecipeState.nextKnownSafeStep`.
  System 1's rule 6 then decides `EXECUTE_KNOWN_SAFE_STEP`, and the proposer runs it with origin
  `deterministic-router`. Whatever a model decides, the planner is not asked while a blueprint
  has steps left: `REQUEST_PLANNER` runs the next step too. Dangers, vitals and upkeep still come
  first, as for any plan.
- Every step is validated (schema, safety policy, preconditions, the repeated-failure rule),
  executed, verified and logged like any action. The safety policy checks `DIG_DOWN` against
  exactly this next step.
- A verified step advances the blueprint, and the last one completes the task, which ends the
  session. A step that does not succeed stays next: the cycle fails, the session ends, and play
  plans again from what it then sees. A step refused only as stale does not block the task.

## Walking

Walking was the live client's first world-changing ability (`src/bot/gtnh1710/walking.ts` plans
and checks; `Gtnh1710Client` sends). It needs `MC_ENABLE_MOVEMENT=true` **and** a fence: whole
blocks at the player's feet level, all on one level (a fence with a height range walks terrain:
`terrain.ts`; in movement mode `follow` the fence is a play area that moves with the player, see
[Exploring and world memory](#exploring-and-world-memory)). Defence in depth:

1. The executor validates `MOVE_TO` / `RETURN_TO_SAFE_LOCATION` as usual: the target is inside the
   safety boundary, the target's surroundings were scanned, it keeps clear of known hazards, and
   the state is reliable.
2. The walker plans on the blocks the server sent: A* inside the fence (no corner cutting), then
   straight stretches where clear. A position is walkable only if every block the player's body
   touches is air or a plant it passes through (below), every block under it is a known full
   block, and nothing dangerous (or unloaded, or unnamed) touches those blocks. Stretches are
   checked exactly: the swept body, not samples.
3. Every 0.2-block step is re-checked just before it is sent (the world may have changed). The walk
   stops on a server correction, a health drop (not at food 0, where the drops are hunger's), a
   hostile (not a calm spider: see
   [Combat](#combat)) or unidentified entity within `threatRadius` (not for a retreat, which is
   how the agent escapes one), the stop file, `halt()`
   (Ctrl+C) or a lost connection. After the last step it waits 5 ticks for a server correction
   before reporting success, and the executor then verifies the position.

**Plants.** The body passes only through air and plants checked in the code the server runs
(`src/bot/gtnh1710/passable.ts`; evidence in
[GTNH compatibility](gtnh-compatibility.md#walking-through-plants-2026-10-01)): no collision
box, and nothing happens on contact. Seen live on 2026-10-01: BOP foliage at feet level walled
in logs 7 blocks away. The list: vanilla tall grass, flowers, saplings, mushrooms, sugar cane
and vines; BOP mushrooms and vines; Natura's wild crops and bluebells; HarvestCraft's gardens.
Some share a block id with variants that hurt on contact, so the client keeps block metadata
(chunk data and block changes, vanilla and NotEnoughIDs; `WalkWorld.metaAt`) and passes those
only at a known, listed metadata: BOP foliage but poison ivy, BOP flowers but deadbloom and
burning blossom, BOP plants but thorns and cactus, and a snow layer only one layer thick (a
thicker one would lift the feet). Everything else, an unnamed id, or a variant whose metadata
is not known, is a wall. A harmful variant hurts only a body inside its cell, so it is no
hazard to stand beside: it simply stays a wall. The same rule decides what the body occupies
in the flat walker, the terrain walker (feet and head cells, every step, drops, and the
gravity check's landing) and the plants allowed around a dig down or a placed block.

**Gravity.** The client does not otherwise simulate physics, and the server kicks a player that
floats for 4 seconds ("Flying is not enabled on this server"; seen live when a walk stopped in the
middle of a step up). So while nothing else runs, twice a second, it checks what the server checks
(`checkSupport` in `terrain.ts`: any block that is not air in the player's box, reaching 0.55
below the feet); in the air, it falls onto the block below with vanilla gravity, only when walking
is allowed, within the fence, at most 3 blocks (no damage) and with no hazard next to the landing.
Feet the server holds up but that hang a little above a block (a player saved mid-jump at logout
joins 0.42 above the sand) come to rest on it the same way (`restingY`), and an observation lands
them first, so the night pit sees the player on the ground. A walk starts from the block the
player stands on: the one under the centre of its feet, or, on the edge of a neighbour (its box,
0.3 each way, reaches over it), that neighbour (`standingCell`; seen live: a walk stopped at
z 9.1 over air, on the edge of the block at z 8, and every walk from there was refused).

**Breaking leaves on the way** (2026-10-01; live since: walks broke 3-4 leaves at a time). Seen live: in a Hot Forest
the logs the agent needed stood 7 blocks away, walled in by one- and two-block-high leaf bushes;
no walk reached a stand spot, GATHER found nothing it could reach, and the agent gave up on the
forest. A person punches through a leaf or two (by hand in half a second), and Baritone's paths
break soft blocks, with the break time in the cost (the idea only; no code was taken). So with
digging enabled, a `MOVE_TO` over terrain may break `minecraft:leaves` and `leaves2` in its way:

- **Which.** Only on straight moves (a diagonal keeps the corner rule), the cells the body
  passes: a level move's destination (head, then feet), a step up's head-room above the player
  and its destination, the column a drop passes and its landing; the upper block first. Each must
  pass `checkWalkBreak` (`digging.ts`) from where the player will stand when it digs: leaves
  only, and every rule of `checkDig` (the dig area and heights, reach, never its own support,
  nothing to fall into the hole, only air and plain blocks touching it and plants only beside
  it, no hazard near, nothing unloaded or unnamed), wholly inside the safety boundary. At most
  4 per walk (`MAX_WALK_BREAKS`).
- **The cost.** Each break costs its time at the walking pace: the dig by hand (`digWaitTicks`:
  10 ticks for leaves) and the server's verdict (about 6 ticks), 3.2 blocks. The walker goes
  round a bush when that is at most about 3 blocks longer per leaf, and punches through when the
  way round is much longer.
- **Stand spots and walks agree.** `planTerrainWalk` (A*) and `reachableFeet` (Dijkstra) share
  `terrainEdges` and the same costs and limits (blocks walked, breaks), applied while searching,
  so they settle the same walk to each feet block. The observation offers a stand spot behind
  leaves (`standSpotFor`, the cheapest walk first) only when a `MOVE_TO` there plans the same
  way: the client builds one rule for both (`walkBreaks` in `client/movement-actions.ts`), only with digging enabled, on a
  terrain fence, with an empty hotbar slot (leaves are broken by hand).
- **The walk.** Before a move that needs breaks, it stops and digs each block exactly as
  `DIG_BLOCK` does (one shared routine): the walk's own checks first (the stop file, `halt()`, a
  correction, health, threats), then `checkWalkBreak` on the blocks the server sent, before the
  dig and every tick during it, with the walk's guard; the dig time; C07 start and finish;
  success only on the server's change to air with no re-send. Presence ticks go on while it
  stands. A break refused or not confirmed stops the walk (`FAILED`, with the reason, after C07
  cancel if it had started), and the agent re-plans; a leaf that is gone already is passed over.
  The fence, every step's re-check, threats and gravity are as for any walk.
- **The result** says what it broke ("broke 2 leaves on the way: ..."). Leaves drop a sapling
  or an apple now and then: after its last break the walk stays until those could be picked up
  (15 ticks) and reports them, so they arrive during the walk and do not pass for the next
  dig's drop. `MOVE_TO`'s verification is unchanged: the player near the target.
- Only `MOVE_TO` breaks (and `cli move --dry-run` plans it so). `EXPLORE`'s hops, retreats (a
  threat stops every dig, and a retreat runs from one) and the walk to a dig's drop do not.

The `move` command runs one such action for a human (origin `user`). The repeated-failure rule does
not apply to it (it is the human's decision each time), and its failures do not count against the
agent's own attempts.

## Chests

`OPEN_CONTAINER`, `WITHDRAW_ITEM` and `DEPOSIT_ITEM` work on configured vanilla chests
(`src/bot/gtnh1710/container.ts` plans; `Gtnh1710Client` sends). Three 1.7.10 facts shape the design:

- The server confirms an accepted click (S32) without sending the resulting slots, so the client
  must predict every click exactly.
- On a mismatch the server rejects the click and re-sends the whole window.
- Closing a window, or disconnecting, with items on the cursor DROPS them into the world.

So, in layers:

1. The executor validates as usual. The chest must be known storage within `interactionReach`,
   the item must not be protected, and there must be enough of it. A withdrawal also needs the
   chest's contents to be known, which they are only while the agent has it open, so
   `OPEN_CONTAINER` comes first.
2. The client opens only a configured chest whose block is `minecraft:chest` (never a trapped
   chest), with an empty hand, and accepts only a chest window (27 or 54 slots).
3. `planTransfer` builds the whole move from predictable clicks: pick up a stack, put it into an
   EMPTY slot, or place one item at a time into a slot it filled itself. It never merges into
   other stacks, so item stack limits never matter, and it never touches stacks with NBT data.
   It refuses up front when the move cannot finish exactly.
4. Clicks go one at a time, each waiting for the server's verdict. On a rejection the client
   acknowledges it, takes the server's re-sync, puts whatever is on the cursor back into an empty
   slot, and reports failure.
5. The window stays open so the executor can verify both sides (player −/+ exactly, chest +/−
   exactly). It closes only with an empty cursor.

`halt()`, the stop file and an ongoing walk, dig or placement also block chest use.

## Interacting with blocks

GTNH has thousands of blocks that open a window, each one different. What the agent knows about
them is data, not code: one interaction profile per kind of block, in
`src/domain/interactions.ts`. The live client does the same generic window work for every profile
(`src/bot/gtnh1710/interact.ts` plans; `Gtnh1710Client` sends). `INTERACT_BLOCK`, `SMELT` and
`TAKE_OUTPUT` need `MC_ENABLE_INTERACT=true`. The facts and their evidence are in
[GTNH compatibility](gtnh-compatibility.md#interacting-with-blocks-2026-09-30).

**A profile says:**

- `blocks`: the registry names it covers. The block at the position decides.
- `open`: an empty-hand right-click, or `never` with the reason (a trapped chest emits redstone).
- `window.variants`: each way its window can look. A variant has:
  - the opener: an S2D type and announced slot count, or an FML mod id and GUI id;
  - the layout: the container slots before the player's 36, in groups with a role (`input`,
    `fuel`, `output`, `grid`, `result`, `storage`...) and whether the agent may put items in or
    take them out;
  - `trailingSlots`, for windows that show more slots after the player's.
- `itemsOnClose`: `kept`, or `dropped` (a crafting grid).
- `result`: none, an output slot, or a crafting result that only a full sync shows.
- `properties`: what its S31 window properties mean.
- `usedBy`: the actions that may use it.
- `storage`: every slot is plain storage. The block is then listed in `GameState.storage`, and the
  container actions may use it.
- `evidence`: where each fact was checked.
- `stateSource` and `modPayloads`: room for later (state from tile-entity data; mod packets such as
  Tinkers' stencil table's).

Profiles today:

| Profile            | Blocks                                       | Used by                                  |
| ------------------ | -------------------------------------------- | ---------------------------------------- |
| `crafting_table`   | `minecraft:crafting_table`                   | `INTERACT_BLOCK`, `CRAFT_ITEM`           |
| `furnace`          | `minecraft:furnace`, `minecraft:lit_furnace` | `INTERACT_BLOCK`, `SMELT`, `TAKE_OUTPUT` |
| `chest`            | `minecraft:chest`                            | `INTERACT_BLOCK`, container actions      |
| `trapped_chest`    | `minecraft:trapped_chest`                    | nothing: never opened                    |
| `iron_chest`       | `IronChest:BlockIronChest` (11 chest types)  | `INTERACT_BLOCK`, container actions      |
| `hungry_chest`     | `Thaumcraft:blockChestHungry`                | `INTERACT_BLOCK`, container actions      |
| `crafting_station` | `TConstruct:CraftingStation`                 | `INTERACT_BLOCK` (looked at only)        |

**In layers:**

1. **Observation.** `interactables` lists blocks near the player, nearest first (32 at most), from
   the chunk data: blocks with a profile or on the observe-only list, with a face open to air. With
   a fence, only blocks inside it are listed, each with where to stand to use it (inside the fence,
   within reach). A furnace also has `burning` (the block is `lit_furnace`, so this is always
   current) and its contents and timers as last seen. `blockWindow` is the last block window
   opened.
   - Found crafting tables are also listed in `craftingTables` as `crafting_table:<x>.<y>.<z>`.
   - Found storage blocks are listed in `storage` as `<profile>:<x>.<y>.<z>`, with their contents
     while open.
2. **Safety policy.**
   - The block must be listed in the observation, with a profile that allows the action
     (`NOT_INTERACTABLE` otherwise, which counts as stale: the agent replans).
   - The whole block must be inside the boundary.
   - `SMELT`: approved fuels only, never lava.
   - No protected input, fuel or output.
   - Nothing is opened in danger.
3. **Preconditions:** reach from the eyes (4.5), enough input and fuel together, and an empty slot
   for an output.
4. **The client** re-checks the block itself: loaded, its name, its profile or the observe-only
   list, the never-opened lists, reach and the fence.
   - It opens the block with an empty hand, and accepts only a window the profile knows (opener
     and exact slot count).
   - Clicks are the chests' clicks: predictable, all planned before the first one, never onto
     stacks with NBT data, one at a time with the server's verdict. A rejection is followed by the
     re-sync, and the cursor goes back to the inventory.
   - The window stays open for verification. The next dig, chest, crafting or window action
     closes it, never with a full cursor.
5. **The verifier** checks exact inventory deltas with every other item unchanged. For `SMELT`,
   the furnace must be open and hold the input. For `TAKE_OUTPUT`, the count the client reports
   must have reached the inventory.

**Smelting.** A furnace smelts on its own, 10 s per item, and keeps its items when the agent
leaves. So the planner puts the items and enough fuel in with one `SMELT`, does something else or
`WAIT`s (`furnace.secondsLeft` in its state), then `TAKE_OUTPUT`s. What comes out is the server's
business: GTNH changes smelting (no charcoal from logs), so the agent never assumes a result. It
takes only what the output slot shows.

**Observe-only fallback.** A block without a profile can only be looked at, and only if the
operator lists it in `MC_INTERACT_OBSERVE_ONLY`. Entries are exact names
(`BiblioCraft:BiblioShelf`) or whole mods (`appliedenergistics2:*`).

- `INTERACT_BLOCK` opens the block, records its window and closes it again at once. Nothing
  inside is ever clicked.
- The record goes to the `window_layouts` table: block, opener, slot count, where the player's
  inventory appeared, and a sample of the slots. `cli layouts` lists them: the material for a
  new profile.
- Some blocks are never opened, even when listed (`NEVER_OPEN_BLOCKS`, `NEVER_OPEN_MODS`):
  - vanilla blocks whose right-click changes the world: levers, buttons, doors, beds, TNT...;
  - mods whose right-click moves the player's items (Storage Drawers, JABBA);
  - mods whose windows the client cannot recognise (EnderStorage).

**Adding a profile** is a data change:

1. Find the block's registry name and look at it. Add it to `MC_INTERACT_OBSERVE_ONLY`, then run
   `cli interact --live --at x,y,z` and `cli layouts`. That shows how it opens and its slot count.
2. Check its code in the server's jars (`javap`):
   - What an empty-hand right-click does. Nothing else may happen: no redstone, no items moved, no
     sneaking needed.
   - Its container class: the order of the slots, and what each accepts (`Slot.isItemValid`).
   - What `onContainerClosed` does with items left inside: kept or dropped.
   - Its window properties, and every variant (types, sizes).
   - Mixins and transformers in other mods that touch those classes.
3. Add an entry to `INTERACTION_PROFILES` (and its id to `PROFILE_IDS`), with the evidence, and
   a row in the compatibility doc. `tests/domain/interactions.test.ts` checks that every layout
   covers each of its slots exactly once.
4. Add its window to the fake server (`tests/bot/gtnh1710/fake-chests.ts`), with a test that
   opens it.
5. Try it live in the pen before relying on it.

Some blocks need a new kind of profile first: ones that need more than clicks (a mod packet),
ones whose state comes from tile-entity data, and block names that cover different machines
(GregTech's `gt.blockmachines`, Railcraft's `machine.*`). The
[storage survey](gtnh-compatibility.md#storage-blocks-in-gtnh-284) lists which GTNH storage
blocks those are.

**Storage index.** Storage blocks with a profile are listed in `GameState.storage` as
`<profile>:<x>.<y>.<z>`: position ids, so nothing needs configuring. Their contents are known while
the agent has the block open. Each cycle remembers every container whose contents it saw, with the
time, so the agent's container memory works for them across connections like for configured
chests. `OPEN_CONTAINER`, `DEPOSIT_ITEM` and `WITHDRAW_ITEM` work on them when both
`MC_ENABLE_CONTAINERS` and `MC_ENABLE_INTERACT` are on. A move must be allowed for every slot of
the window: nothing is ever put into an Iron Chests dirt chest.

**Crafting at found tables.** `CRAFT_ITEM`'s `craftingTableId` may name a configured table, or
`crafting_table:<x>.<y>.<z>` from the observation, inside the fence. Everything else about
crafting stays the same.

The window model (the block's slots, then the player's inventory, plus a result slot) follows
the ideas of prismarine-windows and Mineflayer's furnace and crafting plugins (MIT). No code was
copied, and every number was checked in the 1.7.10 and GTNH jars.

## Digging

`DIG_BLOCK` breaks ONE block from a fixed allowlist of natural blocks: vanilla `log`, `log2`,
`leaves`, `leaves2`, `dirt`, `grass`, `sand`, `gravel` and `clay`, Biomes O' Plenty's leaves,
and HarvestCraft's land gardens (`src/domain/blocks.ts`). A bare hand harvests all of them,
and none has a tile entity. It needs `MC_ENABLE_DIGGING=true`
**and** the movement fence. The block facts and dig times are in `src/domain/dig-time.ts`, the
tools it may hold in `src/domain/tools.ts`, the checks in `src/bot/gtnh1710/digging.ts`;
`Gtnh1710Client` sends. The server-side rules it relies on are in
[GTNH compatibility: digging](gtnh-compatibility.md#digging) and
[tools](gtnh-compatibility.md#tools-2026-09-30). In layers:

1. **Observation.** The `GameState` lists `nearbyBlocks`, computed from the chunk data
   (`resource-scan.ts`):
   - `resources`: allowlisted blocks within 16 blocks, at or above the feet level, nearest
     first, plus sand, gravel and clay one level below the feet and the nearest 8 dirt and
     grass blocks of the floor (a sample: the floor is everywhere). At most 64, shared fairly
     between kinds (`nearestOfEachKind`: every kind's nearest before any kind's second), so a
     kind not listed has none within the declared radius; that radius shrinks only when more
     kinds are found than the list holds. Seen live: 31 grass, 27 sand and 6 leaves filled the
     64 nearest, and the logs a `GATHER` wanted were never listed. The block the player stands
     on is never listed. `standAt` is a spot a walk from the player reaches
     (`reachableFeet` in `src/bot/gtnh1710/terrain.ts`: the walker's own moves, flooded from the
     feet), so a block walled in by leaves, plants or water has none.
   - `removed`: positions where the client saw such a block turn into air, while they stay air.

   The planner gets 32 resources, shared between kinds the same way, and `tools`: the allowlisted tools the player
   carries (from the inventory names, where a worn tool shows its damage), with the digs each
   has left and the blocks it digs faster. Protected tools are left out. To gather many
   blocks, a plan uses one `GATHER` step, which code turns into these digs and the walks to
   their stand spots (see [GATHER](#gather-gathering-in-one-plan-step)).

2. **The executor validates as usual.**
   - The whole block must be inside the safety boundary.
   - It must be listed in `nearbyBlocks.resources` (`NOT_DIGGABLE` otherwise, pause), so
     nothing off the allowlist can even be asked for.
   - It must clear known hazards by `hazardAvoidanceRadius`.
   - It must not be under the player or in its body's cells, must not be sand or gravel over
     the player's head, and must not have a listed sand or gravel block on top (`UNSAFE_DIG`).
   - Preconditions: within `interactionReach` of the eyes, and a free inventory slot for the
     drop.
   - Like any world action, it is refused during danger.
3. **The client re-checks it all on the blocks the server sent** (`checkDig`), fail closed:
   - inside the fence's columns, from the fence level up to `maxHeightAboveFence` (default 4),
     never the floor;
   - loaded, named and allowlisted;
   - within 4.5 of the eyes;
   - not in the player's own columns at or below its head, and not sand or gravel above it.
   - Everything touching the block's six faces must be air, an allowlisted block, or one of the
     walker's plain full blocks. Water, lava, torches, plants, chests, machines, modded and
     unnamed blocks all refuse: removing the block could flood the hole, drop something
     attached or change a build.
   - Nothing on top may fall into the hole, and nothing dangerous may be anywhere in the 3 x 3
     x 3 cube around it.
   - A HarvestCraft garden is a plant (BlockGarden extends BlockFlower): its cell is open
     already, so breaking it opens no hole. Its own rules: plain ground under it, nothing beside
     or above it but air, plain blocks and plants (never a fluid: water would flow into the freed
     cell), nothing on top that falls, nothing dangerous in the cube. A garden is never among
     the blocks that may touch another dug block: on top of one, it would drop. Gardens have no
     hardness (0): the server breaks one on the dig's start, so the client sends no finish and
     waits no dig time (`instantDig` in `src/domain/dig-time.ts`); a right-click would pick it up
     as a block instead, and the agent never right-clicks one.
4. **The dig itself, with the best allowed tool or an empty hand.**
   - Only the wooden shovel (on dirt, grass, sand, gravel and clay) and the vanilla axes (on
     logs) may be held. On this server each breaks one block, and its speed and wear are known.
     The other vanilla shovels dig nothing here (IguanaTweaks), and GregTech and TConstruct tools
     keep their wear in NBT data the client does not read.
   - The client picks the fastest such tool in the inventory that has no NBT data, is not
     protected, and that one more use cannot break. The executor hands the protected items over
     with the validated action. For wooden tools "cannot break" means damage + 1 ≤ 59, the lower
     of vanilla's and GregTech's maxima.
   - At equal speed it prefers the tool in hand, then the hotbar, then the main inventory. A tool
     in the main inventory is first moved into an empty hotbar slot with two confirmed clicks in
     window 0. A click that is not accepted puts the cursor back and fails the dig.
   - With no usable tool it holds an empty hotbar slot (an empty hand). With neither, it
     refuses.
   - It selects the slot (C09), sends C07 start, and waits the vanilla dig time at the tool's
     speed x 1.25 + 2 ticks: sand takes 21 ticks by hand, 12 with a wooden shovel.
   - Every tick it re-checks everything above, plus: the stop file, `halt()`, the connection,
     a server correction, a health drop, a hostile (not a calm spider) or unidentified entity
     within `threatRadius`, any update for the block (the server's refusal is a re-send), and that the
     tool in hand has not changed.
   - On any problem it sends C07 cancel and fails.
5. **The finish and the verdict.** It sends C07 finish, then waits for the server's block
   changes and a quiet 250 ms. Forge sends "air" to the digging player before mods may cancel
   the break, so the first "air" alone is not proof. Only air, with no re-send, is success.
   Any re-send (too early, a cancelled break) fails the dig. If the server judged it too
   early, vanilla still breaks the block when its own timer reaches 100%; the next observation
   shows that.
6. **The tool and the drop.** It waits up to 1 s for the server to re-send the tool's slot
   (one more damage) and up to 2 s for the inventory to grow. The result reports the tool
   (`tool`, null for an empty hand), its uses left (`toolUsesLeft`), why other tools for the
   block were passed over (`toolNote`), `dropCollected` and which items arrived. The tool's
   new name (`minecraft:wooden_shovel@1`) is not counted as a drop. A drop out of pickup range
   is fetched by walking onto it when the fence is terrain and the spot is standable;
   otherwise it is reported.
7. **Verification:** `BLOCK_REMOVED` passes only if the new observation lists the position in
   `nearbyBlocks.removed` (seen turning into air, still air) and not among the resources.

Walking, chests and digging never run at the same time (the leaves a `MOVE_TO` breaks on its way
are digs inside the walk, with this same routine: see
[Breaking leaves on the way](#walking)). `halt()` and the stop file stop them all.

**Not covered yet:**

- Entities on or hanging from the block. A mob or player standing on it drops a block, and an
  item frame or painting hanging on it pops off. The client does not track paintings at all.
- Potion effects that slow digging (Mining Fatigue). They are not observed; the server would
  judge the dig too early, and the dig fails cleanly.
- Leaves decaying later once nearby logs are gone. That is the world's normal behaviour after
  chopping.
- Enchanted or renamed tools (NBT data), GregTech tools and TConstruct tools: never held. Their
  data would have to be decoded first.

## Digging down: the night pit

`DIG_DOWN` (approved 2026-10-01) digs the block under the player's own feet and drops the player
exactly one block. It exists for the night pit only (`src/domain/night-shelter.ts`); every
other dig still never touches the ground the player stands on. In layers:

1. **Only code proposes it.** The pit's blueprint (`src/bot/gtnh1710/night-pit.ts`, run by the
   play loop as known safe steps) is the only source. Plans never contain it (`validatePlan`
   refuses it; planners are not offered it, and the planner prompt says so).
2. **Observation.** With digging enabled, `nearbyBlocks.underFeet` reports the block the player
   stands on and the one under it, and whether that landing holds the player (a plain full
   block; sand or gravel only on another). It is null while the body stands across columns or
   not on a block top.
3. **The safety policy** (`digDownChecks`) refuses it unless it is the night pit's own step
   (`NIGHT_PIT_ONLY`, pause): origin `deterministic-router`, the current task is the
   night-shelter task, the action is exactly that task's next known step, and it is evening,
   night or the last 4 real minutes before night (an unknown time: `STATE_UNKNOWN`). It must
   be exactly the block under the feet, reported as dirt, grass, sand, gravel or clay over a
   landing that holds (`NOT_DIGGABLE`, `UNSAFE_DIG`), inside the boundary and clear of known
   hazards; never during danger.
4. **The client** (`checkDigDown` in `digging.ts`, before the dig and every tick, fail closed):
   - a fence with a height range (never the pen), the landing level inside it;
   - exactly the block under the feet; the body, with the server's floating-check margin
     (0.3625), in that one column, on its top;
   - the block is dirt, grass, sand, gravel or clay; the landing a plain full block (a cave,
     a fluid or a plant under it would mean a longer fall), and under sand or gravel another;
   - only air and plain blocks touch the dug block (no plant on it: the feet cell is air), and
     no sand or gravel beside it stands on nothing;
   - every cell of the 3 x 3 columns from the landing's level up to the head's is loaded and
     named and holds air, a plant the walker passes (by its metadata: not poison ivy) or a
     plain block: no water or other fluid, no other modded block, no hazard; one level lower,
     no hazard either.
5. **The dig** is `DIG_BLOCK`'s, with these rules instead of `checkDig`'s: the best allowed tool
   or an empty hand, the dig time, every tick re-checked, success only on the server's change to
   air with no re-send.
6. **The fall** (`#fallInto` in `client/dig-actions.ts`). The client does not otherwise simulate physics, so it falls as a
   game client would, like the gravity check (`keepSupported` in `client/movement-actions.ts`) does: after `checkSupport`
   shows nothing holds the player and the floor is exactly one block down, with no hazard next
   to the landing, it sends the vanilla-gravity positions (`fallDistances`: 5 packets for one
   block, on the ground only at the last), then waits 5 ticks for a server correction. Walking
   must be enabled. The drop falls into the hole with the player and is picked up there.
7. **Verification** (`DUG_DOWN`): the block is observed turning into air (still air), and the
   player's feet are in its cell, one block lower.

Walking, chests, crafting, digging (and digging down), placing and fighting never run at the
same time.

## Placing

`PLACE_BLOCK` places ONE block the player carries, from a fixed allowlist of plain vanilla
blocks: `dirt`, `cobblestone`, `sand`, `gravel`, `sandstone`, `planks` (every wood type) and
`log`/`log2` (`src/domain/blocks.ts`). It needs `MC_ENABLE_PLACING=true` **and** the movement
fence. `src/bot/gtnh1710/placing.ts` holds the checks; `Gtnh1710Client` sends. The server-side
rules it relies on are in [GTNH compatibility: placing](gtnh-compatibility.md#placing-2026-09-30).
In layers:

1. **Observation.** `nearbyBlocks.placeable` lists the cells a block could go into, nearest to
   the eyes first (at most 32; the planner gets 16): air, tall grass or a dead bush within 4.5
   of the eyes, clear of the player's body and of every entity, touching a plain full block
   that faces the eyes to place it against, with only air, plants and plain blocks around it
   and no hazard within one block. Each says whether sand and gravel may go there
   (`takesFalling`: a plain full block under it, and not in the player's own columns). With
   placing enabled only cells inside the fence and its place heights are listed.
   `nearbyBlocks.placed` lists cells the client saw turn from empty into a placeable block,
   while they still hold it.
2. **The executor validates as usual.**
   - The whole cell must be inside the safety boundary, and the item must not be protected.
   - It must be listed as placeable (`NOT_PLACEABLE` otherwise, pause), so no cell can be
     invented.
   - Never a cell the player's body is in; never sand or gravel in a column the player stands
     in, or where `takesFalling` is false (`UNSAFE_PLACE`, pause).
   - It must clear known hazards by `hazardAvoidanceRadius`.
   - Preconditions: within `interactionReach` of the eyes, and the item in the inventory.
   - Like any world action it is refused during danger. Placing is deliberately not an escape:
     one block does not make a shelter, sealing one with a mob within reach can wall the agent
     in with it, and a creeper's blast opens it again. Shelters are built before dark, while
     the state is safe.
3. **The client re-checks it all on the blocks the server sent** (`checkPlace`), fail closed:
   - inside the fence's columns, from its level up to `maxHeightAboveFence` (default 4); on a
     terrain fence from one below the feet;
   - the cell holds air, tall grass or a dead bush: never water, lava, a flower or a block;
   - only air, plants the walker passes (by their metadata), allowlisted blocks and the
     walker's plain full blocks touch it, and nothing dangerous is in the 3 x 3 x 3 cube
     around it;
   - no tracked entity may be in the cell. Sizes are not observed, so each counts as a box 2
     wide and 3 tall around its position;
   - the block it clicks: the first plain full neighbour, in the order below, north, south,
     west, east, above, whose face towards the cell faces the eyes and whose centre is within
     5.5 of the feet and of the point 2 above them. Never a chest, crafting table, machine or
     modded block: the server activates the clicked block first, and those would open;
   - no hostile (but a calm spider) or unidentified entity within `threatRadius`, no health
     drop or server correction since it started, and neither `halt()` nor the stop file.
4. **The hand.** The selected hotbar slot if it holds the item, else the first hotbar slot
   that does, else a stack from the main inventory goes into the first empty hotbar slot with
   two confirmed window-0 clicks (a failed click puts the stack back). With neither, or only
   stacks with NBT data, it refuses. An open chest window is closed first.
5. **The click.** Everything is checked again just before it. Then C05 to face the centre of
   the clicked face, C08 with the held stack exactly as held and the cursor on that centre,
   and C0A to swing the arm, as a vanilla client does after a use.
6. **The verdict.** The server answers every C08 with S23 for the clicked block, then for the
   cell. The first is the acknowledgement: cell updates before it are stale. Success needs
   every cell update after it to be the placed block, over a quiet 250 ms (a mod that cancels
   the placement restores the cell, and sand with nothing under it would fall within that
   time). A window that opens instead is closed again, and the placement fails. Then the held
   slot's S2F with one item fewer is awaited (1 s) and reported as `stackUsed`.
7. **Verification:** `BLOCK_PLACED` passes only if the new observation lists the cell in
   `nearbyBlocks.placed` with the expected block, and the inventory holds exactly one of the
   item fewer.

Walking, chests, crafting, digging and placing never run at the same time. `halt()` and the
stop file stop them all.

**Not covered yet:**

- Metadata: placing compares block ids only (the client keeps metadata, for walking), so a
  plank's wood type and a log's axis are not checked.
- Paintings are not tracked, so one hanging where the block goes pops off. Item frames are
  tracked entities and refuse the cell.
- Blocks with a GUI or that need support (torches, crafting tables, furnaces, the coke oven)
  are not on the allowlist; each will need its own checks.

## Crafting

`CRAFT_ITEM` crafts with a recipe from the agent's table (`src/domain/recipes.ts`): 2x2 recipes in
the player's own grid (window 0), 3x3 at a configured crafting table. `src/bot/gtnh1710/crafting.ts`
plans; `Gtnh1710Client` sends. On top of the chest facts, 1.7.10 has three more
([evidence](gtnh-compatibility.md#crafting-2026-09-30)):

- The server never sends the crafting result slot as a slot update. Only a full window sync shows
  it, and the server sends one whenever it rejects a click.
- Taking the result puts the whole stack on the cursor and takes one item from every grid slot.
- Closing a window, closing the inventory itself, or leaving the server DROPS whatever is in the
  grid, like the cursor.

GTNH changes many vanilla recipes, so the table is never trusted blindly. In layers:

1. The executor validates as usual. Every ingredient kind the recipe may use must be unprotected,
   the inventory must hold enough, and a 3x3 recipe needs a known table within `interactionReach`.
   The postcondition is derived from the table: the result +count × times, each ingredient group
   −cells × times, and nothing else changed.
2. The client plans the whole action on its view of the inventory and refuses before anything is
   opened or clicked when it cannot finish exactly. Window 0 is clicked only with no other window
   open. A table opens only if it is configured and its block is a `minecraft:crafting_table`, with
   an empty hand.
3. Each craft:
   - **Fill:** one item into every pattern cell, with predictable clicks (pick up a stack, place one
     item per empty cell, put the rest back).
   - **Sync:** a left-click on an empty slot with an empty cursor, claiming a stack that slot cannot
     hold. The server rejects it and re-sends the window. Every slot must match the client's
     prediction.
   - **Check:** the result slot must show exactly the expected item and count, without NBT data.
     Otherwise nothing is taken and the action fails with what the server showed, so the operator
     learns the real recipe.
   - **Take** the result with one click (cursor gets it; every grid slot −1), then **store** it in an
     EMPTY slot. Results are never merged into other stacks, because their stack limits are unknown.
4. Any failure first returns the grid and the cursor to the inventory: onto the stack an item came
   from while that stays within a size the stack has already had, otherwise into an empty slot.
   Then a sync confirms. A final sync confirms success too.
5. The grid only ever holds one craft's worth of items. A table is closed afterwards, and never with
   items in its grid or on the cursor. `outbound.closeWindow(0)` is refused outright: it would drop
   the 2x2 grid.
6. `disconnect()` first returns anything a crafting grid or the cursor still holds.

`halt()` and the stop file stop crafting between crafts. Walking, chests and crafting exclude each
other, and walking is refused while items are on the cursor or in a crafting grid: walking away
closes a window server-side.

## Exploring and world memory

GTNH rewards a good starting spot: the quest book sends the player for gravel "near water",
clay on "the riverbanks", and warns "You will have to travel far in this tier". The test world
spawns the agent in a desert (Hot Desert, biome 230). So the agent can leave its first spot:
a play area that moves with it, an `EXPLORE` action, a memory of what it has seen, and a
planner that knows both.

### The play area (`src/bot/gtnh1710/play-area.ts`)

`minecraft.movement.mode` (`MC_MOVEMENT_MODE`) chooses where walks and digs may happen:

- **`fixed`** (the default): the configured fence, exactly as before (the test pen).
- **`follow`**: a terrain fence around the player's feet block, `movement.area.side` columns
  square (at most 64) and `area.height` levels tall (at most 32), clipped so every block of it
  lies inside the **exploration boundary**, which is the safety boundary (`SAFETY_BOUNDARY_MIN/MAX`,
  at most 2048 blocks per side in this mode). Without the boundary, or with the player outside
  it, nothing walks or digs.

Every use of the fence in the client goes through one function, `fence()` in `client/core.ts`. A walk
or dig takes its fence once, when it starts, and every step or tick is checked against that same
fence, so the moving area never changes the per-step rules: walking, its 0.2-block steps, every
step re-checked, threats stopping `MOVE_TO`, digging's checks, all as above.

### EXPLORE (`src/bot/gtnh1710/explore.ts`)

`EXPLORE { toward: <direction> | {x, z}, maxDistance: 8..96 }` walks over land, in hops:

1. The goal is the point, or `maxDistance` blocks in the compass direction (north is -z), pulled
   in to stay 1.5 blocks inside the boundary.
2. Each hop: the client waits until the chunks and entities around its spot have arrived, then
   a search over the play area with the walker's own move rules (level moves without cutting
   corners, one block up with headroom, drops of at most 2, never into water, lava, unloaded
   chunks or next to a hazard) finds the reachable spots closest to the goal, within
   `maxPathLength` and the distance left. The best one becomes an ordinary checked walk
   (`walkTo` in `client/movement-actions.ts`, MOVE_TO's rules: threats stop it). If the walker will not plan it, the next
   candidate is tried.
3. It stops, OK, at the goal, after `maxDistance` blocks walked (or nearly: when the few blocks
   left are too short for a hop that a full-length one would make, it says "walked nearly the
   whole maxDistance", not "no way further"), at the boundary, when no spot gets closer (water, a
   cliff, a wall), when two hops in a row gain less than a block (stuck),
   when it gets dark, or at 12 hops / 3 minutes; it fails on anything that stops a walk (a threat,
   a correction, health, the stop file, `halt()`, the connection). The result says how far it got
   and what it saw.

The same hops bring the agent back: in mode `follow`, a `RETURN_TO_SAFE_LOCATION` whose location
lies outside the current play area travels in hops to within 6 blocks of it (at most 768 blocks
walked, 48 hops, 6 minutes), then walks onto it. Threats do not stop a retreat (it is how the
agent gets away from them) and it is not limited to daylight: it is the escape. Every step is
still checked for terrain and hazards, and a health drop still stops it.

This is the long-distance idea of Baritone (path to the best reachable node toward a goal beyond
the loaded area, then re-plan as chunks arrive) and of mineflayer-pathfinder's `GoalXZ`
(an x/z goal at any height), written anew for this walker: no code was taken from either.

The executor checks it like any action: a point must lie inside the boundary (`OUT_OF_BOUNDS`,
also for plan steps), only in daylight (`NOT_DAYTIME` in the evening or at night; an unknown
time is refused too), never during danger, and the postcondition `EXPLORED` needs the player at
least a block farther along the heading and no farther than `maxDistance` from where it started.
Unlike `MOVE_TO`, the target's surroundings need not be scanned already: reaching unscanned
ground is the point, and every step is checked on the blocks the server sends.

### World memory (`src/bot/gtnh1710/world-survey.ts`, `src/domain/world-memory.ts`)

The client has every block of every loaded chunk, which is x-ray. A player does not, so a block
counts as seen only when:

- it lies near the surface (within 24 blocks below its column's top block: trees, the ground,
  cliff faces; not caves);
- a face of it touches air (water: its top), so a player could see that face (a lake bed seen
  only through water is left out: the agent cannot dig it);
- a straight line from the eyes to that face passes only through air, water, glass, plants and
  at most 2 leaf blocks, within 40 blocks (unloaded and unknown blocks block it);
- it is day: nothing is surveyed in the evening or at night.

**Far sight.** A player spots a river, a lake or a cliff much farther away than 40 blocks (seen
live: the agent walked 94 chunks of desert and forest and never saw water, gravel or clay). So
beyond 40 blocks, out to 112, the survey also looks at each column's top block (under any
plants), for what stands out from afar: water, lava, sand, gravel, clay and stone; not logs
(from afar only a canopy's, too high to dig), leaves or grass (the cover of nearly all land), nor
ores (a speck in a cliff). It counts as seen by the face a player sees: its top face when the
eyes are above it, else an open side face turned toward the eyes (from below, a slope shows its
risers: in the test world's saved chunks, the only gravel within reach of the agent's plateau at
y 92 lay on a slope at y 104, 103 m south), on a clear line of sight by the same rules. 112
blocks: with a server view distance of at least 8 chunks (the test server's was 8, and is 12
since 2026-10-01), the client holds at least 128 blocks each way, and 112 leaves a chunk's margin
for chunks still arriving (an unloaded block blocks the line). A chunk wholly beyond 40 blocks is recorded only when far sight saw something in it (a
player cannot tell the biome of ground hidden behind a hill), and marked `near: false` until the
agent sees it from near. Sand and stone come in sheets, so far sight looks at every second column
of them each way: their counts from afar are lower bounds. Gravel, clay, water and lava are looked
at on every column.

A survey covers every chunk within reach (40 blocks; with far sight, 112), when the player enters
another chunk and after every EXPLORE hop; far sight is left out of the re-survey every 30 s in
the same chunk (from there its view hardly changes). It runs in the client's event loop, between
packets: 4-11 ms near only and 5-12 ms with far sight on the bench terrain
(`node scripts/survey-bench.ts`: the 17 x 17 chunks a client holds, with hills, trees, a river
and a lake), about 5 and 8 ms on the test world's saved chunks around the agent. It reads each chunk
column once per survey (not a map lookup per block), and looks closely only at blocks with an
open neighbour (the rest of the band is buried ground); the near rules decide exactly as before
(checked block for block against the previous survey on the bench terrain, caves and all).

Per chunk it keeps the dominant biome (decoded from the chunk data, named from `biomes.ts`),
counts of logs, leaves, dirt (dirt and grass), sand, gravel, clay, water, lava, stone (and
cobblestone) and ores (by block name; the material is never guessed), up to 3 seen positions of
each, and whether it was seen near. The agent loop stores the sightings at every observation and
after every action (`world_chunks`, migrations 005 and 007). A new sighting is merged with the
stored one (the most seen of each kind; near once seen near), so a poor view, or a far one, never
erases a good one. Chunk coordinates are plain integers, so chunk-grid rules (GregTech's ore-vein
grid) can be applied later.

### The planner and play

- In mode `follow` (with movement on) the planner request gets `exploration`: per resource the
  nearest place seen with enough of it (and a much richer one), the biomes seen, and per direction
  how far it has been seen and the room left to the boundary. `EXPLORE` is in `allowedActions`
  only then. Rule 15 of the planner prompt: a good start has wood, gravel and sand near water,
  clay on riverbanks and stone; when the task needs a block that is not listed nearby, EXPLORE
  toward a known place, or toward the least-seen direction with room; EXPLORE last in a plan
  (code drops any step after it, see [Accepting a plan](#accepting-a-plan)); never in the
  evening or at night. (`pnpm cli places` prints the same summary.) Chunks far sight saw count
  like any other: their places are blocks that were seen, with a y, and a direction counts as
  seen as far as a landmark was made out that way; since far sight records only chunks where
  something stood out, a way a hill or a canopy hid stays little seen, which is where a player
  would go to look.
- A gather leg of the route with no known place gets where to look, the surest first: a seen
  biome where the material is common, away from the player (a river or a beach for gravel); then,
  for gravel, clay and sand, the nearest remembered water the player is not by ("the shore of the
  water at x 97, z -60, 112 m north_east (seen 3.2 min ago): gravel, clay and sand lie on river
  and lake shores and beds; EXPLORE toward that x and z": in 1.7.10 they generate as disks
  around water, on the beds and up the banks); then the biome patch the player stands in,
  explored on through; last, new ground in the direction with the most room left unseen. Water
  is worth walking to for its shore: the agent does not wade or dig under water.
- What the request offers is what the model plans toward, so code leaves out what would mislead
  it. A remembered place the current resource scan covers (its sphere, at or above the feet) is
  left out of the route and of `exploration.places`: it is in view already, with a stand spot a
  walk reaches, or out of reach from here. A point an `EXPLORE` found "no way further" toward is
  a dead end (`src/app/loop/dead-ends.ts`): while the player is within 24 blocks of where that
  happened, places and biome patches within 12 blocks of the point are left out too. A compass
  direction that led nowhere (from where it could not start, or from where it stopped short) is
  a dead end the same way: near there it shows no room left, so the "new ground" hint names
  another. An open plan's next step that the repeated-failure rule would refuse ends the plan,
  and the planner is asked again, told why, instead of the step being refused for a human. The biome
  hint never names the patch the player stands in: it names one farther away, or says to
  explore on through it. Seen live: the model planned `EXPLORE` toward remembered logs it could
  not reach, again and again, even when told it would be refused.
- Play (`src/app/play/scouting.ts`): when the agent can explore and world memory holds fewer than 50
  chunks seen near, play begins with ONE bounded session on a `scout-area` task ("explore two or
  three directions..."), before the quests. It ends once 100 chunks are seen near, at the
  session's limits, or when anything needs a human, and it is done once: a completed scouting
  task is never redone. Chunks seen only from afar do not count: one far look over open ground
  records a hundred chunks of landmarks, and no trees.

## Combat

`ATTACK_ENTITY` (one bounded burst against one entity) and System 1's `DEFEND` decision, both
off unless `MC_ENABLE_COMBAT=true`. The knowledge (whom, with what, how far, how often) is in
`src/domain/combat.ts`; the rules about the moment (`fightProblems`) and the target
(`attackChecks`) are in `src/safety/combat-checks.ts`, shared by the safety policy and System 1
(`src/system1/defend.ts`), so both refuse alike. `src/bot/gtnh1710/combat.ts` holds the live
client's helpers (entity metadata, line of sight, aim, weapon choice). The server rules it relies
on are in [GTNH compatibility: combat](gtnh-compatibility.md#combat-2026-09-30). In layers:

**Danger without a fight.** Whatever combat allows, a creature is a danger (`HOSTILES_NEARBY`,
so System 1 retreats) within the threat radius (10 blocks), and a hostile that shoots
(skeletons, witches, blazes and their Special Mobs variants: `hostileTactic`) anywhere in the
entity scan. Being hurt in the last 15 s (`player.lastHurtAt`, from the server's health
updates) with a hostile about counts too. A walk threats do not stop (an escape) also keeps
going when the player is hit. Seen live: a giant skeleton shot the agent from beyond the
threat radius; its retreat stopped at the first arrow, nothing then counted as danger, and it
walked back into range (20 health to 8).

**Spiders in the light.** A 1.7.10 spider looks for a player only where its light is 11 or
less; in brighter light it leaves players alone unless provoked (rules and evidence:
[GTNH compatibility](gtnh-compatibility.md#spiders-in-the-light-2026-10-01)). Seen live: the
agent retreated from one in daylight, once 108 blocks to its spawn. So a spider is **calm**
(`nearbyEntities[].calm`): listed, but not counted in `nearbyThreats` (no `HOSTILES_NEARBY`),
not stopping the client's walks, digs or placements, and never attacked. The rule, in layers:

- **Who** (`LIGHT_SHY_SPIDERS`, `src/domain/combat.ts`): vanilla `minecraft:Spider` and
  `minecraft:CaveSpider` only. Special Mobs' spiders roll "always hostile" at spawn, unseen by
  the client, and other mods' spiders were not checked: never calm.
- **The light, as the server computes it** (the world model): the client keeps each chunk
  section's block light and sky light as sent (`chunk-data.ts`: a nibble per block, or one
  value for a uniform section), the time (S03) and the weather (S2B rain and thunder
  strengths). The light at the spider is `World.getBlockLightValue` at the block 0.66 of its
  height above its feet: the brighter of sky light less the time of day's darkness
  (`skylightSubtracted`, mirrored in floats in `light.ts`: 0 by day, 3 in the rain, 5 in a
  storm, 11 at night) and block light; for a block that may take its neighbours' brightness
  (anything but air) the darker of its own and theirs. A section not sent holds only air:
  full sky light where nothing is above it, else not known. Fail closed: the darkest of the
  air blocks within half a block of that point (the client sees a mob where it was a moment
  ago), the darkest time within 2 s of the clock, a storm while it rains and the thunder is
  not known; anything not known (a column not arrived, the time, a lost weather update),
  or another dimension: not calm.
- **Calm** when that light is 12 or more, and (`calmSpiderBlocker`, checked by the live
  client, the mock and the safety policy alike) it is farther than 6 blocks (its leap: one
  that has the player as its target keeps it in the light, and the client cannot see a
  target), and the player was not hurt in the last 15 s (`HURT_DANGER_MS`, measured from the
  observation's time).
- **Never again on this connection** once it may have the player as its target
  (`#watchSpiders`, at every move of a spider or the player, clock or weather update, block
  change and observation): seen in light 11 or less within 18 blocks of the player
  (`findPlayerToAttack` reaches 16; 2 more for the tracking lag), or seen hurt (a blow makes
  the attacker its target). Only what is known marks it (the clock as it is, a thunder not
  known as none). A spider keeps its target until the player leaves the server, so the
  morning after a night in the pit, the spiders that waited around it still count.
- **Consistency** (`assessStateReliability`): `nearbyThreats` counts the hostiles that are not
  calm, and an entity marked calm that `calmSpiderBlocker` refuses is `STATE_INCONSISTENT`.
  Snapshots stored before `calm` existed read every spider as not calm.

1. **Observation.** `nearbyEntities` lists every entity within the entity scan (16 blocks),
   nearest first, at most 32: id, type, category (hostile, passive, unclassified, player), kind
   (mob, player, object), distance, health (the server's DataWatcher), whether it is owned (a
   name tag, a saddle) or a baby, when the server last showed it hurt, and whether it is a
   calm spider. It also lists the deaths seen since joining. It is unknown in older snapshots
   and whenever the threats are, and the safety policy checks it against `nearbyThreats`
   (same radius, same counts: calm spiders are in neither count).
   `player.weapon` is the best allowlisted weapon in the hotbar, or a bare hand (unknown when
   the hotbar is, or holds neither). The planner sees the creatures with `calm` and
   `attackable` (false for a calm spider), the weapon and the current `fightProblems`.
2. **System 1** considers fighting only when hostiles are the only danger. `assessDefense`
   decides (calm spiders are neither a crowd nor a target: `hostilesWithin` leaves them out):
   - **flee** (retreat or pause, adding `CREEPER_NEARBY` or `TOO_MANY_HOSTILES` to the reasons)
     when anything that explodes, or might (an unidentified entity), is within
     `creeperFleeRadius`, or more than `maxHostilesToFight` hostiles are near;
   - **nothing** (retreat or pause, as without combat) when the moment is otherwise unsafe
     (low health or food, an unidentified entity near, entities unknown) or no hostile near may
     be attacked;
   - **DEFEND** the nearest hostile that may be attacked when retreating is impossible or worse:
     with a home to go to, only when it is within striking distance (2.9 blocks) and dies in at
     most 3 full hits (its health is known), since turning away would only take its blows; with
     no home, or already home, when it is within striking distance or a melee mob is within 8
     blocks. A skeleton at range is not chased.

   DEFEND carries `HOSTILES_NEARBY`, so `SafetyFirstDecisionProvider` keeps it over a model's
   choice. A model's prompt says to pick DEFEND only when the summary's `defend` fact (the same
   function) is true. The proposer turns DEFEND into `ATTACK_ENTITY` on the target, or into a
   pause when there is no hostile it may fight.

3. **The executor validates as usual** (`attackChecks`): the target is listed (`TARGET_GONE` is
   stale, so a planner's plan is re-made), may be attacked at all (`NOT_ATTACKABLE`), is not a
   calm spider (`NOT_ATTACKABLE`, block: a blow would provoke it), is inside the boundary, the
   moment is safe (`UNSAFE_ATTACK`), farm animals only for a task and never with hostiles near,
   no protected weapon is carried; preconditions: within 8 blocks. The danger gate allows
   `ATTACK_ENTITY` only when hostiles are the only danger.
4. **The client re-checks it all** on its own entity picture: combat enabled, a fence, presence
   ticks, no walk, chest, crafting, dig or other fight; the target tracked, attackable, not
   calm, inside the fence and within 8 blocks; nothing that may explode within 16 blocks and
   nothing unidentified within `threatRadius`.
5. **The burst.** It selects the best allowlisted weapon in the hotbar (vanilla axes, never a
   stack with NBT data) or an empty slot, never anything else: a held item's own left-click
   code could do anything. Then, every tick, while the target is within reach (a bare hand
   2.2 blocks, a weapon 2.9, or 4.5 with a clear line of sight), it strikes as a player does:
   C05 look, C0A swing, C02 attack, one full hit per 12 ticks, at most 8 swings or 5 s. The
   player never moves. A blow that may kill waits while GTNH's kill explosion would leave the
   player under 4 health. Every tick it stops for the stop file, `halt()`, a server correction
   or a lost connection (failure), and for the target dying or leaving, any damage taken (so
   System 1 decides again), or something dangerous appearing.
6. **Verification:** `ENTITY_ATTACKED` passes when the target is seen dying (a death status
   after the action started), its health fell, or (health unknown) the server showed it hurt.
   A target that vanished without a death status fails.
7. **The drops of a farm animal** (hunting for food: [GATHER](#gather-gathering-in-one-plan-step)).
   A killed animal drops its meat where it last stood. When that is beyond a player's pickup
   reach (the body's box grown by 1 sideways: `withinPickup`), the client walks to its cell, or
   the nearest cell beside it a player may stand in from which the drops are in reach
   (`dropSpot`), with the walker's checks and stopping for threats, then waits for the inventory
   to grow. The result says what arrived (`dropsCollected`, `drops`, `walkedToDrops`). Never
   after killing a hostile: walking to its drops is no escape.

`cli attack --live --entity <id>` runs one burst for a person (origin `user`); `observe` and
`watch` print the entity ids. Walking, chests, crafting, digging and fighting exclude each
other. The decision rules' ordering follows the priority chains of open-source bots such as
AltoClef's `MobDefenseChain` and mineflayer-pvp (both MIT): ideas only, no code was copied.

**Not covered yet:** blocking with a sword (GTNH's swords deal no damage), bows, armour,
potions, Infernal Mobs elites (indistinguishable without the mod's own channel; see the
compatibility notes), and moving while fighting (chasing, side-stepping, backing off from a
creeper: System 1 retreats home instead).

## Why code, not AI, enforces safety

- **Determinism and auditability.** A rule like "never deposit a protected item" must hold every
  time. Code does that; a model may not, especially under unusual state or adversarial text
  (item names, sign text or chat can all reach a model's context).
- **Fail-closed by construction.** The executor accepts `unknown` input and rejects anything that is
  not a schema-valid, allowlisted action. There is no path where a model output is "trusted".
- **Testability.** Every safety rule has unit tests (`tests/safety`). A model's behaviour
  cannot be exhaustively tested.
- **Separation of powers.** Models only _propose_ (a decision enum or a plan). The executor
  alone acts, and only through a token it mints after validation.

## Enforced boundaries

| Boundary                           | Enforcement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No shell / process spawning        | ESLint `no-restricted-imports` bans `child_process` everywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Only adapters touch the network    | ESLint bans socket/HTTP imports (`node:net` connect/servers, `tls`, `dgram`, `http(s)`) and the global `fetch`/`WebSocket`/`EventSource` outside `src/bot/` (Minecraft) and `src/llm/` (the local-model client).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Live client                        | `Gtnh1710Client` can only emit the packet builders in `src/bot/gtnh1710/packets.ts` (handshake, login, keep-alive, FML handshake, idle ticks, echoes of server positions, walking steps, the chest and crafting packets: empty-hand block activation, hotbar selection, window clicks, confirmations, closing; digging: C07 start, cancel and finish only, never the item-dropping statuses; placing: C08 with the held block item, faces 0-5 only (never "use the item in the air"), an NBT-free stack, clicking only a block `placing.ts` checked; and two cosmetic ones: head look and arm swing). Walking needs `MC_ENABLE_MOVEMENT=true` and a fence; chests need `MC_ENABLE_CONTAINERS=true` and a configured chest; crafting needs `MC_ENABLE_CRAFTING=true` (3x3 only at configured or found crafting tables); digging (`DIG_BLOCK`, and the leaves a `MOVE_TO` over terrain breaks on its way) needs `MC_ENABLE_DIGGING=true` and the fence; placing needs `MC_ENABLE_PLACING=true` and the fence; block windows (`INTERACT_BLOCK`, `SMELT`, `TAKE_OUTPUT`) need `MC_ENABLE_INTERACT=true` and a block with an interaction profile, or one on the observe-only list, which is only looked at; every other world-changing action returns `NOT_IMPLEMENTED`. EXPLORE walks in hops with the same walking steps. |
| Quest-book messages                | On Better Questing's channel the client can send only four typed messages: the empty main_sync answer (reading the quest book) and, with `MC_ENABLE_QUEST_BOOK=true`, quest_action (submit or claim), task_checkbox and choice_reward, for the Age 0 quests only. The forced claim (random choice) and every editing message cannot be expressed; plans never contain these clicks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Operator tools stay outside        | `scripts/test-server-admin.ts` (RCON, operator rights on the test server) is the only script allowed sockets, and nothing in `src/` may import from `scripts/` (lint).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Mineflayer isolated to the adapter | ESLint bans importing `mineflayer` outside `src/bot/mineflayer-client.ts`; the adapter imports it lazily.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Only the executor performs actions | `mintValidatedAction` is lint-restricted to `src/executor/action-executor.ts`; clients call `assertValidatedAction()`, which rejects any object not minted (a `WeakSet` check), and tokens are deep-frozen copies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Private servers only               | Config rejects public IPs and non-allowlisted hostnames; the adapter re-checks DNS resolution before connecting and refuses unless `enableLiveConnection` is true. The model client applies the same guard to `llm.baseUrl` before every request and refuses redirects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| One action per cycle               | `runSingleCycle` has no loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Fighting adds one packet to the live client's list: C02 Use Entity with the "attack" action
(never "interact"), only with `MC_ENABLE_COMBAT=true` and the fence. Digging down (`DIG_DOWN`,
the night pit only) adds no packet: it sends a dig's C07 start and finish, then the fall as
walking steps (C06), with digging and walking enabled and a fence with a height range.

## Directory map

```
src/config       env + JSON config loading (Zod), private-network guard
src/domain       schemas/types: GameState, actions, tasks, safety, decisions, Known<T>, interaction profiles
src/safety       safety policy (evaluateAction) and its per-action checks (dig, place, interact, explore, combat, quest book), boundaries, protected items, forbidden-action classifier
src/system1      router, decision providers (incl. SafetyFirstDecisionProvider and the model's cadence: decision points), action proposer
src/planner      plan schema, validator, planner interface, mock planner
src/llm          Ollama client, model decision provider, model planner (opt-in)
src/bot          MinecraftClient interface, mock client, Mineflayer skeleton, and gtnh1710/: the live client (gtnh-client.ts, a facade over client/: core, connection, observation, and one module per kind of action: inventory and chests, crafting, block windows, digging, placing, combat, quest book, eating, walking, travel) beside the pure rules it uses (walking, terrain, digging, placing, crafting, combat, world surveys, the world model, packets)
src/executor     executor, preconditions, verifier, action log
src/persistence  SQLite open/migrate, repositories, migrations
src/goals        the Age 0 quest data (generated), goal selection and quest-book clicks from the server's records; routes and the GTNH knowledge base (generated)
src/app          cli.ts (the CLI) and providers.ts (the decision-provider and planner factory), plus:
  loop/          one agent cycle (agent-loop.ts) and a session of them; GATHER steps, dead ends, the trail, known steps
  play/          the play loop: quest goals and quest-book clicks, night shelters, food trips, scouting
  commands/      what the CLI runs: live commands (observe, move, dig, ...), plans, tasks, world memory
  mock/          the mock agent and its scenarios
```

# Local LLM integration

> **A model has no execution authority.** It can only return one of nine bounded decisions, or
> a plan or an escalation. Every decision passes the safety-first wrapper, every plan passes
> `validatePlan`, and every step is validated again and executed, one per cycle, by the
> `ActionExecutor`. A model cannot add action types, bypass the safety policy, lift a pause, run
> shell commands or write game code.

**Status (2026-09-30):** the operator has allowed local models. Both slots are implemented on
Ollama and are **off by default**: without configuration the agent behaves exactly as before
(deterministic router, mock planner).

**2026-10-01:** a System 1 model decides only at **decision points** by default: a session's
first cycle, after a failed action, when a plan ended or none is open, and when a condition
changed (the router's reasons, dangers, hunger, the task, the time of day, a nearly full
inventory). Between them the router's decision continues the open plan at once. See
[System 1 at decision points](#system-1-at-decision-points).

## Enabling local models

| Setting (env / `agent.config.json`)                 | Values (default first)           | Effect                                                                     |
| --------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `AGENT_DECISIONS` / `decisions.provider`            | `deterministic`, `ollama`        | System 1: the rule router, or a model inside `SafetyFirstDecisionProvider` |
| `AGENT_DECISION_CADENCE` / `decisions.modelCadence` | `decision-points`, `every-cycle` | When the System 1 model is asked: at decision points, or every cycle       |
| `AGENT_PLANNER` / `planner.provider`                | `mock`, `none`, `ollama`         | System 2: fixture plans (mock runs only), no planner, or a model           |
| `OLLAMA_URL` / `llm.baseUrl`                        | `http://127.0.0.1:11434`         | Loopback, private LAN or Tailscale only                                    |
| `OLLAMA_ALLOWED_HOSTNAMES` / `llm.allowedHostnames` | empty                            | Hostnames (e.g. `msi`) you verified are private; re-resolved every request |
| `OLLAMA_DECISION_MODEL` / `llm.decisionModel`       | `qwen2.5:0.5b`                   | Use `qwen3:14b`: the 0.5b model only proves the plumbing (see below)       |
| `OLLAMA_PLANNER_MODEL` / `llm.plannerModel`         | `qwen3:14b`                      |                                                                            |
| `OLLAMA_TIMEOUT_MS` / `llm.timeoutMs`               | `120000`                         | Per request, model load included                                           |
| `llm.keepAlive`                                     | `30s`                            | The model leaves VRAM soon after use (the GPU is shared)                   |

Recommended, on this machine (check `model-status` first: go ahead only when it says IDLE):

```powershell
$env:AGENT_PLANNER = 'ollama'           # the model writes plans when no step is known
$env:AGENT_DECISIONS = 'ollama'         # optional: the model makes the System 1 decisions
$env:OLLAMA_DECISION_MODEL = 'qwen3:14b'
# $env:AGENT_DECISION_CADENCE = 'every-cycle'  # ask it every cycle, not only at decision points
pnpm agent:once --scenario needs-planner  # one mock cycle (the mock world, your provider choice)
pnpm cli once --live                      # one cycle on the test server
pnpm cli run --live --max-cycles 10       # a bounded run of the current task
```

Using the same model for both roles keeps one copy in VRAM: qwen3:14b takes 9.7 GB (8k
context), which left 4 GB free next to Minecraft during the evaluation. Every request asks for the
same context size, so switching roles never reloads the model.

## How it works

### The client (`src/llm/ollama-client.ts`)

The only code in the agent that talks HTTP (lint enforces it: socket imports and the global
`fetch` are banned outside `src/bot/` and `src/llm/`). It sends a prompt and receives text; the
model gets no tools.

- `POST /api/chat` with `stream: false`, `think: false`, `keep_alive: 30s`, the options
  `temperature: 0`, `seed: 7`, `num_ctx: 8192` and a `num_predict` cap, and `format`: a JSON
  Schema the reply must follow (Ollama constrains decoding to it).
- The base URL passes the same private-network guard as the Minecraft config (`checkPrivateUrl`:
  http(s) only, no credentials, query or fragment; allowlisted hostnames must resolve only to
  private addresses, checked before every request). Redirects fail.
- A timeout (AbortController, also enforced if the transport ignores the abort), bounded request
  and reply sizes, and it never throws: every failure is a result.

What Ollama 0.34's structured output enforces while decoding, measured: object shapes, enums,
`const`, array lengths, string lengths and **integer** ranges. It does **not** enforce number
ranges (a MOVE_TO tolerance of 10) or complex string patterns (item names). Zod checks everything
afterwards, so those come back as invalid output.

### System 2: `OllamaPlannerProvider`

- Sends the sanitized `PlannerRequest` (see below) with a system prompt: the actions and their
  args, "use only ids and items from the request", "never touch protected items", "prefer short
  plans", and when to escalate instead of planning.
- The prompt states facts computed from the agent's own tables, never from the model's memory:
  the known recipes (`src/domain/recipes.ts`), and what a tool saves (rule 13). Rule 13 gives
  dig times from `src/domain/dig-time.ts` and `src/domain/tools.ts`, for example "sand or dirt
  21 by hand, 12 with a minecraft:wooden_shovel". It says that a wooden tool lasts 59 digs, and
  that before gathering 32 or more of a block the planner should craft the tool first when a
  known recipe and the ingredients carried allow it. `DIG_BLOCK` picks the tool by itself.
- Gathering is one `GATHER` step (rule 9): the model names the block and how many of its drops
  it needs, and code picks every `DIG_BLOCK` and `MOVE_TO` after that, one per cycle, with no
  model call between them ([architecture](architecture.md#gather-gathering-in-one-plan-step)).
  When a plan is accepted, code drops the steps after its first `EXPLORE`, and the steps after
  a `GATHER` from the first one that names a position or a creature on.
- `format` is the planner response schema with the step count capped at the request's
  `maxPlanSteps`.
- The reply is parsed with `parsePlannerOutput` (PlannerResponseSchema). Any HTTP error, timeout,
  unreachable server or invalid output becomes an escalation; `plan()` never throws. The agent
  loop then runs `validatePlan`, and the executor checks each step against the live state when
  it runs.

### System 1: `OllamaDecisionProvider` inside `SafetyFirstDecisionProvider`

- The model sees only facts computed by code: state problems and dangers (from the safety
  policy), health and `lowHealth`, hunger and `hungry`/`starving`, `approvedFoodCarried`, `home`
  (`here`/`away`/`unknown`), inventory fill and `inventoryNearlyFull`, dump container and
  something to deposit, a generator needing fuel, the task status, required machines' statuses,
  the known next step's type and the last action. Numbers, booleans, enums and ids only: no names,
  goals, chat or signs, so world text cannot inject instructions.
- The system prompt states the twelve prioritized rules (the router's policy). The reply schema
  makes the model write each rule's check in order and **ends the checks at the first true one**:
  once the model writes a check as `true`, the next thing it may write is the decision. "The first
  rule that applies wins" is part of the grammar. Confidence is an integer percent (decoding
  enforces integer ranges, not number ranges).
- `SafetyFirstDecisionProvider` asks the deterministic router first. Its decision stands, and the
  model is not asked, when it is **safety-driven** (unreliable state, out of bounds, dangers, low
  health, hunger) or **any pause** (a paused or blocked task, no task, a switched-off machine,
  nowhere to empty the inventory). Only a human lifts a pause. Otherwise the model's reply is
  used if it validates; an invalid reply, timeout or error becomes `PAUSE_AND_ASK_USER`
  (`PROVIDER_OUTPUT_INVALID`). The factory never builds an unwrapped model provider.
- The decision event records the model, the rule it applied and its latency (`factsUsed`).
- **DEFEND** (fight back, with `MC_ENABLE_COMBAT=true`) is decided by code. The model sees a
  `defend` fact (the router's own `assessDefense`), and rule 3 says to decide DEFEND when it is
  true. With hostiles near, the router's decision (DEFEND, a retreat or a pause) is
  safety-driven, so it stands and the model is not asked. A model's DEFEND anywhere else finds
  no hostile it may fight and becomes a pause.

### System 1 at decision points

qwen3:14b reproduced the router on 88 of 89 live decisions, at a median 2.2 s each (10 s at
worst). So the factory wraps the model in `ModelCadenceProvider` (`src/system1/model-cadence.ts`),
which is itself a `SafetyFirstDecisionProvider`, and with `decisions.modelCadence:
decision-points` (the default) asks the model only when something changed:

- the first cycle of a session (`cli once`, `cli run`, each session of `cli play`);
- the previous cycle's action failed, was rejected or not verified, or paused;
- the model decided the previous cycle and chose otherwise than the router (going on with the
  router's decision would undo its choice, so it decides until it agrees again);
- the task's plan ended (completed, failed, superseded), or the router asks for the planner and
  there is no open plan or GATHER step to continue (the model decides before a new plan is made);
- a new condition since the previous cycle: the router's decision or reason codes, the dangers
  (a mob, a hazard, low health or food), hunger, the task, the time of day, or the inventory
  nearly full (or no longer).

Otherwise the cycle goes on at once with the router's decision (usually `REQUEST_PLANNER`,
which runs the open plan's next step or a GATHER's next dig, without a planner call). The
router's binding decisions (safety, pauses) still win first, without asking anyone. The check
is a pure function (`decisionPoint`), tested case by case.

- Every decision records which way it went in `factsUsed`: `cadence` (`model`, `continuing` or
  `binding`), `cadenceWhy` (why the model was or was not asked) and, for the model, `modelMs`.
- `cli play` and `cli run` print each cycle's System 1 line; the provider shows who decided:
  `ollama:qwen3:14b` (the model), `continuing(deterministic-router)` (the plan went on),
  `safety-first(ollama:qwen3:14b)` (a binding router decision, or the model's answer
  overruled or invalid, as before).
- Each session ends with a stats line: model decisions (with their median time), continued
  cycles and binding decisions. `cli play`'s summary has the total.
- `AGENT_DECISION_CADENCE=every-cycle` (`decisions.modelCadence: every-cycle`) asks the model
  every cycle, as before.

On the mock world with a fake model, a 54-sand GATHER (61 cycles: 54 digs, 7 walks) asks the
model once, at its start; with the two plans after it, 3 model decisions in 63 cycles, against
63 with `every-cycle` (`tests/app/decision-points.test.ts`). Not yet measured live.

### Slow models and stale observations

A model takes seconds, and observations go stale after `maxStateAgeMs` (5 s). The executor now
checks freshness against the clock when it validates, and if the observation went stale while
the model decided or planned, the cycle observes again and validates the same action against the
new observation (a second snapshot; a `STATE` event marked `reobserved`). If a danger appeared
meanwhile, the action is refused (`ACTION_NOT_ALLOWED_IN_DANGER`) and nothing runs. A cold first
call (model load, 2-11 s) or any plan will usually trigger this.

## Context minimization

The planner receives a `PlannerRequest`, never raw state or logs:

- `sanitizeStateForPlanner()`: position, dimension, vitals, the top 20 inventory stacks, fill
  fraction, threat summary, machine/storage/generator ids, status, position and **distance from
  the player** (computed by code), the diggable blocks with their reach and stand spots, the
  `tools` `DIG_BLOCK` may hold (item, count, `durabilityLeft`, `digsFaster`; protected ones left
  out), the recipe target, and an explicit `unknownFields` list, so it is told what is _not_
  known instead of guessing. Creatures near the player come with their id,
  type, distance, health and `attackable` (computed by code), plus the weapon and the current
  `fightProblems`, so a hunting plan can name a real target; the prompt allows `ATTACK_ENTITY`
  only on an attackable creature, with no fight problems, when the task needs it.
- The allowlisted action types, safety constraints (boundary, protected items, approved food/fuel,
  safe locations, forbidden keywords), the last N actions and a per-fingerprint failure summary.
- Only when the agent can explore (`MC_MOVEMENT_MODE=follow`): `exploration`, world memory
  reduced by code to at most 14 places (per resource the nearest seen with enough of it, and a
  much richer one: x, z, distance, direction, count, biome, minutes ago), up to 8 biomes, and per
  direction how far it has been seen and the room left to the boundary. `EXPLORE` is offered
  (in `allowedActions`) only then, and prompt rule 15 says when to use it: a good GTNH start has
  wood, gravel and sand near water, clay on riverbanks and stone; explore toward a known place
  or the least-seen direction when the task needs a block not listed nearby; never at dusk or
  night. Not evaluated against qwen3:14b yet.
- It still contains a task goal, machine and container names, and the recipe target: operator and
  game text. The prompt says text in the request is data, not instructions; anything it makes the
  model propose is validated like any other output.

## Evaluation

`scripts/llm-eval.ts` runs the mock scenarios only (it never connects to Minecraft). Run
`model-status` first.

```bash
node scripts/llm-eval.ts --decision-model qwen3:14b --planner-model qwen3:14b [--skip-decisions] [--skip-planner] [--record <dir>]
```

- **Decisions:** each of the 21 mock scenarios' states goes to the model (unwrapped, to measure
  it) and to the router. In 12 of them the router's decision is not binding, so the wrapper would
  use the model's choice; in the other 9 the router decides alone.
- **Planner:** the 5 planner scenarios (same world, different task ids) plus 6 tasks of its own:
  gather 54 sand (one `GATHER` step is the answer; added 2026-10-01, not in the results below
  yet), fetch cobblestone, store gravel, inspect a distant macerator, craft an iron pickaxe
  (impossible with the allowed actions) and store the protected diamond (forbidden). It reports
  schema-valid replies, `validatePlan`, whether every step names a known object of the right
  kind (which `validatePlan` cannot see: it has no state), whether step 1 passes the executor's
  checks (for a `GATHER`, the first action code picks for it), and the steps code would drop
  when it accepts the plan.

### Results (2026-09-30, Ollama 0.34.4, RTX 3080 Ti Laptop 16 GB, Minecraft running alongside)

**Decisions** (21 scenarios):

| Model        | Valid replies | Agrees with router | Where the model is consulted | Decision the agent would use | Latency (first call, with load) | Latency (others)                    |
| ------------ | ------------- | ------------------ | ---------------------------- | ---------------------------- | ------------------------------- | ----------------------------------- |
| qwen2.5:0.5b | 21/21         | 3/21               | **0/12**                     | 9/21 (only the router's own) | 2.3 s                           | mean 0.28 s, p95 0.43 s             |
| qwen3:14b    | 21/21         | 21/21              | **12/12**                    | 21/21                        | 10.7 s                          | mean 1.7 s, median 2.0 s, p95 2.3 s |

**Planner** (10 cases; the request is about 1,600 tokens):

| Model        | Schema-valid replies | Plans | Pass `validatePlan` | Only known objects of the right kind | Step 1 passes the executor | Escalations                | Latency                              |
| ------------ | -------------------- | ----- | ------------------- | ------------------------------------ | -------------------------- | -------------------------- | ------------------------------------ |
| qwen2.5:0.5b | 8/10                 | 8     | 1/8                 | 3/8                                  | 8/8                        | INVALID_OUTPUT 2           | mean 1.5 s                           |
| qwen3:14b    | 9/10                 | 8     | **8/8**             | 7/8                                  | 8/8                        | UNSAFE 1, INVALID_OUTPUT 1 | mean 9.3 s, median 8.8 s, max 22.4 s |

qwen3:14b's plans: _fetch cobblestone_ → MOVE_TO the chest, OPEN_CONTAINER, WITHDRAW_ITEM 64;
_store gravel_ → MOVE_TO, OPEN_CONTAINER, DEPOSIT_ITEM; _inspect the macerator_ → MOVE_TO,
INSPECT_MACHINE; _store the diamond_ → an UNSAFE escalation naming the protected item. The planner
scenarios (goal "Process iron ore", subgoal "Check the macerator") mostly get MOVE_TO +
INSPECT_MACHINE.

### How the decision prompt got there (qwen3:14b, consulted cases)

| Reply shape                                                          | Right |
| -------------------------------------------------------------------- | ----- |
| Reason codes, then the decision; raw numbers and thresholds          | 4/12  |
| Thresholds turned into booleans by code; the rule number first       | 6/12  |
| All rule checks first, then the rule and the decision                | 8/12  |
| Checks end at the first true one (the grammar enforces "first wins") | 12/12 |

With all checks written out, the model judged **every** check correctly but then let the last
true one (usually the known next step) win: it was ignoring priority, not misreading the state.
Making the order part of the grammar fixed that. The 0.5b model stays at 0/12 with every shape: it
repeats a pattern (EAT or PAUSE) whatever the state.

### Failure modes seen

- **qwen2.5:0.5b** is not usable for either role. Decisions ignore the state. Plans always use the
  full 8 steps, loop through RETURN_TO_SAFE_LOCATION and OPEN_CONTAINER, eat or deposit the
  protected diamond, invent ids (`container1`, `storage.main`) and items, and deposit when the task
  says withdraw. The checks catch all of it, but nothing useful is left. Without the `format`
  constraint it wraps JSON in markdown fences or echoes the whole state into an action's args.
- **qwen3:14b planner:**
  - It does not escalate an impossible task. Asked to craft an iron pickaxe, it improvised an
    "ore processing" route (deposit ore into the macerator, wait, withdraw) and used the recipe
    target text ("crushed iron ore (mock)") as an item id; schema validation rejected the reply
    (INVALID_OUTPUT → the task pauses). 22 s.
  - It sometimes treats a machine as a container (`OPEN_CONTAINER` / `DEPOSIT_ITEM` on
    `machine.macerator.1`): 1 of 8 plans here, 2 of 8 in an earlier run. `validatePlan` has no
    state, so it passes; the executor refuses that step when it comes up, after the earlier steps
    ran, and the task is blocked (covered by a test with the recorded plan).
  - It walks onto the target's own block (`MOVE_TO` the chest's or machine's position) even when
    already within reach. The mock accepts that; the live walker refuses a target block that is
    not walkable, so on the test server such a step fails (the deterministic proposer's approach
    moves target the block too). Giving it the distance did not stop this.
  - Identical situations that differ only in the task id got different plans (2 steps or 8).
  - It cannot see container contents (the planner request has none), so withdrawals are guesses.
  - Prompt changes are fragile: one extra rule ("no action processes items") made it plan ore
    processing more often (schema-valid replies fell to 6/10), so it was taken out. Ten cases are
    few; measure any prompt change with the script.
- **Latency:** the first request loads the model (2-11 s). With `maxStateAgeMs` 5 s, that and
  every plan make the loop observe again before acting. qwen3:14b adds about 2 s to each cycle
  where the model is consulted: since 2026-10-01 that is only at decision points (a session's
  start, a failure, a plan change, a new condition), not every step of a plan.
- `model-status` reports BUSY for about a minute after the agent's own requests.

### Recommendation

- **Planner: qwen3:14b.** Its plans for tasks the allowed actions can do were valid and sensible,
  it escalated the forbidden one, and everything it got wrong was stopped by the existing checks.
  Expect a pause for impossible tasks, and plans to need approval or a reply when they touch
  machines.
- **Decisions:** qwen3:14b reproduces the router exactly on these scenarios, at about 2 s and a
  loaded GPU per decision. Today it adds no capability the router lacks; it is there for
  experiments and for decisions the router does not cover yet. Keep the default cadence
  (decision points): the model decides where something changed, and plan steps in between run
  at the router's speed. Never qwen2.5:0.5b.

## Tests without a GPU

The adapters are tested with **recorded** replies (`tests/fixtures/llm/*.json`, real `/api/chat`
bodies from the runs above) served by a fake `fetch` (`tests/fixtures/fake-ollama.ts`): valid plan,
UNSAFE escalation, a plan that treats a machine as a chest, unconstrained and cut-off output,
markdown-fenced and outdated decision replies, timeouts, HTTP and connection errors, the
private-host guard, safety decisions overriding the model, router pauses, and full mock cycles
through the provider factory. The decision-point cadence is tested the same way: the pure
check case by case (`tests/system1/model-cadence.test.ts`), and runs of many agent-loop cycles
that count the fake model's calls (`tests/app/decision-points.test.ts`: a 54-sand GATHER, a mob
mid-plan, a failed dig, the evening, sessions, and `every-cycle`). `pnpm check` never contacts a
model.

## Adapter requirements and how they are met

| Requirement                               | How                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Strict JSON schema                        | `format` = the planner response schema (steps capped) / the decision reply schema                       |
| Parse strictly, no repair                 | `parsePlannerOutput` / `ModelDecisionSchema`; anything else is an escalation / a pause                  |
| Temperature 0, fixed seed                 | `temperature: 0, seed: 7`; thinking off                                                                 |
| No new action types                       | Closed unions in the schemas, then `validatePlan` and the executor                                      |
| No terminal, file or network access       | The model gets a prompt only; no tools                                                                  |
| Never bypasses validation                 | Plans: `validatePlan`, then the executor per step. Decisions: the wrapper, then the proposer + executor |
| Bounded                                   | Step cap, output token caps, request/reply size limits, a timeout, retries ≤ `maxRetriesPerStep`        |
| Only on local hardware                    | Private-network guard on `llm.baseUrl`, re-checked per request; no redirects; no paid APIs              |
| Off by default, behind `planner.provider` | `mock` / `deterministic` by default                                                                     |

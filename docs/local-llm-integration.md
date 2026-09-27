# Local LLM integration (future)

> **The LLM has no direct execution authority.** It can only return a validated plan or an
> escalation. Every step is re-validated by code and executed, one per cycle, by the
> `ActionExecutor`. A model cannot add action types, bypass the safety policy, run shell commands
> or write game code.

Nothing in this milestone downloads, loads or calls a model. The planner is `MockPlannerProvider`.

## Where a model plugs in

| Slot                | Interface                                               | Today                            | Later                                                                          |
| ------------------- | ------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| High-level planner  | `PlannerProvider` (`src/planner/planner-provider.ts`)   | `MockPlannerProvider` (fixtures) | A local-LLM adapter (e.g. Ollama)                                              |
| Fast bounded choice | `DecisionProvider` (`src/system1/decision-provider.ts`) | `DeterministicDecisionProvider`  | Optional small classifier, **always** wrapped in `SafetyFirstDecisionProvider` |

The planner is consulted **only** when System 1 returns `REQUEST_PLANNER`: no known step, a
required machine in an unknown/unpowered state, or other low-confidence situations. Safety,
vitals and upkeep never reach the model.

## Adapter requirements (must all hold before merging a real adapter)

1. **Strict JSON schema.** Request structured output constrained to the planner schema. Print it with:
   `node src/app/cli.ts plan-schema`. Pass it as the structured-output / grammar constraint.
2. **Parse with `parsePlannerOutput()`.** Any non-JSON, truncated, extra-field or wrong-shape
   output becomes an `INVALID_OUTPUT` escalation. There is no "repair" step.
3. **Temperature 0** (and a fixed seed where supported) for reproducibility.
4. **Cannot introduce new action types.** Guaranteed by the schema (a closed discriminated union)
   and re-checked by `validatePlan()` and the executor.
5. **No raw terminal, file or network access.** The adapter sends a prompt and receives text; it
   exposes no tools to the model.
6. **Never bypasses validation.** The adapter returns a `PlannerResponse`; the agent loop runs
   `validatePlan()` (schema, step limit, static safety on every step), and the executor runs the full
   safety policy + preconditions on the step it executes.
7. **Bounded.** Steps ≤ `planner.maxPlanSteps` (≤ 16), request/response size limits, a timeout, and
   retries ≤ `failureHandling.maxRetriesPerStep` (≤ 2).
8. **Only on local hardware.** Default endpoint `http://127.0.0.1:11434` (or a private Tailscale
   address). The same private-network guard as the Minecraft config applies. No paid APIs.

## Context minimization

The model receives a `PlannerRequest`, never raw state or logs:

- `sanitizeStateForPlanner()`: position, dimension, vitals, the top 20 inventory stacks, fill
  fraction, threat summary, machine/storage/generator ids+status+positions, the recipe target, and an
  explicit `unknownFields` list, so it is told what is _not_ known instead of guessing.
- The allowlisted action types, safety constraints (boundary, protected items, approved food/fuel,
  safe locations, forbidden keywords), the last N actions and a per-fingerprint failure summary.
- Free text from the world (chat, signs, book contents, item display names) must **not** be placed in
  the prompt without sanitization, because it is a prompt-injection vector.

## Running without a GPU (now)

Everything runs on CPU with mocks:

```bash
pnpm test
pnpm agent:once --scenario needs-planner
```

`needs-planner`, `planner-needs-approval`, `planner-escalates`, `planner-invalid-output` and
`planner-unsafe-plan` exercise the whole planner path with fixtures.

## Conditions for adding Ollama later

Add a real adapter only when all of these hold:

1. **GPU availability is confirmed.** On this machine, run `model-status` first; other jobs
   (the default Ollama on `:11434`, another harness on `:11435`, llama.cpp, Python/WSL/Docker CUDA jobs)
   may be using the 16 GB of VRAM. Do not start, pull or unload models while it reports BUSY.
2. The mock-planner test suite is green, and the adapter passes the same tests with a **recorded**
   model output (golden JSON files), so CI never needs a GPU.
3. A decision has been made about which model and quantization fit in VRAM alongside other jobs.
4. The adapter is behind `planner.provider` config, defaulting to `mock`.
5. The adapter has timeouts and treats any error as an escalation (the agent pauses).

## Sketch of the adapter

```ts
class OllamaPlannerProvider implements PlannerProvider {
  readonly name = 'ollama';
  async plan(request: PlannerRequest): Promise<PlannerResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: plannerResponseJsonSchema(), // structured output
        options: { temperature: 0, seed: 0 },
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT }, // rules + "you only propose"
          { role: 'user', content: JSON.stringify(request) },
        ],
      }),
    });
    if (!res.ok) return escalation(`HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return parsePlannerOutput(body.message?.content ?? ''); // fail closed
  }
}
```

(Illustrative only. Check the Ollama API version in use before implementing.)

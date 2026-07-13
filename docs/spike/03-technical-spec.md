# Validation Spike — Technical Specification

## Stack

| Item | Choice | Note |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript | |
| Browser engine | Stagehand v3 (Browserbase, MIT) | Local Chromium via CDP, headless |
| LLM | **Gemini** via the Google AI Studio API | Target model: `gemini-2.5-flash` (low cost, sufficient for generating structured JSON). Model format in Stagehand: `google/gemini-2.5-flash`, key via `GOOGLE_GENERATIVE_AI_API_KEY` |
| Trajectory cache | Local JSON file (`.cache/trajetorias/*.json`) | Redis vs SQLite remains **open** for the MVP |
| Environment | Docker (Node + Chromium) | See [05-environment.md](05-environment.md) |
| CLI | `spike run <scenario> [--no-cache] [--repeat N]` | No UI |

**Note on Stagehand usage:** the spike uses Stagehand as the CDP execution layer (act on deterministic selectors, DOM observation, navigation events). Plan generation is done via a direct call to Gemini with context extracted from the page — we do **not** use Stagehand's agent mode, precisely because the project's thesis is not to delegate the decision loop to the LLM.

## Components (spike minimums)

```
┌─────────┐   miss   ┌──────────────┐
│  Cache   │────────▶│ Planner      │──▶ Gemini (1 call)
│ (JSON)   │         │ (LLM)        │
└────┬────┘         └──────┬───────┘
     │ hit                  │ schema-validated JSON plan
     ▼                      ▼
┌────────────────────────────────────┐
│ Deterministic executor             │──▶ Stagehand v3 / CDP
│ (action loop, zero reasoning)      │
└────────────────┬───────────────────┘
                 ▼ after each action
        ┌────────────────┐  pass   → next action
        │ Verifier        │
        │ (post-conds)    │  fail   → invalidate plan → re-plan (Gemini)
        └────────────────┘
                 ▼ end of plan
        ┌────────────────┐
        │ Metrics         │──▶ runs/<timestamp>.json
        └────────────────┘
```

### 1. Trajectory cache

- Key: `scenario_id` (stable string defined in the scenario file) + `start_url`.
- Hit → returns the saved plan for replay. Miss → triggers the planner.
- Write: only after **complete and verified** execution of the plan.
- Invalidation: a verification failure during replay marks the entry as `stale`; the next execution re-plans and overwrites.
- No page signature in the spike (scope decision — see [01-scope.md](01-scope.md)).

### 2. Planner (the only boundary with the LLM)

Prompt input:

- Task description (scenario text).
- Initial page context: accessibility tree / simplified DOM extracted via Stagehand (`observe()` or direct extraction), truncated to a fixed token budget (target: ≤ 8k tokens of page context).
- The plan's JSON Schema (Gemini supports structured output with `responseSchema` — use that, not free-text parsing).

Output: JSON plan. Validation pipeline:

1. Structural validation against the schema ([04-schemas.md](04-schemas.md)).
2. Minimal semantic validation: every `click`/`fill` action has a `target.selector`; the last action has an `expect`.
3. Validation failure → 1 retry with the error message in the prompt. Second failure → abort with an error (recorded in the metrics).

**Important for the experiment:** the planner sees only the initial page. For multi-page flows (scenario 2), Gemini must predict the subsequent steps from knowledge of the task. If that proves fragile, the documented fallback is incremental per-page planning (1 call per new page) — record in the metrics which mode was needed, since this affects the cost thesis.

### 3. Deterministic executor

Pseudo-code:

```
plan = cache.get(scenario) ?? planner.generate(scenario)
for each action in plan.actions:
    stagehand.execute(action)         # click/fill/goto via selector, no LLM
    result = verifier.check(action.expect, action.timeout_ms)
    if result == FAILURE:
        if origin == CACHE:
            cache.invalidate(scenario)
            new_plan = planner.generate(scenario, failure_context)
            restart execution with new_plan     # spike: re-plans the entire flow
        else:
            abort(PLAN_FAILURE)                 # freshly generated plan already failed
if all passed: cache.save(scenario, plan); metrics.record()
```

Action types supported in the spike: `goto`, `click`, `fill`, `wait_for` (nothing else — no `select`, `hover`, `scroll`, `press` for now; add only if a scenario requires it).

### 4. Verifier

Post-conditions supported in the spike, all cheap (CDP/DOM, no LLM):

| Post-condition | How it is verified |
|---|---|
| `expect.selector` | Element present and visible within the timeout |
| `expect.url` | Current URL matches a glob pattern (`**/inventory.html`) |
| `expect.selector_value` | Element has the expected value (for `fill`) |

`expect_request` (network interception) is left out of the spike — saucedemo does not require it, and it adds complexity without contributing to the validation.

Timeout semantics: DOM polling (or `MutationObserver`) until it passes or `timeout_ms` is exceeded. Exceeding it = verification failure.

### 5. Metrics

Each execution writes a `runs/<timestamp>-<scenario>.json`:

```json
{
  "scenario_id": "saucedemo-login",
  "started_at": "2026-07-11T14:00:00Z",
  "cache": "hit | miss | invalidated",
  "llm_calls": 1,
  "llm_model": "gemini-2.5-flash",
  "tokens": { "input": 6200, "output": 480 },
  "estimated_cost_usd": 0.0021,
  "duration_ms": { "total": 8400, "planning": 3100, "execution": 5300 },
  "actions": [
    { "id": "a1", "duration_ms": 350, "verify_ms": 40, "status": "passed" }
  ],
  "result": "passed | failed",
  "failure": null
}
```

Estimated cost = tokens × the model's current price (price table as a constant in the code, with a date — prices change).

## Execution flows

**Cache miss (1st execution):** CLI → cache miss → extract page context → Gemini generates plan → validate → execute action by action with verification → everything passes → save to cache → record metrics.

**Cache hit (replay):** CLI → cache hit → execute plan directly → verifications pass → record metrics with `llm_calls: 0`.

**Failure during replay (broken selector):** replay → verification of action N fails → invalidate cache → re-plan entire flow via Gemini → execute new plan → passes → overwrite cache. (In the MVP this evolves into partial re-planning with DOM diff — out of the spike's scope.)

## Open decisions (documented, not resolved in the spike)

| Question | Options | Current position |
|---|---|---|
| Cache persistence in the MVP | Redis (native TTL, multi-worker, requires infra) vs SQLite (zero infra, rich queries, single-writer) | The spike uses JSON on disk on purpose, to defer the decision with real data on entry format/size |
| Full-flow planning vs incremental per page | 1 call (cheaper, requires prediction) vs N calls (more robust, more expensive) | The spike tests full-flow first; the metrics will tell |
| Definitive Gemini model | `gemini-2.5-flash` vs pro variants | Start with flash; scale up only if the valid-plan rate drops below 80% |

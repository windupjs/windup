# SPEC-001 — Post-Spike Evolution: Site Map, Fragments, and Manifest

> **Historical document** (originally written in Portuguese; translated to English). Fully implemented — see the English living specification in [SPEC.md](SPEC.md) and measured results in [RESULTS-tranche-1.md](RESULTS-tranche-1.md) / [-2](RESULTS-tranche-2.md) / [-3](RESULTS-tranche-3.md).

**Status:** implemented · **Context:** [RESULTS.md](../spike/RESULTS.md)

## Problem

The spike proved the steady state: replay in ~1.2s, zero cost. What remains slow and fragile is the **cache miss** — first execution and re-planning. Today the planner sees only the initial page and must *predict* the following ones; removing the hardcode (spike 07/A1) exposes this fragility for real. This spec attacks the root: give the planner real knowledge of every page in the flow, without screen-by-screen navigation and without screenshots.

## Principles (inherited and new)

1. LLM is the exception, not the rule (unchanged).
2. **Zero hardcoded site knowledge** (spike 07) — all knowledge enters via input or is discovered at runtime.
3. **Every execution is also collection** — the executor already passes through every page of the flow; persisting what it sees has ~zero marginal cost.
4. Knowledge is cache, not truth — anything the map asserts may be stale and must degrade to runtime discovery.

## Component 1 — Site map (site model)

Persisted graph per project: **pages** (nodes) and **transitions** (edges).

```json
{
  "map_version": "0.1",
  "pages": {
    "sig:7f3a…": {
      "urls_seen": ["https://app.exemplo.com/inventory.html"],
      "url_pattern": "**/inventory.html",
      "title": "Products",
      "interactive": ["button id=add-to-cart-x data-test=…", "a class=shopping_cart_link"],
      "first_seen": "2026-07-12T…", "last_seen": "2026-07-12T…", "seen_count": 14
    }
  },
  "transitions": [
    { "from": "sig:1b2c…", "action": { "type": "click", "selector": "#login-button" }, "to": "sig:7f3a…", "seen_count": 14 }
  ]
}
```

- **Page signature (`sig:`):** structural DOM hash — tags + ids + names + data-test of the interactive elements, normalized (no dynamic text, no values). Two visits to the same screen produce the same signature even with different data. It is the prerequisite for everything here and also becomes part of the trajectory cache key (anticipated in spike doc 04).
- **Passive feeding (primary mechanism):** after each executed action, the executor records the signature + interactive elements + the transition taken. No extra network or LLM call.
- **Active feeding (optional bootstrap):** explicit crawler — see SPEC-002 (`scan`), which also feeds this same graph from source code.
- **Use in planning:** on a cache miss, the runner assembles the prompt context with: initial page (live snapshot) + slices of the map reachable from it (BFS over the graph, bounded by a token budget, prioritizing pages whose `interactive` matches task terms). The planner now sees the entire flow instead of predicting it.
- **Staleness:** a map entry with an old `last_seen` is a hint, not truth; if verification fails at runtime, the page is re-collected and the map updated (same philosophy as trajectory invalidation).

## Component 2 — Trajectory fragments (compositional cache)

Named, reusable sub-trajectories:

```json
{
  "fragment_id": "login-admin",
  "description": "Login como administrador",
  "params": { "user": "ENV:ADMIN_USER", "password": "ENV:ADMIN_PASSWORD" },
  "actions": [ "…same action schema as the plan…" ],
  "postcondition": { "url": "**/dashboard" }
}
```

- A plan can reference `{ "use": "login-admin" }` as its first "action"; the executor expands it inline.
- **Fragment origins:** (a) the user promotes a stretch of a cached plan to a fragment (`rubberduck fragment extract`); (b) automatic detection of common prefixes across plans in the same project (later phase).
- **Gains:** smaller prompt (the LLM composes blocks instead of regenerating), partial cache hit (a new flow that starts with a known login already has its prefix resolved), readable tests (a Gherkin-like task maps to fragments: "given I am logged in as admin…" → `use: login-admin`).
- The planner receives the fragment catalog (id + description + postcondition, never the actions) in the prompt and is instructed to use them when they cover part of the task.

## Component 3 — Project manifest

File versioned in the user's repo (`rubberduck.config.*`, see SPEC-002), `context` section:

```jsonc
{
  "context": {
    "base_url": "https://app.exemplo.com",
    "conventions": ["todo elemento interativo tem data-test"],
    "credentials": { "admin": { "user": "ENV:ADMIN_USER", "password": "ENV:ADMIN_PASSWORD" } },
    "vocabulary": { "pedido": "entidade Order, tela /orders", "cliente PJ": "cliente com CNPJ" }
  }
}
```

~1k tokens in the prompt. Eliminates the planner's biggest source of error (task ambiguity), not lack of capability. It is the generalization of the `hints` field (spike 07/A1) to the project level — and obeys the same principle: site knowledge is user input, never our code.

## Cache-miss latency optimizations (later phase)

- **Parallelize launch + planning:** with the map covering the initial page, the LLM call can fire before the browser opens; the live snapshot only confirms.
- **Speculative execution with streaming:** streamed structured output allows executing `a1` while the LLM is still generating `a5`. The first execution gains an instantaneous feel. Requires partial-plan verification — high complexity, only after everything else stabilizes.
- **Warm browser pool:** cuts the fixed ~1.2s of replay to sub-second (already recommended in RESULTS.md).

## Phases

| Phase | Deliverable | Done criterion |
|---|---|---|
| E1 | Page signature + cache key with signature | Same screen → same sig in 10/10 visits; changed screen → different sig; replay remains 10/10 |
| E2 | Map fed by executions + use in the planner prompt | Bench C1 (no hints, post spike 07) improves or holds on a multi-page flow; prompt tokens measured |
| E3 | Fragments: schema, executor expansion, manual `fragment extract` | Composite flow (`use:` + new actions) plans with a smaller prompt and 10/10 replay |
| E4 | Project manifest in the prompt | Ambiguous scenario fails without manifest / passes with manifest (documented test case) |
| E5 | Latency: browser pool, launch ∥ planning | Replay < 500ms p50; miss without degrading success rate |

Real streaming/speculation stays outside these phases — reassess with E5 metrics.

## Open decisions

| Question | Options | Note |
|---|---|---|
| Map persistence | Alongside the trajectory cache (SQLite favored post-spike) vs its own file | Decide together with Redis vs SQLite; a graph calls for queries (BFS) — a point for SQLite |
| Signature algorithm | Interactive elements only vs full normalized structure | Start with the simplest (interactive); measure collision/breakage rate in E1 |
| Automatic fragment detection | Exact common prefix vs similarity | Only in the post-E3 phase; manual first |

# Results — Tranche 2 (P2 → E3 → P3)

**Date:** 2026-07-12 · **Scope:** static indexing, trajectory fragments, and incremental scan (SPEC-001/002 track)

## Verdict: ✅ all three milestones passed

| Milestone | Criterion (spec) | Measured |
|---|---|---|
| **P2** — static `windup scan` | ≥90% of convention-based routes detected; elements with data-test extracted; map populated | ✅ Next fixture (app router with groups/dynamic routes + pages router): **7/7 routes (100%)**; data-test/id/name/aria/label elements extracted; `static:` nodes in the same graph |
| **E3** — fragments | composite flow (`use:` + new actions) plans and replays 10/10 | ✅ Gemini generated a composite plan (`a1 use login-saucedemo` + 2 new actions) in **5.4s / 1 clean call**; replay **10/10 llm_calls=0** (~0.9s) |
| **P3** — `scan --update` | edit 1 component → only it re-indexed; page marked stale | ✅ test with a real git repo: 1 component edited → **1/7 routes re-indexed**; execution knowledge for the affected url becomes stale |

## Design decisions worth recording

1. **execution > static precedence in the slice, not in the graph** — static nodes live under their own key (`static:<route-hash>`) and never overwrite execution observations; dedupe by `url_pattern` happens when assembling the prompt. Static nodes enter the slice even without transitions — that is what makes the scan valuable **before the first execution**.
2. **The cache stores the `use` reference, not the expansion** — an updated fragment propagates to every cached plan that uses it; a removed fragment orphans the plan → invalidation + automatic re-plan (same cycle as verification failure). Fragments are committable (curated knowledge), unlike the cache.
3. **Cascading staleness (P3):** source changed → static node re-indexed immediately AND the execution node for the same url marked stale (the runtime may have changed along with the code); stale entries leave the prompt slice until a new observation, which clears the flag. "Knowledge is cache, not truth" became mechanics.
4. **The fragment catalog in the prompt exposes id+description+postcondition, never the actions** (SPEC-001) — the composite plan came out with 3 actions instead of 5, and the prompt did not grow with the fragment body.

## Observations

- E3's composite plan came in 1 clean 4s call — another point for the hypothesis that prompts with structured knowledge (map/fragments) escape flash's degeneration basin; still not conclusive (Tranche 1 showed a counterexample with compra-dupla).
- `windup status` closes the index DX loop: pages by origin (+staleness), cached scenarios, fragments, SHA of the last scan.
- Suite at 63 tests; everything committed (3 commits, one per milestone).

## What remains for the next phases

- **P4**: LLM-assist in the scan (with the `llmAssist.maxCalls` cap) + optional dynamic crawl; react-router indexer.
- **P5**: vitest/jest adapter over the `run()` API (already exported).
- **E4**: project manifest in the prompt (the config's `context` section is already typed and inert).
- **E5**: browser pool + launch ∥ planning (replay <500ms p50).
- Automatic fragment detection via common prefix (post-E3, SPEC-001).
- Inherited debts: synthetic click `isTrusted=false`; planner model A/B.

# Results — Tranche 1 (E1 → P1 → E2)

**Date:** 2026-07-12 · **Baseline to beat:** C1 multi-page without hints = checkout 3/5, compra-dupla 5/5 · **Untouchable regression:** replay 10/10 with `llm_calls=0`

## Verdict: ✅ all three milestones passed; E2 criterion beaten with room to spare

| Milestone | Criterion | Measured |
|---|---|---|
| **E1** — page signature | same screen → same sig 10/10; changed → sig ≠; replay 10/10 | ✅ 10/10 identical sigs on saucedemo; mutation unit tests; replay 10/10 (`cache_version` 0.2 with `start_sig`) |
| **P1** — `windupjs` package | external project installs via npm and runs without cloning the repo | ✅ `npm pack` → `npx windup init` (3 questions, CI fallback) → 1st run plans (Gemini), 2nd run **1.2s / llm_calls=0**; `import("windupjs")` exposes `run`/`defineConfig` |
| **E2** — site map | C1 without hints improves or holds; prompt tokens measured | ✅ checkout **3/5 → 5/5**; compra-dupla holds **5/5**; `prompt_chars` ≈ 10.9k reported per run |

## Bench numbers with the map (no hints)

| Scenario | C1 | C2 | C3 | cost/generation |
|---|---|---|---|---|
| saucedemo-checkout | 5/5 | 10/10 | 5.7x (6.3s vs 1.1s) | US$ 0.004 |
| saucedemo-compra-dupla | 5/5 | 10/10 | 85.8x (102s vs 1.2s) | US$ 0.068 |

Map after 1 execution of compra-dupla + benches: **9 pages, 17 transitions** — including distinct states of the same page (inventory with/without items in the cart produce different sigs because the `add-to-cart`⇄`remove` ids change; E1's anticipated limitation turned into extra coverage in practice: each state documents its own selectors).

## Findings

1. **The map fixed the right class of error.** The baseline failures were plausible-but-wrong selectors on unseen pages (`#shopping_cart_container`). With the instruction "use EXACTLY the selectors listed for known pages," checkout went to 5/5 with a clean `llm_calls=1` and ~6s per generation.
2. **Unexpected and valuable side effect: the prompt with the map pulled checkout out of flash's degeneration basin** (the no-hints baseline degenerated in 10/10 generations; with the map, zero degeneration on checkout — cost per generation dropped from ~US$ 0.065 to ~US$ 0.004). **But it is not universal:** compra-dupla generations kept degenerating (~100s, US$ 0.068) even with the map. Degeneration is sensitive to the exact prompt content; the model A/B on the planner remains a priority.
3. Passive collection cost ~1 evaluate/action and did not degrade replay (10/10 post-collection).
4. `sig_mismatch` stayed `false` in all replays — no signature false positives under the lenient policy so far.

## Debts carried (not part of this tranche)

- Synthetic click `isTrusted=false` (doc 07-A2) — first candidate post-E2.
- Flash degeneration on compra-dupla — input for the provider A/B (the `llm` config already makes the swap a 1-line change).
- SQLite for the map — reassess in P2 with scale data (JSON + `SiteMapStore` interface for now).

## Suggested next tranche (specs)

P2 (static `windup scan` — Next.js first) → E3 (fragments) → P3 (`scan --update` via git), per the SPEC-001/002 track.

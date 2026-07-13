# Spike — Post-Review Fixes (correction spec)

Corrections identified in the review of the spike's code (2026-07-11). Three fixes, in order of importance. A1 partially invalidates the C1 evidence and requires re-running the bench; the others are debts recorded so they are not forgotten.

## Cross-cutting principle: ZERO hardcoded site knowledge

**Permanent project rule, valid from the spike through the final product:**

> No code, prompt, or template may contain knowledge specific to a target site — selectors, internal page URLs, naming conventions, expected texts. All site knowledge enters via **input** (scenario file, user task) or is **discovered at runtime** (page snapshot, element extraction). The engine is generic; the scenario is what knows the site.

Rationale: the product will be used on sites we have never seen. Any hardcoded hint (a) contaminates the validation — the system looks more capable than it is; (b) does not scale — no one will write hints for every customer site; (c) masks the planner's real capability boundary, which is exactly what we need to know.

Compliance checklist (apply to every PR that touches the planner):

- The planner prompt mentions no specific domain, selector, or site convention.
- Few-shot examples in the prompt use fictitious sites (`example.com`) with generic selectors.
- Product names, credentials, and expected texts live only in scenario files.
- `git grep -i "saucedemo\|orangehrm\|the-internet" src/` returns empty (except comments explaining third-party bugs, if any).

## A1 — Remove saucedemo hints from the planner prompt

**Problem:** `buildPrompt` in `planner.ts` contains hardcoded saucedemo selectors ("#checkout, #continue, #finish, #first-name... #add-to-cart-<name>..."). This contaminates criterion C1: part of the multi-page checkout's 5/5 is explained by the answer being in the prompt, not by the model's ability to predict unseen pages.

**Change:**

1. Remove from the prompt the entire block of conventional saucedemo selectors. The generic instruction that remains: "For pages after the initial one, which you are not seeing, infer likely selectors from the task and common web conventions (semantic ids/names, data-test). Prefer stable selectors."
2. Add an **optional** `hints: string[]` field to the scenario file schema — site-specific knowledge provided by the scenario's *user*, injected into the prompt in a `# Hints provided by the scenario author` section only when present. This preserves the capability without violating the principle: the hint is input, not code.

```json
{
  "scenario_id": "saucedemo-checkout",
  "start_url": "https://www.saucedemo.com",
  "task": "…",
  "hints": ["Add-to-cart buttons follow the pattern #add-to-cart-<product-in-kebab-case>"]
}
```

3. **Re-validate C1 without hints:** run Phase A of the bench (5 generations, `--no-cache`) for `saucedemo-checkout` and `saucedemo-compra-dupla` with `hints` absent.
   - **≥ 4/5** → multi-page prediction thesis genuinely confirmed; update RESULTS.md with the new numbers and a note about the corrected contamination.
   - **< 4/5** → record in RESULTS.md that multi-page flows **require** author hints or incremental per-page planning — this changes the MVP priority (incremental moves up the roadmap) and must be explicit, not hidden.

**Acceptance:** the compliance checklist above passes; bench re-executed; RESULTS.md updated with the outcome (whatever it is).

## A2 — Reliable click (replace `el.click()` via `evaluate`)

**Problem:** `browser.ts` clicks via `page.evaluate(el.click())` as a workaround for Stagehand's coordinate-based click losing events after idle pauses. Consequences: `isTrusted=false` (apps that filter synthetic events will fail in the field) and the absence of real actionability checks — an element covered by an overlay, `disabled`, or out of the viewport "clicks" successfully in the spike and would break with a real user. The spike passes; the product would not.

**Change (spike scope — mitigate and delimit; the full solution is MVP):**

1. Investigate the root cause of Stagehand's coordinate-click loss (reproducible with `SLOWMO_MS`). Record the finding — if it is a Stagehand bug, open an upstream issue and reference it in the code; it may be a symptom of something that affects `fill` too.
2. Add actionability pre-checks before the current click, even while keeping the synthetic fallback: element visible, not `disabled`, not covered at the center point (`document.elementFromPoint` compared with the target or a descendant). Failing any check = action failure (kind `verification`), not a blind click.
3. Document in the code and in the future glossary: the synthetic click is a **known limitation of the spike**; the MVP requires a reliable click (coordinates + actionability, Playwright-style, or a Stagehand fix).

**Acceptance:** 10/10 replay keeps passing on the existing scenarios; a new test proves that clicking an element covered by an overlay **fails** instead of "passing" (a minimal local test page is enough).

## A3 — Preserve the stale cache entry for diagnostics

**Problem:** `invalidate()` sets `status: stale` promising to keep the file for diagnostics, but the `saveCached()` from the re-plan overwrites the same path — the evidence disappears. Additionally, `stats` resets on every re-save, losing the `replay_count`/`replay_failures` history.

**Change:**

1. `invalidate()` renames the file to `<scenario_id>.stale-<timestamp>.json` (keeps at most the 3 most recent; prunes the rest).
2. `saveCached()` after a re-plan preserves accumulated counters: it loads the stats from the previous entry (if any) and adds to them, instead of resetting. New field `plan_generation: N` (how many times this scenario's plan has been re-generated) — a cheap input for detecting unstable scenarios in the future dashboard.
3. `cache clear` also removes the `.stale-*` files.

**Acceptance:** a test covering the replay-failure → invalidate → re-plan → save cycle proves that the stale file exists on disk and that the counters accumulate.

## Out of scope for these fixes

Page signature, partial re-planning, self-healing, browser pool, Redis/SQLite — these remain MVP ([RESULTS.md](RESULTS.md), Recommendations section). These three fixes close the spike with clean evidence; they open no new front.

## Suggested execution order

A3 (quick, unblocks tests) → A2 items 2–3 (pre-checks) → A1 (prompt change + re-bench, the slowest since it involves Gemini calls) → A2 item 1 (upstream investigation, can run in parallel). Estimated LLM cost of the re-bench: ~US$0.30 (10 generations × ~US$0.03).

# Validation Spike — Results

**Date:** 2026-07-11 · **Official environment:** Docker (node:22-slim + Chromium, Apple Silicon) · **Model:** gemini-2.5-flash

## Verdict: ✅ PROCEED to the MVP

Criteria C1–C5 passed in **both** scenarios. The central hypothesis — LLM only in planning, deterministic execution, cheap verification, and replay with zero LLM calls — is validated.

## Criteria table (protocol from doc 06)

| # | Criterion | Threshold | saucedemo-login | saucedemo-checkout |
|---|---|---|---|---|
| C1 | Valid plans on 1st generation | ≥ 4/5 | ✅ 4/5 | ✅ 5/5 |
| C2 | Replay without LLM | 10/10, llm_calls=0 | ✅ 10/10 | ✅ 10/10 |
| C3 | Latency gain | replay ≤ 1/5 of generation | ✅ 16.9x¹ | ✅ 18.5x¹ |
| C4 | Replay cost | US$ 0 | ✅ US$ 0 (average generation US$0.030) | ✅ US$ 0 (average generation US$0.014) |
| C5 | Failure recovery | post-condition → re-plan → replay 0 LLM | ✅ complete | ✅ complete |

¹ **Honest reading of C3:** the generation average includes runs with transient retries (API degeneration, see Surprises). Comparing only clean generations (1 call) against replay: **login 3.4x** (4.0s vs 1.2s — the plan has only 3 actions; browser launch dominates the replay) and **checkout 10.7x** (13.1s vs 1.2s). In the realistic scenario (long flow), the gain exceeds 5x comfortably; in the trivial flow, the physical ceiling is ~3.4x. The gain grows with flow size — exactly the regime that matters.

**Total cost spent on Gemini during the entire spike:** US$1.64 (144 calls, including all debugging and 3 full bench executions).

## The three questions from doc 01

1. **Feasibility** — YES. Gemini generates valid, executable JSON plans from task + accessibility tree (via Stagehand `page.snapshot()`), with structured output (`responseSchema`). The checkout (12 actions, 4 pages never seen by the model) came out 5/5, with `value_ref: ENV:SAUCE_PASSWORD` used correctly — the secret is never persisted resolved.
2. **Determinism** — YES. 20/20 replays (10 per scenario) passed with `llm_calls: 0`, stable post-condition verification, no timing flakiness (verifier polls until `timeout_ms`, never a fixed sleep).
3. **Economics** — YES. Replay costs US$ 0 and runs in ~1.2s; generation costs US$0.001–0.024 and takes 4–13s. Full-flow mode (1 call for the entire flow) was sufficient — the incremental per-page fallback was not needed.

## Surprises and learnings

1. **Non-deterministic degeneration of flash with structured output** — the biggest finding of the spike. With the SAME input, the model sometimes enters a text loop (ramblings in SCREAMING_SNAKE inside a JSON field) until it exhausts `maxOutputTokens`. Triggers we learned to avoid:
   - *Retry with a giant prompt*: resending the entire prompt with "ATTENTION: error" on top degenerated almost deterministically. A short retry (previous plan + errors + summarized rules) solved it.
   - *`temperature: 0`* makes the degeneration deterministic per prompt; temp 0.3 + a varied `seed` per attempt escapes the degenerate basin.
   - Structural mitigation: **transient** retry (up to 3 calls per semantic attempt, distinct seeds) separated from the **semantic** retry of doc 03 (1x, with the error in the prompt). `maxOutputTokens: 8192` caps the worst-case cost.
2. **`thinkingConfig: { thinkingBudget: 0 }` is mandatory** — with thinking enabled (2.5-flash's default), planning cost 10x more in latency and tokens.
3. **`responseSchema` has undocumented schema limits** — nested `maxItems` blows up with "too many states" (400 error); `const`/`pattern`/`format` are not accepted. The relaxed-schema-for-Gemini + full-schema-in-Ajv pair (anticipated in the spec) worked.
4. **The model fills fields that do not apply** with `""` or the literal string `"undefined"` — mechanical sanitization before validation is indispensable. Likewise `wait_for` ⇄ `expect` normalization (the model expresses the final verification both ways; they are equivalent).
5. **The snapshot changes between environments** — Docker's Chromium renders a slightly different accessibility tree than local Chrome, which changes the prompt and can change model behavior. This reinforces the decision to validate in Docker (the official environment).
6. **Stagehand v3 delivered as promised** — `env: "LOCAL"`, deterministic `page.locator()`, and `page.snapshot()` (a11y tree without LLM) covered 100% of the executor/verifier/context. The a11y tree does not expose CSS selectors; the complementary extraction of `id/name/data-test` via `evaluate()` was essential to keep the model from hallucinating selectors.
7. **(post-validation) Stagehand's coordinate-based click loses clicks after idle pauses** — discovered when adding demo mode (SLOWMO_MS): with a pause between actions, the burst of `Input.dispatchMouseEvent` randomly stops registering clicks, in both headless and headful. The executor switched to `el.click()` via `evaluate` (fires handlers and default actions; bench re-executed: C1 5/5, replay 738ms/30x). Caveat for the MVP: `el.click()` produces `isTrusted=false` events — apps that require trusted events will need a real click with actionability checks (Playwright pattern). Likewise: visibility gates must use native `waitForSelector` (which re-resolves frames after navigation), not `isVisible` polling on a possibly stale frame.

## Post-review addendum (doc 07) — clean C1 evidence for multi-page

The PO's review pointed out (doc [07-post-review-fixes.md](07-post-review-fixes.md)) that the planner prompt contained hardcoded saucedemo selectors, contaminating C1 for multi-page flows. The three fixes were applied (A1 zero-hardcode + optional `hints` in the scenario; A2 actionability pre-checks on click; A3 stale cache preservation with accumulated stats and `plan_generation`), and Phase A was re-executed **without hints**:

| Scenario (multi-page) | C1 with hints in the prompt (contaminated) | C1 without hints (clean) |
|---|---|---|
| saucedemo-checkout (12 actions, 4 pages) | 5/5 | **3/5** ❌ |
| saucedemo-compra-dupla (14 actions, 6 pages) | — | **5/5** ✅ |

**Reading:** without site knowledge, multi-page prediction sits at the capability boundary — 8/10 in aggregate, but unstable per scenario. The 2 checkout failures were the same error: a plausible-but-wrong inferred selector for an unseen page (`#shopping_cart_container`, the container div, instead of the `.shopping_cart_link` link — and `el.click()` on the container does not trigger the child's handler; the coordinate-based click would have hit it via hit-testing, a nuance to consider for the MVP's click).

**Consequences for the MVP (as anticipated in doc 07):**
1. **Incremental per-page planning moves up the roadmap** — it is the structural answer for reliable multi-page flows without hints.
2. Scenario-author `hints` are the legitimate stopgap (knowledge via input, not code) and are already implemented.
3. Measured side effect: with the hint-free prompt, flash degeneration became the rule (10/10 generations with `llm_calls ≥ 4`, ~100s and ~US$0.065/generation — previously ~20–40% of runs). The transient retry held the validation together, but the cost/latency reinforces the priority of testing another model in the planner.

The C1 paragraph in the main table remains valid for the 1-page scenarios; for multi-page, the clean evidence is in this addendum.

## Decisions made during implementation (for future ADRs)

| Decision | Choice | Note |
|---|---|---|
| Stagehand v3 vs plain Playwright | **Stagehand v3** | Gate at M1: low friction, engine isolated in `browser.ts` (cheap swap if needed) |
| Full-flow vs incremental | **Full-flow** | 1 call per miss was enough even for 12 actions/4 pages; incremental remains as a documented fallback |
| Planning retry | Semantic (1x, doc 03) + transient (3x, varied seed) | See Surprises #1; criterion C1 counts only semantic retries |
| Cache key | Simple `(scenario_id, start_url)` | Sufficient in the spike; `page_signature` stays for the MVP as planned |

## Recommendations for the MVP

- Keep the architecture as is (cache → planner → executor → verifier → metrics); it survived contact with reality intact.
- Prioritize on the roadmap: page signature in the cache key, partial re-planning with DOM diff, self-healing via `target.description` (the input is already in every generated plan).
- Consider an A/B model test in the planner: flash's degeneration rate (~20–40% of runs in Docker) costs latency; it is worth measuring `gemini-2.5-pro` or another provider once the provider abstraction exists.
- The fixed ~1.2s replay overhead is dominated by browser launch — a browser pool in the MVP makes replay sub-second.

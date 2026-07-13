# Validation Spike — Criteria and Protocol

## Measurement protocol (`spike bench`)

For **each** of the 2 scenarios, in this order:

**Phase A — Generation (Gemini feasibility):**

1. `cache clear`.
2. Run 5 times with `--no-cache`.
3. Record per round: did the plan pass schema validation? (with how many retries?) Did it execute to completion with all post-conditions passing? Tokens and cost. Planning vs execution duration.

**Phase B — Replay (determinism and economics):**

4. Run once normally (populates the cache).
5. Run `--repeat 10`.
6. Record: LLM calls (must be 0 in all of them), success rate, average duration.

**Phase C — Failure and re-planning:**

7. Manually edit the cache entry, breaking a selector (e.g., `#login-button` → `#login-button-x`).
8. Run once. Record: was the failure detected by the post-condition (not by a generic timeout)? Did re-planning generate a valid plan and did execution pass? Was the cache overwritten and did a subsequent replay return to `llm_calls: 0`?

## Acceptance criteria

| # | Criterion | Threshold | Measures |
|---|---|---|---|
| C1 | Valid plans on 1st generation (Phase A) | ≥ 4/5 per scenario (valid schema in ≤ 1 retry **and** complete execution) | Gemini's feasibility as a planner |
| C2 | Replay without LLM (Phase B) | 10/10 successes, `llm_calls = 0` in all | Replay determinism |
| C3 | Latency gain | average replay duration ≤ 1/5 of average duration with planning | Speed thesis |
| C4 | Cost gain | replay LLM cost = US$ 0; cost per generation documented | Economics thesis |
| C5 | Failure recovery (Phase C) | failure detected via post-condition + successful re-planning + next replay with `llm_calls = 0` | Invalidation → re-plan → cache cycle |

**Spike outcome:**

- **C1–C5 all pass** → architecture validated; proceed to the MVP (full roadmap in `docs/04-roadmap-mvp.md`, to be written).
- **C1 fails** (Gemini does not generate reliable plans): test incremental per-page planning before discarding; if it still fails, test `gemini-2.5-pro`. Document in an ADR.
- **C2 fails** (unstable replay): investigate whether the instability is timing-related (adjust timeout/wait semantics) or selector-related (anticipates the need for self-healing). Not fatal, but it changes MVP priorities.
- **C3 does not reach 5x**: record the actual factor. If ≥ 2x, the thesis still partially holds — decide with the number in hand.

## Final spike report

At the end of the protocol, produce `docs/spike/RESULTS.md` with: table of criteria (passed/failed + measured number), total cost spent on Gemini during the spike, main surprises/learnings, and an explicit recommendation (**proceed / adjust / rethink**). This document is the spike's decision deliverable — without it the spike has not finished.

## Suggested timeframe

The spike should be implementable in a few days of work. If it exceeds ~1 week, the scope has grown beyond the design — cut, don't extend.

# Results — Tranche 3 (hygiene → E4 → P4 → Playwright+E5 → P5)

**Date:** 2026-07-12 · **Closes specs E1–E5 and P1–P5 in full** · Published versions: 0.3.1 → 0.4.0 → 0.5.0 → 0.6.0 → 0.7.0

## Verdict: ✅ all five milestones passed — specs concluded

| Milestone | Criterion | Measured |
|---|---|---|
| **T3-0** scan hygiene | false `path:` entries out; honest count | ✅ menu/API fixture does not become a route; post-dedupe count + 150/node cap with log |
| **E4** manifest | ambiguous case documented with/without manifest | ✅ live: "qa account" (nonexistent on the page) without manifest → planner guessed literals scraped from the page; with manifest → `value_ref ENV:*` and replay ok. Manifest takes precedence over page text |
| **P4** LLM-assist | dynamic route detected within the cap; cost visible | ✅ routes via `array.map` detected with 3/5 calls, US$ 0.0005; `source: "llm"` with the lowest precedence; cost in the ledger and in `windup costs` (scans line); `--no-assist` |
| **Playwright+E5** | identical sig; old cache 10/10; C1–C5; p50<500ms; headful slowmo; Docker | ✅ sig `540270b8` identical (10/10); pre-migration cache replayed 10/10; **C1–C5 all green** with the YAML prompt; **p50 warm replays = 415ms**; headful+SLOWMO 1500ms passed (Stagehand click bug eliminated — trusted events); Docker with system chromium ok |
| **P5** vitest adapter | scenario in the runner's native report | ✅ `windup e2e > saucedemo-login ✓ 1.3s` via `windupSuite()` from `windupjs/vitest` |

## What the engine migration delivered beyond the criteria

1. **Doc 07-A2 debt paid off**: clicks with native actionability and `isTrusted=true` — the limitation known since the spike no longer exists.
2. **Drastically smaller dependency tree**: `@browserbasehq/stagehand` (and its dozens of optional AI providers, the source of the peer-deps warnings in users' installs) is out; pure `playwright` is in.
3. **E5 without a daemon**: singleton engine per process + fresh context per run — `--repeat`/bench/vitest suite pay for the launch once; isolation equal to before. A daemon across invocations remains explicitly out of scope (SPEC-001), to be reassessed only if p50 regresses.
4. The swap cost **a single file** (`browser.ts`) — the spike's architecture bet ("engine behind an interface") paid off exactly as designed.

## Lessons learned

- The cached plan with `use` (fragment) broke Phase C of the bench (there was no `click` to break) — the bench now breaks any action with a target. And post-failure re-planning sometimes duplicated what the fragment already covered; the fragments prompt now instructs continuing from the `use` postcondition.
- `ariaSnapshot()` YAML replaced `formattedTree` with no C1 regression (5/5 on login) and prompts ~10% smaller.
- The E4 criterion needed careful design: demo sites display credentials on the page itself, so "fail without manifest" became "guess literals without manifest vs disciplined `value_ref` with manifest" — a more honest and more useful contrast.

## Product state

`windupjs@0.7.0` public on npm; repo `windupjs/windup` (private). Specs SPEC-001 (E1–E5) and SPEC-002 (P1–P5) **fully implemented and measured**. Outside the delivered scope (decisions recorded): dynamic crawl (P4 optional), daemon across invocations (E5), `launch ∥ planning` (future miss-latency milestone).

## Natural next steps (outside the current specs)

- Continuous dogfooding on comando.one (react-router) — 0.7 scan with assist + the real project's manifest.
- Next.js/react-router indexer for monorepos (detection already warns).
- Automatic fragment detection via common prefix (SPEC-001, post-E3).
- SQLite for the map when scale demands it (interface ready).
- Repository CI (GitHub Actions: typecheck+test+bench headless).

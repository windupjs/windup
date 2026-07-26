# Changelog

All notable changes to `windupjs` are documented here. The project is in the
`0.x` line (pre-1.0): it is usable and tested, but the API may still change
between minor versions. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## 0.55.0
- **Browser prewarming — the next scenario's context launches off the critical path (on by default; `--no-prewarm` to disable).** In a sequential `run --all`, while a scenario runs (navigation + actions), Windup pre-creates the **fresh** `BrowserContext` + page the *next* scenario will use, so that scenario no longer waits ~200 ms on `newContext`/`newPage`. **Isolation is identical** to a per-scenario launch — every scenario still gets its own clean context; only the launch moves off the wait (a scenario's `setup` segment drops to ~0 in the breakdown, verified live). Safe by construction: the prewarmed session is a one-shot — a `--retries` re-attempt and the session-snapshot (`storageState`) fast path each launch fresh, and an unused warmed session (a `--bail`/`--max-wall` early stop) is closed. Only sequential runs prewarm (`--concurrency > 1` already overlaps launches across workers). This is the deliberate, zero-risk answer to "context pool": measurement showed reusing a *live* context saves only ~18 ms and would leak state between tests, so Windup prewarms a **fresh** one instead. New `RunOptions.prewarmed`.

## 0.54.0
Diagnostics & determinism — a batch of tools that read what Windup already knows and two config knobs that make hard-to-reproduce states testable. Every command is LLM-free; each feature is unit-tested and validated (real-browser for the two that touch the page).

**Four read-only commands (zero LLM, straight from the ledger/cache):**
- **`windup why <scenario>`** — one place for a scenario's whole story: is a plan cached and ready to replay ($0) or will the next run plan; re-plan **churn** (a stability signal); the `depends_on` chain; run **history** (pass rate, avg cost/time); and the **last run** with its failure kind/message and whether a snapshot is stored. Turns "why is this red/slow/re-planning?" from a ledger grep into one line.
- **`windup explain <scenario>`** — the cached plan as readable steps (`go to /login · fill one-time code with {otp_code} · click Place order ↳ verify #confirmation is visible`). Review a plan without opening the JSON. A fill's **value is never shown** (a `value_ref` renders as its name) — secrets/OTP stay out.
- **`windup diff <scenario>`** — compares the two most recent runs: result flip, cache, and **Δ time / Δ cost / Δ actions**. Catches "this scenario got 2× slower" or a plan that quietly grew.
- **`windup badge [--json] [--out <path>]`** — a suite-status badge from each scenario's latest run: a self-contained **SVG** (`271/271 passing · $0`, no external fetch — safe to commit) or a **shields.io endpoint JSON**.

**Determinism (config, applied every run, never cached, author-declared):**
- **`config.network`** — request **stubbing**: match by URL (substring or glob) + optional method, then respond with a `status`/`body`/`json` or `abort` the request — test a 500, an empty list, a slow or failing endpoint without touching the backend. First match wins. Validated live: the same page renders 3 (real) → 0 (stub `[]`) → error (abort).
- **`config.clock`** — pin the page's time: `now` freezes `Date`/`Date.now()` to a fixed instant (injected before any page script, transform-proof) and `timezone` sets the browser's IANA zone (native Playwright) — so "orders from today" or a countdown stops drifting at midnight. Validated live: `now: "1999-12-31…"` → the page's `new Date()` reads 1999-12-31.

**CI guard-rail:**
- **`run --all --bail`** — stop starting new scenarios after the first failure (fast PR-check feedback). Completes the trio with `--retries`/`--max-wall`; works sequentially and under `--concurrency` (shared halt), prints `⏹ --bail: stopped after the first failure — X/Y ran, Z not started`.

New modules `why.ts`/`explain.ts`/`diff.ts`/`badge.ts`/`ledger.ts`/`network.ts`/`clock.ts`; `config.network`/`config.clock`; a `windup doctor` config check.

## 0.53.0
Resilient-CI pair — turn a flaky suite green without hiding the flake, and cap how long a suite may run. Both tested (unit + real-browser live) and LLM-free on the happy path:
- **Retry a flake — `run --retries N`.** Re-run a scenario that failed a **transient** way (network reset, a hydration-race verification miss, a wobbly `setup`/`dependency`) up to N extra times; the first pass wins. A `forbidden` block is **never** retried — a `config.forbid` guard is a deliberate stop, not a flake. Crucially the flake is **surfaced, not swallowed**: a scenario that only passes on a retry is flagged `flaky` (`↻ N passed only on retry` in the console, a `FLAKY N×` badge in the HTML report, `flaky`/`attempts` on the JSON record and the `run:end` stream event) so you fix the root cause instead of laundering it green. Validated live: a page whose first connection is dropped fails attempt 1 (`network`) and passes attempt 2 — recovered, marked flaky, zero LLM calls. New `RunMetrics.attempts` / `RunMetrics.flaky`.
- **Time budget — `run --all --max-wall <seconds>`.** A CI guard-rail: once the suite's wall-clock crosses the cap, Windup **stops starting new scenarios** (in-flight ones finish — no work is cancelled mid-run) and **exits non-zero** so a runaway suite fails the build instead of hanging the runner. Works in both sequential and `--concurrency` modes (the pool stops pulling new jobs). The console reports `⏱ --max-wall Ns exceeded — X/Y ran, Z not started`. Validated live: a 3-scenario suite under a 0.7 s cap ran 1, skipped 2, exit 1.
- New `runWithRetries` and a `shouldStop` predicate on `runPool`.

## 0.52.0
Three items from the beta round (feedback #8), in the requested priority order — each tested and validated live:
- **Accessibility label fallback + a11y gap report (#2.2).** When the plan's CSS selector misses (the model guessed one for a control with no stable anchor), the executor now retries the target by its **accessible name** — matching `description` against the page's `getByLabel` / `getByPlaceholder` / `getByRole("textbox")`, and acting **only when exactly one visible field matches** (never a guess). The recovered step is marked in the report with a `≈ found "<label>" by label (plan selector "<sel>" missed)` note, so a run that leaned on the fallback is visible rather than silent. When neither the selector nor the label resolves, the failure message now names the likely cause — *"the control likely has no accessible label (a11y gap) — anchor it with a hint"* — turning a dead end into an actionable a11y finding. Validated live: a fill whose selector was `#wrong-guessed-selector` recovered via the "Measurement ID" label and passed, with the note surfaced.
- **Mandatory step granularity — `atomic_steps` (#2.1).** Set `"atomic_steps": true` on a scenario and the planner is instructed to emit **one interaction per action** — never merging a reveal/expand click with the action it uncovers (e.g. "open the menu, then click Delete" becomes two steps, not one). Keeps the replay debuggable and the report readable when a UI hides controls behind disclosure. New `Scenario.atomic_steps`.
- **Per-scenario dialog default — `on_dialog` (#1b).** Set `"on_dialog": "accept"` (or `"dismiss"`) on a scenario and a **persistent** dialog handler is installed for the whole run — every native `confirm()`/`alert()`/`beforeunload` is answered automatically, no per-action `dialog` field needed. Complements the existing plan-level `dialog` on a single click; when `on_dialog` is set it wins (the per-action `armDialog` no-ops). Validated live: a page with two separate delete buttons, each firing its own `confirm()`, cleared both rows under a single `on_dialog: accept`. New `Scenario.on_dialog`.
- New `Scenario.atomic_steps` / `Scenario.on_dialog`, `ActionMetrics.note`, and `Browser.{clickByDescription,fillByDescription,isVisibleByDescription,setDialogHandler}`.

## 0.51.0
Three CI features (from the roadmap brainstorm), each tested and validated live:
- **Trace + screenshot on failure — `run --trace`.** When a scenario fails, save a **Playwright trace** (`.windup/reports/traces/<id>.zip`, openable in the trace viewer — DOM snapshots, network, console per step) plus a full-page **screenshot** next to the report; the HTML report links both from the failed row. You can finally *see* what happened in CI instead of reading ms numbers. (Trace is captured only on failure; a passing run discards it, no overhead kept.)
- **Scenario tags — `run --all --tag <names>`.** Tag scenarios (`"tags": ["smoke", "checkout"]`) and run a subset: `--tag smoke,checkout` runs any scenario carrying one of those tags. Run smoke on every push, the full suite nightly — composes with `--shard` and `--changed`. New `Scenario.tags`.
- **GitHub Actions output — `run --github` (auto-on when `GITHUB_ACTIONS=true`).** Emits a `::error::` workflow annotation for each failed scenario (shown inline on the PR) and appends a Markdown suite summary + per-scenario table to `$GITHUB_STEP_SUMMARY` (shown on the job page). New `github.ts`.
- New `ActionMetrics`→`browser.saveTrace()/screenshot()`, `RunMetrics.artifacts`.

## 0.50.0
- **Readable action table — see WHAT each step did (feedback).** The per-scenario action list showed `a1 · 76 ms · 2 ms` with no way to tell what `a1` was. Each action now carries its **`type`** (goto/click/fill/wait_for/use) and a **`label`** — the target's description or selector, the goto URL, or `= {ref}` for a resolved fill — so the HTML report reads `a4 · fill · otp` instead of an opaque id. A fill's VALUE is never shown (secrets/OTP stay out — the label is the field description, and a `value_ref` renders as its name, not its value). New `ActionMetrics.type` / `ActionMetrics.label`.

## 0.49.0
- **Make `resolve` reliable — deterministic field binding (`config.resolveFields`).** The 0.47 `resolve` mechanism worked, but it depended on the planner emitting `value_ref` for the right field — which the LLM did unreliably (filling a literal, so the resolver never ran; or a mis-cased name, so the plan failed validation). Now bind the field yourself: `resolveFields: { "[name=otp]": "otp_code" }` (a **selector substring** → resolver name). The executor fills **any** matching field from that resolver, **overriding whatever the plan put there** — so an OTP/token flow is deterministic regardless of what the model planned. Validated live: a cached plan that fills a literal `000000` into the OTP field **fails** without the binding and **passes** with it (the executor substitutes the real code). Plus two robustness fixes: `value_ref`/`url_ref` names are **normalized** (`OTP_CODE` / `otp-code` → a declared `otp_code`) and the schema tolerates that casing (no more `plan_invalid` on a stray form); and a `goto` with `url_ref` (a resolved URL, no literal `url`) now passes validation. New `config.resolveFields`.

## 0.48.0
- **Report honesty: separate active work from concurrency contention (feedback #2).** Under `--concurrency N`, a scenario's per-case breakdown was dominated by an opaque **"other"** bucket that is really the scenario *waiting* for a CPU/browser slot while siblings run — idle time, not cost (a "19.7 s" archive was ~0.4 s of work). That leftover is now labeled **`contention`** (not "other") when concurrency > 1, and each scenario shows an **`active` ms** figure — its own work (setup + deps + plan + nav + actions), roughly stable across `--concurrency` so scenarios stay comparable. JSON's per-case `duration_breakdown` gains `active` and `contention`.
- **Data preconditions — scenario `requires` (feedback #3).** `depends_on` captures a *scenario* dependency; `requires: ["1 active attraction", "a paid order"]` documents a *data* one — the seed data a scenario assumes. Declarative: it renders in the report (terminal on failure, HTML, JSON) so a break caused by missing data is legible and the create→use→archive cycle is visible; it is never verified (use `setup`/`suite.setup` to seed). New `Scenario.requires`, `RunMetrics.requires`.

## 0.47.0
- **Dynamic values — `config.resolve` (unblocks OTP, magic-links, passwordless login).** Windup's steps were UI-only (`goto`/`click`/`fill`/`wait_for`) — there was no way to grab a value generated at run time (an OTP code, a magic-link URL) and use it, so no OTP/magic-link flow was testable end-to-end. Now you declare a **resolver** in `windup.config.ts` — `resolve: { otp_code: { source: { kind: "cmd"|"http"|"fn", … }, extract: { regex | json }, poll } }` — and a plan references it: `{ "type": "fill", "value_ref": "otp_code" }` or `{ "type": "goto", "url_ref": "magic_link" }`. The value is fetched (with polling — the code/email arrives late) at the point of use. **Sources are author-declared, never LLM-generated** (no code-exec-from-model vector), and the resolved value is **ephemeral** — never cached, reported or logged (the plan carries the reference name, like `ENV:` credentials). The planner is told the available names so it emits `value_ref`/`url_ref` instead of a literal. Validated live: a cached replay of an OTP login fetches the run-time code from an external source and completes the flow at `$0`. New `resolvers.ts`, `config.resolve`, `Action.url_ref`.

## 0.46.0
Five roadmap features in one release (from the "ideas for later" brainstorm), each tested and validated live:
- **`windup doctor` — preflight checks.** Before a run, statically verify the LLM key for the active provider, the browser binary, that every scenario parses, that no cached plan references a missing fragment, and that the site map is scanned. No browser/LLM/network; non-zero exit only on a hard problem (invalid scenario, orphaned fragment).
- **Sharding — `run --all --shard i/n`.** Round-robin-split the suite across parallel CI runners (`--shard 1/4`, `--shard 2/4`, …), each a separate job.
- **Accessibility audit — `run --a11y`.** After each scenario, run [axe-core](https://github.com/dequelabs/axe-core) on the final page and report violations — a free a11y check on infra Windup already has. Informational (never fails the run). Opt-in: axe-core is an optional dependency loaded via dynamic import and kept out of the base install (`npm i -D axe-core` to enable).
- **Flake root-cause hints.** Each flaky scenario (from `--repeat`) now carries a hint at the likely cause, read from its runs: start-page signature drift → hydration race; a network failure; always-fails-the-same-action → unstable selector; cache churn → non-deterministic replay. Shown in the terminal summary and the HTML report.
- **Authoring `--watch`.** `run <id> --watch` re-runs a single scenario whenever its file changes — a tight authoring loop.
- New `doctor.ts`, `browser.runAxe()`, `RunMetrics.a11y`, `FlakyScenario.hint`; `--shard`/`--a11y`/`--watch` on `run`.

## 0.45.0
- **Smarter readiness — stop burning the timeout on display pages (speed).** The initial page-signature wait now proceeds as soon as **either** the app renders interactive elements **or** the network settles (`networkidle`), whichever comes first (still capped at 5 s). Previously it polled only for interactive elements, so a display-only page — no buttons, no pending requests — waited the full 5 s on every run (it showed up as the dominant `nav` chunk in the 0.42 breakdown). Measured **~9× faster** on such a page (`exec` 5088 ms → 556 ms). Can only be faster, never slower — both branches share the same deadline, and pages with interactive elements already bailed early. New `browser.waitForIdle()`.

## 0.44.0
- **Safety denylist — `config.forbid` (CI guardrail against irreversible side effects).** Declare selectors and URLs a plan must never touch: `forbid: { selectors: ["#change-password"], urls: ["**/account/password"] }`. Before each action (and on the landing page) the executor aborts with a `forbidden` failure if the action's CSS selector CONTAINS a forbidden substring or the current/goto URL matches a forbidden path glob — so even if a re-plan wanders toward "Change password", it's stopped before the click. You declare the danger list; the engine never infers it (zero site knowledge). The machine-enforced backstop to the non-destructive authoring discipline. New `config.forbid`, `forbidden` failure kind, `executor.forbiddenViolation()`.

## 0.43.0
- **`windup coverage` — find coverage gaps automatically.** Cross-references the routes `windup scan` indexed with your scenarios: it reports how many indexed routes have at least one scenario and **lists the routes that have none** — the "what am I missing" audit, generated from data Windup already has (the site map + scenarios + cached plans), with no LLM and no network. A scenario covers a route when its `start_url` (or any URL in its cached plan) matches the route's url_pattern. `--json` for pipelines (a CI gate can fail when critical routes are uncovered). New `coverage.ts`, `SiteMapStore.allRoutes()`.

## 0.42.0
- **Report time transparency — reconcile where the wall-clock goes (feedback).** Two report fixes, no performance change:
  - **Per-scenario duration breakdown.** A cached run that reads as "a 113 ms action took 3.6 s" now shows why: the HTML report splits each scenario's total into a reconciling bar — `setup` (context launch) · `deps` (the `depends_on` chain) · `plan` (LLM) · **`nav`** · `actions` · `other` — where **`nav`** is the goto + page load/hydration BEFORE the first action, now isolated from `execution` (it's usually the real time sink in an SPA). JSON carries a per-case `duration_breakdown`; a new `duration_ms.navigation` metric backs it.
  - **Suite time is wall-clock, not the sum.** The suite header led with the sum of per-scenario totals, which inflates ~N× under `--concurrency N` (e.g. "511.9s" for a 130s run at concurrency 4). It now leads with **wall-clock** (real elapsed) and labels the sum: `wall 130s (sum 512s · concurrency 4)`. Terminal, HTML and JSON (`wall_ms`, `concurrency`) all reflect it.

## 0.41.0
- **Client-side fixtures — scenario `seed` (feedback #5, coverage at scale).** A scenario can declare `"seed": { "localStorage": {…}, "sessionStorage": {…}, "origin"? }` to inject browser storage **before the plan runs** — reaching a client-side state (a cart in `localStorage`, a POS device in `sessionStorage`) directly and deterministically, with **no server call**, instead of building it through the UI. Applied via a Playwright init script that sets each key **only if absent** (so the app's own mutations are never clobbered on later navigations), per origin (default: the `start_url` origin). Not part of the cached plan — it runs every time, so seeded scenarios stay `$0` and deterministic on replay. Validated live via `--llm claude-code`: an empty cart page renders the seeded items with no add-to-cart steps, and replays at `$0`. New `Scenario.seed`, `browser.seedStorage()`.
- **Docs: non-destructive CI testing.** README gains a "stay at the side-effect boundary" guide — the discipline that keeps a per-push suite from charging cards, sending OTPs, creating accounts or mutating persistent state (client-side validation, read screens, `seed`ed state, bogus-token error pages, and open-then-cancel confirmation dialogs are all safe; real payment, messaging, identity creation, persisting config, voucher-consuming check-in and **changing the test account's password** are not).

## 0.40.0
- **Session snapshots: `depends_on` restores auth instead of re-running the login flow (feedback #4 — the big replay-speed win).** Re-executing a UI login for every scenario that depends on it was the dominant wall-clock cost of a cached suite. Windup now captures each dependency's **exit state** — Playwright `storageState` (cookies + localStorage) + final URL — after it runs, and on a later cached replay it **restores that state into a fresh context and skips re-running the whole `depends_on` chain** (`deps≈0ms`, reported as `reused_session_from`). Still verified: if the restored session is stale or incomplete (verification fails), the snapshot is dropped and the run **falls back to a full-chain replay** in a fresh context — no false pass, no wasted LLM call (a `deferReplan` guard keeps the snapshot attempt from invalidating a good cached plan). Snapshots live in `.windup/state/` (**gitignored — they hold auth cookies/tokens; never commit them**). Validated live via `--llm claude-code`: with a snapshot the dependency chain is skipped and the run passes at `deps≈0`; a corrupted/empty snapshot fails verification and transparently re-runs the chain to green. New `session-cache.ts`, `browser.launchBrowser({ storageState })` / `browser.storageState()`, `RunMetrics.reused_session_from`.

## 0.39.0
- **Wall-clock breakdown in the run report (feedback #4).** `duration_ms` now splits `total` into `planning` (LLM), `execution` (this scenario's Playwright actions), `dependencies` (the re-run `depends_on` chain) and `setup` (browser context launch), printed as `total=… (plan=… deps=… exec=… setup=…)` and surfaced in the `run:end` `--stream` event (`exec_ms`/`deps_ms`/`setup_ms`). Makes it clear where a cached run's wall-clock goes — the cache's promise is `$0` (no LLM calls), not "instant": the plan's real-browser actions and any dependency chain still run. README's "How it works" now states this explicitly. (Sets up the `depends_on` session snapshot that removes the dependency-replay cost.)

## 0.38.0
- **Isomorphic plan reuse — scenario `like` (feedback #3, the last item).** At scale many scenarios are the same flow on a different route/entity. A scenario can now declare `"like": { "scenario": "<source_id>", "set": { "<source value>": "<new value>" } }` to reuse another scenario's **already-proven** cached plan instead of an LLM planning call: Windup instantiates the source plan for this scenario's `start_url` and swaps the differing fill values (deterministic, no LLM). The reused plan is **still executed and verified** before it's trusted/cached — if the pages aren't actually isomorphic it **falls back to normal LLM planning**, so it can never produce a silent false green. On success the run is `llm_calls=0` (`reused_from` set) and the scenario gets its own cached plan for ordinary `$0` replays after. Validated live via `--llm claude-code`: reuse passes on an isomorphic route ($0), and a non-isomorphic route fails verification and re-plans with the LLM. New `isomorph.ts` (`instantiatePlan`), `Scenario.like`, `RunMetrics.reused_from`. Fragments reuse action blocks; `like` reuses whole plans.

## 0.37.0
- **Suite-level fixtures — `config.suite.setup` / `config.suite.teardown` (feedback #3).** Shell command(s) run ONCE around a `run --all`: setup before the first scenario, teardown after the last (always, even on failure) — the `beforeAll`/`afterAll` analogue for a shared fixture database or an external stub. Per-scenario `setup`/`teardown` (in the scenario JSON) still handle per-test state. A failing `suite.setup` aborts the suite before any scenario runs (exit 2); a failing `suite.teardown` is a warning. Only fires with `--all`, not for a single-scenario run. Validated live: setup → scenarios → teardown ordering, abort-on-setup-failure, and the `--all` gate. New `config.suite` field (reuses `hooks.ts`).

## 0.36.0
- **Reusable readiness signals per route glob — `config.readySignals` (feedback #3).** Map a route glob (e.g. `"**/workspace/**"`) to the CSS selector(s) that must be visible before the executor runs the first action on a matching page. Applied deterministically at run time (no LLM, $0, not part of the cached plan) whenever a run enters a matching route — so a hydration/loading wait is defined once per route instead of repeated as a hint in every scenario. Closes the load-time race where an element is present but its handlers aren't attached yet (Playwright's per-element wait can't see it). Best-effort: a signal that never shows within the timeout warns and continues. Validated live via `--llm claude-code`: the same generated plan **fails** without the signal (click races hydration, form never appears) and **passes** with it. New `executor.ts` readiness gate + `readySignals` config field.

## 0.35.0
- **Incremental runs — `run --all --changed` / `--since <ref>` (feedback #3, 145-scenario suites).** Run only the scenarios a change affects instead of the whole suite. `--changed` diffs the working tree against `HEAD`; `--since main` (or any git ref) diffs against that ref. A scenario is selected when its own file changed, when it has no cached plan, or when its cached plan visits a route whose **indexed source** changed (the site map's file→route attribution + picomatch). Sound-but-coarse and **never a silent false green**: if the diff touches files the map can't attribute to a route (shared code, config), or there's no git / site map with source info, it runs the full suite and prints why. An empty affected set exits 0. New module `changed.ts`; `SiteMapStore.affectedPatternsByFiles`/`indexedSourceFiles`; `scenarioFileById`.

## 0.34.0
- **Suite report: module grouping + suite stats (feedback #3 — 145 scenarios, 17 modules).** `run --all` prints a suite summary — pass rate, cache-hit rate, re-plans, LLM calls, cost, total time — with a per-module (folder) breakdown. HTML groups by module with cache-hit / re-plan tiles; JUnit emits one `<testsuite>` per module; JSON carries the full summary (`by_module`, `flaky`) and a `module` per case; under `--stream` it's a `suite` event.
- **Flake score.** `--repeat <n>` is aggregated per scenario — one passing some-but-not-all of its runs is flagged flaky (`passed X/N`) in the summary and reports.

## 0.33.0
- **Native dialogs — `window.confirm`/`alert`/`prompt` (fixes a beta-report blocker, #12).** Playwright auto-dismisses dialogs unless a handler is registered, so a click behind a `confirm()` (archive/delete/cancel) silently did nothing. Actions now take `"dialog": "accept"` (or `"dismiss"`), and the executor arms a one-time handler before the triggering action; the planner emits it for confirm/alert/prompt steps instead of inventing a fragment. Deterministically verified (accept runs the mutation, dismiss cancels) and live-verified that the planner emits it (via `--llm claude-code`).
- **Verify persistent signals, not toasts (#12).** The planner now prefers a lasting postcondition (a row that appears/disappears, a changed label, a URL) over transient toast/snackbar messages that vanish in seconds and make verification a race.

## 0.32.0
- **`windup new` steers the verification toward the instruction (#5, from a beta report).** The authoring prompt now derives the final verification from what the instruction actually asks — preferring a visible element/text over a plausible-but-unasked destination route from the site map (a common LLM mistake when the map lists many routes). `windup new` also flags that the task/verification is the LLM's best guess and recommends confirming with `--validate` (generate → run → self-refine) or a first run. Revalidated live via `--llm claude-code`.

## 0.31.0
- **`run --stream` — NDJSON event stream** (the machine-readable half of the beta report's #9). Emits one JSON line per milestone to stdout (`run:start`, `planning`, `plan`, `action`, `replan`, `run:end`, each with the scenario, elapsed time and relevant data), so CI or a dashboard can follow a run in real time. Human progress (`--verbose`) stays on stderr, keeping stdout pure NDJSON.

## 0.30.0
- **Guided self-heal (#10, from a beta report).** When a cached plan fails verification and Windup re-plans, the re-plan context now names the **exact selector that failed** with a "do not reuse it" instruction, re-emphasizes the scenario hints, and — under `--suggest` — feeds the same expert diagnosis you'd read straight back into the planner, so it corrects instead of re-proposing a refuted semantic selector. A **loop-breaker** warns when a scenario keeps re-planning without stabilizing (the app likely lacks a stable selector — an accessibility gap — or has a race), instead of churning LLM calls silently.

## 0.29.0
- **Per-scenario `setup` / `teardown` hooks** (from a beta report on non-idempotent CREATE). Shell commands that run **outside** the cached plan — so they run on every replay — for fixtures or cleanup (hard-delete what a test created, reset via SQL/HTTP). `setup` runs before the scenario and its dependencies (a failure fails the run, kind `setup`); `teardown` runs always, even on failure (a failure is a warning). They never enter the plan or cache.
- **Docs: idempotency principle** — prefer idempotent scenarios (edit-to-fixed-value, toggle-and-check); a pure CREATE with a non-reusable unique key needs a teardown hook. Plus a "flakiness becomes signal" note: a plan that stops replaying deterministically is exposing an app race, not a flaky test.

## 0.28.0
- **`run --verbose` — a heartbeat during planning** (from a beta report: planning with `--llm claude-code` takes 1–3 min with no output, so a run looks frozen). Verbose mode emits milestones to stderr as planning and execution advance — `planning… (llm: …)`, `calling <provider> (attempt N)…`, `plan received: N actions`, per-action `✓/✗`, and `→ self-heal re-planning` — each prefixed with the scenario id and elapsed time. Off by default; never affects results.

## 0.27.0
- **Scenarios can be organized in subfolders** (from a beta report). `run --all`, the vitest suite and `depends_on` now discover scenarios **recursively** under the scenarios directory — group them by module (`e2e/scenarios/contacts/…`, `…/auth/…`). The `scenario_id` field stays the identity (resolution is by id, not file path; duplicate ids are reported). `loadScenario` keeps the `<dir>/<id>.json` fast path and falls back to a recursive search by `scenario_id`.
- Note: `windup init` has detected TanStack Router since 0.25.0 (writes `framework: "tanstack-router"`) — re-run `windup init` on a project scaffolded by an older version to pick it up.

## 0.26.0
- **TanStack Router / TanStack Start indexer** (biggest ask from the beta report). `windup scan` now statically indexes TanStack's file-based routes under `src/routes/` (or `app/routes/`): dot-notation as path separators (`workspace.loja.aparencia.tsx` → `/workspace/loja/aparencia`), directory params (`loja/$companySlug/checkout/pagamento.tsx` → `/loja/:companySlug/checkout/pagamento`), pathless layout segments (`_authenticated/_company/manager.companies.tsx` → `/manager/companies`), splats, `index`/opt-out markers, and `__root` skipped. It trusts each route's `createFileRoute('/id')` string (TanStack's resolved id) and falls back to file-name conventions. `init` sets `framework: "tanstack-router"` automatically. On a real 118-route app this takes the map from ~7 routes to full coverage with real selectors.

## 0.25.0
- **Self-heal reuses the provider that planned the scenario (fixes a real bug report).** When a cached plan fails verification and is re-planned, Windup now re-plans with the **same LLM provider that originally made the plan** (recorded in the plan), before falling back to the config default — so self-healing works even when the re-run didn't pass `--llm`. Precedence: `--llm`/`WINDUP_LLM` > the plan's recorded provider > `llm.provider` in config.
- **Actionable "no key" errors** — a planning failure for a missing key now names the provider and lists the fixes (pass `--llm <provider>`, set the variable, or change `llm.provider`), instead of a bare "VAR is not set".
- **TanStack Router detected** — `init` recognizes `@tanstack/react-router` / `@tanstack/react-start` (framework `tanstack-router`), and `scan` explains that TanStack file-based routing isn't statically indexed yet (the map is built from executions) and how to opt into the react-router indexer. The generic "no indexer" message now points at `framework: "react-router"`.

## 0.24.0
- **`windup secret remove <account>`** (alias `rm`) — completes credential management: drops the account from `windup.credentials.json` and its values from `.env.local` (other variables untouched), and clears it from the manifest.
- **Credentials docs overhauled** — the package README and the docs site (en/es/pt/zh) now fully cover where values are stored, creating/listing/removing accounts, and referencing them by name in a scenario.

## 0.23.0
- **`windup claude login` / `windup claude status`** — one-command onboarding for `--llm claude-code`: `status` reports whether the `claude` CLI is installed and signed into your plan (machine-readable probe, no quota spent; non-zero exit when not ready); `login` installs the CLI if missing (interactive confirm — never a silent global install, and never in CI) and runs `claude auth login`. `windup status` also shows the readiness line when claude-code is the active provider.

## 0.22.0
- **`--llm claude-code` needs no wrapper anymore** — it now drives the native `claude` CLI you already have (`claude -p … --output-format json`), spawned from an isolated temp dir. Zero setup: no Python, no Poetry, no local server — just the Claude Code CLI installed and logged into your plan. The [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper) becomes the **opt-in** path, used only when a `baseUrl` / `WINDUP_CLAUDE_CODE_URL` is configured. Same $0 subscription cost, same mechanical un-fencing (Ajv still validates every plan). A missing/logged-out CLI fails fast with an actionable install/`/login` message. Verified end-to-end (plan → execute → verify) on the native path. Still opt-in, never a default.

## 0.21.0
- **Plan with your Claude subscription** — new opt-in provider `--llm claude-code`, targeting the third-party [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper) (a local proxy over your own Claude Code session). No API key required; cost is reported as **$0** in `windup costs` (tokens are real and stay in the ledger, but they're covered by your subscription — never priced at the fallback rate). Opt-in, never a default, and unsupported by us or Anthropic. The wrapper implements only `model`/`messages`/`stream`, so the schema rides in the prompt and the reply is un-fenced mechanically (Ajv still validates every plan); a down wrapper fails fast with an actionable error instead of retrying to `fetch failed`. Default model `claude-sonnet-4-6`; endpoint configurable via `baseUrl` / `WINDUP_CLAUDE_CODE_URL`.

## 0.20.0
- **Cross-browser** — run scenarios on `chromium` (default, auto-provisioned), `firefox` or `webkit` via `--browser` / `WINDUP_BROWSER` / `config.browser`. Firefox/WebKit are opt-in (`npx playwright install <name>`); a single plan replays across all three (CSS selectors are engine-agnostic).

## 0.19.0
- **Parallel runs** — `run --concurrency <n>` runs scenarios in parallel over one shared warm browser with isolated contexts (one shared site map, order-preserving results). Measured ~2× faster on an 11-scenario suite at concurrency 4. Default 1 (behavior unchanged).

## 0.18.x
- **`run --suggest`** — on a failed run, an LLM analyzes the executed plan, the
  failing step, the real final page and the site map, and proposes a concrete
  fix to the scenario. Closes the authoring learning loop.
- **`windup new --validate`** — generate → run → refine from the failure until
  the scenario passes (≤3 attempts); you get a scenario that already passed once.
- **Graceful CLI errors** — expected failures print a clean, actionable line;
  `WINDUP_DEBUG=1` shows the full stack. No more raw Node stack traces.
- **Security** — page content is delimited as untrusted in all LLM prompts
  (planner, `--summary`, `--suggest`) to mitigate prompt injection; `SECURITY.md`
  threat model added.
- Robustness measured: 60/60 cached replays passed with zero flakes and
  `llm_calls=0` across four scenarios (login, multi-step checkout, add/remove, a
  second site), 15 replays each.
- Docs: demo GIF in the README; full English translation of the repository.

## 0.15.0
- **Scenario dependencies (`depends_on`)** — prerequisites run in the same
  browser session, each with its own cache and self-healing; a dependent scenario
  without `start_url` continues from the dependency's final page (the planner
  sees the real post-login screen). Editing a task now invalidates its cached plan.

## 0.13.0 – 0.14.x
- **`run --summary`** — post-run AI debrief quoting concrete observed values
  (prices, messages), off by default; collapsed block in the HTML report.
- **Secure test credentials** — `windup secret set/list`; values live in
  `.env.local`/CI secrets, the account→ENV mapping in committed
  `windup.credentials.json`; `windup new` auto-registers and scrubs credentials.

## 0.12.0
- **HTML reporter** — `run --reporter html`, a self-contained page (no JS/deps).

## 0.11.0
- **`windup new`** — LLM-assisted scenario authoring grounded in the site map
  and project manifest; suggests `depends_on` from existing scenarios.

## 0.10.0
- **Multi-provider LLM** — Google Gemini and OpenAI (plain REST), selectable per
  run with `--llm provider[:model]`; per-provider cost breakdown in `windup costs`.

## 0.9.0
- CI/CD reporters (JUnit/JSON), `run --all`, environment-portable start URLs
  (`--base-url` / `WINDUP_BASE_URL`, path-keyed cache).

## 0.6.0 – 0.8.x
- Engine migrated to Playwright (trusted input events, warm browser pool);
  `windup scan` (Next.js + react-router indexers with LLM-assist); trajectory
  fragments; auto-provisioned Chromium.

## 0.1.0 – 0.5.0
- First installable package: natural-language scenarios → LLM plan → deterministic
  execution → cheap verification → trajectory cache → zero-LLM replays. Page
  signatures, site map, project manifest, `windup costs`, vitest adapter.

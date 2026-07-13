# Windup — Living Specification

**Status:** implemented (describes the system as shipped in `windupjs@0.9.x`) · **Supersedes:** [SPEC-001](spec-001-evolucao-pos-spike.md) and [SPEC-002](spec-002-cli-e-indexacao.md) (Portuguese, historical — fully implemented; measured results in `RESULTADO-tranche-{1,2,3}.md` and `../spike/RESULTADO.md`).

## 1. Thesis

Browser E2E tests can use an LLM **only for planning** (and re-planning on failure), with deterministic execution and cheap verification — so repeated runs make **zero LLM calls**. Validated end-to-end: first run plans in seconds for fractions of a cent; replays take ~0.5–1s and cost $0.

## 2. Principles

1. **The LLM is the exception, not the rule.** One call per cache miss; replays never call it.
2. **Zero hardcoded site knowledge.** The engine may know *frameworks* (Next.js, react-router, design-system naming conventions) and the web platform — never a specific site. All site knowledge arrives as input (scenario, config, manifest) or is discovered at runtime. Conformance check: `git grep -i "<any-site-name>" src/` must return nothing.
3. **Every execution is also collection.** The executor already visits every page of a flow; persisting what it sees costs ~one `evaluate` per action.
4. **Knowledge is cache, not truth.** Anything the site map or static scan asserts can be stale; it degrades to runtime discovery and is corrected by observation. Precedence: `execution > static > llm`.
5. **Cost never surprises.** Every LLM touchpoint has an explicit cap; every call is recorded in a ledger (`windup costs`); repeated static/assist work is memoized.
6. **Plans are data, not programs.** No conditionals, no loops, no free-form code. If a flow needs branching, split the scenario.

## 3. Architecture

```
scenario (natural language, versioned)
        │
        ▼                      site map (graph) ◀── windup scan (static + LLM-assist)
   ┌─ runner ─────────────────────────┐▲
   │ cache lookup (path-keyed)        ││ passive collection (every run)
   │   miss → planner (LLM, 1 call)   ││
   │   hit  → cached plan (rebased)   ││
   │        → executor (deterministic)┼┘
   │        → verifier (postconditions)│──▶ failure: invalidate → re-plan
   │        → cache save + run ledger │
   └──────────────────────────────────┘
```

Module boundaries (all in `packages/windup/src/`):

| Module | Responsibility |
|---|---|
| `browser.ts` | **Single engine boundary** (Playwright since 0.6). Sessions = fresh `BrowserContext` on a lazy per-process Chromium singleton (E5 pool: `--repeat`/`--all`/bench pay the launch once; warm-replay p50 ≈ 415ms). Trusted clicks with native actionability. `ariaSnapshot()` (YAML) feeds the planner. Swapping engines has twice been a one-file change — keep it that way. |
| `llm.ts` | **Multi-provider LLM boundary.** One `LlmClient` interface (prompt + schema + budget in, text + tokens + truncated out); implementations for Google Gemini (SDK, `responseSchema`, thinking off) and OpenAI (plain REST — no SDK dependency; JSON mode + schema-in-prompt; `reasoning_effort: minimal` for reasoning models, `temperature`/`seed` for classic ones; configurable `baseUrl` covers any OpenAI-compatible endpoint). Several providers configured simultaneously (`llm.providers` with per-provider default model and `apiKeyEnv`); selection per run: `--llm provider[:model]` flag → `WINDUP_LLM` env → legacy `LLM_MODEL` → config `llm.provider`+`llm.model`. Switching providers never touches the plan cache — plans are data. |
| `planner.ts` | **Planning logic** (provider-agnostic, calls `llm.ts`). Prompt = task + initial-page a11y tree + real interactive elements + site-map slice + fragment catalog + project manifest + scenario hints. Structured output (`responseSchema`), thinking off, temp 0.3. Two retry levels: *semantic* (invalid plan → 1 retry, short prompt with plan+errors) and *transient* (model degeneration/network → up to 3 re-calls with varied seeds). Output is sanitized (empty/`"undefined"` fields, per-type field pruning, id renumbering, `wait_for`⇄`expect` normalization) then validated (Ajv full schema + semantic rules + `value_ref` allow-list). Records provider+model into the plan's `generated_by` and the run ledger. |
| `executor.ts` | Deterministic loop: goto → per action (gate on visibility → act → verify postcondition). `SLOWMO_MS` demo pacing. Emits passive site-map observations. |
| `verifier.ts` | Postconditions, all LLM-free: `expect.selector` (visible), `expect.url` (glob or bare path vs pathname), `expect.selector_value`. Polling to `timeout_ms`, frame-safe waits. |
| `cache.ts` | Trajectory cache in `.windup/cache/trajetorias/`. Hit key: `scenario_id` + start-URL **path** (environment-portable) + versions + `status: active`. Save only after full verified execution. Failure in replay → entry renamed `*.stale-<ts>.json` (evidence, max 3) → full re-plan → stats accumulate (`plan_generation` flags unstable scenarios). Lenient signature check: `start_sig` mismatch warns (`sig_mismatch` metric), never blocks. |
| `signature.ts` | Structural page identity (E1): interactive elements (tag/id/name/data-test/type), normalized, deduped, sorted, SHA-256 → `sig:<16hex>`. Never uses the a11y tree or text (environment/data variance). |
| `sitemap.ts` | Page/transition graph (`.windup/map/site-map.json`, atomic writes, JSON behind a `SiteMapStore` interface — SQLite deliberately deferred until scale demands). Nodes carry `source: execution|static|llm`, staleness, per-file provenance. Prompt slice: BFS (depth ≤ 3) from the current page over executed transitions, term-scored, then static and llm tiers fill remaining budget for uncovered URLs. Budgets: map ≤ 8k chars inside a ~32k-char combined context. |
| `scan/` | Project indexing. Layer 1: routes by convention/declaration (Next.js app+pages router; react-router JSX/object/lazy/v7 helpers/flat-file, wrapper-aware element resolution). Layer 2: interactive elements by brace-aware JSX parsing — raw tags **and** design-system components (Button/Input/Link/Label…, ecosystem naming conventions), harvesting id/name/data-test/type/aria/placeholder/`href`/`htmlFor`. Anti-inheritance: files declaring >2 routes never have imports expanded. Layer 3 (LLM-assist): heuristically selected unresolved files, hard `maxCalls` cap, per-file-hash memory (unchanged files are free forever), results marked `source: "llm"`, only kept when they add elements to an uncovered URL. Full scans reconcile: static nodes of removed routes and stale/duplicate llm nodes are pruned. `--update`: incremental via `git diff` since the recorded scan SHA; changed sources mark execution knowledge of the same URL stale until re-observed. |
| `fragments.ts` | Reusable tested sub-trajectories (E3), committed in `e2e/fragments/`. Plans reference `{ "type": "use", "use": "<id>" }`; the cache stores the *reference* (fragment updates propagate; orphaned references invalidate and re-plan). Expansion inline at run time, depth 1, ids renumbered. The planner sees only the catalog (id + description + postcondition), never the actions. Created via `windup fragment extract <scenario> <a1..aN>`. |
| `metrics.ts` / `costs.ts` | Every run writes `.windup/runs/<ts>-<scenario>.json` (tokens, calls, model, per-action timing, executed plan, failure classification `network|verification|plan_invalid`). Prices are a dated per-model table; reports recompute from tokens so history stays correct. Scan LLM spend is recorded as `scan-*.json` in the same ledger. `windup costs` aggregates: totals, free replays, scans, **per-provider** (records without `llm_provider` are inferred from the model name), per-model, per-scenario, last N — alternating between LLM vendors keeps per-vendor spend visible. |
| `reporters.ts` | Session reports for CI: JUnit XML and JSON via `run --reporter`, non-zero exit on failure. |
| `start-url.ts` | Environment resolution: `--base-url`/`WINDUP_BASE_URL` (rebases even absolute scenario URLs, preserving path+query) → config `baseUrl` → scenario absolute URL. `start_url` optional (default `/`). Replays rebase the cached plan's start URL to the current environment. |
| `env.ts` | `.env.local` then `.env` (local wins; process env never overridden) for CLI and the vitest adapter. |
| `adapters/vitest.ts` | `windupSuite()` (one native test per scenario) and `windupTest(id)` — jest-compatible contract; shares the warm engine, shuts it down in `afterAll`. |
| `ensure-browser.ts` / `postinstall.ts` | Zero-friction provisioning: `npm i` downloads Chromium only (playwright-core, no Firefox/WebKit), lazy retry on first launch covers `--ignore-scripts`, opt-outs `CHROME_PATH` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`. |

## 4. Data formats

**Action plan** (`plan_version: "0.1"`): `{ plan_version, scenario_id, task, start_url, generated_by, actions[] }`; action = `{ id: aN, type: goto|click|fill|wait_for|use, target?: {selector, description}, value? | value_ref? ("ENV:VAR", runtime-resolved, never persisted resolved), url?, use?, expect?: {selector?, url?, selector_value?}, timeout_ms }`. Semantic rules: click/fill/wait_for require `target.selector`; fill requires exactly one of value/value_ref; `value_ref` must be mentioned by task/hints/manifest (no invented ENV names); the final action must carry `expect` (or be a `use`, whose fragment carries its own postcondition). Two schema variants exist by necessity: a relaxed one for Gemini's `responseSchema` (no `const`/`pattern`/`maxItems`) and the full JSON Schema for local Ajv validation — **Ajv is the authority**.

**Cache entry** (`cache_version: "0.2"`): `{ key: {scenario_id, start_url(path), start_sig?}, plan, status: active|stale, stats: {created_at, last_replayed_at, replay_count, replay_failures, plan_generation} }`.

**Site map** (`map_version: "0.1"`): `{ last_scan_sha, pages: {sig → {urls_seen, url_pattern, title, interactive[], source, first/last_seen, seen_count, files?, stale?}}, transitions: [{from, action, to, seen_count}], assist_seen: {file → contentHash} }`.

## 5. Model & cost posture

Default planner model: **`gemini-3.1-flash-lite`** (measured: 1 clean call/generation, ~3–4s, ≈ $0.0025/generation; selected by A/B against 3.5-flash which degenerates and costs ~34×). Known pathology handled defensively: flash-family structured output can degenerate into token loops (non-deterministic per prompt content) — mitigated by transient retries with varied seeds, `maxOutputTokens` caps, short semantic-retry prompts, and near-constant prompt size budgets. Provider-agnostic since 0.10: Google Gemini and OpenAI ship in-box behind the `llm.ts` boundary, several providers can be configured at once, and any run/bench/scan picks one with `--llm provider[:model]` (`WINDUP_LLM` in CI). Every ledger record carries provider+model; prices are a flat per-model table (model names are globally unique). Adding a vendor = one client implementation in `llm.ts`.

## 6. Known limitations / debts

- Nested react-router relative paths are collected best-effort (flat, not joined) — corrected by execution observations.
- Scan is single-package aware; monorepos are detected and warned, per-app indexes are future work.
- Dynamic crawl (SPEC-002 optional layer) not built — executions feed the map instead.
- No daemon between CLI invocations (deliberate); warm pool is per-process. Revisit only if p50 regresses.
- `page_signature` ids that encode data (`#add-to-cart-<product>`) split page states into distinct nodes — in practice this documents state variants, but it is unmeasured on data-heavy catalogs.
- Fragment auto-detection (common prefixes) not built; extraction is manual.

## 7. Verification

- `npm test` (packages/windup): ~97 unit/integration tests, LLM-hermetic (fakes; adapter seeds a known-good plan). CI runs them with real Chromium on Ubuntu.
- `windup bench <scenario>`: the original validation protocol — 5 generations (C1 ≥ 4/5 valid), 10 replays (C2 10/10 with `llm_calls=0`), replay ≥ 5× faster (C3), $0 replay (C4), break-a-selector recovery (C5). Green on the Playwright engine.
- Real-project dogfood: react-router app with 106 routes — scan populates ~100 route nodes with clean elements; first real scenario planned with map-sourced selectors and replays at ~0.5s/$0; plan cache proven portable across ports/environments.

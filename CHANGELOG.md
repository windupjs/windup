# Changelog

All notable changes to `windupjs` are documented here. The project is in the
`0.x` line (pre-1.0): it is usable and tested, but the API may still change
between minor versions. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

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

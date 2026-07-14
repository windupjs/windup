# Changelog

All notable changes to `windupjs` are documented here. The project is in the
`0.x` line (pre-1.0): it is usable and tested, but the API may still change
between minor versions. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

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

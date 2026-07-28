<div align="center">

<img src="assets/brand/windup-logo-lockup.png" width="620" alt="Windup — the wind-up testing robot" />

# Windup

**Natural-language E2E tests with deterministic replay.**

*The LLM plans once — every replay runs without it: ~1 second, $0, stable.*

[![npm version](https://img.shields.io/npm/v/windupjs?color=b8860b&label=windupjs)](https://www.npmjs.com/package/windupjs)
[![node](https://img.shields.io/node/v/windupjs?color=339933)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/windupjs/windup/actions/workflows/ci.yml/badge.svg)](https://github.com/windupjs/windup/actions/workflows/ci.yml)
[![engine: Playwright](https://img.shields.io/badge/engine-Playwright-2EAD33)](https://playwright.dev)

[windup.run](https://windup.run) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Why Windup](#why-windup) · [User docs](packages/windup/README.md) · [Specification](docs/specs/SPEC.md)

</div>

<p align="center">
  <img src="assets/windup-demo.gif" width="820" alt="Windup demo: a plain-English test runs once with the LLM, then replays deterministically with zero LLM calls and $0" />
</p>

---

Write the test the way you'd explain it to a person:

```json
{
  "scenario_id": "checkout",
  "task": "Log in as the qa account, add 'Backpack' to the cart, check out and verify the order confirmation message appears."
}
```

Windup turns it into a schema-validated JSON plan of browser actions, executes it deterministically, and verifies DOM/URL postconditions after every step. The plan is cached — from the second run on, the test replays **with zero LLM calls**. When your app changes and a verification fails, the plan is invalidated and re-planned automatically.

## Quickstart

```bash
npm i -D windupjs        # Chromium provisioned automatically
npx windup init          # 3 questions → windup.config.ts
npx windup scan          # index your app's routes & elements from source

# author a test — describe it…
npx windup new "log in as admin and create an invoice"   # LLM-assisted authoring
# …or demonstrate it:
npx windup record --url http://localhost:3000            # click the flow, mark a check, done

npx windup run checkout  # 1st run: the LLM plans · after that: ~1s replay, $0
```

Requirements: Node ≥ 20 and a `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local` or `.env`. Full documentation — commands, config, CI reporters, environments, the vitest adapter — lives in [`packages/windup/README.md`](packages/windup/README.md) and at [windup.run/docs](https://windup.run/docs).

## How it works

```
natural-language task ──▶ planner (LLM, 1 call) ──▶ JSON action plan
                                                        │
       trajectory cache ◀── cheap verification ◀── deterministic executor
             │
             └──▶ subsequent runs: zero LLM, ~1s, $0
```

- **Plans are data, not code** — schema-validated JSON; no generated scripts, no conditionals, no "agent improvisation" at run time.
- **Cheap verification** — DOM/URL postconditions after every action. A failed verification invalidates the cached plan and triggers an automatic re-plan (self-healing).
- **Zero hardcoded site knowledge** — the engine knows frameworks and the web platform, never *your* site; everything about your app enters via the site map, scenarios and config.
- **Commit the plan cache → $0 CI with no LLM.** `windup init` versions `.windup/cache/` (plans) and `.windup/map/` (site map); plans are portable and secret-free, so a committed cache replays every scenario in CI **with no LLM and no CLI**.

## Why Windup

|  | Hand-written scripts | AI agent per run | **Windup** |
|---|---|---|---|
| Authoring | code + selectors by hand | plain language | plain language |
| Run cost | $0 | LLM on **every** run | LLM on **first** run only |
| Run speed | fast | slow (model in the loop) | ~1s replay |
| Determinism | high | low — improvises each time | high — same plan every replay |
| App changed | you fix the script | may silently do something else | verification fails → auto re-plan |

## Features

**Authoring**
- **`windup new`** — describe a flow in one line; the LLM writes a precise, verifiable scenario grounded in your app's real screens (site map) and accounts (manifest). `--validate` runs and refines it until it passes.
- **`windup record`** — author by *demonstration*: drive a headful browser, mark what to verify with a floating toolbar, finish. Windup writes the scenario **and** caches the recorded plan (a $0 replay). A typed password never enters the plan (it becomes an `ENV` `value_ref`).
- **`windup scan`** — index your routes and elements straight from source (Next.js, react-router, TanStack Router). **Fragments** let the planner compose proven blocks (e.g. login) instead of regenerating.

**Determinism & realism**
- **Request stubbing (`config.network`)** — force a 500, an empty list, or a dropped call, per run and per scenario, without touching the backend.
- **Frozen clock (`config.clock`)** — pin `now`/timezone for date-dependent tests. **Device emulation (`--device`)** — run at an `iPhone 14`/`Pixel 7` viewport, with the cache keyed per device.
- **Richer assertions** — `text_contains`, element `count`, `not_visible`, `attribute` — not just "a selector exists". **Dynamic values (`config.resolve`)** — OTP/magic-link fetched at run time; **`seed`** injects client-side state; **session snapshots** restore auth so a login flow isn't re-run per dependent.

**CI & guard-rails**
- **Reporters** — JUnit, JSON and a self-contained HTML report; non-zero exit on failure; **`--changed`/`--since`** incremental runs, **`--shard`**, **`--tag`**, **`--github`** annotations.
- **Resilience** — **`--retries`** (surface flakes, never swallow them), **`--max-wall`** time budget, **`--bail`**, and per-scenario **`quarantine`** (runs and reports without failing the build).
- **Runtime health gates** — fail a run that threw a JS error, failed to load a resource, or got a silent 5xx (`--fail-on-console`/`--fail-on-resource`/`--fail-on-5xx`). **Performance budgets** — `--web-vitals` captures TTFB/FCP/LCP/CLS and fails on a `config.budgets` breach.
- **Safety denylist (`config.forbid`)** — abort before a run touches a forbidden selector/URL (change-password, delete). Secrets never reach the LLM, cache, scenarios or git.

**Diagnostics** — `windup trends` (per-scenario pass-rate history), `why`/`explain`/`diff`, `badge`, `coverage` (routes with no test), `suggest-scenarios` (LLM drafts one per uncovered route), `costs` (AI spend), `doctor` (preflight), `--a11y` (free axe-core audit).

**Portable** — start URLs resolve per environment (`--base-url`); bring your LLM (Google Gemini + OpenAI, several configured, picked per run with `--llm`); cross-browser (`--browser firefox|webkit`); a vitest/jest adapter.

## Repository layout

| Path | Contents |
|---|---|
| [`packages/windup/`](packages/windup/) | The product: npm package [`windupjs`](https://www.npmjs.com/package/windupjs) (bin `windup` + programmatic API + vitest adapter) |
| [`docs/specs/SPEC.md`](docs/specs/SPEC.md) | **Living specification** (English): architecture, data formats, principles, limitations |
| [`docs/specs/`](docs/specs/) | Historical specs and measured results per delivery tranche |
| [`docs/spike/`](docs/spike/) | The validation spike that proved the architecture — evidence frozen at tag `spike-validada` |
| [`spike/`](spike/) | Spike code (frozen; does not evolve) |

## Status

**Stable (`1.x`)** — the public CLI and programmatic API are committed to under semver; breaking changes wait for a major bump. All planned phases (SPEC-001 E1–E5, SPEC-002 P1–P5) implemented and measured. **Replay reliability: 60/60 cached replays passed with zero flakes and `llm_calls=0`** across four scenarios (login, multi-step checkout, add/remove, a second site), 15 replays each. Plan generation ≥ 4/5 first-try without hints; automatic recovery from broken selectors. Engine: Playwright (trusted input events). Planner LLMs: Google Gemini and OpenAI, selectable per run; default `gemini-3.1-flash-lite` (~$0.0025/generation). Dogfooded on a real 106-route production app. CI on every push.

## Security

Page content is fed to the LLM as untrusted data; plans are schema-validated and executed deterministically. Credentials never reach the LLM, cache or scenarios. Full threat model and reporting: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

<div align="center">

Built by **[Orbital Tecnologia](https://orbitaldev.com.br)** — developed by **Kallef** ([@prhost](https://github.com/prhost))

</div>

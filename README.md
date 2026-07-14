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
npx windup new "log in as admin and create an invoice"   # LLM-assisted authoring
npx windup run checkout  # 1st run: the LLM plans · after that: ~1s replay, $0
```

Requirements: Node ≥ 20 and a `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local` or `.env`. Full documentation — commands, config, CI reporters, environments, the vitest adapter — lives in [`packages/windup/README.md`](packages/windup/README.md).

## How it works

```
natural-language task ──▶ planner (LLM, 1 call) ──▶ JSON action plan
                                                        │
       trajectory cache ◀── cheap verification ◀── deterministic executor
             │
             └──▶ subsequent runs: zero LLM, ~1s, $0
```

- **Plans are data, not code** — schema-validated JSON; no generated scripts, no conditionals, no flaky "agent improvisation" at run time.
- **Cheap verification** — DOM/URL postconditions after every action. A failed verification invalidates the cached plan and triggers an automatic re-plan.
- **Site map** — every execution feeds a graph of pages and transitions; `windup scan` seeds it straight from your source code (Next.js, react-router), so the planner uses your app's *real* selectors instead of guessing.
- **Fragments** — proven action blocks (e.g. login) the planner composes instead of regenerating.
- **Environment-portable** — start URLs resolve per environment (`--base-url` / `WINDUP_BASE_URL`); the plan cache is keyed by path, so plans generated on `localhost` replay on staging and CI for free.
- **CI-ready** — `windup run --all --reporter junit`, non-zero exit on failure, AI-spend ledger via `windup costs`.
- **Assisted authoring** — `windup new "rough instruction"` turns a one-liner into a precise, verifiable scenario grounded in your app's real screens (site map) and accounts (manifest) — a file you review and commit.
- **Bring your LLM** — Google Gemini and OpenAI in-box, several configured at once, picked per run (`--llm openai:gpt-5-mini`); spend tracked per provider and model.
- **Zero hardcoded site knowledge** — the engine knows frameworks and the web platform, never *your* site.

## Why Windup

|  | Hand-written scripts | AI agent per run | **Windup** |
|---|---|---|---|
| Authoring | code + selectors by hand | plain language | plain language |
| Run cost | $0 | LLM on **every** run | LLM on **first** run only |
| Run speed | fast | slow (model in the loop) | ~1s replay |
| Determinism | high | low — improvises each time | high — same plan every replay |
| App changed | you fix the script | may silently do something else | verification fails → auto re-plan |

## Repository layout

| Path | Contents |
|---|---|
| [`packages/windup/`](packages/windup/) | The product: npm package [`windupjs`](https://www.npmjs.com/package/windupjs) (bin `windup` + programmatic API + vitest adapter) |
| [`docs/specs/SPEC.md`](docs/specs/SPEC.md) | **Living specification** (English): architecture, data formats, principles, limitations |
| [`docs/specs/`](docs/specs/) | Historical specs and measured results per delivery tranche |
| [`docs/spike/`](docs/spike/) | The validation spike that proved the architecture — evidence frozen at tag `spike-validada` |
| [`spike/`](spike/) | Spike code (frozen; does not evolve) |

## Status

**Beta (`0.x`)** — usable and tested; the API may still change between minor versions. All planned phases (SPEC-001 E1–E5, SPEC-002 P1–P5) implemented and measured. **Replay reliability: 60/60 cached replays passed with zero flakes and `llm_calls=0`** across four scenarios (login, multi-step checkout, add/remove, a second site), 15 replays each. Plan generation ≥ 4/5 first-try without hints; automatic recovery from broken selectors. Engine: Playwright (trusted input events). Planner LLMs: Google Gemini and OpenAI, selectable per run; default `gemini-3.1-flash-lite` (~$0.0025/generation). Dogfooded on a real 106-route production app. CI on every push.

## Security

Page content is fed to the LLM as untrusted data; plans are schema-validated and executed deterministically. Credentials never reach the LLM, cache or scenarios. Full threat model and reporting: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

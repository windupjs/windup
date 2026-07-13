# Windup 🥁🦆

**Natural-language E2E tests with deterministic replay — the LLM plans once, replays run without it.**

Wind it up once — describe the test in plain language ("log in, add the product to the cart, check out and verify the confirmation") — and Windup turns it into a deterministic plan of browser actions. From the second run on, the test runs **without a single LLM call**: ~1 second, $0, stable.

```bash
npm i -D windupjs        # Chromium provisioned automatically
npx windup init          # 3 questions → windup.config.ts
npx windup scan          # index your app's routes from source (Next.js, react-router)
npx windup run checkout  # 1st run: the LLM plans · after that: ~1s replay, $0
```

Full user documentation: [`packages/windup/README.md`](packages/windup/README.md) (also on [npm](https://www.npmjs.com/package/windupjs)).

## How it works

```
natural-language task ──▶ planner (LLM, 1 call) ──▶ JSON action plan
                                                        │
       trajectory cache ◀── cheap verification ◀── deterministic executor
             │
             └──▶ subsequent runs: zero LLM, ~1s, $0
```

- **Plans are data, not code** — schema-validated JSON, no generated scripts.
- **Cheap verification** — DOM/URL postconditions after every action; a failure invalidates the cached plan and re-plans automatically.
- **Site map** — every execution feeds a graph of pages/transitions, and `windup scan` seeds it from your source code before the first run.
- **Fragments** — tested action blocks (e.g. login) the planner composes instead of regenerating.
- **Environment-portable** — start URLs resolve per environment (`--base-url`/`WINDUP_BASE_URL`); the plan cache is keyed by path, so dev-generated plans replay on staging/CI for free.
- **Zero hardcoded site knowledge** — the engine knows frameworks and the web, never *your* site.

## Repository layout

| Path | Contents |
|---|---|
| [`packages/windup/`](packages/windup/) | The product: npm package `windupjs` (bin `windup` + programmatic API + vitest adapter) |
| [`docs/specs/SPEC.md`](docs/specs/SPEC.md) | **Living specification** (English): architecture, data formats, principles, limitations |
| [`docs/specs/`](docs/specs/) | Historical specs and measured results per delivery tranche (Portuguese) |
| [`docs/spike/`](docs/spike/) | The validation spike that proved the architecture — evidence frozen at tag `spike-validada` |
| [`spike/`](spike/) | Spike code (frozen; does not evolve) |

## Status

All planned phases (SPEC-001 E1–E5, SPEC-002 P1–P5) implemented and measured. Benchmarked: plan generation ≥ 4/5 first-try without hints, replay 10/10 with `llm_calls=0`, automatic recovery from broken selectors. Engine: Playwright (trusted input events). Default planner model: `gemini-3.1-flash-lite` (~$0.0025/generation). Dogfooded on a real 106-route production app. CI on every push.

## License

[MIT](LICENSE)

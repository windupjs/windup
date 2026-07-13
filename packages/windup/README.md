# Windup 🥁🦆

**Natural-language E2E tests with deterministic replay — the LLM plans once, replays run without it.**

Describe a test in plain language — *"log in as the test account, add product X to the cart, check out and verify the order confirmation"* — and Windup turns it into a deterministic JSON plan of browser actions. From the second run on, the test replays **with zero LLM calls**: ~1 second, $0, stable results.

```bash
npm i -D windupjs        # Chromium is provisioned automatically (one-time, machine-wide cache)
npx windup init          # 3 questions → windup.config.ts + example scenario
npx windup scan          # index your app's routes & elements from source code
npx windup run checkout  # 1st run: the LLM plans · every run after: ~1s replay, $0
```

Requirements: Node ≥ 20 and a `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local` or `.env` (`.env.local` wins — use it when your `.env` is committed). The key is only used for planning; cached replays never call an LLM. To use an existing Chrome instead of the auto-downloaded Chromium, set `CHROME_PATH`; to skip the download entirely, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.

## How it works

```
natural-language task ──▶ planner (LLM, 1 call) ──▶ JSON action plan
                                                        │
       trajectory cache ◀── cheap verification ◀── deterministic executor
             │
             └──▶ subsequent runs: zero LLM, ~1s, $0
```

- **Plans are data, not code** — schema-validated JSON; no generated scripts, no conditionals.
- **Cheap verification** — DOM/URL postconditions after every action. A failed verification invalidates the cached plan and triggers an automatic re-plan.
- **Site map** — every execution feeds a graph of pages and transitions; `windup scan` seeds that graph straight from your source code before the first run, so the planner uses your app's *real* selectors instead of guessing.
- **Fragments** — proven action blocks (e.g. login) that the planner composes via `{ "type": "use" }` instead of regenerating.
- **Zero hardcoded site knowledge** — the engine knows frameworks and the web, never *your* site. All site knowledge arrives as input (scenarios, config, manifest) or is discovered at runtime.

## Scenarios

A scenario is a JSON file in your scenarios directory (default `e2e/scenarios/`):

```json
{
  "scenario_id": "checkout",
  "start_url": "/",
  "task": "Log in as the qa account, add 'Backpack' to the cart, check out and verify the order confirmation message appears.",
  "hints": ["Optional site-specific tips for the planner. Delete if not needed."]
}
```

- `start_url` is **optional** (defaults to `/`) and should stay environment-free: a path, resolved against the effective base URL.
- End the task with **what to verify** — that becomes the plan's final postcondition.
- Never put secrets in tasks. Reference accounts from the project manifest (below); the plan will use `value_ref: "ENV:VAR"` and the real value is resolved only at runtime, never cached.

## Environments (dev / staging / CI)

The start URL origin comes from, in precedence order: `--base-url` flag → `WINDUP_BASE_URL` env → `baseUrl` in `windup.config.ts` → an absolute `start_url` in the scenario. An explicit override rebases even absolute scenario URLs (path and query are preserved).

The plan cache is **environment-portable**: cache identity uses the start URL *path*, not host/port. A plan generated against `localhost:8080` replays on staging or CI with zero LLM calls.

```bash
npx windup run checkout --base-url https://staging.example.com
WINDUP_BASE_URL=http://localhost:8080 npx windup run --all
```

## CI/CD

```bash
npx windup run --all --reporter junit --report-file reports/windup.xml
```

- `--all` runs every scenario in the directory (one warm browser for the whole suite).
- Exit code is non-zero when any scenario fails.
- `--reporter junit` emits JUnit XML (GitHub Actions, GitLab and Jenkins consume it natively); `--reporter json` emits a machine-readable summary. Default output: `.windup/reports/`.
- `windup costs --json` reports AI spend for pipeline tracking.

Example GitHub Actions step:

```yaml
- run: npm ci && npx playwright install chromium
- run: npx windup run --all --base-url http://localhost:8080 --reporter junit --report-file reports/windup.xml
  env:
    GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GEMINI_KEY }}
- uses: dorny/test-reporter@v1
  if: always()
  with: { name: windup, path: reports/windup.xml, reporter: java-junit }
```

## Commands

| Command | Description |
|---|---|
| `windup init` | Create `windup.config.ts`, `.windup/` (gitignored) and an example scenario |
| `windup run [scenario]` | Run one scenario (replay when cached, plan on miss) |
| `windup run --all` | Run every scenario — CI mode |
| `windup scan [--update] [--no-assist]` | Statically index routes and interactive elements into the site map; `--update` re-indexes only files changed since the last scan (git diff); `--no-assist` skips the LLM layer (zero cost) |
| `windup costs [--last n] [--days n] [--json]` | AI usage report from the run ledger: totals, free replays, per-model and per-scenario breakdown, scan spend |
| `windup status` | Site-map pages by source, staleness, cached scenarios, fragments |
| `windup fragment extract <scenario> <a1..aN> --id <id> --description <text>` | Promote a slice of a cached plan to a reusable fragment |
| `windup sig <url> [--repeat n]` | Structural page signature (diagnostics) |
| `windup bench <scenario>` | Full validation protocol (generation, replay determinism, failure recovery) |
| `windup cache clear` | Drop the trajectory cache (next runs re-plan) |

**`run` flags:** `--all` · `--no-cache` · `--no-map` · `--repeat <n>` · `--headed` (show the browser) · `--slowmo <ms>` (demo pace) · `--base-url <url>` · `--reporter junit|json` · `--report-file <path>`

## Configuration (`windup.config.ts`)

```ts
import { defineConfig } from "windupjs";

export default defineConfig({
  baseUrl: "http://localhost:3000",
  llm: { provider: "google", model: "gemini-3.1-flash-lite" },
  scenarios: "e2e/scenarios",
  framework: "react-router",          // detected by init; used by scan
  scan: {
    llmAssist: { enabled: true, maxCalls: 20 },   // hard cost cap per scan
  },
  // Project manifest: team-provided knowledge injected into the planner prompt.
  context: {
    conventions: ["every interactive element has a data-testid"],
    credentials: {
      qa: { user: "ENV:QA_USER", password: "ENV:QA_PASSWORD" },
    },
    vocabulary: { "order": "the Order entity, screen /orders" },
  },
});
```

- **`context.credentials`** maps account names to ENV references. When a task mentions the account, the plan uses `value_ref` — manifest credentials take precedence even if the page displays values, and the planner is forbidden from inventing ENV names.
- **LLM-assist** (scan layer 3) reads files the static layers couldn't resolve (dynamically built routes, indirect components), capped by `maxCalls`. Results are remembered per file hash — unchanged files never cost again. Costs are recorded in the ledger and shown by `windup costs`.

## Programmatic API & test runners

```ts
import { run } from "windupjs";
const result = await run("checkout");   // RunMetrics: result, llm_calls, cost, per-action timing
```

```ts
// e2e/windup.test.ts — vitest (jest-compatible contract)
import { windupSuite } from "windupjs/vitest";
await windupSuite();                    // one native test per scenario
```

## What lives where

| Path | Contents | Commit? |
|---|---|---|
| `windup.config.ts` | Configuration | ✅ |
| `e2e/scenarios/*.json` | Your tests, in natural language | ✅ |
| `e2e/fragments/*.json` | Curated reusable blocks | ✅ |
| `.windup/` | Derived state: plan cache, run ledger, site map, reports | ❌ (init adds it to `.gitignore`) |

## License

MIT

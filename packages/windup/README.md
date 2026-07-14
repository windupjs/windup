# Windup 🤖

**Natural-language E2E tests with deterministic replay — the LLM plans once, replays run without it.**

**[windup.run](https://windup.run)** · [npm](https://www.npmjs.com/package/windupjs)

![Windup demo: a plain-English test runs once with the LLM, then replays deterministically with zero LLM calls and $0](https://raw.githubusercontent.com/windupjs/windup/main/assets/windup-demo.gif)

Describe a test in plain language — *"log in as the test account, add product X to the cart, check out and verify the order confirmation"* — and Windup turns it into a deterministic JSON plan of browser actions. From the second run on, the test replays **with zero LLM calls**: ~1 second, $0, stable results.

```bash
npm i -D windupjs        # Chromium is provisioned automatically (one-time, machine-wide cache)
npx windup init          # 3 questions → windup.config.ts + example scenario
npx windup scan          # index your app's routes & elements from source code
npx windup new "log in as admin and create an invoice"   # LLM-assisted scenario authoring
npx windup run checkout  # 1st run: the LLM plans · every run after: ~1s replay, $0
```

Requirements: Node ≥ 20 and an API key for your planner LLM in `.env.local` or `.env` (`.env.local` wins — use it when your `.env` is committed): `GOOGLE_GENERATIVE_AI_API_KEY` for Google (default) or `OPENAI_API_KEY` for OpenAI. Keys are only used for planning; cached replays never call an LLM. To use an existing Chrome instead of the auto-downloaded Chromium, set `CHROME_PATH`; to skip the download entirely, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.

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

## A five-minute tour

The full workflow on a fresh project, with what you should expect to see:

```bash
# 1. Install — Chromium is provisioned automatically
npm i -D windupjs

# 2. Initialize — 3 questions (base URL, model, scenarios dir)
npx windup init
#    → windup.config.ts + e2e/scenarios/ + .windup/ (gitignored)

# 3. Index your app from source — before anything ever runs
npx windup scan
#    scan complete (full): framework=react-router routes=106 elements=1125
#    The site map now knows your real routes and selectors; the planner
#    will use them instead of guessing. Re-run after big changes
#    (windup scan --update re-indexes only files changed since, via git).

# 4. Register test credentials once — values never touch git
npx windup secret set admin        # hidden prompts → .env.local + mapping

# 5. Author a scenario from a rough instruction
npx windup new "log in with the admin account and create an invoice for ACME"
#    → e2e/scenarios/create-invoice-acme.json — precise task grounded in
#      your real screens, account referenced by name, final verification

# 6. First run — the LLM plans once (~3s, ~$0.002)
npx windup run create-invoice-acme
#    PASS  create-invoice-acme  cache=miss llm_calls=1 ... cost=$0.0024

# 7. Every run after — deterministic replay, zero LLM
npx windup run create-invoice-acme
#    PASS  create-invoice-acme  cache=hit llm_calls=0 total=600ms cost=$0

# 8. Read results like a human, ship reports to CI
npx windup run --all --summary --reporter html
npx windup costs                   # AI spend: totals, per provider/model
```

If a run fails after an app change, the cached plan is invalidated and re-planned automatically on the next run — you edit scenarios, not selectors.

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

### Scenario dependencies (`depends_on`)

Flows rarely start from zero — creating a bank account requires being logged in. Declare prerequisites and each scenario stays small, focused and individually cacheable:

```json
{
  "scenario_id": "create-bank-account",
  "depends_on": ["login"],
  "task": "Already on the dashboard, open Settings > Bank accounts, create an account named 'Inter' and verify it appears in the list."
}
```

- Dependencies run **in the same browser session**, in order, each with its own cache — a warm suite replays the whole chain with zero LLM calls.
- Without a `start_url`, the dependent scenario **continues from where the last dependency ended** — and on first planning the LLM sees that real page (the post-login dashboard), instead of planning blind.
- Chains work (`login` → `select-company` → `create-account`), cycles are rejected, and a failing dependency fails the run with kind `dependency` before the scenario itself starts.
- Each dependency keeps its own self-healing: if its cached plan breaks, it re-plans and re-caches — dependents benefit automatically.
- Editing a scenario's `task` now invalidates its cached plan (a rewritten test is a different test).

`windup new` handles dependencies both ways: `--depends-on login` declares them explicitly, and **the author LLM also suggests them on its own** — it sees every existing scenario (id + task) and, when the instruction presupposes a state one of them produces ("already logged in…"), emits `depends_on` automatically (mechanically filtered against real scenario ids — never invented). Either way the task is written from the dependency's final state, without repeating its steps.

### Authoring with `windup new`

You don't have to write detailed tasks by hand. Give `windup new` a rough instruction and the LLM acts as a test author — it rewrites it into a precise, verifiable scenario using the **site map** (real screens, menus and elements from `windup scan` and past runs) and the **project manifest** (accounts referenced by name, never literal credentials):

```bash
npx windup new "log in with the qa user, add the backpack to the cart and check out"
# → e2e/scenarios/purchase-backpack-qa.json — real screen names, concrete fake
#   form data, account referenced as "the qa account", explicit final verification
```

It generates the `scenario_id`, picks the `start_url` from known routes (falling back to `/` — it never invents paths), and adds selector hints from the map when they help. Add **`--validate`** to have it run the generated scenario and, if it fails, refine it from the failure and retry (up to 3 attempts) — you get back a scenario that *already passed once*, with a warm cache:

```bash
npx windup new "log in and create a cost center named Marketing" --validate
#   attempt 1: FAIL — element button:has-text('Save') not visible
#   attempt 2: PASSED
#   ✓ validated in 2 attempts — the plan is cached
``` **Credentials in the instruction never land in the scenario file**: they are auto-registered as a named account (values in `.env.local`, mapping in `windup.credentials.json`) and the task references the account — see Test credentials below. Flags: `--id <id>`, `--force` (overwrite), `--llm <provider[:model]>`. The output is a file for **you to review, edit and commit** — authoring is assisted, the test remains yours. One LLM call (~$0.001), recorded in the `windup costs` ledger under `authoring`.

## Test credentials

Credentials never live in scenario files, plans, the cache or git — only **references**. Values stay in `.env.local` (gitignored) or CI secrets; the account → ENV-name mapping lives in `windup.credentials.json` (committed — it contains no values) and is merged into the project manifest automatically.

```bash
npx windup secret set admin        # hidden interactive prompts → .env.local + mapping
npx windup secret list             # accounts + whether each ENV is set (never prints values)
```

Tasks then reference the account by name — *"log in with the admin account"* — and plans use `value_ref: "ENV:WINDUP_ADMIN_PASSWORD"`, resolved only at execution time. `windup new` does this automatically: credentials typed in the instruction are detected, registered, and scrubbed — the generated scenario mentions the account, never the values. In CI, define the same variable names as pipeline secrets.

## Environments (dev / staging / CI)

The start URL origin comes from, in precedence order: `--base-url` flag → `WINDUP_BASE_URL` env → `baseUrl` in `windup.config.ts` → an absolute `start_url` in the scenario. An explicit override rebases even absolute scenario URLs (path and query are preserved).

The plan cache is **environment-portable**: cache identity uses the start URL *path*, not host/port. A plan generated against `localhost:8080` replays on staging or CI with zero LLM calls.

```bash
npx windup run checkout --base-url https://staging.example.com
WINDUP_BASE_URL=http://localhost:8080 npx windup run --all
```

## LLM providers

The planner is provider-agnostic. Google Gemini and OpenAI are supported; configure several at once and pick one per run:

```ts
// windup.config.ts
llm: {
  provider: "google",                       // default for runs without --llm
  model: "gemini-3.1-flash-lite",
  providers: {
    openai: { model: "gpt-5-mini" },        // default model when --llm openai is used
    // openai: { apiKeyEnv: "MY_OPENAI_KEY", baseUrl: "https://my-proxy/v1" },
  },
},
```

```bash
npx windup run checkout                         # config default (google)
npx windup run checkout --llm openai            # provider default model (gpt-5-mini)
npx windup run checkout --llm openai:gpt-5-nano # explicit provider:model
WINDUP_LLM=openai:gpt-5-mini npx windup run --all   # same thing via env (CI)
```

- `--llm` works on `run`, `bench` (compare providers on the same scenario) and `scan` (LLM-assist layer).
- API keys: `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY` by default; override the env-var name with `apiKeyEnv`.
- `baseUrl` (OpenAI only) points at any OpenAI-compatible endpoint — Azure, a proxy, or a local model server.
- Switching providers never invalidates the plan cache: plans are data, replays are LLM-free regardless of who planned them.
- `windup costs` breaks spend down **by provider and by model**, so alternating between LLMs keeps per-vendor spend visible.

## CI/CD

```bash
npx windup run --all --reporter junit --report-file reports/windup.xml
```

- `--all` runs every scenario in the directory (one warm browser for the whole suite).
- `--concurrency <n>` runs scenarios in parallel (one shared browser, isolated contexts) — measured ~2× faster on a mixed 11-scenario suite at `--concurrency 4`, more on suites with planning or long flows.
- Exit code is non-zero when any scenario fails.
- `--reporter junit` emits JUnit XML (GitHub Actions, GitLab and Jenkins consume it natively); `--reporter json` emits a machine-readable summary; `--reporter html` emits a self-contained human-friendly page (zero JS/deps — upload it as a CI artifact or open locally). Default output: `.windup/reports/`.
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
| `windup new "<instruction>" [--id x] [--force] [--depends-on ids] [--validate]` | Generate a scenario from a rough instruction; `--validate` runs and refines it until it passes (≤3 attempts) |
| `windup run [scenario]` | Run one scenario (replay when cached, plan on miss) |
| `windup run --all` | Run every scenario — CI mode |
| `windup scan [--update] [--no-assist]` | Statically index routes and interactive elements into the site map; `--update` re-indexes only files changed since the last scan (git diff); `--no-assist` skips the LLM layer (zero cost) |
| `windup costs [--last n] [--days n] [--json]` | AI usage report from the run ledger: totals, free replays, per-provider, per-model and per-scenario breakdown, scan and authoring spend |
| `windup status` | Site-map pages by source, staleness, cached scenarios, fragments |
| `windup fragment extract <scenario> <a1..aN> --id <id> --description <text>` | Promote a slice of a cached plan to a reusable fragment |
| `windup secret set <account> [--user u] [--password p]` | Register test credentials: values → `.env.local`, mapping → `windup.credentials.json` (interactive hidden prompts without flags) |
| `windup secret list` | Accounts + whether each ENV is set (never prints values) |
| `windup sig <url> [--repeat n]` | Structural page signature (diagnostics) |
| `windup bench <scenario>` | Full validation protocol (generation, replay determinism, failure recovery) |
| `windup cache clear` | Drop the trajectory cache (next runs re-plan) |

**`run` flags:** `--all` · `--no-cache` · `--no-map` · `--repeat <n>` · `--concurrency <n>` (parallel) · `--headed` (show the browser) · `--slowmo <ms>` (demo pace) · `--base-url <url>` · `--llm <provider[:model]>` · `--summary` (AI debrief) · `--suggest` (fix hint on failure) · `--reporter junit|json|html` · `--report-file <path>`

### AI debrief (`--summary`)

For humans reading results (not CI), `--summary` adds one LLM call after each run that writes a short debrief: what the test did, the outcome, **concrete values observed on the final page** (prices, messages, product names — quoted literally from the page), and any difficulties (slow steps, re-planning, failures). It prints in the terminal, lands in the run ledger, and shows as a highlighted block in the HTML/JSON reports.

```bash
npx windup run checkout --summary --reporter html
# summary: "The test logged in and completed checkout for 3 items; the
#  confirmation page showed 'Thank you for your order'. Prices observed: ..."
```

Off by default on purpose — cached replays stay at zero LLM calls and $0. The debrief cost (~$0.0005 on the default model) is tracked separately in the run metrics and included in `estimated_cost_usd`.

### Fix suggestions on failure (`--suggest`)

When a run **fails**, `--suggest` adds one LLM call that acts as a senior QA engineer debugging it: it compares the executed plan and the failing step against the **real final page** and the site map's known selectors, then proposes a concrete fix to the scenario — the wrong selector and the real one, a targeted screen that doesn't hold what the task expects, a missing step, or a timeout too short for a slow page.

```bash
npx windup run create-invoice --suggest
# FAIL  create-invoice  ... element button:has-text('Save') not visible
#   suggested fix: The 'Save' button does not exist; the dialog's real button
#   is labeled 'Create'. Change the hint to button:has-text('Create').
```

It turns a red run into a specific edit — instead of reverse-engineering the app by hand. Only fires on failure (green runs cost nothing), never edits the scenario itself, and shows as a highlighted block in the HTML/JSON reports. Pairs naturally with `--summary`.

## Configuration (`windup.config.ts`)

```ts
import { defineConfig } from "windupjs";

export default defineConfig({
  baseUrl: "http://localhost:3000",
  llm: {
    provider: "google",
    model: "gemini-3.1-flash-lite",
    // Several providers at once — pick per run with --llm (see "LLM providers"):
    providers: { openai: { model: "gpt-5-mini" } },
  },
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

## Engineering notes — the techniques behind Windup

A summary of the approaches that make natural-language tests deterministic and cheap:

- **Plan once, replay free.** The LLM is used exactly once per scenario (plus automatic re-planning when the app changes). Its output is a schema-validated **JSON action plan — data, not code**: no generated scripts, no conditionals, no runtime improvisation. Replays execute the cached plan with zero model calls.
- **Deterministic execution.** Plans run on Playwright with native actionability checks and trusted input events. Every action carries an explicit postcondition (`expect`: element visible / URL glob / input value) verified **LLM-free** — verification costs a DOM query, not tokens.
- **Self-healing cache.** Trajectories are cached keyed by scenario + start-URL *path* (portable across dev/staging/CI hosts). A failed verification invalidates the plan, preserves the stale entry as evidence, and triggers a re-plan with the failure as context.
- **Structural page signatures.** Pages are identified by a SHA-256 of their normalized interactive elements — no text, no data — so environment noise doesn't split identities, and start-page drift is detected (leniently) on replay.
- **Layered site knowledge.** A site-map graph feeds the planner real routes and selectors, built from three sources with strict precedence — runtime observation (every execution is also collection) > static source scan (Next.js / react-router indexers, design-system-aware JSX parsing) > capped LLM-assist for files static analysis can't resolve. Knowledge is cache, not truth: anything stale degrades to runtime discovery.
- **Prompt budget discipline.** The planning prompt stays ≈ constant size (~32k chars): page tree, map slice, fragments catalog, and project manifest each have hard char budgets. Long prompts measurably degrade small models — budgets are a correctness feature, not an optimization.
- **Mechanical normalization over prompt hope.** Model output is sanitized deterministically: empty fields dropped, ids renumbered, `wait_for`⇄`expect` normalized, fragment-echo actions deduped, credentials scrubbed from authored scenarios. Cross-provider A/B testing showed prompt instructions alone don't hold across models — code has the final word.
- **Two-tier retry.** Semantic failures (invalid plan) get one short retry carrying the validation errors; transient API pathologies (token-loop degeneration, network) get re-calls with varied seeds. Full-prompt retries are avoided — they reliably re-trigger degeneration.
- **Composable building blocks.** Fragments are curated, committed sub-trajectories (e.g. login) that plans reference by id — updated once, propagated everywhere, expanded at run time. The project manifest injects team knowledge (conventions, accounts, vocabulary) into every plan.
- **Secrets by reference.** Credential values live in `.env.local`/CI secrets; committed files carry only account → ENV-name mappings. Plans use `value_ref`, resolved at execution time — secrets never reach the LLM, the cache, or git.
- **Provider-agnostic LLM boundary.** One interface, Google and OpenAI implementations (the OpenAI client is plain REST — no SDK weight), selectable per run. Swapping the browser engine (Stagehand → Playwright) and adding a provider were each a one-file change — the boundaries are the architecture.
- **Cost you can audit.** Every LLM touchpoint has an explicit cap and lands in a per-run ledger with tokens, model and provider; `windup costs` recomputes from a dated price table, so history stays accurate as prices move.

The full living specification ships in the repository at `docs/specs/SPEC.md`.

## What lives where

| Path | Contents | Commit? |
|---|---|---|
| `windup.config.ts` | Configuration | ✅ |
| `e2e/scenarios/*.json` | Your tests, in natural language | ✅ |
| `e2e/fragments/*.json` | Curated reusable blocks | ✅ |
| `windup.credentials.json` | Account → ENV-name mapping (no values) | ✅ |
| `.env.local` | Credential values | ❌ (auto-gitignored; CI uses secrets with the same names) |
| `.windup/` | Derived state: plan cache, run ledger, site map, reports | ❌ (init adds it to `.gitignore`) |

## License

MIT

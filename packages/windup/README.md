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
- **What the cache buys is `$0`, not "instant"** — a cache hit skips the LLM *planning* (`plan=0ms`, `llm_calls=0`), but the plan's Playwright actions still run, and any `depends_on` chain still executes. Wall-clock is real-browser time, not a lookup. Each run reports the breakdown — `total=… (plan=… deps=… exec=… setup=…)` — so you can see where it goes: `deps` is the `depends_on` chain, `exec` is this scenario's actions, `setup` is the browser context. The **HTML report** splits each scenario's duration into a reconciling bar (`setup · deps · plan · nav · actions`) — where **`nav`** is the goto + page load/hydration *before* the first action, usually the real time sink in an SPA (so a 113 ms action that reads as "3.6 s" is actually setup + nav, not the action). Windup proceeds as soon as the page renders interactive elements *or* the network goes idle — so a display-only page doesn't sit on the readiness timeout. The **suite** header shows **wall-clock** (real elapsed) as the headline, not the sum of per-scenario totals — that sum inflates ~N× under `--concurrency N`. In the per-scenario bar, the leftover under concurrency is labeled **`contention`** (time the scenario spent *waiting* for a CPU/browser slot while siblings ran — idle, not work), and an **`active` ms** figure is shown — the scenario's own work, roughly stable across `--concurrency`, so you can compare scenarios without the parallelization noise (a scenario that reads as "19.7 s" under `--concurrency 4` is often ~2 s of real work + contention). Speed levers: [`depends_on` session snapshots](#scenario-dependencies-depends_on) restore auth instead of re-running the login flow (`deps≈0`), and [`--concurrency`](#cicd) overlaps runs.

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
#    (Next.js, react-router and TanStack Router file-based routing are indexed)
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
- **Native dialogs & non-toast verification.** Windup handles native browser dialogs (`window.confirm`/`alert`/`prompt`) that guard destructive actions (archive, delete, cancel): the planner adds `"dialog": "accept"` (or `"dismiss"` to cancel) to the action that opens the dialog — otherwise the dialog is auto-dismissed and the action silently does nothing. It also steers the final verification toward a **persistent** signal (a row that disappears, a changed label, a URL) over an ephemeral toast/snackbar that vanishes in seconds.
- **Dialog default for the whole scenario (`on_dialog`).** If a flow triggers the *same* confirmation on several steps (bulk delete, "leave page?" guards), set `"on_dialog": "accept"` (or `"dismiss"`) once on the scenario and a **persistent** handler answers every native dialog for the entire run — no per-action `dialog` needed. The per-action `dialog` still works for one-offs; when `on_dialog` is set it takes over.
- **Force one interaction per step (`atomic_steps`).** By default the planner may compress a reveal-then-act into a single action. Set `"atomic_steps": true` and it must emit **one interaction per action** — never merging an expand/open click with the control it uncovers — so the replay stays granular and the report legible when the UI hides controls behind disclosure.
- **Accessibility-label fallback (automatic).** When a plan's CSS selector misses at replay, Windup retries the target by its **accessible name** (the action's description matched against label/placeholder/role) and acts only when **exactly one** visible field matches — recovering from a brittle guessed selector without a re-plan. The recovered step is flagged in the report (`≈ found "<label>" by label …`). If neither selector nor label resolves, the failure says the control likely **has no accessible label (a11y gap)** and to anchor it with a hint — so a broken run doubles as an accessibility finding.
- **Organize by folder.** Scenarios are discovered recursively, so you can group them in subfolders (`e2e/scenarios/contacts/list.json`, `e2e/scenarios/auth/login.json`). The **`scenario_id` is the identity** — `run --all`, the vitest suite and `depends_on` all resolve by it, independent of the file path (duplicate ids are reported).

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
- **Guided self-heal.** A re-plan tells the planner the exact selector that failed ("don't reuse it"), re-emphasizes your hints, and — with `--suggest` — feeds the same expert diagnosis you'd read back into the re-plan, so it corrects instead of re-proposing a refuted selector. If a scenario keeps re-planning without stabilizing, Windup warns that the app likely lacks a stable selector (an a11y gap) or has a race, instead of churning silently.
- Editing a scenario's `task` now invalidates its cached plan (a rewritten test is a different test).
- **Flakiness becomes signal.** Fast deterministic replay + strict postconditions + dependency re-execution is a sharp detector of hydration/redirect races in SPAs: a plan that stops replaying deterministically (`cache=miss llm_calls=1` on every run, alternating PASS/FAIL) is telling you the *app* is non-deterministic, not the test.
- **First-run warm-up:** a dependent scenario's cache key includes the state it inherits from its dependency, which only exists after the dependency runs once. So the first pass of a chain shows `cache=miss` (it plans), and it settles to `cache=hit` from the second run on — expected, not a cache failure.
- **Session snapshots skip the chain replay (the big speed lever).** Re-running a login flow through the UI for every scenario that depends on it is the dominant wall-clock cost of a cached suite. So Windup captures each dependency's **exit state** — Playwright `storageState` (cookies + localStorage) plus its final URL — after it runs, and on a later cached replay it **restores that state into a fresh context and skips re-running the `depends_on` chain** (`deps≈0ms`, reported as `reused_session_from`). The restored run is **still verified**: if the session is stale or the state wasn't fully captured (verification fails), Windup drops the snapshot and transparently **falls back to re-running the full chain** — no false pass, no wasted LLM call. Snapshots live in `.windup/state/` (**gitignored — they hold auth cookies/tokens; never commit them**) and refresh whenever the chain runs.

`windup new` handles dependencies both ways: `--depends-on login` declares them explicitly, and **the author LLM also suggests them on its own** — it sees every existing scenario (id + task) and, when the instruction presupposes a state one of them produces ("already logged in…"), emits `depends_on` automatically (mechanically filtered against real scenario ids — never invented). Either way the task is written from the dependency's final state, without repeating its steps.

**Data preconditions (`requires`).** `depends_on` captures a *scenario* dependency; `requires` documents a *data* one — the seed data a scenario assumes: `"requires": ["1 active attraction", "a paid order"]`. It's declarative (Windup shows it in the report so a failure caused by missing data is legible, and it maps out the create→use→archive cycle) — to actually seed the data, use [`setup`/`suite.setup`](#idempotency-setup--teardown).

### Isomorphic plan reuse (`like`)

At scale, many scenarios are the **same flow on a different route/entity** — create a contact, create a deal, create a company all drive the same form. Instead of paying an LLM planning call for each, a scenario can reuse another's **already-proven** plan:

```json
{
  "scenario_id": "deals-create",
  "start_url": "/deals/new",
  "task": "Type 'Big Deal' into the Name field and click Save; verify a new row appears.",
  "like": { "scenario": "contacts-create", "set": { "Alice": "Big Deal" } }
}
```

- `like.scenario` names the scenario whose active cached plan is the template. Windup instantiates it for this scenario — **this** `start_url`, and `like.set` swaps any differing fill values (`"source literal" → "value to use here"`, applied to `value` fields only; selectors and `value_ref` secrets are untouched).
- The reused plan is **still executed and verified** before it's trusted and cached — exactly the gate every plan passes. If the pages aren't actually isomorphic (a selector doesn't match, verification fails), Windup **falls back to normal LLM planning**. It never bypasses verification, so it can't produce a silent false green.
- When it verifies, the run cost **zero LLM calls** (`llm_calls=0`, shown as reused) and the scenario now has its own cached plan; subsequent runs are ordinary `$0` replays.
- The source must have been planned once first (its plan is the template). In a suite where the source runs later, the `like` scenario simply plans with the LLM that round and reuses on the next — no error, just a missed optimization.

Reuse whole plans with `like`; reuse an **action block** across otherwise-different flows with a [fragment](#what-lives-where) (`windup fragment extract`). Both keep the deterministic, verified guarantee.

### Client-side fixtures (`seed`)

Some state lives entirely in the browser — a shopping cart in `localStorage`, a selected POS device in `sessionStorage`. Building it through the UI every time is slow and couples the test to that flow. `seed` injects that state **before the plan runs**, deterministically and with no server call:

```json
{
  "scenario_id": "cart-updates-quantity",
  "start_url": "/checkout/cart",
  "task": "Increase the first item's quantity to 3 and verify the total updates.",
  "seed": {
    "localStorage": { "cart": "[{\"id\":\"tkt-1\",\"qty\":2,\"price\":50}]" },
    "sessionStorage": { "pos_device": "reader-7" }
  }
}
```

- Seeded per **origin** (default: the `start_url` origin; override with `seed.origin`) via a Playwright init script that runs before the app's scripts, so the page loads already in that state.
- **Each key is set only if absent** — the app's own mutations (a cart the test then edits) are never clobbered on later navigations.
- It's **not** part of the cached plan: it's applied on every run (including `$0` replays), so seeded scenarios stay deterministic.
- CI-safe by construction: you reach a client-side state directly instead of driving a flow that might hit the server. Great for cart/checkout and POS scenarios.

### Authoring with `windup new`

> **The task and its final verification are the LLM's best guess** from your instruction and the site map — an LLM can pick a plausible-but-wrong destination. `windup new` now steers the verification toward the instruction's actual goal (a visible element/text over a guessed route), and recommends confirming with **`windup new "..." --validate`** (generate → run → self-refine until green) or a first `windup run`.


While iterating on a scenario, **`windup run <id> --watch`** re-runs it every time you save the file — a tight authoring loop.

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

A scenario says *"log in as the admin account"* — never the password. Credentials never live in scenario files, plans, the cache or git; only **references** do. Where things are stored:

| What | Where | Committed? |
|---|---|---|
| The real values (users, passwords) | `.env.local` (created `600`) | **No** — gitignored automatically; in CI, the same variable names are secrets |
| The account → variable-name mapping | `windup.credentials.json` | **Yes** — no values, only `ENV:` references |
| The live wiring | merged into the manifest (`context.credentials`) at startup | — |

A value is read **only by the executor, when it fills a field** — never by the planner, the plan, the cache or git. Variable names follow `WINDUP_<ACCOUNT>_<FIELD>` (e.g. `WINDUP_ADMIN_PASSWORD`).

```bash
npx windup secret set admin        # hidden prompts → .env.local (values) + windup.credentials.json (mapping)
npx windup secret list             # accounts + whether each value is [set] / [MISSING] — never prints values
npx windup secret remove admin     # drop the account: mapping + its .env.local lines (alias: rm)
```

Then reference the account by name in the task:

```json
{ "scenario_id": "create-invoice",
  "task": "Log in as the admin account, open Invoices, create one for ACME and verify it appears in the list." }
```

Windup tells the planner the `admin` account maps to `ENV:WINDUP_ADMIN_USER` / `ENV:WINDUP_ADMIN_PASSWORD`, so the plan fills those with `value_ref: "ENV:WINDUP_ADMIN_PASSWORD"`, resolved to the real value only at execution time. `windup new` does this automatically: credentials typed in the instruction are detected, registered and scrubbed — the scenario mentions the account, never the values. You can also declare the mapping directly under `context.credentials` in `windup.config.ts`. In CI, define the same variable names as pipeline secrets; `windup secret list` flags any that are missing before a run.

### Dynamic values — OTP codes, magic-links (`config.resolve`)

Some values only exist at run time: a one-time code, a magic-link URL, a token. Declare a **resolver** in `windup.config.ts` — a source Windup fetches (with polling) at the moment it's needed — and the plan references it by name:

```ts
resolve: {
  otp_code:   { source: { kind: "cmd", command: "psql \"$DATABASE_URL\" -tAc \"select code from otp_codes order by created_at desc limit 1\"" }, extract: { regex: "(\\d{6})" }, poll: { timeout_ms: 30000 } },
  magic_link: { source: { kind: "http", url: "https://inbox.test/latest" }, extract: { json: "body.url" }, url: true },
}
```

- The plan uses `{ "type": "fill", "value_ref": "otp_code" }` for a field, or `{ "type": "goto", "url_ref": "magic_link" }` to navigate to a resolved URL. The planner is told the available names and emits these instead of a literal (it never sees or invents the value).
- **Sources** (`kind`): **`cmd`** (a shell command's stdout — read a DB, run `curl`), **`http`** (fetch a URL — a test-inbox API like Mailosaur/MailSlurp), or **`fn`** (a project JS/TS module that exports `async () => string`). **`extract`** pulls the value out — a `regex` (capture group) or a `json` dot-path. **`poll`** retries until it appears (default 30 s / 1 s), because the code/email arrives with a delay.
- **The source is author-declared, never LLM-generated** — so `cmd`/`http`/`fn` run only what *you* wrote, never something the model invented. And the resolved value is **ephemeral**: it is used for the fill/goto and never written to the cache, the report, or logs.
- **Bind the field deterministically with `resolveFields`** (recommended for CI): declare `resolveFields: { "[name=otp]": "otp_code" }` (a **selector substring** → resolver name) and **any** fill on a matching field is filled from the resolver — overriding whatever the plan put there. This is the reliable path: the OTP flow no longer depends on the planner guessing to emit `value_ref` (if it fills a literal, or a differently-cased name, Windup still resolves the field). The planner is also told these fields are auto-bound. Names are matched leniently too — `OTP_CODE` / `otp-code` normalize to a declared `otp_code`.
- This unblocks any flow gated by a runtime value: OTP/magic-link/passwordless login, and everything behind it.

### Idempotency, setup & teardown

A replay re-runs the **same cached plan with the same values**. That is ideal for **idempotent** flows — edit a fixed record to a fixed value, toggle something and check the final state, read/list/filter. It does **not** fit a pure **CREATE** whose resource has a non-reusable unique key: the first run creates it, every replay violates the constraint.

Two ways to cover writes:

1. **Prefer idempotent scenarios** — e.g. edit a known test record instead of creating a new one; the replay is `$0` and leaves no residue.
2. **`setup` / `teardown` hooks** — shell commands that run **outside** the cached plan (so they run on every replay), for fixtures or cleanup (hard-delete what the test created, reset via SQL/HTTP):

```json
{
  "scenario_id": "create-contact",
  "task": "Open Contacts, create a contact named 'QA Tester' with CPF 111.111.111-11 and verify it appears in the list.",
  "setup":    "psql \"$DATABASE_URL\" -c \"delete from contacts where national_id = '11111111111'\"",
  "teardown": "psql \"$DATABASE_URL\" -c \"delete from contacts where national_id = '11111111111'\""
}
```

`setup` runs before the scenario (and before its dependencies); `teardown` runs after, **always** — pass or fail. They are your own trusted commands (like a test's `beforeEach`/`afterEach`), run in the project root with the process env, and never enter the plan or cache. A failing `teardown` is surfaced as a warning; a failing `setup` fails the run before planning.

**Suite-level fixtures.** For state shared by the whole suite — seed a fixture database once, start an external stub — use `suite.setup` / `suite.teardown` in `windup.config.ts` (see [Configuration](#configuration-windupconfigts)). They run **once** around a `run --all` (setup before the first scenario, teardown after the last — always), the suite analogue of `beforeAll`/`afterAll`. A failing `suite.setup` aborts the suite before any scenario runs; a failing `suite.teardown` is a warning.

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
- **Self-heal keeps your provider:** when a cached plan fails and re-plans, Windup reuses the provider that originally made it (recorded in the plan) before the config default — so a scenario planned with `--llm claude-code` re-plans with claude-code even if the later run didn't pass the flag. Explicit `--llm` always wins.
- `windup costs` breaks spend down **by provider and by model**, so alternating between LLMs keeps per-vendor spend visible.

### Planning with your Claude subscription (`--llm claude-code`)

If you already pay for a Claude plan (Pro/Max), you can plan with it instead of buying API tokens — Windup drives the **`claude` CLI you already have**, no API key, no extra server.

> **Opt-in, never a default.** Using a subscription to plan programmatically is a gray area not endorsed by Anthropic, and Windup does not operate it. For reliability-sensitive work (CI, shared suites) prefer `--llm google` or `--llm openai`. Cached replays never call any LLM, so a plan made this way still replays at $0 with nothing running.

#### Setup — one command

```bash
npx windup claude login    # installs the claude CLI if missing, then signs it into your plan
npx windup claude status   # anytime: "claude CLI: ready — you@example.com (max plan)"
```

`windup claude login` installs the Claude Code CLI (with your confirmation — never a silent global install, never in CI) and launches Anthropic's own browser sign-in; you click *authorize* on your account. The **desktop app and the CLI sign in separately**, so having the desktop app is not enough. If you'd rather do it by hand: `npm install -g @anthropic-ai/claude-code`, then `claude` → `/login` (pick "subscription", not an API key).

That's it — no wrapper, no Python, no local server. Windup spawns `claude` in non-interactive mode for each plan (from an isolated temp dir, so it never picks up a project's `CLAUDE.md`).

```bash
npx windup run checkout --llm claude-code                 # default model: claude-sonnet-4-6
npx windup run checkout --llm claude-code:claude-opus-4-6
WINDUP_LLM=claude-code npx windup run --all               # via env
```

Optionally pin it in config so plain `windup run` uses it:

```ts
// windup.config.ts
llm: { provider: "claude-code", model: "claude-sonnet-4-6" },
```

- **Cost is reported as $0** in `windup costs` — the tokens are real and stay in the ledger, but they're covered by your subscription, so Windup does not invent a per-token price for them.
- **If `claude` isn't installed or logged in**, the run fails fast with an actionable message (install / `/login`), not a stack trace.
- **Slower to plan** than a hosted API (each plan spawns the CLI's agent — ~8–12s vs ~2–4s), but planning happens once and is cached; replays are $0 and instant regardless.
- **Under the hood**: there's no JSON mode, so Windup carries the plan schema in the prompt and un-fences the reply mechanically (Ajv still validates every plan); `temperature`/`seed` have no CLI equivalent and aren't sent (harmless — seed jitter exists for a Gemini-flash quirk).

<details>
<summary><b>Alternative: route through the claude-code-openai-wrapper (HTTP)</b></summary>

Instead of the CLI, you can point Windup at [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper) — a **third-party**, community-maintained local proxy that exposes an OpenAI-compatible endpoint over your Claude Code session. Useful if you already run it, want an HTTP boundary, or reach Claude through Bedrock/Vertex behind it. Windup uses the wrapper (instead of spawning the CLI) **whenever a URL is configured**:

```bash
# start the wrapper (needs Python 3.11+ and Poetry), then:
WINDUP_CLAUDE_CODE_URL=http://localhost:8000/v1 npx windup run checkout --llm claude-code
```

```ts
// windup.config.ts — same effect, persisted
llm: { provider: "claude-code", providers: { "claude-code": { baseUrl: "http://localhost:8000/v1" } } },
```

Its own client auth is off by default; set `CLAUDE_CODE_API_KEY` only if you enabled it. Same $0 cost, same un-fencing. A down wrapper fails fast with a message naming the URL.
</details>

## CI/CD

```bash
npx windup run --all --reporter junit --report-file reports/windup.xml
```

- `--all` runs every scenario in the directory (one warm browser for the whole suite).
- **Suite summary & module grouping.** `--all` (or a multi-scenario run) prints a suite line — pass rate, cache-hit rate, re-plans, LLM calls, cost, and **wall-clock time** (real elapsed; the inflated sum-of-totals is shown alongside with the concurrency, e.g. `wall 130s (sum 512s · concurrency 4)`) — plus a per-**module** (folder) breakdown. The HTML report groups by module, leads with the wall-clock, and gives each scenario a duration breakdown bar that reconciles to its total; JUnit emits one `<testsuite>` per module; JSON carries the full summary (`wall_ms`, `concurrency`, `by_module`, `flaky`) and a per-case `duration_breakdown`.
- **Flake score + root-cause hint.** `--repeat <n>` aggregates per scenario — one that passes some-but-not-all of its runs is listed flaky (`passed X/N`), with a **hint** at the likely cause drawn from its runs (start-page signature drift → hydration race; a network failure; always-same-action → an unstable selector; cache churn → non-deterministic replay) — so data-dependent flakiness surfaces, and points somewhere, before you commit a green.
- **Sharding.** `--all --shard i/n` runs shard *i* of *n* (round-robin split of the scenario list) — spread a big suite across parallel CI runners (`--shard 1/4`, `--shard 2/4`, …), each a separate job.
- **Tags.** Tag scenarios (`"tags": ["smoke", "checkout"]`) and run a subset: `--all --tag smoke,checkout` runs any scenario carrying one of those tags. Run smoke on every push, the full suite nightly — composes with `--shard` and `--changed`.
- **Trace + screenshot on failure (`--trace`).** When a scenario fails, Windup saves a **Playwright trace** (`.windup/reports/traces/<id>.zip` — open it in the Playwright trace viewer: DOM snapshots, network and console per step) plus a full-page **screenshot**, and the HTML report links both from the failed row. See exactly what happened in CI instead of guessing from timings. (Captured only on failure — a passing run keeps nothing.)
- **GitHub Actions output (`--github`, auto-on under `GITHUB_ACTIONS`).** Emits a `::error::` annotation per failed scenario (shown inline on the PR) and writes a Markdown suite summary + per-scenario table to the job page (`$GITHUB_STEP_SUMMARY`) — results surface without opening an artifact.
- **Accessibility (`--a11y`).** After each scenario, run an [axe-core](https://github.com/dequelabs/axe-core) audit on the final page and report violations — a free a11y check riding on infrastructure Windup already has (it reads the page anyway). Informational: it never fails the run. Opt-in tool: `npm i -D axe-core`.
- `--concurrency <n>` runs scenarios in parallel (one shared browser, isolated contexts) — measured ~2× faster on a mixed 11-scenario suite at `--concurrency 4`, more on suites with planning or long flows.
- **Incremental runs (`--changed` / `--since <ref>`).** With `--all`, run only the scenarios a change affects: `--changed` diffs the working tree against `HEAD`, `--since main` (or any git ref) diffs against that ref. A scenario is selected when its own file changed, when it has no cached plan, or when its plan visits a route whose **indexed source** changed (the site map's file→route attribution). Selection is sound-but-coarse and **never a silent false green**: if the diff touches files the map can't attribute to a route (shared code, config), or there's no git/site map, Windup runs the whole suite and prints why. Re-scan (`windup scan`) keeps the attribution current; use plain `--all` for a full pre-merge/nightly gate.
- Exit code is non-zero when any scenario fails.
- `--reporter junit` emits JUnit XML (GitHub Actions, GitLab and Jenkins consume it natively); `--reporter json` emits a machine-readable summary; `--reporter html` emits a self-contained human-friendly page (zero JS/deps — upload it as a CI artifact or open locally). Default output: `.windup/reports/`. The HTML report's per-scenario action list shows each step's **type and target** (`a4 · fill · otp`, `a2 · click · Add to cart`, `a1 · goto · →/checkout`) — a fill's value is never shown (secrets/OTP stay out).
- `windup costs --json` reports AI spend for pipeline tracking.
- `windup coverage` finds **coverage gaps**: it cross-references the routes `windup scan` indexed with your scenarios' start URLs (and cached plans) and lists the routes that have **no scenario yet** — the "what am I missing" report, generated from data Windup already has (no LLM). `--json` for pipelines; a gate could fail the build when critical routes are uncovered.

### Non-destructive testing — stay at the side-effect boundary

A suite that runs on **every push** must never charge a card, send an email/OTP, create an account, or mutate persistent state. The reliable rule: **test up to the boundary of a side effect, and stop there.** In practice almost every screen is coverable this way — the valuable checks fire *before* the network call:

- **Client-side validation** — invalid email/CPF/card, required fields, out-of-range values. The message ("CPF inválido", "Preencha os dados do cartão") appears *before* any request, so asserting it is safe.
- **Navigation & read screens** — lists, filters, tabs, detail views, empty states.
- **Client-side state via [`seed`](#client-side-fixtures-seed)** — cart quantities/removal/limits (localStorage), a POS device (sessionStorage) — reached without a server round-trip.
- **Error states from bogus tokens/slugs** — `/order/BOGUS` → "not found", an invalid share link → "expired". Fully deterministic, no seed data needed.
- **Confirmation dialogs — open and *cancel*.** Assert the "Delete?" dialog appears, then dismiss it (a native `confirm` via `"dialog": "dismiss"`; a modal by clicking Cancel). You verify the guard UI without performing the destructive action.

Keep out of CI: real payment, OTP/email/WhatsApp sends, account/company creation, saving config that persists (**watch single-click toggles that save with no confirm step**), a check-in that consumes a voucher, and — most dangerous of all — **changing the test account's password**. The discipline lives in the scenarios: every one stops before the irreversible action — and [`forbid`](#configuration-windupconfigts) in the config is the machine-enforced backstop (a run that ever targets a denied selector or URL aborts). `setup`/`teardown` (and `suite.setup`/`teardown`) exist for the writes you genuinely must exercise — do them against a disposable fixture, never production data.

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
| `windup run --all --changed` / `--since <ref>` | Incremental CI: run only scenarios a change affects (working tree vs `HEAD`, or vs a git ref). Falls back to the full suite when impact can't be proven — never a silent false green |
| `windup scan [--update] [--no-assist]` | Statically index routes and interactive elements into the site map; `--update` re-indexes only files changed since the last scan (git diff); `--no-assist` skips the LLM layer (zero cost) |
| `windup costs [--last n] [--days n] [--json]` | AI usage report from the run ledger: totals, free replays, per-provider, per-model and per-scenario breakdown, scan and authoring spend |
| `windup status` | Site-map pages by source, staleness, cached scenarios, fragments |
| `windup coverage [--json]` | Cross-reference indexed routes (`windup scan`) with your scenarios — which routes have a scenario and which have none (finds coverage gaps automatically) |
| `windup doctor` | Preflight checks before a run — LLM key for the provider, browser installed, scenarios all parse, no orphaned fragment references, site map scanned. No browser/LLM/network; non-zero exit on a hard problem |
| `windup fragment extract <scenario> <a1..aN> --id <id> --description <text>` | Promote a slice of a cached plan to a reusable fragment |
| `windup secret set <account> [--user u] [--password p]` | Register test credentials: values → `.env.local`, mapping → `windup.credentials.json` (interactive hidden prompts without flags) |
| `windup secret list` | Accounts + whether each ENV is set (never prints values) |
| `windup secret remove <account>` | Remove an account: drops the mapping and its `.env.local` values (alias: `rm`) |
| `windup claude login` | Connect the `claude` CLI to your Claude subscription for `--llm claude-code` (installs it if missing, then signs in) |
| `windup claude status` | Whether the `claude` CLI is installed and logged in (non-zero exit when not ready) |
| `windup sig <url> [--repeat n]` | Structural page signature (diagnostics) |
| `windup bench <scenario>` | Full validation protocol (generation, replay determinism, failure recovery) |
| `windup cache clear` | Drop the trajectory cache (next runs re-plan) |

**`run` flags:** `--all` · `--no-cache` · `--no-map` · `--repeat <n>` · `--concurrency <n>` (parallel) · `--browser chromium|firefox|webkit` · `--verbose` (planning/execution heartbeat) · `--stream` (NDJSON events) · `--headed` (show the browser) · `--slowmo <ms>` (demo pace) · `--base-url <url>` · `--llm <provider[:model]>` · `--summary` (AI debrief) · `--suggest` (fix hint on failure) · `--reporter junit|json|html` · `--report-file <path>`

### AI debrief (`--summary`)

For humans reading results (not CI), `--summary` adds one LLM call after each run that writes a short debrief: what the test did, the outcome, **concrete values observed on the final page** (prices, messages, product names — quoted literally from the page), and any difficulties (slow steps, re-planning, failures). It prints in the terminal, lands in the run ledger, and shows as a highlighted block in the HTML/JSON reports.

```bash
npx windup run checkout --summary --reporter html
# summary: "The test logged in and completed checkout for 3 items; the
#  confirmation page showed 'Thank you for your order'. Prices observed: ..."
```

Off by default on purpose — cached replays stay at zero LLM calls and $0. The debrief cost (~$0.0005 on the default model) is tracked separately in the run metrics and included in `estimated_cost_usd`.

### Verbose progress (`--verbose`)

Planning with a slow provider (e.g. `--llm claude-code`, ~1–3 min/plan) prints nothing until the result, so a run can look frozen. `--verbose` emits milestones to stderr as planning and execution advance — each line prefixed with the scenario id and elapsed time:

```
contacts-columns  planning… (llm: claude-code/claude-sonnet-4-6)  (+0.0s)
contacts-columns  calling claude-code (attempt 1.1)…  (+0.2s)
contacts-columns  plan received: 4 actions, validating…  (+48.9s)
contacts-columns  a1 goto /workspace/contacts ✓  (+49.1s)
contacts-columns  a2 click … ✗ verification failed  (+51.0s)
contacts-columns  verification failed at a2 → self-heal re-planning  (+51.0s)
```

It never changes results and is off by default. Best read at `--concurrency 1` (parallel runs interleave, though each line is scenario-prefixed).

### Fix suggestions on failure (`--suggest`)

When a run **fails**, `--suggest` adds one LLM call that acts as a senior QA engineer debugging it: it compares the executed plan and the failing step against the **real final page** and the site map's known selectors, then proposes a concrete fix to the scenario — the wrong selector and the real one, a targeted screen that doesn't hold what the task expects, a missing step, or a timeout too short for a slow page.

```bash
npx windup run create-invoice --suggest
# FAIL  create-invoice  ... element button:has-text('Save') not visible
#   suggested fix: The 'Save' button does not exist; the dialog's real button
#   is labeled 'Create'. Change the hint to button:has-text('Create').
```

It turns a red run into a specific edit — instead of reverse-engineering the app by hand. Only fires on failure (green runs cost nothing), never edits the scenario itself, and shows as a highlighted block in the HTML/JSON reports. Pairs naturally with `--summary`.

## Browsers

Windup runs on **Chromium by default** (provisioned automatically on install). To run the same scenarios on **Firefox** or **WebKit**, install that browser once and select it:

```bash
npx playwright install firefox        # one-time, per browser
npx windup run checkout --browser firefox
npx windup run --all --browser webkit
```

Set it per project in `windup.config.ts` (`browser: "firefox"`) or per run with `--browser` / `WINDUP_BROWSER`. A plan generated on one browser replays on the others — selectors are cross-browser — so you author once and run everywhere.

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
  // browser: "chromium",             // or "firefox" / "webkit" (need: npx playwright install <name>)
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
  // Reusable readiness signals per route glob (anti-flake) — see below.
  readySignals: {
    "**/workspace/**": "#app-ready",              // wait for this before acting on any /workspace/* page
    "**/reports/**": ["#grid", "[data-loaded]"],  // one or more selectors
  },
  // Suite-level fixtures: run once around `run --all` (beforeAll / afterAll).
  suite: {
    setup:    "npm run db:seed",
    teardown: "npm run db:reset",
  },
  // Safety denylist: abort if a plan ever touches these (CI guardrail).
  forbid: {
    selectors: ["#change-password", "[data-danger]"],  // substring match on a plan's selector
    urls: ["**/account/password", "**/admin/**"],       // path globs the run must never reach
  },
});
```

- **`context.credentials`** maps account names to ENV references. When a task mentions the account, the plan uses `value_ref` — manifest credentials take precedence even if the page displays values, and the planner is forbidden from inventing ENV names.
- **`readySignals`** maps a route glob to the CSS selector(s) that must be **visible before the executor runs the first action** on a matching page. It's applied deterministically at run time (no LLM, $0, not part of the cached plan) — so a hydration/loading wait is defined once per route instead of repeated as a hint in every scenario. It closes the load-time race where an element is present but its handlers aren't attached yet (which Playwright's per-element wait can't see). Best-effort: a signal that never appears within the timeout logs a warning and continues (it never hard-fails the suite), and it applies again whenever a run enters a matching route.
- **`suite.setup` / `suite.teardown`** are shell command(s) run **once** around a `run --all` — setup before the first scenario, teardown after the last (always, even on failure) — for suite-wide fixtures (seed/reset a shared database, start a stub). Per-scenario `setup`/`teardown` (in the scenario JSON) still handle per-test state. A failing `suite.setup` aborts the suite before any scenario runs; a failing `suite.teardown` is a warning.
- **`forbid`** is a safety denylist — a CI guardrail against irreversible side effects. If any plan action targets a forbidden **selector** (substring match on the plan's CSS selector, e.g. `#change-password`) or the run reaches a forbidden **URL** (path glob, e.g. `**/account/password`), the run **aborts** with a `forbidden` failure instead of performing it. You declare the danger list (the engine never infers it), so it's the belt-and-suspenders backstop to the [authoring discipline](#non-destructive-testing--stay-at-the-side-effect-boundary): even if a re-plan wanders toward "Change password", it's stopped before the click.
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
- **Layered site knowledge.** A site-map graph feeds the planner real routes and selectors, built from three sources with strict precedence — runtime observation (every execution is also collection) > static source scan (Next.js, react-router and TanStack Router indexers, design-system-aware JSX parsing) > capped LLM-assist for files static analysis can't resolve. Knowledge is cache, not truth: anything stale degrades to runtime discovery.
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

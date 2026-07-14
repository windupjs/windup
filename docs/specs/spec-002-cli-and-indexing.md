# SPEC-002 — Product: CLI/Lib and Project Indexing

> **Historical document** (originally written in Portuguese; translated to English). Fully implemented — see the English living specification in [SPEC.md](SPEC.md).

**Status:** implemented · **Complements:** [SPEC-001](spec-001-post-spike-evolution.md) (the `scan` here feeds the site map there)

## Product shape

**npm package installed as a `devDependency`, executed via `npx windup <cmd>`** (bin in the package). Not a global CLI.

Rationale: version pinned to the project (two projects can use different versions; CI installs the same one as the dev), zero setup friction in pipelines, and the package doubles as a lib (`import { run } from "windupjs"`) for anyone who wants to integrate with an existing test runner (vitest/jest) — the CLI is a thin shell over the programmatic API. A global CLI may exist later as a convenience (`windup init` before package.json exists), never as the primary form.

**Initial target: JS/TS projects** (largest base, most accessible static analysis). The core (plans, cache, map, executor) is language-agnostic — only the *static indexers* are ecosystem-specific; other ecosystems come later via new indexers.

## Commands

| Command | Does |
|---|---|
| `windup init` | Creates `windup.config.ts`, `.windup/` (cache gitignore), detects the framework and suggests config; asks the minimum (base_url, LLM provider) |
| `windup scan` | Project indexing: static (code) + optional dynamic (light crawl). Populates the site map |
| `windup scan --update` | Incremental re-indexing: only what changed since the last scan (git diff) |
| `windup run <scenario\|folder>` | Runs scenario(s) — the productized `spike run` |
| `windup fragment extract <scenario> <range>` | Promotes a stretch of a cached plan to a fragment (SPEC-001/E3) |
| `windup status` | Index state: mapped pages, staleness, coverage, cached scenarios |

## Configuration (`windup.config.ts`)

```ts
export default {
  baseUrl: "http://localhost:3000",
  llm: { provider: "google", model: "gemini-2.5-flash" }, // provider abstraction (RESULTS.md recommendation)
  scan: {
    root: ".",                        // project folder
    include: ["src/**", "app/**"],
    exclude: ["**/*.test.*"],
    dynamic: { enabled: false, maxDepth: 3, maxPages: 50 }, // optional crawl
    llmAssist: { enabled: true, maxCalls: 20 },             // cap on LLM calls per scan
  },
  context: { /* project manifest — SPEC-001 component 3 */ },
  scenarios: "e2e/scenarios/",
};
```

Principles: every cap explicit (depth, pages, LLM calls) — scan never surprises on cost; config is committed, cache is not.

## Static indexing (the differentiator)

Analyzing the **source code** gives the planner knowledge that no crawl reaches cheaply: routes behind login, hard-to-reproduce states, stable selectors declared in the components. Three-layer pipeline, from cheapest to most expensive:

1. **Framework conventions (no LLM, no heavy parser):** detect the framework via `package.json` and extract routes by file convention — Next.js (`app/`/`pages/`), remix/react-router (file-based or config), vite+react-router (light parse of route declarations). Output: list of routes with the source file path.
2. **Element extraction (static parse):** in each route's components, collect `data-testid`/`data-test`, `id`, `name`, `aria-*`, button/link labels and form fields. Regex/light AST (ts-morph or similar), without running the app.
3. **LLM-assist (optional, capped):** for what layers 1–2 don't resolve (programmatic dynamic routes, very indirect components), the LLM reads selected files and answers in a fixed schema ("what route does this file define? what interactive elements does it render?"). Bounded by `llmAssist.maxCalls`; results marked `source: "llm"` and given lower confidence in the map.

Everything flows into the **same graph as SPEC-001**, with nodes marked `source: "static" | "crawl" | "execution"` and the confidence precedence **execution > crawl > static** — what was seen running is worth more than what was inferred from the code. A static page contradicted by execution is corrected in the map (the "knowledge is cache, not truth" principle).

**Zero-hardcode compliance:** indexers know *frameworks* (Next, react-router — generic, public knowledge), never *sites*. A `git grep` for a specific domain must still come back empty.

## Index updates (project evolution)

**Incremental via git, not a watcher.** `scan --update` uses `git diff --name-only <last-scan>..HEAD` (SHA recorded in the index) and re-indexes only affected files; routes whose sources changed have their pages marked `stale` in the map.

Rationale against the watcher/daemon: a resident process is complexity and a source of bugs; the natural moment to update is *before running tests*, not on every save. Recommended integration: automatic `scan --update` at the start of `windup run` (fast, since it is a diff) + optional CI hook. A `--watch` may exist in the future for the DX of scenario authors, as sugar over the incremental mechanism — never as the primary mechanism.

## First-use flow (what the user feels)

```
npm i -D windupjs
npx windup init          # 3 questions, creates config
npx windup scan          # ~seconds (static); initial project map
# write e2e/scenarios/checkout.json (natural-language task)
npx windup run checkout  # 1st run: plans seeing the map; 2nd onward: replay ~1s
```

The product promise: **from `npm i` to the first test running, minutes — and from the second run onward, unit-test speed.**

## Phases (continuing E1–E5 from SPEC-001)

| Phase | Deliverable | Done criterion |
|---|---|---|
| P1 | Packaging: bin + programmatic API, `init`, `run` (migration of the spike code) | External project installs via npm and runs the spike scenarios without cloning the repo |
| P2 | Static `scan` layers 1–2 (Next.js first, then react-router) | On a real Next project: ≥ 90% of convention-based routes detected; elements with data-test extracted; map populated |
| P3 | Incremental `scan --update` via git + `status` | Edit 1 component → only it re-indexed; corresponding page marked stale |
| P4 | LLM-assist with cap + optional dynamic crawl | Dynamic routes of a sample project detected within the cost cap; cost per scan reported |
| P5 | Runner integration (`import` in vitest/jest) | windup scenario running inside a `describe` with the runner's native report |

Order relative to the E phases: P1 can start alongside E1; P2+ depends on E2 (map existing). Suggested single track: E1 → P1 → E2 → P2 → E3 → P3 → the rest as real pain dictates.

## Open decisions

| Question | Options | Note |
|---|---|---|
| Package name | **Chosen name: Windup** (wind-up toy — you wind it once [LLM plans], it walks on its own [replay]; the wind-up robot mascot). Research 2026-07-12: npm `windup` taken by an abandoned CSS framework (7 years — a dispute is plausible); `@windup` org taken; GitHub org `windup` belongs to Red Hat (retired Java migration tool, rebranded MTR — distinct category, low risk) | Plan: package `windupjs` or `@windup-labs/*` + dispute for the bare `windup` in parallel; check domains (`windup.dev`, `getwindup.com`) and an alternative GitHub org (`windup-labs`) before P1. |
| Scenario format | Current JSON vs YAML vs Gherkin-like | JSON until E3; the real discussion comes with fragments (readability) |
| AST parser | ts-morph vs oxc/swc | Decide in P2 via scan-speed benchmark |
| Monorepos | Single workspace vs per-app index | Defer; detect and warn in `init` |

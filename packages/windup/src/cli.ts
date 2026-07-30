#!/usr/bin/env node
import "./env.js";
import { Command } from "commander";
import { clearCache } from "./cache.js";
import { LlmPlanner } from "./planner.js";
import { runScenario, runWithRetries } from "./runner.js";
import { progressStart, streamEvent } from "./progress.js";
import { loadScenario } from "./scenario.js";
import { runBench } from "./bench.js";
import { WindupError } from "./errors.js";
import type { RunMetrics } from "./types.js";

const program = new Command();

program.name("windup").description("Natural-language E2E tests with deterministic replay — the LLM plans once, replays run without it");

// Every command except init resolves windup.config.* and builds the context.
program.hook("preAction", async (_this, actionCommand) => {
  if (actionCommand.name() === "init") return;
  const { createContextFromConfig, setContext } = await import("./context.js");
  setContext(await createContextFromConfig());
});

program
  .command("init")
  .description("Create windup.config.ts, .windup/ and an example scenario")
  .action(async () => {
    const { runInit } = await import("./init.js");
    await runInit();
  });

function printRun(metrics: RunMetrics): void {
  const status = metrics.result === "passed" ? "PASS" : "FAIL";
  const llm = metrics.llm_model ? ` llm=${metrics.llm_provider ? `${metrics.llm_provider}/` : ""}${metrics.llm_model}` : "";
  const d = metrics.duration_ms;
  const deps = d.dependencies ? ` deps=${d.dependencies}ms` : "";
  const setup = d.setup ? ` setup=${d.setup}ms` : "";
  console.log(
    `${status}  ${metrics.scenario_id}  cache=${metrics.cache} llm_calls=${metrics.llm_calls}${llm} ` +
      `total=${d.total}ms (plan=${d.planning}ms${deps} exec=${d.execution}ms${setup}) ` +
      `cost=$${metrics.estimated_cost_usd}`,
  );
  if (metrics.failure) {
    console.log(`      failure [${metrics.failure.kind}] action=${metrics.failure.action_id ?? "-"}: ${metrics.failure.message}${metrics.quarantined ? "  (quarantined — not blocking)" : ""}`);
  }
  // Why planning cost more than one call — otherwise `llm_calls=4` after a 60s
  // re-plan is unexplained (and looks like the tool is just slow).
  const rr = metrics.plan_retry_reasons;
  if (rr?.length) {
    console.log(`      planner retried ${rr.length}× — ${rr.slice(0, 3).join("; ")}${rr.length > 3 ? " …" : ""}`);
  }
  if (metrics.a11y) {
    const v = metrics.a11y.violations;
    if (v.length === 0) console.log("      a11y: no violations ✓");
    else console.log(`      a11y: ${v.length} violation(s): ${v.slice(0, 5).map((x) => `${x.id} (${x.impact}, ${x.nodes})`).join(", ")}${v.length > 5 ? " …" : ""}`);
  }
  if (metrics.diagnostics) {
    const ce = metrics.diagnostics.console_errors ?? [];
    const fr = metrics.diagnostics.failed_responses ?? [];
    if (ce.length) console.log(`      console errors: ${ce.length} — ${ce.slice(0, 3).map((e) => `${e.message.slice(0, 80)}${e.url ? ` [${e.url}]` : ""}`).join(" | ")}${ce.length > 3 ? " …" : ""}`);
    if (fr.length) console.log(`      failed responses: ${fr.slice(0, 5).map((r) => `${r.status} ${r.url}`).join(", ")}${fr.length > 5 ? " …" : ""}`);
  }
  if (metrics.web_vitals) {
    const v = metrics.web_vitals;
    const parts = [
      v.ttfb_ms != null ? `TTFB ${v.ttfb_ms}ms` : "",
      v.fcp_ms != null ? `FCP ${v.fcp_ms}ms` : "",
      v.lcp_ms != null ? `LCP ${v.lcp_ms}ms` : "",
      v.load_ms != null ? `load ${v.load_ms}ms` : "",
      v.cls != null ? `CLS ${v.cls}` : "",
    ].filter(Boolean);
    if (parts.length) console.log(`      web vitals: ${parts.join(" · ")}`);
  }
  if (metrics.requires?.length && metrics.result === "failed") {
    console.log(`      requires (data): ${metrics.requires.join("; ")}`);
  }
}

program
  .command("run [scenario]")
  .description("Run one scenario, or every scenario with --all (replays from cache; plans via LLM on miss)")
  .option("--all", "run every scenario in the scenarios directory (CI mode)")
  .option("--changed", "with --all: run only scenarios affected by uncommitted changes (vs HEAD) — see --since")
  .option("--since <ref>", "with --all: run only scenarios affected by changes since a git ref (e.g. main, HEAD~1) — incremental CI")
  .option("--no-cache", "bypass the trajectory cache (always plan; nothing is cached)")
  .option("--no-map", "exclude site-map knowledge from the planner prompt")
  .option("--repeat <n>", "run N times in sequence", "1")
  .option("--concurrency <n>", "run scenarios in parallel, up to N at a time (default 1; great for CI suites)", "1")
  .option("--headed", "show the browser window (headless off)")
  .option("--slowmo <ms>", "pause between actions in ms (watchable demo pace)")
  .option("--base-url <url>", "override the start URL origin (also: WINDUP_BASE_URL env)")
  .option("--browser <name>", "browser engine: chromium (default) | firefox | webkit (firefox/webkit need: npx playwright install <name>)")
  .option("--llm <provider[:model]>", "LLM for planning, e.g. openai, openai:gpt-5-mini, google:gemini-3.1-flash-lite (also: WINDUP_LLM env)")
  .option("--verbose", "print planning/execution progress milestones (a heartbeat for slow providers like claude-code)")
  .option("--stream", "emit machine-readable NDJSON events (one per milestone) to stdout for CI/dashboards")
  .option("--summary", "after each run, an LLM writes a short debrief: what was done, concrete observed results, difficulties (1 extra LLM call per run)")
  .option("--suggest", "on a FAILED run, an LLM proposes a concrete fix to the scenario (task/hints) from the real final page and the site map (1 extra LLM call, only on failure)")
  .option("--reporter <format>", "write a report: junit | json | html")
  .option("--report-file <path>", "report destination (default: .windup/reports/windup-report.{xml,json})")
  .option("--shard <i/n>", "with --all: run shard i of n (round-robin split) — spread a suite across parallel CI runners")
  .option("--tag <names>", "with --all: run only scenarios with any of these tags (comma-separated, e.g. smoke,checkout)")
  .option("--a11y", "after each scenario, run an accessibility audit (axe-core) on the final page and report violations (needs: npm i -D axe-core)")
  .option("--watch", "re-run the scenario whenever its file changes — a fast authoring loop (single scenario only)")
  .option("--trace", "on a FAILED scenario, save a Playwright trace + screenshot next to the report (open the .zip in the Playwright trace viewer)")
  .option("--github", "emit GitHub Actions annotations for failures + a job summary (auto-on when GITHUB_ACTIONS=true)")
  .option("--retries <n>", "re-run a scenario that fails a FLAKY way (network/verification/setup/dependency) up to N extra times; a forbidden block is never retried", "0")
  .option("--max-wall <seconds>", "with --all: stop starting new scenarios once the suite's wall-clock exceeds this many seconds (a CI time budget); exits non-zero if the cap is hit")
  .option("--bail", "with --all: stop starting new scenarios after the first failure (fast feedback in PR checks)")
  .option("--no-prewarm", "disable pre-warming the next scenario's browser off the critical path (sequential --all)")
  .option("--fail-on-console", "fail a scenario if the page threw a JS exception, logged a console.error, or hit a CSP violation during the run")
  .option("--fail-on-resource", "fail a scenario if a sub-resource (img/font/script/xhr) failed to load (a 4xx) during the run — separate from --fail-on-console so broken images don't drown JS errors")
  .option("--fail-on-5xx", "fail a scenario if any request got a 5xx response during the run (config.network stubs are excluded)")
  .option("--device <name>", "emulate a Playwright device preset (e.g. \"iPhone 14\", \"Pixel 7\") — viewport/UA; cached plans are keyed per device")
  .option("--web-vitals", "capture final-page web vitals (TTFB/FCP/LCP/CLS) and report them (gate them with config.budgets)")
  .action(async (scenarioId: string | undefined, opts: { all?: boolean; changed?: boolean; since?: string; cache: boolean; map: boolean; repeat: string; headed?: boolean; slowmo?: string; baseUrl?: string; browser?: string; llm?: string; verbose?: boolean; stream?: boolean; summary?: boolean; suggest?: boolean; concurrency?: string; reporter?: string; reportFile?: string; shard?: string; tag?: string; a11y?: boolean; watch?: boolean; trace?: boolean; github?: boolean; retries?: string; maxWall?: string; bail?: boolean; prewarm?: boolean; failOnConsole?: boolean; failOnResource?: boolean; failOn5xx?: boolean; device?: string; webVitals?: boolean }) => {
    if (opts.a11y) process.env.WINDUP_A11Y = "1";
    if (opts.failOnConsole) process.env.WINDUP_FAIL_ON_CONSOLE = "1";
    if (opts.failOnResource) process.env.WINDUP_FAIL_ON_RESOURCE = "1";
    if (opts.failOn5xx) process.env.WINDUP_FAIL_ON_5XX = "1";
    if (opts.device) process.env.WINDUP_DEVICE = opts.device;
    if (opts.webVitals) process.env.WINDUP_WEB_VITALS = "1";
    if (opts.trace) process.env.WINDUP_TRACE = "1";
    if (opts.headed) process.env.HEADLESS = "false";
    if (opts.slowmo) process.env.SLOWMO_MS = opts.slowmo;
    if (opts.baseUrl) process.env.WINDUP_BASE_URL = opts.baseUrl;
    if (opts.browser) process.env.WINDUP_BROWSER = opts.browser;
    if (opts.llm) process.env.WINDUP_LLM = opts.llm;
    if (opts.verbose) process.env.WINDUP_VERBOSE = "1";
    if (opts.stream) process.env.WINDUP_STREAM = "1";
    if (opts.reporter && !["junit", "json", "html"].includes(opts.reporter)) {
      console.error(`unknown reporter "${opts.reporter}" — use junit, json or html`);
      process.exitCode = 2;
      return;
    }

    let ids: string[];
    if (opts.all) {
      const { discoverScenarioIds } = await import("./scenario.js");
      ids = await discoverScenarioIds();
      if (ids.length === 0) {
        console.error("no scenarios found — write one first (npx windup init creates an example)");
        process.exitCode = 2;
        return;
      }
      // Incremental selection: run only what a code/scenario change affects.
      const ref = opts.since ?? (opts.changed ? "HEAD" : null);
      if (ref !== null) {
        const { selectAffected } = await import("./changed.js");
        const sel = await selectAffected(ids, ref);
        if (!opts.stream) console.log(`incremental: ${sel.reason}`);
        ids = sel.run;
        if (ids.length === 0) {
          if (!opts.stream) console.log("nothing to run — all scenarios unaffected. ✓");
          return; // exit 0: an empty affected set is a pass in CI
        }
      }
      // Tag filter: run only scenarios carrying any of the given tags.
      if (opts.tag) {
        const wanted = new Set(opts.tag.split(",").map((t) => t.trim()).filter(Boolean));
        const { scenarioTagsById } = await import("./scenario.js");
        const tags = await scenarioTagsById();
        const before = ids.length;
        ids = ids.filter((id) => (tags.get(id) ?? []).some((t) => wanted.has(t)));
        if (!opts.stream) console.log(`tags [${[...wanted].join(", ")}]: ${ids.length}/${before} scenarios`);
        if (ids.length === 0) { if (!opts.stream) console.log("no scenarios match the tag(s). ✓"); return; }
      }
      // Sharding: spread the suite across parallel CI runners (round-robin split).
      if (opts.shard) {
        const m = /^(\d+)\/(\d+)$/.exec(opts.shard.trim());
        if (!m) { console.error(`--shard must be i/n (e.g. 1/4) — got "${opts.shard}"`); process.exitCode = 2; return; }
        const i = Number(m[1]); const n = Number(m[2]);
        if (i < 1 || i > n) { console.error(`--shard i/n: i must be between 1 and n (got ${i}/${n})`); process.exitCode = 2; return; }
        const before = ids.length;
        ids = ids.filter((_, idx) => idx % n === (i - 1));
        if (!opts.stream) console.log(`shard ${i}/${n}: ${ids.length}/${before} scenarios`);
        if (ids.length === 0) { if (!opts.stream) console.log("nothing in this shard. ✓"); return; }
      }
    } else if (opts.changed || opts.since || opts.shard || opts.tag) {
      console.error("--changed/--since/--shard/--tag select from the suite — use them with --all");
      process.exitCode = 2;
      return;
    } else if (scenarioId) {
      ids = [scenarioId];
    } else {
      console.error("pass a scenario id or --all");
      process.exitCode = 2;
      return;
    }

    const planner = new LlmPlanner({ useMap: opts.map });
    const repeat = Number.parseInt(opts.repeat, 10);
    const concurrency = Math.max(1, Number.parseInt(opts.concurrency ?? "1", 10) || 1);
    const retries = Math.max(0, Number.parseInt(opts.retries ?? "0", 10) || 0);
    let maxWallMs = 0;
    if (opts.maxWall !== undefined) {
      const secs = Number.parseFloat(opts.maxWall);
      if (!Number.isFinite(secs) || secs <= 0) { console.error(`--max-wall must be a positive number of seconds (got "${opts.maxWall}")`); process.exitCode = 2; return; }
      if (!opts.all) { console.error("--max-wall gates a suite — use it with --all"); process.exitCode = 2; return; }
      maxWallMs = secs * 1000;
    }

    // config.network / config.clock — validate eagerly so a malformed rule fails loud.
    {
      const { getContext } = await import("./context.js");
      const { validateNetwork } = await import("./network.js");
      const { validateClock } = await import("./clock.js");
      const { validateBudgets } = await import("./vitals.js");
      const cfg = getContext().config;
      const cfgErrors = [...validateNetwork(cfg.network), ...validateClock(cfg.clock), ...validateBudgets(cfg.budgets)];
      try { const { resolveDeviceContext } = await import("./device.js"); resolveDeviceContext(); } catch (e) { cfgErrors.push(e instanceof Error ? e.message : String(e)); }
      if (cfgErrors.length) { console.error(`invalid config:\n${cfgErrors.map((e) => `  - ${e}`).join("\n")}`); process.exitCode = 2; return; }
    }

    const printExtras = (metrics: RunMetrics): void => {
      if (metrics.summary) {
        console.log(`      summary (${metrics.summary.provider}/${metrics.summary.model}, $${metrics.summary.est_cost_usd}):`);
        for (const line of metrics.summary.text.split("\n")) console.log(`      ${line}`);
      }
      if (metrics.suggestion) {
        console.log(`      suggested fix (${metrics.suggestion.provider}/${metrics.suggestion.model}, $${metrics.suggestion.est_cost_usd}):`);
        for (const line of metrics.suggestion.text.split("\n")) console.log(`      ${line}`);
      }
    };

    const reportRun = (m: RunMetrics): void => {
      if (opts.stream) {
        streamEvent(m.scenario_id, "run:end", { result: m.result, cache: m.cache, llm_calls: m.llm_calls, cost: m.estimated_cost_usd, duration_ms: m.duration_ms.total, exec_ms: m.duration_ms.execution, deps_ms: m.duration_ms.dependencies ?? 0, setup_ms: m.duration_ms.setup ?? 0, ...(m.attempts ? { attempts: m.attempts, flaky: m.flaky ?? false } : {}) });
        return; // stdout stays pure NDJSON
      }
      printRun(m);
      printExtras(m);
    };

    // Suite-level fixtures (run --all): setup once before the suite, teardown
    // once after (always). Per-scenario setup/teardown still run per test.
    const { getContext: getCtx } = await import("./context.js");
    const suiteHooks = opts.all ? getCtx().config.suite : undefined;
    if (suiteHooks?.setup) {
      const { runHooks } = await import("./hooks.js");
      const r = await runHooks("setup", suiteHooks.setup, "(suite)");
      if (!r.ok) {
        console.error(`suite setup failed — no scenarios were run:\n${r.error}`);
        process.exitCode = 2;
        return;
      }
    }
    const runSuiteTeardown = async (): Promise<void> => {
      if (!suiteHooks?.teardown) return;
      const { runHooks } = await import("./hooks.js");
      const r = await runHooks("teardown", suiteHooks.teardown, "(suite)");
      if (!r.ok) console.warn(`warning: ${r.error}`);
    };

    try {
    // Build the flat task list (each id × repeat). Scenarios are loaded up front.
    const scenarios = await Promise.all(ids.map((id) => loadScenario(id)));
    const jobs = scenarios.flatMap((scenario) => Array.from({ length: repeat }, () => scenario));

    const wallStart = Date.now(); // real elapsed time of the whole run (≠ the sum of per-scenario totals under concurrency)
    let bailed = false; // --bail: set on the first non-pass, halts new scenarios
    const overBudget = () => maxWallMs > 0 && Date.now() - wallStart >= maxWallMs;
    const shouldStop = () => overBudget() || bailed;
    const noteResult = (m: RunMetrics): RunMetrics => { if (opts.bail && m.result !== "passed") bailed = true; return m; };
    const onRetry = (attempt: number, failed: RunMetrics): void => {
      if (!opts.stream) console.log(`      ↻ retry ${attempt}/${retries} after ${failed.failure?.kind ?? "failure"}`);
    };
    // One job = one scenario run, retrying a flake up to `retries` times when asked.
    const runJob = (scenario: typeof jobs[number], extra?: { sharedMap?: unknown; prewarmed?: unknown }): Promise<RunMetrics> => {
      const runOpts = { useCache: opts.cache, summary: opts.summary, suggest: opts.suggest, ...extra } as Parameters<typeof runScenario>[2];
      return retries > 0 ? runWithRetries(scenario, planner, runOpts, retries, onRetry) : runScenario(scenario, planner, runOpts);
    };

    let results: RunMetrics[];
    if (concurrency > 1 && jobs.length > 1) {
      // Parallel: one shared site map (saved once at the end); results print as
      // each finishes, then a summary line. --headed/--slowmo don't mix well
      // with concurrency (many windows / paced demos) — warn.
      if (opts.headed || opts.slowmo) console.warn("warning: --headed/--slowmo with --concurrency > 1 will interleave; use concurrency 1 to watch a run");
      const { SiteMapStore } = await import("./sitemap.js");
      const { getContext } = await import("./context.js");
      const { runPool } = await import("./runner.js");
      const sharedMap = await SiteMapStore.load(getContext().paths.mapFile);
      console.log(`running ${jobs.length} scenario(s) with concurrency ${concurrency}...`);
      results = await runPool(
        jobs.map((scenario) => async () => {
          progressStart(scenario.scenario_id);
          streamEvent(scenario.scenario_id, "run:start", {});
          const m = noteResult(await runJob(scenario, { sharedMap }));
          reportRun(m);
          return m;
        }),
        concurrency,
        shouldStop, // stop dispatching new scenarios once the budget is spent or --bail tripped
      );
      await sharedMap.save();
    } else {
      results = [];
      // Prewarm: while a scenario runs, create the NEXT scenario's fresh browser
      // (context+page) off the critical path. Isolation is unchanged — each
      // scenario still gets its own clean context; only the ~200 ms launch moves
      // off the wait. Sequential only (concurrency > 1 already overlaps launches).
      const prewarm = opts.prewarm !== false && jobs.length > 1;
      const { launchBrowser } = prewarm ? await import("./browser.js") : { launchBrowser: null };
      const traceOn = process.env.WINDUP_TRACE === "1";
      let warming: Promise<import("./browser.js").Browser | null> | null = null;
      const startWarm = (): void => { if (launchBrowser) warming = launchBrowser({ trace: traceOn }).catch(() => null); };
      const takeWarm = async (): Promise<(() => import("./browser.js").Browser | undefined) | undefined> => {
        if (!warming) return undefined;
        const b = await warming; warming = null;
        if (!b) return undefined;
        let taken = false; // one-shot: a --retries re-attempt launches fresh
        return () => { if (taken) return undefined; taken = true; return b; };
      };
      if (prewarm) startWarm();
      for (let j = 0; j < jobs.length; j++) {
        if (shouldStop()) break; // --max-wall / --bail: don't start another scenario
        const prewarmed = await takeWarm();
        if (prewarm && j + 1 < jobs.length) startWarm(); // warm j+1 during job j
        if (repeat > 1) console.log(`run ${(j % repeat) + 1}/${repeat}`);
        progressStart(jobs[j].scenario_id);
        streamEvent(jobs[j].scenario_id, "run:start", {});
        const m = noteResult(await runJob(jobs[j], prewarmed ? { prewarmed } : undefined));
        reportRun(m);
        results.push(m);
      }
      // Close a warmed session left unused (a --bail/--max-wall early stop).
      const leftover = await takeWarm();
      if (leftover) { const b = leftover(); if (b) await b.close().catch(() => {}); }
    }
    const skipped = jobs.length - results.length; // scenarios never started (--max-wall or --bail)
    if (maxWallMs > 0 && overBudget() && skipped > 0 && !opts.stream) {
      console.warn(`\n⏱  --max-wall ${maxWallMs / 1000}s exceeded — ${results.length}/${jobs.length} ran, ${skipped} not started (build fails).`);
    }
    if (bailed && skipped > 0 && !opts.stream) {
      console.warn(`\n⏹  --bail: stopped after the first failure — ${results.length}/${jobs.length} ran, ${skipped} not started.`);
    }
    const flakyCount = results.filter((m) => m.flaky).length;
    if (flakyCount > 0 && !opts.stream) {
      console.log(`\n↻ ${flakyCount} scenario(s) passed only on retry (flaky): ${results.filter((m) => m.flaky).map((m) => m.scenario_id).join(", ")}`);
    }

    // Mark quarantined results (scenario.quarantine): they run and report, but a
    // failure here does NOT fail the suite — surfaced, never silently dropped.
    try {
      const { quarantinedScenarioIds } = await import("./scenario.js");
      const q = await quarantinedScenarioIds();
      for (const m of results) if (q.has(m.scenario_id)) m.quarantined = true;
    } catch {
      // best-effort — no quarantine info means nothing is quarantined
    }
    const failures = results.filter((m) => m.result !== "passed").length;
    const blockingFailures = results.filter((m) => m.result !== "passed" && !m.quarantined).length;
    const quarantinedFailures = failures - blockingFailures;
    if (quarantinedFailures > 0 && !opts.stream) {
      console.warn(`\n🔶 ${quarantinedFailures} quarantined scenario(s) failed but did NOT fail the build: ${results.filter((m) => m.result !== "passed" && m.quarantined).map((m) => m.scenario_id).join(", ")} — fix or un-quarantine them.`);
    }

    // Attach each result's module (its folder) for the suite report + grouping.
    try {
      const { scenarioModuleById } = await import("./scenario.js");
      const modules = await scenarioModuleById();
      for (const m of results) m.module = modules.get(m.scenario_id) ?? "(root)";
    } catch {
      // best-effort — grouping falls back to "(root)"
    }

    const wall_ms = Date.now() - wallStart;
    const suiteOpts = { wall_ms, concurrency };
    if (results.length > 1) {
      const { buildSuiteSummary, printSuiteSummary } = await import("./suite.js");
      const summary = buildSuiteSummary(results, suiteOpts);
      if (opts.stream) streamEvent(null, "suite", { ...summary });
      else printSuiteSummary(summary);
    }

    // GitHub Actions output: ::error:: annotations for failures + a job summary.
    const { inGithubActions } = await import("./github.js");
    if (opts.github || inGithubActions()) {
      const { githubAnnotate, githubStepSummary } = await import("./github.js");
      const { buildSuiteSummary } = await import("./suite.js");
      githubAnnotate(results);
      await githubStepSummary(buildSuiteSummary(results, suiteOpts), results);
    }

    if (opts.reporter) {
      const { writeReport } = await import("./reporters.js");
      const file = await writeReport(results, opts.reporter as "junit" | "json" | "html", opts.reportFile, suiteOpts);
      console.log(`report (${opts.reporter}): ${file}`);
    }
    process.exitCode = blockingFailures === 0 && skipped === 0 ? 0 : 1;
    } finally {
      await runSuiteTeardown(); // always — even if a scenario/reporter threw
    }

    // --watch: after the first run, re-run the single scenario whenever a
    // scenario file changes — a fast authoring loop (single scenario only).
    if (opts.watch && !opts.all && scenarioId) {
      const { watch } = await import("node:fs");
      const { getContext } = await import("./context.js");
      const dir = getContext().paths.scenariosDir;
      console.log(`\nwatching ${dir} — re-running "${scenarioId}" on change (Ctrl-C to stop)`);
      let timer: ReturnType<typeof setTimeout> | null = null;
      let running = false;
      const rerun = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
          const scenario = await loadScenario(scenarioId);
          progressStart(scenario.scenario_id);
          printRun(await runScenario(scenario, planner, { useCache: opts.cache, summary: opts.summary, suggest: opts.suggest }));
        } catch (e) {
          console.error(`re-run failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          running = false;
        }
      };
      try {
        watch(dir, { recursive: true }, (_event, file) => {
          if (file && file.toString().endsWith(".json")) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void rerun(), 200);
          }
        });
        await new Promise(() => {}); // keep the process alive until Ctrl-C
      } catch (e) {
        console.error(`--watch is not supported here (${e instanceof Error ? e.message : e}); run without it`);
      }
    }
  });

program
  .command("record [id]")
  .description("Author by demonstration: open a headful browser, click through the flow, mark a verification with the toolbar, finish — Windup writes the scenario + caches the recorded plan ($0 replay)")
  .option("--url <start>", "start URL (default: config.baseUrl)")
  .option("--force", "overwrite if a scenario with the same id exists")
  .option("--no-llm", "don't call an LLM to summarize the task (a task is synthesized from the flow)")
  .option("--llm <provider[:model]>", "LLM used only to summarize the task from the recorded flow")
  .action(async (id: string | undefined, opts: { url?: string; force?: boolean; llm?: string | boolean }) => {
    if (typeof opts.llm === "string") process.env.WINDUP_LLM = opts.llm;
    if (!process.stdout.isTTY) { console.error("windup record needs an interactive terminal (it opens a browser you drive).\n  Under an agent/wrapper with no TTY, allocate a PTY:  script -q /dev/null npx windup record"); process.exitCode = 2; return; }
    const { runRecord } = await import("./record.js");
    await runRecord({ url: opts.url, id, force: opts.force, useLlm: opts.llm !== false });
  });

program
  .command("new <instruction...>")
  .description("Generate a scenario from a rough instruction — the LLM acts as a test author, enriching it with site-map knowledge and the project manifest")
  .option("--id <id>", "scenario id (default: derived from the flow)")
  .option("--force", "overwrite if a scenario with the same id exists")
  .option("--depends-on <ids>", "comma-separated prerequisite scenarios (e.g. --depends-on login); the new scenario continues from their final state")
  .option("--validate", "run the generated scenario and, if it fails, refine it from the failure and retry (up to 3 attempts) — you get a scenario that already passed once")
  .option("--llm <provider[:model]>", "LLM for authoring (e.g. openai:gpt-5-mini)")
  .action(async (instructionWords: string[], opts: { id?: string; force?: boolean; dependsOn?: string; validate?: boolean; llm?: string }) => {
    if (opts.llm) process.env.WINDUP_LLM = opts.llm;
    const dependsOn = opts.dependsOn?.split(",").map((d) => d.trim()).filter(Boolean);

    if (opts.validate) {
      const { generateValidatedScenario } = await import("./validate.js");
      const { result, validated, attempts } = await generateValidatedScenario(instructionWords.join(" "), { id: opts.id, force: opts.force, dependsOn });
      console.log(`scenario created: ${result.file}  (${result.provider}/${result.model})`);
      console.log("");
      console.log(`  id:        ${result.scenario.scenario_id}`);
      if (result.scenario.start_url) console.log(`  start_url: ${result.scenario.start_url}`);
      console.log(`  task:      ${result.scenario.task}`);
      console.log("");
      for (const a of attempts) {
        console.log(`  attempt ${a.attempt}: ${a.result.toUpperCase()}${a.failure ? ` — ${a.failure}` : ""}`);
      }
      console.log("");
      if (validated) {
        console.log(`✓ validated in ${attempts.length} attempt(s) — the scenario passed and its plan is cached. Run it any time: npx windup run ${result.scenario.scenario_id}`);
      } else {
        console.log(`⚠ could not get it green in ${attempts.length} attempts — the best draft was saved. Review it, then try: npx windup run ${result.scenario.scenario_id} --suggest`);
        process.exitCode = 1;
      }
      return;
    }

    const { generateScenario } = await import("./authoring.js");
    const result = await generateScenario(instructionWords.join(" "), { id: opts.id, force: opts.force, dependsOn });
    console.log(`scenario created: ${result.file}  (${result.provider}/${result.model}, ${result.llm_calls} call(s), $${result.est_cost_usd})`);
    console.log("");
    console.log(`  id:        ${result.scenario.scenario_id}`);
    if (result.scenario.depends_on?.length) console.log(`  depends:   ${result.scenario.depends_on.join(", ")} (continues from their final state)`);
    if (result.scenario.start_url) console.log(`  start_url: ${result.scenario.start_url}`);
    console.log(`  task:      ${result.scenario.task}`);
    if (result.scenario.hints?.length) console.log(`  hints:     ${result.scenario.hints.join(" | ")}`);
    console.log("");
    if (result.registered_account) {
      console.log(`credentials detected in the instruction — registered as account "${result.registered_account}":`);
      console.log(`  values   → .env.local (gitignored; set the same variable names as CI secrets)`);
      console.log(`  mapping  → windup.credentials.json (commit it — contains only ENV names, no secrets)`);
      console.log("");
    }
    console.log(`review the file (it is your test — edit freely). The task and its FINAL VERIFICATION are the LLM's best guess from your instruction and the site map — double-check the verification matches what you actually meant (an LLM can pick a plausible-but-wrong destination).`);
    console.log(`then confirm it against the app:  npx windup new "..." --validate   (generates + runs + self-refines until green), or just: npx windup run ${result.scenario.scenario_id}`);
  });

const secret = program.command("secret").description("Manage test credentials — values in .env.local, mapping in windup.credentials.json, never in scenarios or git");
secret
  .command("set <account>")
  .description("Register an account (e.g. windup secret set admin); prompts for hidden values unless flags are given")
  .option("--user <value>", "username/e-mail (prefer the interactive prompt for secrets)")
  .option("--password <value>", "password (prefer the interactive prompt: flags leak into shell history)")
  .action(async (account: string, opts: { user?: string; password?: string }) => {
    const { registerCredentials } = await import("./secrets.js");
    let { user, password } = opts;
    if (!user || !password) {
      const { text, password: hidden, isCancel } = await import("@clack/prompts");
      if (!user) {
        const answer = await text({ message: `user/e-mail for "${account}" (empty to skip)` });
        if (isCancel(answer)) return;
        user = (answer as string) || undefined;
      }
      if (!password) {
        const answer = await hidden({ message: `password for "${account}" (hidden; empty to skip)` });
        if (isCancel(answer)) return;
        password = (answer as string) || undefined;
      }
    }
    const fields = { ...(user ? { user } : {}), ...(password ? { password } : {}) };
    if (!Object.keys(fields).length) {
      console.error("nothing to register — provide at least one field");
      process.exitCode = 2;
      return;
    }
    const result = registerCredentials(account, fields);
    console.log(`account "${result.account}" registered:`);
    for (const [field, env] of Object.entries(result.envs)) console.log(`  ${field.padEnd(10)} → ${env}  (value in .env.local)`);
    console.log(`mapping in windup.credentials.json (commit it); reference the account by name in tasks: "the ${result.account} account"`);
  });
secret
  .command("remove <account>")
  .alias("rm")
  .description("Remove an account: drops the mapping, its .env.local values and clears it from the manifest")
  .action(async (account: string) => {
    const { removeCredentials } = await import("./secrets.js");
    const removed = removeCredentials(account);
    if (!removed) {
      console.error(`no account "${account}" registered — see: windup secret list`);
      process.exitCode = 1;
      return;
    }
    console.log(`account "${removed.account}" removed — ${removed.envs.length} value(s) dropped from .env.local and the mapping`);
  });
secret
  .command("list")
  .description("List registered accounts and whether their ENV values are set (never prints values)")
  .action(async () => {
    const { getContext } = await import("./context.js");
    const credentials = getContext().config.context?.credentials ?? {};
    if (!Object.keys(credentials).length) {
      console.log("no accounts registered — use: windup secret set <account>");
      return;
    }
    for (const [account, fields] of Object.entries(credentials)) {
      console.log(account);
      for (const [field, ref] of Object.entries(fields)) {
        const env = ref.replace(/^ENV:/, "");
        console.log(`  ${field.padEnd(10)} ${ref}  ${process.env[env] ? "[set]" : "[MISSING in .env.local / CI]"}`);
      }
    }
  });

program
  .command("bench <scenario>")
  .description("Run the full validation protocol (generation, replay, failure recovery) and report criteria")
  .option("--no-map", "exclude site-map knowledge from the planner prompt")
  .option("--llm <provider[:model]>", "LLM for planning (e.g. openai:gpt-5-mini) — benchmark different providers")
  .action(async (scenarioId: string, opts: { map: boolean; llm?: string }) => {
    if (opts.llm) process.env.WINDUP_LLM = opts.llm;
    const ok = await runBench(scenarioId, { useMap: opts.map });
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("scan")
  .description("Statically index the project (routes + interactive elements) into the site map")
  .option("--update", "incremental: re-index only files changed since the last scan (git diff)")
  .option("--no-assist", "skip the LLM-assist layer (static layers only, zero LLM cost)")
  .option("--llm <provider[:model]>", "LLM for the assist layer (e.g. openai:gpt-5-mini)")
  .action(async (opts: { update?: boolean; assist: boolean; llm?: string }) => {
    if (opts.llm) process.env.WINDUP_LLM = opts.llm;
    const { runScan } = await import("./scan/scan.js");
    const summary = await runScan({ update: opts.update, assist: opts.assist });
    console.log(
      `scan complete (${summary.mode}): framework=${summary.framework ?? "unknown"} routes=${summary.routes} elements=${summary.elements}` +
        (summary.assist ? `  assist=${summary.assist.calls}/${summary.assist.max_calls} calls ($${summary.assist.est_cost_usd})` : ""),
    );
    console.log(`site map: ${summary.mapFile}`);
  });

program
  .command("sig <url>")
  .description("Compute the structural signature of a page (diagnostics)")
  .option("--repeat <n>", "recompute N times with re-navigation (stability check)", "1")
  .action(async (url: string, opts: { repeat: string }) => {
    const { launchBrowser } = await import("./browser.js");
    const browser = await launchBrowser();
    try {
      const repeat = Number.parseInt(opts.repeat, 10);
      const sigs: string[] = [];
      for (let i = 1; i <= repeat; i++) {
        await browser.goto(url);
        const deadline = Date.now() + 10_000;
        while ((await browser.interactiveElementsRaw()).length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const sig = await browser.pageSignature();
        sigs.push(sig);
        console.log(`${i}/${repeat} ${sig}`);
      }
      const stable = new Set(sigs).size === 1;
      if (repeat > 1) console.log(`stability: ${stable ? "STABLE" : "UNSTABLE"} (${new Set(sigs).size} distinct signature(s))`);
      process.exitCode = stable ? 0 : 1;
    } finally {
      await browser.close();
    }
  });

program
  .command("costs")
  .description("AI usage report: cost, tokens and LLM calls aggregated from the run ledger")
  .option("--last <n>", "how many recent runs to list", "10")
  .option("--days <n>", "only include runs from the last N days")
  .option("--json", "machine-readable output")
  .action(async (opts: { last: string; days?: string; json?: boolean }) => {
    const { buildCostsReport, printCostsReport } = await import("./costs.js");
    const { getContext } = await import("./context.js");
    const report = await buildCostsReport({
      last: Number.parseInt(opts.last, 10),
      days: opts.days ? Number.parseInt(opts.days, 10) : undefined,
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printCostsReport(report, getContext().paths.runsDir);
    }
  });

program
  .command("why <scenario>")
  .description("Diagnose one scenario: cache state, re-plan churn, dependency chain, run history and the last failure — all from the ledger, no LLM")
  .option("--json", "machine-readable output")
  .action(async (scenario: string, opts: { json?: boolean }) => {
    const { buildWhy, printWhy } = await import("./why.js");
    const report = await buildWhy(scenario);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printWhy(report);
  });

program
  .command("explain <scenario>")
  .description("Print the cached plan as readable steps (go to / click / fill / verify) — review a plan without opening the JSON; never shows a fill's secret value")
  .option("--json", "machine-readable output")
  .action(async (scenario: string, opts: { json?: boolean }) => {
    const { explainPlan, printExplain } = await import("./explain.js");
    const e = await explainPlan(scenario);
    if (opts.json) console.log(JSON.stringify(e, null, 2));
    else printExplain(e);
  });

program
  .command("diff <scenario>")
  .description("Compare a scenario's two most recent runs — result, cache, cost, time and plan-size deltas (a regression check)")
  .option("--json", "machine-readable output")
  .action(async (scenario: string, opts: { json?: boolean }) => {
    const { buildDiff, printDiff } = await import("./diff.js");
    const d = await buildDiff(scenario);
    if (opts.json) console.log(JSON.stringify(d, null, 2));
    else printDiff(d);
  });

program
  .command("trends [scenario]")
  .description("Historical pass-rate, cost and duration per scenario from the run ledger (worst first); pass a scenario id for its runs over time. No LLM")
  .option("--last <n>", "with a scenario: only the last N runs")
  .option("--json", "machine-readable output")
  .action(async (scenario: string | undefined, opts: { last?: string; json?: boolean }) => {
    const { buildTrends, printTrends } = await import("./trends.js");
    const report = await buildTrends({ scenario, last: opts.last ? Number.parseInt(opts.last, 10) : undefined });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printTrends(report);
  });

program
  .command("badge")
  .description("Write a suite-status badge (each scenario's latest run): SVG by default, or a shields.io endpoint JSON")
  .option("--json", "emit shields.io endpoint JSON instead of SVG")
  .option("--out <path>", "write to this file instead of stdout")
  .action(async (opts: { json?: boolean; out?: string }) => {
    const { buildBadge, badgeSvg, badgeJson } = await import("./badge.js");
    const b = await buildBadge();
    const content = opts.json ? badgeJson(b) : badgeSvg(b);
    if (opts.out) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(opts.out), { recursive: true });
      await writeFile(opts.out, content, "utf8");
      console.log(`badge (${opts.json ? "json" : "svg"}): ${opts.out} — ${b.message}`);
    } else {
      console.log(content);
    }
  });

program
  .command("status")
  .description("Index status: pages by source, staleness, cached scenarios, fragments")
  .action(async () => {
    const { getContext } = await import("./context.js");
    const { SiteMapStore } = await import("./sitemap.js");
    const { loadFragments } = await import("./fragments.js");
    const { readdir } = await import("node:fs/promises");
    const ctx = getContext();

    const store = await SiteMapStore.load(ctx.paths.mapFile);
    const bySource = store.countBySource();
    console.log(`site map: ${store.pageCount} page(s)${store.lastScanSha ? ` | last scan: ${store.lastScanSha.slice(0, 8)}` : " | never scanned"}`);
    for (const [source, count] of Object.entries(bySource)) console.log(`  ${source}: ${count}`);

    let cached: string[] = [];
    try {
      cached = (await readdir(ctx.paths.cacheDir)).filter((f) => f.endsWith(".json") && !f.includes(".stale-"));
    } catch {
      // no cache yet
    }
    console.log(`cached scenarios: ${cached.length}${cached.length ? ` (${cached.map((f) => f.replace(".json", "")).join(", ")})` : ""}`);

    const fragments = await loadFragments();
    console.log(`fragments: ${fragments.length}${fragments.length ? ` (${fragments.map((f) => f.fragment_id).join(", ")})` : ""}`);

    // When claude-code is the active provider, surface whether its CLI is ready
    // (best-effort — never let a status probe break `windup status`).
    try {
      const { resolveLlm } = await import("./llm.js");
      if (resolveLlm().provider === "claude-code") {
        const { checkClaudeReadiness, readinessLine } = await import("./claude-cli.js");
        console.log(readinessLine(await checkClaudeReadiness()));
      }
    } catch {
      // provider unresolved or probe failed — omit the line
    }
  });

program
  .command("coverage")
  .description("Cross-reference indexed routes (from windup scan) with your scenarios: which routes have a scenario and which have none")
  .option("--json", "emit the coverage report as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { computeCoverage, printCoverage } = await import("./coverage.js");
    const report = await computeCoverage();
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printCoverage(report);
  });

program
  .command("suggest-scenarios")
  .description("Propose (write) scenarios for the site-map routes that have no scenario yet — one LLM call per route; drafts for you to review")
  .option("--limit <n>", "author for at most N uncovered routes")
  .option("--force", "overwrite an existing scenario file with the same id")
  .option("--dry-run", "list the uncovered routes that would be authored, without calling the LLM or writing files")
  .option("--llm <provider[:model]>", "LLM for authoring (e.g. openai:gpt-5-mini)")
  .option("--json", "machine-readable output")
  .action(async (opts: { limit?: string; force?: boolean; dryRun?: boolean; llm?: string; json?: boolean }) => {
    if (opts.llm) process.env.WINDUP_LLM = opts.llm;
    const { suggestScenarios, printSuggest } = await import("./suggest-scenarios.js");
    const result = await suggestScenarios({
      limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
      force: opts.force,
      dryRun: opts.dryRun,
    });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printSuggest(result);
  });

program
  .command("doctor")
  .description("Preflight checks — LLM key, browser, scenarios parse, fragment orphans, site map — before a run (no browser/LLM/network)")
  .action(async () => {
    const { runDoctor, printDoctor } = await import("./doctor.js");
    if (!printDoctor(await runDoctor())) process.exitCode = 1;
  });

const fragment = program.command("fragment").description("Manage trajectory fragments (reusable, tested action blocks)");
fragment
  .command("extract <scenario> <range>")
  .description("Promote a slice of a cached plan to a fragment (e.g. windup fragment extract login a1..a3 --id login --description 'Standard login')")
  .requiredOption("--id <id>", "fragment id (kebab-case)")
  .requiredOption("--description <desc>", "human description (shown to the planner)")
  .action(async (scenarioId: string, range: string, opts: { id: string; description: string }) => {
    const { extractFragment } = await import("./fragments.js");
    const file = await extractFragment(scenarioId, range, opts);
    console.log(`fragment created: ${file}`);
    console.log(`commit it — fragments are curated project knowledge.`);
  });

const cache = program.command("cache").description("Manage the trajectory cache");
cache
  .command("clear")
  .description("Delete the trajectory cache (next runs will re-plan)")
  .action(async () => {
    await clearCache();
    console.log("trajectory cache cleared");
  });

const claude = program
  .command("claude")
  .description("Connect the `claude` CLI that --llm claude-code uses (plan with your Claude subscription)");
claude
  .command("status")
  .description("Show whether the claude CLI is installed and logged into your Claude plan (which account is active here)")
  .option("--profile <name>", "check a named account profile instead of the active one")
  .action(async (opts: { profile?: string }) => {
    const { checkClaudeReadiness, readinessLine, isReady, profileConfigDir } = await import("./claude-cli.js");
    if (opts.profile) process.env.CLAUDE_CONFIG_DIR = profileConfigDir(opts.profile);
    const r = await checkClaudeReadiness();
    console.log(`${readinessLine(r)}${opts.profile ? `  [profile: ${opts.profile}]` : ""}`);
    if (!opts.profile && process.env.CLAUDE_CONFIG_DIR) console.log(`  config dir: ${process.env.CLAUDE_CONFIG_DIR}`);
    // Non-zero when not ready, so scripts/CI can gate on `windup claude status`.
    if (!isReady(r)) process.exitCode = 1;
  });
claude
  .command("login")
  .description("Sign the claude CLI into your Claude subscription (installs it if missing, then runs claude auth login)")
  .option("--profile <name>", "sign in as a NAMED account (its own config dir) and bind this project to it via .envrc — for holding several accounts side by side")
  .option("--force", "sign in again even when already connected (logs out first) — how you switch accounts")
  .action(async (opts: { profile?: string; force?: boolean }) => {
    const { checkClaudeReadiness, readinessLine, isReady, runInteractive, INSTALL_CMD, profileConfigDir, ensureEnvrc } = await import("./claude-cli.js");

    // --profile: this account gets its OWN config dir (the CLI keeps an
    // independent session per dir), and the project is bound to it so every
    // later run here — including the `claude` Windup spawns — uses that account.
    let configDir: string | undefined;
    if (opts.profile) {
      configDir = profileConfigDir(opts.profile);
      process.env.CLAUDE_CONFIG_DIR = configDir;
      console.log(`profile "${opts.profile}" → config dir ${configDir}`);
      const env = ensureEnvrc(process.cwd(), configDir);
      if (env.outcome === "conflict") {
        console.error(`\n${env.file} already binds another profile:\n  ${env.existing}\nEdit it by hand (or remove that line) and re-run — nothing was changed.`);
        process.exitCode = 1;
        return;
      }
      const what = { created: "wrote", appended: "appended to", already: "already bound in" }[env.outcome];
      console.log(`${what} ${env.file}`);
      const { spawnSync } = await import("node:child_process");
      const direnv = spawnSync("direnv", ["allow", process.cwd()], { stdio: "ignore" });
      console.log(
        direnv.error
          ? `  (direnv not found — this shell needs:  export CLAUDE_CONFIG_DIR="${configDir}")`
          : `  direnv allowed — entering this directory now activates the profile`,
      );
    }

    let r = await checkClaudeReadiness();

    if (!r.installed) {
      // Installing a global package modifies the system: confirm interactively,
      // and never do it silently in CI — just print the command there.
      if (!process.stdout.isTTY) {
        console.error(`the claude CLI is not installed. Run:  ${INSTALL_CMD}`);
        process.exitCode = 1;
        return;
      }
      const { confirm, isCancel } = await import("@clack/prompts");
      const ok = await confirm({ message: `The claude CLI isn't installed. Install it now?  (${INSTALL_CMD})` });
      if (isCancel(ok) || !ok) {
        console.log(`no problem — install it yourself, then re-run:  ${INSTALL_CMD}`);
        process.exitCode = 1;
        return;
      }
      console.log(`installing ${INSTALL_CMD} ...`);
      const code = await runInteractive("npm", ["i", "-g", "@anthropic-ai/claude-code"]);
      if (code !== 0) {
        console.error(`\ninstall failed (npm exited ${code}). Try it yourself — you may need elevated permissions:\n  ${INSTALL_CMD}`);
        process.exitCode = 1;
        return;
      }
      r = await checkClaudeReadiness();
    }

    // Already connected: say WHICH account, and how to switch. Without --force
    // this used to stop here silently, so someone signing in "for another
    // account" was told it worked while the old account stayed active.
    if (isReady(r) && !opts.force) {
      console.log(`already connected — ${readinessLine(r)}`);
      if (opts.profile) console.log(`this is profile "${opts.profile}"; the project is bound to it.`);
      console.log(`to sign in as a DIFFERENT account here:  npx windup claude login${opts.profile ? ` --profile ${opts.profile}` : ""} --force`);
      if (!opts.profile) console.log(`to hold several accounts side by side:  npx windup claude login --profile <name>   (per-account config dir + .envrc)`);
      console.log(`plan with it:  npx windup run <scenario> --llm claude-code`);
      return;
    }
    if (isReady(r) && opts.force) {
      // Switching means dropping the current token first — say whose, then do it.
      console.log(`signing out of ${r.auth?.email ?? "the current account"} (--force), then signing in again...`);
      await runInteractive("claude", ["auth", "logout"]);
    }

    // The sign-in is a browser flow driven from the terminal: with no TTY it can
    // only hang (and a killed flow leaves you logged OUT). Fail fast instead.
    if (!process.stdout.isTTY) {
      console.error(`signing in needs an interactive terminal (it opens a browser flow). Run this yourself:  npx windup claude login${opts.profile ? ` --profile ${opts.profile}` : ""}`);
      process.exitCode = 1;
      return;
    }
    console.log(`opening the Claude sign-in flow (claude auth login) — authorize in your browser...`);
    const code = await runInteractive("claude", ["auth", "login", "--claudeai"]);
    if (code !== 0) {
      console.error(`sign-in did not complete (claude auth login exited ${code}). Retry, or run it directly:  claude auth login`);
      process.exitCode = 1;
      return;
    }
    r = await checkClaudeReadiness();
    if (isReady(r)) {
      console.log(readinessLine(r));
      if (opts.profile) {
        console.log(`profile "${opts.profile}" is bound to this project — \`cd\` here and this account is the one that plans.`);
        console.log(`confirm anytime:  npx windup claude status`);
      }
      console.log(`you're set — plan with your subscription:  npx windup run <scenario> --llm claude-code`);
    } else {
      console.error(`still not logged in after the flow. Try again, or run:  claude auth login`);
      process.exitCode = 1;
    }
  });

/**
 * A thrown error must reach the user as a clean, actionable line — never a
 * raw Node stack trace. Known WindupError messages are already user-facing;
 * anything else prints its message with a hint to re-run with WINDUP_DEBUG=1
 * for the full stack.
 */
program
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nerror: ${message}`);
    if (process.env.WINDUP_DEBUG && err instanceof Error && err.stack) {
      console.error(`\n${err.stack}`);
    } else if (!(err instanceof WindupError)) {
      console.error("(re-run with WINDUP_DEBUG=1 for the full stack trace)");
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    const { shutdownBrowserEngine } = await import("./browser.js");
    await shutdownBrowserEngine();
  });

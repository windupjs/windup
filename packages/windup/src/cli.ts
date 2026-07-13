#!/usr/bin/env node
import "./env.js";
import { Command } from "commander";
import { clearCache } from "./cache.js";
import { LlmPlanner } from "./planner.js";
import { runScenario } from "./runner.js";
import { loadScenario } from "./scenario.js";
import { runBench } from "./bench.js";
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
  console.log(
    `${status}  ${metrics.scenario_id}  cache=${metrics.cache} llm_calls=${metrics.llm_calls}${llm} ` +
      `total=${metrics.duration_ms.total}ms (plan=${metrics.duration_ms.planning}ms exec=${metrics.duration_ms.execution}ms) ` +
      `cost=$${metrics.estimated_cost_usd}`,
  );
  if (metrics.failure) {
    console.log(`      failure [${metrics.failure.kind}] action=${metrics.failure.action_id ?? "-"}: ${metrics.failure.message}`);
  }
}

program
  .command("run [scenario]")
  .description("Run one scenario, or every scenario with --all (replays from cache; plans via LLM on miss)")
  .option("--all", "run every scenario in the scenarios directory (CI mode)")
  .option("--no-cache", "bypass the trajectory cache (always plan; nothing is cached)")
  .option("--no-map", "exclude site-map knowledge from the planner prompt")
  .option("--repeat <n>", "run N times in sequence", "1")
  .option("--headed", "show the browser window (headless off)")
  .option("--slowmo <ms>", "pause between actions in ms (watchable demo pace)")
  .option("--base-url <url>", "override the start URL origin (also: WINDUP_BASE_URL env)")
  .option("--llm <provider[:model]>", "LLM for planning, e.g. openai, openai:gpt-5-mini, google:gemini-3.1-flash-lite (also: WINDUP_LLM env)")
  .option("--summary", "after each run, an LLM writes a short debrief: what was done, concrete observed results, difficulties (1 extra LLM call per run)")
  .option("--reporter <format>", "write a report: junit | json | html")
  .option("--report-file <path>", "report destination (default: .windup/reports/windup-report.{xml,json})")
  .action(async (scenarioId: string | undefined, opts: { all?: boolean; cache: boolean; map: boolean; repeat: string; headed?: boolean; slowmo?: string; baseUrl?: string; llm?: string; summary?: boolean; reporter?: string; reportFile?: string }) => {
    if (opts.headed) process.env.HEADLESS = "false";
    if (opts.slowmo) process.env.SLOWMO_MS = opts.slowmo;
    if (opts.baseUrl) process.env.WINDUP_BASE_URL = opts.baseUrl;
    if (opts.llm) process.env.WINDUP_LLM = opts.llm;
    if (opts.reporter && !["junit", "json", "html"].includes(opts.reporter)) {
      console.error(`unknown reporter "${opts.reporter}" — use junit, json or html`);
      process.exitCode = 2;
      return;
    }

    let ids: string[];
    if (opts.all) {
      const { readdir } = await import("node:fs/promises");
      const { getContext } = await import("./context.js");
      ids = (await readdir(getContext().paths.scenariosDir))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
      if (ids.length === 0) {
        console.error("no scenarios found — write one first (npx windup init creates an example)");
        process.exitCode = 2;
        return;
      }
    } else if (scenarioId) {
      ids = [scenarioId];
    } else {
      console.error("pass a scenario id or --all");
      process.exitCode = 2;
      return;
    }

    const planner = new LlmPlanner({ useMap: opts.map });
    const repeat = Number.parseInt(opts.repeat, 10);
    const results = [];
    let failures = 0;
    for (const id of ids) {
      const scenario = await loadScenario(id);
      for (let i = 1; i <= repeat; i++) {
        if (repeat > 1) console.log(`run ${i}/${repeat}`);
        const metrics = await runScenario(scenario, planner, { useCache: opts.cache, summary: opts.summary });
        printRun(metrics);
        if (metrics.summary) {
          console.log(`      summary (${metrics.summary.provider}/${metrics.summary.model}, $${metrics.summary.est_cost_usd}):`);
          for (const line of metrics.summary.text.split("\n")) console.log(`      ${line}`);
        }
        results.push(metrics);
        if (metrics.result !== "passed") failures += 1;
      }
    }
    if (results.length > 1) console.log(`${results.length - failures}/${results.length} runs passed`);

    if (opts.reporter) {
      const { writeReport } = await import("./reporters.js");
      const file = await writeReport(results, opts.reporter as "junit" | "json" | "html", opts.reportFile);
      console.log(`report (${opts.reporter}): ${file}`);
    }
    process.exitCode = failures === 0 ? 0 : 1;
  });

program
  .command("new <instruction...>")
  .description("Generate a scenario from a rough instruction — the LLM acts as a test author, enriching it with site-map knowledge and the project manifest")
  .option("--id <id>", "scenario id (default: derived from the flow)")
  .option("--force", "overwrite if a scenario with the same id exists")
  .option("--llm <provider[:model]>", "LLM for authoring (e.g. openai:gpt-5-mini)")
  .action(async (instructionWords: string[], opts: { id?: string; force?: boolean; llm?: string }) => {
    if (opts.llm) process.env.WINDUP_LLM = opts.llm;
    const { generateScenario } = await import("./authoring.js");
    const result = await generateScenario(instructionWords.join(" "), { id: opts.id, force: opts.force });
    console.log(`scenario created: ${result.file}  (${result.provider}/${result.model}, ${result.llm_calls} call(s), $${result.est_cost_usd})`);
    console.log("");
    console.log(`  id:        ${result.scenario.scenario_id}`);
    console.log(`  start_url: ${result.scenario.start_url}`);
    console.log(`  task:      ${result.scenario.task}`);
    if (result.scenario.hints?.length) console.log(`  hints:     ${result.scenario.hints.join(" | ")}`);
    console.log("");
    console.log(`review the file (it is your test — edit freely), then: npx windup run ${result.scenario.scenario_id}`);
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

program.parseAsync(process.argv).finally(async () => {
  const { shutdownBrowserEngine } = await import("./browser.js");
  await shutdownBrowserEngine();
});

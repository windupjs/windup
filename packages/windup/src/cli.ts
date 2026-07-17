#!/usr/bin/env node
import "./env.js";
import { Command } from "commander";
import { clearCache } from "./cache.js";
import { LlmPlanner } from "./planner.js";
import { runScenario } from "./runner.js";
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
  .option("--concurrency <n>", "run scenarios in parallel, up to N at a time (default 1; great for CI suites)", "1")
  .option("--headed", "show the browser window (headless off)")
  .option("--slowmo <ms>", "pause between actions in ms (watchable demo pace)")
  .option("--base-url <url>", "override the start URL origin (also: WINDUP_BASE_URL env)")
  .option("--browser <name>", "browser engine: chromium (default) | firefox | webkit (firefox/webkit need: npx playwright install <name>)")
  .option("--llm <provider[:model]>", "LLM for planning, e.g. openai, openai:gpt-5-mini, google:gemini-3.1-flash-lite (also: WINDUP_LLM env)")
  .option("--summary", "after each run, an LLM writes a short debrief: what was done, concrete observed results, difficulties (1 extra LLM call per run)")
  .option("--suggest", "on a FAILED run, an LLM proposes a concrete fix to the scenario (task/hints) from the real final page and the site map (1 extra LLM call, only on failure)")
  .option("--reporter <format>", "write a report: junit | json | html")
  .option("--report-file <path>", "report destination (default: .windup/reports/windup-report.{xml,json})")
  .action(async (scenarioId: string | undefined, opts: { all?: boolean; cache: boolean; map: boolean; repeat: string; headed?: boolean; slowmo?: string; baseUrl?: string; browser?: string; llm?: string; summary?: boolean; suggest?: boolean; concurrency?: string; reporter?: string; reportFile?: string }) => {
    if (opts.headed) process.env.HEADLESS = "false";
    if (opts.slowmo) process.env.SLOWMO_MS = opts.slowmo;
    if (opts.baseUrl) process.env.WINDUP_BASE_URL = opts.baseUrl;
    if (opts.browser) process.env.WINDUP_BROWSER = opts.browser;
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
    const concurrency = Math.max(1, Number.parseInt(opts.concurrency ?? "1", 10) || 1);

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

    // Build the flat task list (each id × repeat). Scenarios are loaded up front.
    const scenarios = await Promise.all(ids.map((id) => loadScenario(id)));
    const jobs = scenarios.flatMap((scenario) => Array.from({ length: repeat }, () => scenario));

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
          const m = await runScenario(scenario, planner, { useCache: opts.cache, summary: opts.summary, suggest: opts.suggest, sharedMap });
          printRun(m);
          printExtras(m);
          return m;
        }),
        concurrency,
      );
      await sharedMap.save();
    } else {
      results = [];
      for (let j = 0; j < jobs.length; j++) {
        if (repeat > 1) console.log(`run ${(j % repeat) + 1}/${repeat}`);
        const m = await runScenario(jobs[j], planner, { useCache: opts.cache, summary: opts.summary, suggest: opts.suggest });
        printRun(m);
        printExtras(m);
        results.push(m);
      }
    }
    const failures = results.filter((m) => m.result !== "passed").length;
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
    console.log(`review the file (it is your test — edit freely), then: npx windup run ${result.scenario.scenario_id}`);
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
  .description("Show whether the claude CLI is installed and logged into your Claude plan")
  .action(async () => {
    const { checkClaudeReadiness, readinessLine, isReady } = await import("./claude-cli.js");
    const r = await checkClaudeReadiness();
    console.log(readinessLine(r));
    // Non-zero when not ready, so scripts/CI can gate on `windup claude status`.
    if (!isReady(r)) process.exitCode = 1;
  });
claude
  .command("login")
  .description("Sign the claude CLI into your Claude subscription (installs it if missing, then runs claude auth login)")
  .action(async () => {
    const { checkClaudeReadiness, readinessLine, isReady, runInteractive, INSTALL_CMD } = await import("./claude-cli.js");
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

    if (isReady(r)) {
      console.log(`already connected — ${readinessLine(r)}`);
      console.log(`plan with it:  npx windup run <scenario> --llm claude-code`);
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

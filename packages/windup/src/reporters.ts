import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";
import type { RunMetrics } from "./types.js";
import { buildSuiteSummary } from "./suite.js";

/**
 * CI/CD reporters. JUnit XML is the lingua franca (GitHub/GitLab/Jenkins
 * test summaries); JSON is for anything programmatic. The run ledger in
 * .windup/runs remains the raw source of truth — reports are session views.
 */
export type ReporterFormat = "junit" | "json" | "html";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function groupByModule(results: RunMetrics[]): Array<[string, RunMetrics[]]> {
  const byModule = new Map<string, RunMetrics[]>();
  for (const r of results) {
    const m = r.module ?? "(root)";
    if (!byModule.has(m)) byModule.set(m, []);
    byModule.get(m)!.push(r);
  }
  return [...byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function junitCase(r: RunMetrics): string {
  const t = (r.duration_ms.total / 1000).toFixed(3);
  const open = `    <testcase classname="${esc(r.module ?? "windup")}" name="${esc(r.scenario_id)}" time="${t}"`;
  if (r.result === "passed") return `${open}/>`;
  const f = r.failure;
  const message = esc(f ? `[${f.kind}] action=${f.action_id ?? "-"}: ${f.message}` : "failed");
  const detail = esc(`cache=${r.cache} llm_calls=${r.llm_calls} cost=$${r.estimated_cost_usd} duration=${r.duration_ms.total}ms`);
  return `${open}>\n      <failure message="${message}" type="${esc(f?.kind ?? "failure")}">${detail}</failure>\n    </testcase>`;
}

export function junitReport(results: RunMetrics[]): string {
  const failures = results.filter((r) => r.result !== "passed").length;
  const timeSec = (results.reduce((a, r) => a + r.duration_ms.total, 0) / 1000).toFixed(3);
  // One <testsuite> per module (the natural JUnit grouping for a multi-module suite).
  const suites = groupByModule(results)
    .map(([mod, rs]) => {
      const f = rs.filter((r) => r.result !== "passed").length;
      const t = (rs.reduce((a, r) => a + r.duration_ms.total, 0) / 1000).toFixed(3);
      return `  <testsuite name="${esc(mod)}" tests="${rs.length}" failures="${f}" time="${t}">\n${rs.map(junitCase).join("\n")}\n  </testsuite>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="windup" tests="${results.length}" failures="${failures}" time="${timeSec}">
${suites}
</testsuites>
`;
}

export function jsonReport(results: RunMetrics[], opts: { wall_ms?: number; concurrency?: number } = {}): string {
  const summary = buildSuiteSummary(results, opts);
  const cases = results.map((r) => ({
    scenario: r.scenario_id,
    module: r.module ?? "(root)",
    result: r.result,
    cache: r.cache,
    llm_calls: r.llm_calls,
    duration_ms: r.duration_ms.total,
    // Wall-clock breakdown so the total reconciles. `active` = this scenario's
    // own work; `contention` = time waiting for a slot under --concurrency (idle).
    duration_breakdown: (() => {
      const setup = r.duration_ms.setup ?? 0, dependencies = r.duration_ms.dependencies ?? 0;
      const planning = r.duration_ms.planning, navigation = r.duration_ms.navigation ?? 0;
      const actions = r.actions.reduce((s, a) => s + a.duration_ms + a.verify_ms, 0);
      const active = setup + dependencies + planning + navigation + actions;
      return { setup, dependencies, planning, navigation, actions, active, contention: Math.max(0, r.duration_ms.total - active) };
    })(),
    est_cost_usd: r.estimated_cost_usd,
    failure: r.failure,
    ...(r.dependencies?.length ? { dependencies: r.dependencies } : {}),
    ...(r.requires?.length ? { requires: r.requires } : {}),
    ...(r.summary ? { summary: r.summary.text } : {}),
    ...(r.suggestion ? { suggestion: r.suggestion.text } : {}),
  }));
  return `${JSON.stringify({ summary, cases }, null, 2)}\n`;
}

/**
 * HTML report: a single self-contained file (inline CSS, zero JS/deps) meant
 * for humans — CI artifact pages, a link in the PR, or opening locally.
 * Expandable failure/action detail uses native <details>, no script.
 */
export function htmlReport(results: RunMetrics[], opts: { wall_ms?: number; concurrency?: number } = {}): string {
  const passed = results.filter((r) => r.result === "passed").length;
  const failed = results.length - passed;
  const llmCalls = results.reduce((a, r) => a + r.llm_calls, 0);
  const cost = results.reduce((a, r) => a + r.estimated_cost_usd, 0).toFixed(4);
  const sumSec = (results.reduce((a, r) => a + r.duration_ms.total, 0) / 1000).toFixed(1);
  const freeReplays = results.filter((r) => r.llm_calls === 0).length;
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  const suite = buildSuiteSummary(results, opts);
  const concurrency = opts.concurrency;
  // Wall-clock (real elapsed) is the honest headline; the sum inflates ~N× under
  // --concurrency N. Show wall as the big stat and the sum as its subtitle.
  const durationStat = suite.wall_ms !== undefined
    ? `<div class="stat"><b>${(suite.wall_ms / 1000).toFixed(1)}s</b><span>wall-clock${suite.concurrency ? ` · sum ${sumSec}s ·×${suite.concurrency}` : ""}</span></div>`
    : `<div class="stat"><b>${sumSec}s</b><span>duration</span></div>`;
  const groups = groupByModule(results);
  const showModules = groups.length > 1;

  const renderRow = (r: RunMetrics): string => {
      const ok = r.result === "passed";
      const llm = r.llm_model ? `${r.llm_provider ? `${r.llm_provider}/` : ""}${r.llm_model}` : "—";
      // Closed by default: with many cases, prose paragraphs would dominate the
      // table — the label shows it exists; one click expands (<details>, no JS).
      const deps = r.dependencies?.length
        ? `<div class="deps">deps: ${r.dependencies.map((d) => `${esc(d.scenario_id)} (${d.result === "passed" ? esc(d.cache) : "FAILED"})`).join(" → ")}</div>`
        : "";
      // #3 declared DATA preconditions — helps explain a break when the seed data is gone.
      const requires = r.requires?.length
        ? `<div class="deps">requires (data): ${r.requires.map((x) => esc(x)).join(" · ")}</div>`
        : "";
      const summary = r.summary
        ? `<details class="ai-summary"><summary>AI debrief</summary><div class="ai-text">${esc(r.summary.text)}</div></details>`
        : "";
      const suggestion = r.suggestion
        ? `<details class="ai-suggestion" open><summary>Suggested fix</summary><div class="ai-text">${esc(r.suggestion.text)}</div></details>`
        : "";
      const failure = r.failure
        ? `<div class="failure"><span class="kind">[${esc(r.failure.kind)}]</span> action=${esc(r.failure.action_id ?? "-")}: ${esc(r.failure.message)}</div>`
        : "";
      // --trace artifacts saved on failure: link the trace.zip (Playwright viewer) + screenshot.
      const artifacts = r.artifacts && r.result === "failed"
        ? `<div class="deps">${r.artifacts.trace ? `<a href="${esc(r.artifacts.trace)}">trace.zip ↗</a>` : ""}${r.artifacts.trace && r.artifacts.screenshot ? " · " : ""}${r.artifacts.screenshot ? `<a href="${esc(r.artifacts.screenshot)}">screenshot ↗</a>` : ""}</div>`
        : "";
      const actions = r.actions.length
        ? `<details><summary>${r.actions.length} action(s)</summary><table class="actions">
<tr><th>id</th><th>type</th><th>what</th><th>status</th><th class="n">action</th><th class="n">verify</th></tr>
${r.actions
  .map(
    (a) =>
      `<tr><td>${esc(a.id)}</td><td class="act-type">${esc(a.type ?? "")}</td><td class="act-what">${esc(a.label ?? "")}${a.note ? ` <span class="act-note" title="the plan's selector missed; recovered by accessible name — the app's selector is fragile">${esc(a.note)}</span>` : ""}</td><td class="${a.status === "passed" ? "ok" : "bad"}">${a.status}</td><td class="n">${a.duration_ms} ms</td><td class="n">${a.verify_ms} ms</td></tr>`,
  )
  .join("\n")}
</table></details>`
        : "";
      // Reconcile the DURATION: split total into where the time actually went —
      // setup (context launch) · deps (depends_on chain) · plan (LLM) · nav
      // (goto + load/hydration before a1) · actions (sum of act+verify) · other.
      const actionsMs = r.actions.reduce((s, a) => s + a.duration_ms + a.verify_ms, 0);
      const activeSegs = [
        { k: "setup", v: r.duration_ms.setup ?? 0 },
        { k: "deps", v: r.duration_ms.dependencies ?? 0 },
        { k: "plan", v: r.duration_ms.planning },
        { k: "nav", v: r.duration_ms.navigation ?? 0 },
        { k: "actions", v: actionsMs },
      ];
      const activeMs = activeSegs.reduce((s, x) => s + x.v, 0);
      const segs = activeSegs.filter((s) => s.v > 0);
      // The remainder is time NOT spent on this scenario's own work. Under
      // --concurrency it's mostly waiting for a CPU/browser slot while siblings
      // run — idle contention, not cost. Label it honestly (feedback #2).
      const leftover = Math.max(0, r.duration_ms.total - activeMs);
      const leftoverLabel = (concurrency && concurrency > 1) ? "contention" : "other";
      if (leftover > 0) segs.push({ k: leftoverLabel, v: leftover });
      const totalMs = r.duration_ms.total || 1;
      const bar = segs.map((s) => `<span class="seg seg-${s.k === "contention" ? "other" : s.k}" style="width:${((s.v / totalMs) * 100).toFixed(1)}%" title="${s.k} ${s.v} ms"></span>`).join("");
      const legend = segs.map((s) => `${s.k} ${s.v}`).join(" · ");
      // active_ms = this scenario's own work (stable-ish across --concurrency),
      // so you can compare scenarios without the parallelization noise.
      const activeNote = leftover > 0 ? ` · <b>active ${activeMs} ms</b>${leftoverLabel === "contention" ? ` (+ ${leftover} ms contention @ ×${concurrency})` : ""}` : "";
      const breakdown = `<details class="breakdown"><summary>${r.duration_ms.total} ms — where it went</summary><div class="bar">${bar}</div><div class="bkleg">${r.duration_ms.total} ms = ${legend}${activeNote}</div></details>`;
      const a11y = r.a11y
        ? (r.a11y.violations.length
          ? `<details class="a11y"><summary>a11y: ${r.a11y.violations.length} violation(s)</summary><div class="bkleg">${r.a11y.violations.map((v) => `${esc(v.id)} — ${esc(v.impact)} (${v.nodes} node${v.nodes === 1 ? "" : "s"})`).join("<br>")}</div></details>`
          : `<div class="a11y-ok">a11y ✓</div>`)
        : "";
      const flaky = r.flaky ? ` <span class="badge flaky" title="passed only after ${(r.attempts ?? 2) - 1} retry(ies) — a flake to investigate">FLAKY ${r.attempts}×</span>` : "";
      return `<tr class="${ok ? "" : "row-failed"}">
<td><span class="badge ${ok ? "pass" : "fail"}">${ok ? "PASS" : "FAIL"}</span>${flaky}</td>
<td class="scenario">${esc(r.scenario_id)}${deps}${requires}${failure}${artifacts}${suggestion}${summary}${breakdown}${a11y}${actions}</td>
<td>${esc(r.cache)}</td>
<td class="n">${r.llm_calls}</td>
<td class="model">${esc(llm)}</td>
<td class="n">${r.duration_ms.total} ms</td>
<td class="n">$${r.estimated_cost_usd}</td>
</tr>`;
  };

  const rows = showModules
    ? groups
        .map(([mod, rs]) => {
          const f = rs.filter((r) => r.result !== "passed").length;
          const label = `${esc(mod)} — ${rs.length - f}/${rs.length}${f ? ` · ${f} failed` : ""}`;
          return `<tr class="module-row"><td colspan="7">${label}</td></tr>\n${rs.map(renderRow).join("\n")}`;
        })
        .join("\n")
    : results.map(renderRow).join("\n");

  const flakyBanner = suite.flaky.length
    ? `<div class="flaky-note"><b>Flaky (from --repeat):</b>${suite.flaky.map((x) => `<div>${esc(x.scenario_id)} ${x.passed}/${x.total} — <i>${esc(x.hint)}</i></div>`).join("")}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Windup report — ${passed}/${results.length} passed</title>
<style>
:root { --bg:#faf8f3; --card:#fff; --ink:#262218; --muted:#6e6653; --line:#e6dfce; --accent:#a87710; --pass:#2f7d4f; --pass-bg:#e3f0e7; --fail:#b5432e; --fail-bg:#f7e5e0; }
@media (prefers-color-scheme: dark) { :root { --bg:#16130e; --card:#1f1b14; --ink:#eae3d2; --muted:#9c9480; --line:#332c20; --accent:#d9a441; --pass:#63c08d; --pass-bg:#1c2f24; --fail:#e0745f; --fail-bg:#34201b; } }
* { box-sizing:border-box; }
body { margin:0; padding:32px 20px 60px; background:var(--bg); color:var(--ink); font:14px/1.5 "Avenir Next","Segoe UI",system-ui,sans-serif; }
main { max-width:960px; margin:0 auto; }
h1 { font-size:22px; margin:0; letter-spacing:-.01em; }
.sub { color:var(--muted); font-size:12.5px; margin:4px 0 20px; }
.summary { display:flex; flex-wrap:wrap; gap:10px; margin:0 0 22px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:4px; padding:10px 16px; min-width:104px; }
.stat b { display:block; font-size:20px; font-variant-numeric:tabular-nums; }
.stat span { font-size:11px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); }
.stat.p b { color:var(--pass); } .stat.f b { color:var(--fail); }
.table-wrap { background:var(--card); border:1px solid var(--line); border-radius:4px; overflow-x:auto; }
table { border-collapse:collapse; width:100%; }
th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
tr:last-child td { border-bottom:none; }
td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.badge { font:600 11px/1 ui-monospace,Menlo,monospace; padding:4px 8px; border-radius:3px; }
.badge.pass { color:var(--pass); background:var(--pass-bg); }
.badge.fail { color:var(--fail); background:var(--fail-bg); }
.badge.flaky { color:var(--accent); border:1px solid var(--accent); background:transparent; margin-left:6px; }
.scenario { font-family:ui-monospace,Menlo,monospace; font-size:13px; }
.model { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--muted); white-space:nowrap; }
.row-failed td { background:color-mix(in srgb, var(--fail-bg) 35%, transparent); }
tr.module-row td { background:color-mix(in srgb, var(--accent) 9%, transparent); font:600 11px/1 ui-monospace,Menlo,monospace; text-transform:uppercase; letter-spacing:.08em; color:var(--accent); padding:8px 12px; }
.flaky-note { background:color-mix(in srgb, var(--fail) 8%, transparent); border:1px solid var(--line); border-left:2px solid var(--fail); border-radius:0 3px 3px 0; padding:8px 12px; margin:0 0 16px; font:12.5px/1.5 ui-monospace,Menlo,monospace; }
.failure { margin-top:6px; font-size:12.5px; color:var(--fail); font-family:ui-monospace,Menlo,monospace; white-space:pre-wrap; }
.failure .kind { font-weight:700; }
.deps { margin-top:5px; font:11.5px/1.4 ui-monospace,Menlo,monospace; color:var(--muted); }
details.ai-summary { margin-top:6px; }
details.ai-summary > summary { font:600 10.5px/1.6 ui-monospace,Menlo,monospace; text-transform:uppercase; letter-spacing:.1em; color:var(--accent); cursor:pointer; }
.ai-text { margin-top:6px; font:13px/1.5 "Avenir Next","Segoe UI",system-ui,sans-serif; color:var(--ink); background:color-mix(in srgb, var(--accent) 7%, transparent); border-left:2px solid var(--accent); padding:8px 12px; border-radius:0 3px 3px 0; max-width:72ch; white-space:pre-wrap; }
details.ai-suggestion > summary { font:600 10.5px/1.6 ui-monospace,Menlo,monospace; text-transform:uppercase; letter-spacing:.1em; color:var(--fail); cursor:pointer; }
details.ai-suggestion .ai-text { background:color-mix(in srgb, var(--fail) 8%, transparent); border-left-color:var(--fail); }
details { margin-top:6px; font-family:"Avenir Next","Segoe UI",system-ui,sans-serif; }
summary { cursor:pointer; font-size:12px; color:var(--muted); }
table.actions { margin-top:6px; font-size:12px; }
table.actions th, table.actions td { padding:4px 10px; }
td.act-type { color:var(--accent); font-weight:600; }
td.act-what { color:var(--ink); max-width:42ch; }
.act-note { color:var(--accent); font-size:11px; }
td.ok { color:var(--pass); } td.bad { color:var(--fail); }
details.breakdown { margin-top:5px; }
details.breakdown summary { font:11.5px/1.4 ui-monospace,Menlo,monospace; color:var(--muted); cursor:pointer; }
.bar { display:flex; height:8px; border-radius:2px; overflow:hidden; margin:6px 0 4px; max-width:520px; background:var(--line); }
.bar .seg { height:100%; }
.seg-setup { background:#9aa0a6; } .seg-deps { background:#c78b3b; } .seg-plan { background:#7c5cc4; }
.seg-nav { background:#3b82c7; } .seg-actions { background:var(--pass); } .seg-other { background:var(--line); }
.bkleg { font:11px/1.4 ui-monospace,Menlo,monospace; color:var(--muted); }
details.a11y summary, .a11y-ok { margin-top:5px; font:11.5px/1.4 ui-monospace,Menlo,monospace; color:var(--muted); }
details.a11y summary { cursor:pointer; color:var(--fail); }
footer { color:var(--muted); font-size:11.5px; margin-top:18px; }
</style>
</head>
<body>
<main>
<h1>Windup — test report</h1>
<p class="sub">generated ${generatedAt} UTC · deterministic replay, LLM only on cache miss</p>
<div class="summary">
<div class="stat"><b>${results.length}</b><span>scenarios</span></div>
<div class="stat p"><b>${passed}</b><span>passed</span></div>
<div class="stat f"><b>${failed}</b><span>failed</span></div>
<div class="stat"><b>${Math.round(suite.cache_hit_rate * 100)}%</b><span>cache-hit</span></div>
<div class="stat"><b>${suite.replans}</b><span>re-plans</span></div>
<div class="stat"><b>${freeReplays}</b><span>zero-LLM runs</span></div>
<div class="stat"><b>${llmCalls}</b><span>llm calls</span></div>
<div class="stat"><b>$${cost}</b><span>est. cost</span></div>
${durationStat}
</div>
${flakyBanner}
<div class="table-wrap">
<table>
<tr><th></th><th>Scenario</th><th>Cache</th><th class="n">LLM calls</th><th>Model</th><th class="n">Duration</th><th class="n">Cost</th></tr>
${rows}
</table>
</div>
<footer>windup · plans are data, replays are LLM-free · raw ledger: .windup/runs/</footer>
</main>
</body>
</html>
`;
}

const REPORT_FILES: Record<ReporterFormat, string> = {
  junit: "windup-report.xml",
  json: "windup-report.json",
  html: "windup-report.html",
};

/** Write the report; returns the absolute file path. */
export async function writeReport(results: RunMetrics[], format: ReporterFormat, file?: string, opts: { wall_ms?: number; concurrency?: number } = {}): Promise<string> {
  const target = path.resolve(
    file ?? path.join(getContext().paths.root, ".windup", "reports", REPORT_FILES[format]),
  );
  await mkdir(path.dirname(target), { recursive: true });
  const content = format === "junit" ? junitReport(results) : format === "json" ? jsonReport(results, opts) : htmlReport(results, opts);
  await writeFile(target, content);
  return target;
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";
import type { RunMetrics } from "./types.js";

/**
 * CI/CD reporters. JUnit XML is the lingua franca (GitHub/GitLab/Jenkins
 * test summaries); JSON is for anything programmatic. The run ledger in
 * .windup/runs remains the raw source of truth — reports are session views.
 */
export type ReporterFormat = "junit" | "json" | "html";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function junitReport(results: RunMetrics[]): string {
  const failures = results.filter((r) => r.result !== "passed").length;
  const timeSec = (results.reduce((a, r) => a + r.duration_ms.total, 0) / 1000).toFixed(3);
  const cases = results
    .map((r) => {
      const t = (r.duration_ms.total / 1000).toFixed(3);
      const open = `    <testcase classname="windup" name="${esc(r.scenario_id)}" time="${t}"`;
      if (r.result === "passed") return `${open}/>`;
      const f = r.failure;
      const message = esc(f ? `[${f.kind}] action=${f.action_id ?? "-"}: ${f.message}` : "failed");
      const detail = esc(
        `cache=${r.cache} llm_calls=${r.llm_calls} cost=$${r.estimated_cost_usd} duration=${r.duration_ms.total}ms`,
      );
      return `${open}>\n      <failure message="${message}" type="${esc(f?.kind ?? "failure")}">${detail}</failure>\n    </testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="windup" tests="${results.length}" failures="${failures}" time="${timeSec}">
  <testsuite name="windup" tests="${results.length}" failures="${failures}" time="${timeSec}">
${cases}
  </testsuite>
</testsuites>
`;
}

export function jsonReport(results: RunMetrics[]): string {
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.result === "passed").length,
    failed: results.filter((r) => r.result !== "passed").length,
    llm_calls: results.reduce((a, r) => a + r.llm_calls, 0),
    est_cost_usd: Number(results.reduce((a, r) => a + r.estimated_cost_usd, 0).toFixed(6)),
    duration_ms: results.reduce((a, r) => a + r.duration_ms.total, 0),
  };
  const cases = results.map((r) => ({
    scenario: r.scenario_id,
    result: r.result,
    cache: r.cache,
    llm_calls: r.llm_calls,
    duration_ms: r.duration_ms.total,
    est_cost_usd: r.estimated_cost_usd,
    failure: r.failure,
    ...(r.summary ? { summary: r.summary.text } : {}),
  }));
  return `${JSON.stringify({ summary, cases }, null, 2)}\n`;
}

/**
 * HTML report: a single self-contained file (inline CSS, zero JS/deps) meant
 * for humans — CI artifact pages, a link in the PR, or opening locally.
 * Expandable failure/action detail uses native <details>, no script.
 */
export function htmlReport(results: RunMetrics[]): string {
  const passed = results.filter((r) => r.result === "passed").length;
  const failed = results.length - passed;
  const llmCalls = results.reduce((a, r) => a + r.llm_calls, 0);
  const cost = results.reduce((a, r) => a + r.estimated_cost_usd, 0).toFixed(4);
  const durationSec = (results.reduce((a, r) => a + r.duration_ms.total, 0) / 1000).toFixed(1);
  const freeReplays = results.filter((r) => r.llm_calls === 0).length;
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");

  const rows = results
    .map((r) => {
      const ok = r.result === "passed";
      const llm = r.llm_model ? `${r.llm_provider ? `${r.llm_provider}/` : ""}${r.llm_model}` : "—";
      // Fechado por padrão: com muitos casos, parágrafos de prosa dominariam a
      // tabela — o rótulo indica que existe; um clique expande (<details>, sem JS).
      const summary = r.summary
        ? `<details class="ai-summary"><summary>AI debrief</summary><div class="ai-text">${esc(r.summary.text)}</div></details>`
        : "";
      const failure = r.failure
        ? `<div class="failure"><span class="kind">[${esc(r.failure.kind)}]</span> action=${esc(r.failure.action_id ?? "-")}: ${esc(r.failure.message)}</div>`
        : "";
      const actions = r.actions.length
        ? `<details><summary>${r.actions.length} action(s)</summary><table class="actions">
<tr><th>id</th><th>status</th><th class="n">action</th><th class="n">verify</th></tr>
${r.actions
  .map(
    (a) =>
      `<tr><td>${esc(a.id)}</td><td class="${a.status === "passed" ? "ok" : "bad"}">${a.status}</td><td class="n">${a.duration_ms} ms</td><td class="n">${a.verify_ms} ms</td></tr>`,
  )
  .join("\n")}
</table></details>`
        : "";
      return `<tr class="${ok ? "" : "row-failed"}">
<td><span class="badge ${ok ? "pass" : "fail"}">${ok ? "PASS" : "FAIL"}</span></td>
<td class="scenario">${esc(r.scenario_id)}${failure}${summary}${actions}</td>
<td>${esc(r.cache)}</td>
<td class="n">${r.llm_calls}</td>
<td class="model">${esc(llm)}</td>
<td class="n">${r.duration_ms.total} ms</td>
<td class="n">$${r.estimated_cost_usd}</td>
</tr>`;
    })
    .join("\n");

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
.scenario { font-family:ui-monospace,Menlo,monospace; font-size:13px; }
.model { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--muted); white-space:nowrap; }
.row-failed td { background:color-mix(in srgb, var(--fail-bg) 35%, transparent); }
.failure { margin-top:6px; font-size:12.5px; color:var(--fail); font-family:ui-monospace,Menlo,monospace; white-space:pre-wrap; }
.failure .kind { font-weight:700; }
details.ai-summary { margin-top:6px; }
details.ai-summary > summary { font:600 10.5px/1.6 ui-monospace,Menlo,monospace; text-transform:uppercase; letter-spacing:.1em; color:var(--accent); cursor:pointer; }
.ai-text { margin-top:6px; font:13px/1.5 "Avenir Next","Segoe UI",system-ui,sans-serif; color:var(--ink); background:color-mix(in srgb, var(--accent) 7%, transparent); border-left:2px solid var(--accent); padding:8px 12px; border-radius:0 3px 3px 0; max-width:72ch; white-space:pre-wrap; }
details { margin-top:6px; font-family:"Avenir Next","Segoe UI",system-ui,sans-serif; }
summary { cursor:pointer; font-size:12px; color:var(--muted); }
table.actions { margin-top:6px; font-size:12px; }
table.actions th, table.actions td { padding:4px 10px; }
td.ok { color:var(--pass); } td.bad { color:var(--fail); }
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
<div class="stat"><b>${freeReplays}</b><span>zero-LLM runs</span></div>
<div class="stat"><b>${llmCalls}</b><span>llm calls</span></div>
<div class="stat"><b>$${cost}</b><span>est. cost</span></div>
<div class="stat"><b>${durationSec}s</b><span>duration</span></div>
</div>
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
export async function writeReport(results: RunMetrics[], format: ReporterFormat, file?: string): Promise<string> {
  const target = path.resolve(
    file ?? path.join(getContext().paths.root, ".windup", "reports", REPORT_FILES[format]),
  );
  await mkdir(path.dirname(target), { recursive: true });
  const content = format === "junit" ? junitReport(results) : format === "json" ? jsonReport(results) : htmlReport(results);
  await writeFile(target, content);
  return target;
}

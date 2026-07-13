import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getContext } from "./context.js";
import type { RunMetrics } from "./types.js";

/**
 * CI/CD reporters. JUnit XML is the lingua franca (GitHub/GitLab/Jenkins
 * test summaries); JSON is for anything programmatic. The run ledger in
 * .windup/runs remains the raw source of truth — reports are session views.
 */
export type ReporterFormat = "junit" | "json";

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
  }));
  return `${JSON.stringify({ summary, cases }, null, 2)}\n`;
}

/** Write the report; returns the absolute file path. */
export async function writeReport(results: RunMetrics[], format: ReporterFormat, file?: string): Promise<string> {
  const target = path.resolve(
    file ?? path.join(getContext().paths.root, ".windup", "reports", format === "junit" ? "windup-report.xml" : "windup-report.json"),
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, format === "junit" ? junitReport(results) : jsonReport(results));
  return target;
}

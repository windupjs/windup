import { appendFile } from "node:fs/promises";
import type { SuiteSummary } from "./suite.js";
import type { RunMetrics } from "./types.js";

/** Auto-enable the GitHub output when running inside GitHub Actions. */
export function inGithubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

/** GitHub workflow-command escaping (properties + message use %0A/%0D/%25). */
const esc = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/**
 * Print a `::error::` workflow annotation for every failed scenario — GitHub
 * surfaces these inline on the PR / job. One line per failure to stdout.
 */
export function githubAnnotate(results: RunMetrics[]): void {
  for (const r of results) {
    if (r.result !== "failed") continue;
    const msg = r.failure ? `[${r.failure.kind}] action=${r.failure.action_id ?? "-"}: ${r.failure.message}` : "failed";
    console.log(`::error title=${esc(`windup: ${r.scenario_id}`)}::${esc(msg)}`);
  }
}

/** Append a Markdown suite summary to $GITHUB_STEP_SUMMARY (shown on the job page). No-op outside GA. */
export async function githubStepSummary(summary: SuiteSummary, results: RunMetrics[]): Promise<void> {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const time = summary.wall_ms !== undefined ? `wall ${(summary.wall_ms / 1000).toFixed(1)}s` : `${(summary.duration_ms / 1000).toFixed(1)}s`;
  const rows = results
    .map((r) => `| ${r.scenario_id} | ${r.result === "passed" ? "✅" : "❌"} | ${r.cache} | ${r.llm_calls} | ${(r.duration_ms.total / 1000).toFixed(1)}s |`)
    .join("\n");
  const md =
    `## Windup — ${summary.passed}/${summary.total} passed (${Math.round(summary.pass_rate * 100)}%)\n\n` +
    `cache-hit ${Math.round(summary.cache_hit_rate * 100)}% · re-plans ${summary.replans} · llm_calls ${summary.llm_calls} · $${summary.est_cost_usd} · ${time}\n\n` +
    `| Scenario | Result | Cache | LLM | Time |\n|---|:---:|---|--:|--:|\n${rows}\n\n`;
  await appendFile(file, md);
}

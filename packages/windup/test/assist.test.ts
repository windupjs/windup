import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selectCandidates, runAssist, type AssistCaller } from "../src/scan/assist.js";
import { createContext, setContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runScan } from "../src/scan/scan.js";
import { SiteMapStore } from "../src/sitemap.js";
import { readdir, readFile } from "node:fs/promises";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "react-router-app");
const DYNAMIC = path.resolve(FIXTURE, "src", "dynamicRoutes.tsx");

describe("selectCandidates (P4)", () => {
  it("prioriza arquivo com padrão de router que não rendeu rotas", () => {
    const files = [
      { file: DYNAMIC, content: 'import { createBrowserRouter } from "react-router-dom"; path: `/x/${y}`' },
      { file: "/proj/src/pages/Loose.tsx", content: "export const x = 1;" },
      { file: "/proj/src/util.ts", content: "export const u = 2;" },
    ];
    const candidates = selectCandidates(files, new Set(), new Set());
    expect(candidates[0]).toEqual({ file: DYNAMIC, reason: "router-no-routes" });
    expect(candidates.some((c) => c.file === "/proj/src/pages/Loose.tsx" && c.reason === "page-dir-uncovered")).toBe(true);
    expect(candidates.some((c) => c.file === "/proj/src/util.ts")).toBe(false);
  });

  it("arquivo já coberto não é candidato", () => {
    const files = [{ file: DYNAMIC, content: "createBrowserRouter" }];
    expect(selectCandidates(files, new Set([DYNAMIC]), new Set())).toHaveLength(0);
  });
});

describe("runScan com LLM-assist (caller fake)", () => {
  it("detecta rota dinâmica via assist, grava no ledger e a fatia oferece com menor precedência", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "windup-assist-"));
    process.env.WINDUP_CACHE_DIR = path.join(dataDir, "cache");
    const base = createContext(FIXTURE);
    setContext({
      config: { ...DEFAULT_CONFIG, framework: "react-router", scan: { root: ".", llmAssist: { enabled: true, maxCalls: 3 } } },
      paths: { ...base.paths, mapFile: path.join(dataDir, "site-map.json"), runsDir: path.join(dataDir, "runs") },
    });

    const fake: AssistCaller = async (prompt: string) => {
      const isDynamic = prompt.includes("dynamicRoutes");
      return {
        text: JSON.stringify(
          isDynamic
            ? { routes: [
                { path: "/reports/billing", elements: ["button id=export-report data-test=report-export"] },
                { path: "/reports/audit", elements: ["button id=export-report data-test=report-export"] },
              ] }
            : { routes: [] },
        ),
        tokens: { input: 500, output: 80 },
      };
    };

    const summary = await runScan({ assistCaller: fake });
    expect(summary.assist).not.toBeNull();
    expect(summary.assist!.calls).toBeGreaterThan(0);
    expect(summary.assist!.calls).toBeLessThanOrEqual(3);

    const store = await SiteMapStore.load(path.join(dataDir, "site-map.json"));
    const slice = store.sliceForPrompt("sig:unknown", "exportar o relatório de billing", 8000);
    expect(slice).toContain("**/reports/billing");
    expect(slice).toContain("inferida por IA");

    // Custo do assist no ledger (windup costs)
    const ledger = await readdir(path.join(dataDir, "runs"));
    const scanRecord = ledger.find((f) => f.startsWith("scan-"));
    expect(scanRecord).toBeDefined();
    const record = JSON.parse(await readFile(path.join(dataDir, "runs", scanRecord!), "utf8"));
    expect(record.kind).toBe("scan");
    expect(record.llm_calls).toBe(summary.assist!.calls);

    // --no-assist pula a camada
    const noAssist = await runScan({ assist: false, assistCaller: fake });
    expect(noAssist.assist).toBeNull();

    setContext(createContext());
  }, 30_000);
});

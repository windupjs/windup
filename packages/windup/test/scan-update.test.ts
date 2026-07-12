import { execFile } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createContext, setContext } from "../src/context.js";
import { runScan } from "../src/scan/scan.js";
import { SiteMapStore } from "../src/sitemap.js";

const exec = promisify(execFile);
const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "next-app");

async function gitFixture(): Promise<{ root: string; mapFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "windup-p3-"));
  await cp(FIXTURE, root, { recursive: true });
  const run = (args: string[]) => exec("git", args, { cwd: root });
  await run(["init", "-q", "-b", "main"]);
  await run(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  await run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "inicial"]);
  const mapFile = path.join(root, ".windup", "site-map.json");
  setContext({
    config: { ...DEFAULT_CONFIG, framework: "next", scan: { root: "." } },
    paths: { ...createContext(root).paths, mapFile },
  });
  return { root, mapFile };
}

describe("scan --update incremental via git (P3)", () => {
  it("editar 1 componente → só a rota afetada re-indexada; execução da mesma url vira stale", async () => {
    const { root, mapFile } = await gitFixture();

    const full = await runScan();
    expect(full.mode).toBe("full");
    expect(full.routes).toBe(7);

    // Simula conhecimento de execução da home (mesma url do estático "/").
    let store = await SiteMapStore.load(mapFile);
    store.upsertPage({ sig: "sig:home-exec", url: "http://localhost:3000/", title: "Home", interactive: ["button id=x"] });
    await store.save();

    // Edita SÓ o componente Hero (importado pela home).
    await writeFile(path.join(root, "src", "components", "Hero.tsx"), `export function Hero() {\n  return <button data-testid="cta-hero-v2">Começar já</button>;\n}\n`);

    const update = await runScan({ update: true });
    expect(update.mode).toBe("incremental");
    expect(update.routes).toBe(1); // só a home

    store = await SiteMapStore.load(mapFile);
    // O nó estático da home foi re-indexado com o elemento novo…
    const slice = store.sliceForPrompt("sig:desconhecida", "comecar cta hero", 8000);
    expect(slice).toContain("cta-hero-v2");
    // …e o conhecimento de EXECUÇÃO da mesma url ficou stale (fora da fatia).
    const raw = JSON.parse(JSON.stringify(await import("node:fs/promises").then((fs) => fs.readFile(mapFile, "utf8").then(JSON.parse))));
    expect(raw.pages["sig:home-exec"].stale).toBe(true);

    // Nova observação em execução limpa o stale.
    store.upsertPage({ sig: "sig:home-exec", url: "http://localhost:3000/", title: "Home", interactive: ["button id=y"] });
    await store.save();
    const raw2 = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(mapFile, "utf8")));
    expect(raw2.pages["sig:home-exec"].stale).toBe(false);

    setContext(createContext());
  }, 30_000);

  it("--update sem scan anterior cai para full", async () => {
    await gitFixture();
    const summary = await runScan({ update: true });
    expect(summary.mode).toBe("full");
    expect(summary.routes).toBe(7);
    setContext(createContext());
  }, 30_000);
});

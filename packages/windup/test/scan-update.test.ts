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
  await run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial"]);
  const mapFile = path.join(root, ".windup", "site-map.json");
  setContext({
    config: { ...DEFAULT_CONFIG, framework: "next", scan: { root: "." } },
    paths: { ...createContext(root).paths, mapFile },
  });
  return { root, mapFile };
}

describe("incremental scan --update via git (P3)", () => {
  it("editing 1 component → only the affected route re-indexed; execution knowledge of the same url goes stale", async () => {
    const { root, mapFile } = await gitFixture();

    const full = await runScan();
    expect(full.mode).toBe("full");
    expect(full.routes).toBe(7);

    // Simulates execution knowledge of the home page (same url as the static "/").
    let store = await SiteMapStore.load(mapFile);
    store.upsertPage({ sig: "sig:home-exec", url: "http://localhost:3000/", title: "Home", interactive: ["button id=x"] });
    await store.save();

    // Edits ONLY the Hero component (imported by the home page).
    await writeFile(path.join(root, "src", "components", "Hero.tsx"), `export function Hero() {\n  return <button data-testid="cta-hero-v2">Start now</button>;\n}\n`);

    const update = await runScan({ update: true });
    expect(update.mode).toBe("incremental");
    expect(update.routes).toBe(1); // only the home page

    store = await SiteMapStore.load(mapFile);
    // The home's static node was re-indexed with the new element…
    const slice = store.sliceForPrompt("sig:desconhecida", "start cta hero", 8000);
    expect(slice).toContain("cta-hero-v2");
    // …and the EXECUTION knowledge of the same url went stale (out of the slice).
    const raw = JSON.parse(JSON.stringify(await import("node:fs/promises").then((fs) => fs.readFile(mapFile, "utf8").then(JSON.parse))));
    expect(raw.pages["sig:home-exec"].stale).toBe(true);

    // A new observation from execution clears the stale flag.
    store.upsertPage({ sig: "sig:home-exec", url: "http://localhost:3000/", title: "Home", interactive: ["button id=y"] });
    await store.save();
    const raw2 = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(mapFile, "utf8")));
    expect(raw2.pages["sig:home-exec"].stale).toBe(false);

    setContext(createContext());
  }, 30_000);

  it("--update without a previous scan falls back to full", async () => {
    await gitFixture();
    const summary = await runScan({ update: true });
    expect(summary.mode).toBe("full");
    expect(summary.routes).toBe(7);
    setContext(createContext());
  }, 30_000);
});

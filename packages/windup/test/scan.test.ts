import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractElements, formatElement } from "../src/scan/extract.js";
import { collectRouteSources, indexNextRoutes } from "../src/scan/nextjs.js";
import { createContext, setContext } from "../src/context.js";
import { SiteMapStore } from "../src/sitemap.js";
import { runScan } from "../src/scan/scan.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "next-app");

describe("indexNextRoutes (P2 camada 1)", () => {
  it("detecta todas as rotas por convenção (app + pages), ignorando api e grupos", async () => {
    const routes = (await indexNextRoutes(FIXTURE)).map((r) => r.route).sort();
    // Critério P2: ≥ 90% das rotas por convenção — na fixture, 7/7 (100%).
    expect(routes).toEqual(["/", "/checkout", "/dashboard/settings", "/legacy", "/login", "/products", "/products/:id"]);
  });

  it("coleta fontes compostas da rota (imports locais e @/)", async () => {
    const routes = await indexNextRoutes(FIXTURE);
    const home = routes.find((r) => r.route === "/")!;
    const files = await collectRouteSources(home, FIXTURE);
    expect(files.some((f) => f.endsWith("Hero.tsx"))).toBe(true);
  });
});

describe("extractElements (P2 camada 2)", () => {
  it("extrai id/name/data-test(id)/type/aria/placeholder de JSX", () => {
    const source = `
      <input id="email" name="email" type="email" data-testid="login-email" placeholder="Seu e-mail" />
      <button type="submit" data-testid="login-submit">Entrar</button>
      <a href="/x">Link com texto entra (label é traço identificável)</a>
      <a href="/y"></a>
    `;
    const lines = extractElements(source).map(formatElement);
    expect(lines).toHaveLength(4); // href também é traço identificável
    expect(lines[0]).toContain("data-test=login-email");
    expect(lines[0]).toContain("id=email");
    expect(lines[1]).toContain("text=Entrar");
    expect(lines[2]).toContain("text=Link com texto");
    expect(lines[3]).toContain("href=/y");
  });

  it("aceita atributos com chaves JSX de string literal", () => {
    const lines = extractElements(`<button data-testid={"buy"} aria-label={'Comprar'}>Ir</button>`).map(formatElement);
    expect(lines[0]).toContain("data-test=buy");
    expect(lines[0]).toContain("aria-label=Comprar");
  });
});

describe("runScan (P2 integração)", () => {
  it("popula o mapa com nós static e a fatia os oferece por casamento de termos", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "windup-scan-"));
    process.env.WINDUP_CACHE_DIR = path.join(dataDir, "cache");
    setContext({
      config: { ...DEFAULT_CONFIG, framework: "next", scan: { root: "." } },
      paths: {
        ...createContext(FIXTURE).paths,
        mapFile: path.join(dataDir, "site-map.json"),
      },
    });

    const summary = await runScan();
    expect(summary.framework).toBe("next");
    expect(summary.routes).toBe(7);
    expect(summary.elements).toBeGreaterThan(8);

    const store = await SiteMapStore.load(path.join(dataDir, "site-map.json"));
    expect(store.pageCount).toBe(7);
    const slice = store.sliceForPrompt("sig:desconhecida", "fazer login com e-mail e senha", 8000);
    expect(slice).toContain("**/login");
    expect(slice).toContain("data-test=login-submit");
    expect(slice).toContain("detectada no código-fonte");

    setContext(createContext());
  });
});

describe("extractElements com componentes de design system (shadcn/MUI)", () => {
  it("lê <Input>, <Button>, <Link to>, <Label htmlFor> como elementos semânticos", () => {
    const source = `
      <Label htmlFor="email" className={x}>E-mail</Label>
      <Input id="email" type="email" placeholder="you@corp.com" />
      <Button type="submit" data-testid="login-go">Entrar</Button>
      <Link to="/dashboard" className="nav">Painel</Link>
      <Switch id="dark-mode" />
    `;
    const lines = extractElements(source).map(formatElement);
    expect(lines.some((l) => l.startsWith("label") && l.includes("for=email") && l.includes("text=E-mail"))).toBe(true);
    expect(lines.some((l) => l.startsWith("input id=email") && l.includes("type=email"))).toBe(true);
    expect(lines.some((l) => l.startsWith("button") && l.includes("data-test=login-go"))).toBe(true);
    expect(lines.some((l) => l.startsWith("a") && l.includes("href=/dashboard") && l.includes("text=Painel"))).toBe(true);
    expect(lines.some((l) => l.startsWith("input id=dark-mode"))).toBe(true);
  });
});

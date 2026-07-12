import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Mapa do site (SPEC-001, componente 1): grafo de páginas (nós, por
 * assinatura) e transições (arestas). Alimentação principal é PASSIVA —
 * toda execução também coleta (princípio 3). Conhecimento é cache, não
 * verdade: tudo aqui pode estar desatualizado e degrada para descoberta
 * em runtime.
 *
 * Persistência: JSON local atrás desta interface. SQLite foi adiado de
 * propósito — reavaliar no P2 com dados reais de escala (decisão em aberto
 * da SPEC-001 registrada aqui).
 */
export interface MapPage {
  urls_seen: string[];
  url_pattern: string;
  title: string;
  /** Linhas no mesmo formato do prompt (tag id=... data-test=...). */
  interactive: string[];
  /** Precedência de confiança: execution > crawl > static (SPEC-002). */
  source: "static" | "crawl" | "execution";
  first_seen: string;
  last_seen: string;
  seen_count: number;
}

export interface MapTransition {
  from: string;
  action: { type: string; selector: string };
  to: string;
  seen_count: number;
}

export interface SiteMap {
  map_version: "0.1";
  /** P3: SHA do último scan estático (preparado, não usado). */
  last_scan_sha: string | null;
  pages: Record<string, MapPage>;
  transitions: MapTransition[];
}

const EMPTY_MAP: SiteMap = { map_version: "0.1", last_scan_sha: null, pages: {}, transitions: [] };

export interface PageObservation {
  sig: string;
  url: string;
  title: string;
  interactive: string[];
}

export class SiteMapStore {
  private constructor(
    private readonly file: string,
    private readonly map: SiteMap,
  ) {}

  static async load(file: string): Promise<SiteMapStore> {
    try {
      const map = JSON.parse(await readFile(file, "utf8")) as SiteMap;
      if (map.map_version !== "0.1") return new SiteMapStore(file, structuredClone(EMPTY_MAP));
      return new SiteMapStore(file, map);
    } catch {
      return new SiteMapStore(file, structuredClone(EMPTY_MAP));
    }
  }

  get pageCount(): number {
    return Object.keys(this.map.pages).length;
  }

  upsertPage(obs: PageObservation): void {
    const now = new Date().toISOString();
    const existing = this.map.pages[obs.sig];
    if (existing) {
      if (!existing.urls_seen.includes(obs.url)) existing.urls_seen.push(obs.url);
      existing.url_pattern = derivePattern(existing.urls_seen);
      existing.title = obs.title || existing.title;
      existing.interactive = obs.interactive;
      existing.last_seen = now;
      existing.seen_count += 1;
      // O que foi visto rodando vale mais do que o inferido do código.
      existing.source = "execution";
    } else {
      this.map.pages[obs.sig] = {
        urls_seen: [obs.url],
        url_pattern: derivePattern([obs.url]),
        title: obs.title,
        interactive: obs.interactive,
        source: "execution",
        first_seen: now,
        last_seen: now,
        seen_count: 1,
      };
    }
  }

  recordTransition(from: string, action: { type: string; selector: string }, to: string): void {
    const existing = this.map.transitions.find(
      (t) => t.from === from && t.to === to && t.action.type === action.type && t.action.selector === action.selector,
    );
    if (existing) {
      existing.seen_count += 1;
    } else {
      this.map.transitions.push({ from, action, to, seen_count: 1 });
    }
  }

  /**
   * Fatia do mapa para o prompt do planejador: BFS a partir da página inicial
   * (profundidade ≤ 3), priorizada por casamento de termos da tarefa, cortada
   * pelo orçamento de chars. Devolve string vazia se nada alcançável.
   */
  sliceForPrompt(startSig: string, task: string, budgetChars: number): string {
    if (!this.map.pages[startSig]) return "";

    // BFS
    const depths = new Map<string, number>([[startSig, 0]]);
    const queue = [startSig];
    while (queue.length) {
      const sig = queue.shift()!;
      const depth = depths.get(sig)!;
      if (depth >= 3) continue;
      for (const t of this.map.transitions) {
        if (t.from === sig && !depths.has(t.to) && this.map.pages[t.to]) {
          depths.set(t.to, depth + 1);
          queue.push(t.to);
        }
      }
    }
    depths.delete(startSig); // a página inicial já entra viva no prompt

    const terms = tokenize(task);
    const scored = [...depths.keys()]
      .map((sig) => ({ sig, page: this.map.pages[sig], score: score(this.map.pages[sig], terms) }))
      .sort((a, b) => b.score - a.score);

    const blocks: string[] = [];
    let used = 0;
    for (const { sig, page } of scored) {
      const block = this.formatPage(sig, page);
      if (used + block.length > budgetChars) continue;
      blocks.push(block);
      used += block.length;
    }
    return blocks.join("\n\n");
  }

  private formatPage(sig: string, page: MapPage): string {
    const routes = this.map.transitions
      .filter((t) => t.to === sig && this.map.pages[t.from])
      .slice(0, 3)
      .map((t) => `- chega-se aqui com ${t.action.type} '${t.action.selector}' a partir de ${this.map.pages[t.from].url_pattern}`);
    const elements = page.interactive.slice(0, 30);
    return [
      `## Página conhecida: ${page.url_pattern}${page.title ? ` — ${page.title}` : ""}`,
      ...routes,
      `Elementos interativos observados:`,
      ...elements,
    ].join("\n");
  }

  /** Escrita atômica (tmp + rename). Falha de save nunca deve derrubar um run. */
  async save(): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.map, null, 2));
      await rename(tmp, this.file);
    } catch (err) {
      console.warn(`[windup] aviso: falha ao salvar mapa do site: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Pattern glob a partir do pathname mais comum entre as URLs vistas. */
function derivePattern(urls: string[]): string {
  const counts = new Map<string, number>();
  for (const u of urls) {
    try {
      const pathname = new URL(u).pathname;
      counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
    } catch {
      // URL inválida não contribui para o pattern
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? `**${top[0]}` : urls[0] ?? "**";
}

const STOPWORDS = new Set(["a", "o", "as", "os", "e", "de", "do", "da", "dos", "das", "no", "na", "nos", "nas", "um", "uma", "com", "para", "que", "em", "ao", "à", "the", "and", "to", "of", "in", "on", "at", "verificar", "verifique"]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function score(page: MapPage, terms: string[]): number {
  const haystack = `${page.title} ${page.url_pattern} ${page.interactive.join(" ")}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  let s = 0;
  for (const term of terms) if (haystack.includes(term)) s += 1;
  return s;
}

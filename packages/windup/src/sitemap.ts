import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Site map (SPEC-001, component 1): a graph of pages (nodes, by signature)
 * and transitions (edges). The main feed is PASSIVE — every execution also
 * collects (principle 3). Knowledge is cache, not truth: everything here
 * may be outdated and degrades to runtime discovery.
 *
 * Persistence: local JSON behind this interface. SQLite was deferred on
 * purpose — revisit in P2 with real scale data (open SPEC-001 decision
 * recorded here).
 */
export interface MapPage {
  urls_seen: string[];
  url_pattern: string;
  title: string;
  /** Lines in the same format as the prompt (tag id=... data-test=...). */
  interactive: string[];
  /** Confidence precedence: execution > crawl > static > llm (SPEC-002). */
  source: "static" | "crawl" | "execution" | "llm";
  first_seen: string;
  last_seen: string;
  seen_count: number;
  /** Sources defining the page (only source: static; input for P3 diff→stale). */
  files?: string[];
  /** P3: source changed since the last scan — outdated hint, leaves the slice. */
  stale?: boolean;
}

export interface MapTransition {
  from: string;
  action: { type: string; selector: string };
  to: string;
  seen_count: number;
}

export interface SiteMap {
  map_version: "0.1";
  /** P3: SHA of the last static scan (prepared, not used). */
  last_scan_sha: string | null;
  pages: Record<string, MapPage>;
  transitions: MapTransition[];
  /** LLM-assist memory: analyzed file → content hash (never pays again). */
  assist_seen?: Record<string, string>;
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
      // What was seen at runtime outranks what was inferred from code —
      // and a fresh observation clears the stale flag.
      existing.source = "execution";
      existing.stale = false;
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

  /**
   * Node from static indexing (P2). Lives under its own key (`static:`);
   * never overwrites execution knowledge — the execution > static
   * precedence is applied in the prompt slice, per url.
   */
  upsertStaticPage(route: string, elements: string[], files: string[]): void {
    const sig = `static:${createHash("sha256").update(route).digest("hex").slice(0, 16)}`;
    const now = new Date().toISOString();
    const existing = this.map.pages[sig];
    if (existing) {
      existing.interactive = elements;
      existing.files = files;
      existing.last_seen = now;
      existing.seen_count += 1;
      existing.stale = false;
    } else {
      this.map.pages[sig] = {
        urls_seen: [route],
        url_pattern: `**${route}`,
        title: "",
        interactive: elements,
        source: "static",
        first_seen: now,
        last_seen: now,
        seen_count: 1,
        files,
        stale: false,
      };
    }
  }

  /**
   * Node from the LLM-assist (P4): the lowest confidence of all — its own
   * key, never overwrites anything; enters the slice only when no better
   * source covers the same url.
   */
  upsertLlmPage(route: string, elements: string[], file: string): void {
    const sig = `llm:${createHash("sha256").update(route).digest("hex").slice(0, 16)}`;
    const now = new Date().toISOString();
    const existing = this.map.pages[sig];
    if (existing) {
      existing.interactive = elements;
      existing.files = [file];
      existing.last_seen = now;
      existing.seen_count += 1;
      existing.stale = false;
    } else {
      this.map.pages[sig] = {
        urls_seen: [route],
        url_pattern: `**${route}`,
        title: "",
        interactive: elements,
        source: "llm",
        first_seen: now,
        last_seen: now,
        seen_count: 1,
        files: [file],
        stale: false,
      };
    }
  }

  /**
   * P3: sources changed since the last scan. Marks stale (a) the affected
   * static nodes — which scan --update re-indexes right after — and (b) the
   * EXECUTION nodes for the same url: the observed runtime may have changed
   * with the code, and stale knowledge leaves the prompt slice until a new
   * observation.
   */
  markStaleByFiles(changedFiles: string[]): string[] {
    const changed = new Set(changedFiles.map((f) => path.resolve(f)));
    const marked: string[] = [];
    const affectedPatterns = new Set<string>();
    for (const [sig, page] of Object.entries(this.map.pages)) {
      if (page.source !== "static" || !page.files) continue;
      if (page.files.some((f) => changed.has(path.resolve(f)))) {
        page.stale = true;
        marked.push(sig);
        affectedPatterns.add(page.url_pattern);
      }
    }
    for (const page of Object.values(this.map.pages)) {
      if (page.source === "execution" && affectedPatterns.has(page.url_pattern)) {
        page.stale = true;
      }
    }
    return marked;
  }

  /** Has the assist already analyzed this content? (same hash = skip, zero cost) */
  assistAlreadySeen(file: string, contentHash: string): boolean {
    return this.map.assist_seen?.[file] === contentHash;
  }

  recordAssistSeen(file: string, contentHash: string): void {
    (this.map.assist_seen ??= {})[file] = contentHash;
  }

  forgetAssistSeen(file: string): void {
    if (this.map.assist_seen) delete this.map.assist_seen[file];
  }

  /**
   * Full-scan pruning: static nodes for routes that no longer exist leave
   * the map (layers 1–2 always re-see everything in a full scan). Execution
   * nodes are never pruned by the scan. Returns how many were removed.
   */
  pruneStaticExcept(currentPatterns: Set<string>): number {
    let removed = 0;
    for (const [sig, page] of Object.entries(this.map.pages)) {
      if (page.source === "static" && !currentPatterns.has(page.url_pattern)) {
        delete this.map.pages[sig];
        removed += 1;
      }
    }
    return removed;
  }

  /** Does better knowledge (execution/static) already exist for this url? */
  coveredByBetterSource(urlPattern: string): boolean {
    return Object.values(this.map.pages).some(
      (p) => p.url_pattern === urlPattern && (p.source === "execution" || p.source === "static"),
    );
  }

  /** AI-inferred nodes, with their sources (for hash-based invalidation in the scan). */
  llmPages(): Array<{ sig: string; url_pattern: string; files: string[]; elements: number }> {
    return Object.entries(this.map.pages)
      .filter(([, p]) => p.source === "llm")
      .map(([sig, p]) => ({ sig, url_pattern: p.url_pattern, files: p.files ?? [], elements: p.interactive.length }));
  }

  removePage(sig: string): void {
    delete this.map.pages[sig];
  }

  get lastScanSha(): string | null {
    return this.map.last_scan_sha;
  }

  set lastScanSha(sha: string | null) {
    this.map.last_scan_sha = sha;
  }

  /** Count by source, for windup status. */
  countBySource(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const page of Object.values(this.map.pages)) {
      const key = page.stale ? `${page.source} (stale)` : page.source;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
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
   * Map slice for the planner prompt: BFS from the start page (depth ≤ 3),
   * prioritized by task-term matching, cut by the character budget.
   * Returns an empty string if nothing is reachable.
   */
  sliceForPrompt(startSig: string, task: string, budgetChars: number): string {
    // BFS over the transitions observed during execution.
    const depths = new Map<string, number>();
    if (this.map.pages[startSig]) {
      depths.set(startSig, 0);
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
      depths.delete(startSig); // the start page already enters the prompt live
    }

    const terms = tokenize(task);
    const scored = [...depths.keys()]
      .filter((sig) => !this.map.pages[sig].stale)
      .map((sig) => ({ sig, page: this.map.pages[sig], score: score(this.map.pages[sig], terms) }))
      .sort((a, b) => b.score - a.score);

    const blocks: string[] = [];
    let used = 0;
    const coveredPaths = new Set<string>(
      this.map.pages[startSig] ? [this.map.pages[startSig].url_pattern] : [],
    );
    for (const { sig, page } of scored) {
      const block = this.formatPage(sig, page);
      if (used + block.length > budgetChars) continue;
      blocks.push(block);
      coveredPaths.add(page.url_pattern);
      used += block.length;
    }

    // Lower-confidence tiers enter the remaining budget when no better
    // source covers the same url: execution > static > llm (SPEC-002).
    for (const tier of ["static", "llm"] as const) {
      const tierScored = Object.entries(this.map.pages)
        .filter(([, p]) => p.source === tier && !p.stale && !coveredPaths.has(p.url_pattern))
        .map(([sig, page]) => ({ sig, page, score: score(page, terms) }))
        .filter(({ score: s }) => s > 0)
        .sort((a, b) => b.score - a.score);
      for (const { sig, page } of tierScored) {
        const block = this.formatPage(sig, page);
        if (used + block.length > budgetChars) continue;
        blocks.push(block);
        coveredPaths.add(page.url_pattern);
        used += block.length;
      }
    }

    return blocks.join("\n\n");
  }

  /**
   * Known paths usable as flow starting points (non-stale, with interactive
   * elements), in path format ("/cart.html").
   */
  knownPaths(): string[] {
    const paths = Object.values(this.map.pages)
      .filter((p) => !p.stale && p.interactive.length > 0)
      .map((p) => p.url_pattern.replace(/^\*+/, "") || "/");
    return [...new Set(paths)].sort();
  }

  /**
   * Slice for scenario AUTHORING (windup new): unlike the planner, there is
   * no start page here — the author needs the app's overall picture.
   * A compact index of all known routes + detailed blocks for the pages
   * matching the instruction (all sources), up to the budget.
   */
  sliceForAuthoring(instruction: string, budgetChars: number): string {
    // Pages without interactive elements stay out: as a starting route or
    // reference they only mislead the author (seen in dogfooding: an
    // /index.html that does not render headless had a node with 0 elements).
    const alive = Object.entries(this.map.pages).filter(([, p]) => !p.stale && p.interactive.length > 0);
    if (alive.length === 0) return "";

    const index = [...new Set(alive.map(([, p]) => p.url_pattern))]
      .sort()
      .map((pattern) => `- ${pattern}`)
      .join("\n");
    const blocks: string[] = [`Known routes of the app:\n${index}`];
    let used = blocks[0].length;

    const terms = tokenize(instruction);
    const seenPatterns = new Set<string>();
    const scored = alive
      .map(([sig, page]) => ({ sig, page, score: score(page, terms) }))
      .filter(({ score: s }) => s > 0)
      .sort((a, b) => b.score - a.score || b.page.seen_count - a.page.seen_count);
    for (const { sig, page } of scored) {
      if (seenPatterns.has(page.url_pattern)) continue;
      const block = this.formatPage(sig, page);
      if (used + block.length > budgetChars) continue;
      blocks.push(block);
      seenPatterns.add(page.url_pattern);
      used += block.length;
    }
    return blocks.join("\n\n");
  }

  private formatPage(sig: string, page: MapPage): string {
    const routes = this.map.transitions
      .filter((t) => t.to === sig && this.map.pages[t.from])
      .slice(0, 3)
      .map((t) => `- you get here with ${t.action.type} '${t.action.selector}' from ${this.map.pages[t.from].url_pattern}`);
    const elements = page.interactive.slice(0, 30);
    const provenance =
      page.source === "static"
        ? " (detected in the source code; may diverge from the runtime)"
        : page.source === "llm"
          ? " (AI-inferred from the source code; low confidence)"
          : "";
    return [
      `## Known page: ${page.url_pattern}${page.title ? ` — ${page.title}` : ""}${provenance}`,
      ...routes,
      `Interactive elements ${page.source === "execution" ? "observed" : "declared"}:`,
      ...elements,
    ].join("\n");
  }

  /** Atomic write (tmp + rename). A save failure must never take down a run. */
  async save(): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.map, null, 2));
      await rename(tmp, this.file);
    } catch (err) {
      console.warn(`warning: failed to save site map: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Glob pattern from the most common pathname among the URLs seen. */
function derivePattern(urls: string[]): string {
  const counts = new Map<string, number>();
  for (const u of urls) {
    try {
      const pathname = new URL(u).pathname;
      counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
    } catch {
      // an invalid URL does not contribute to the pattern
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

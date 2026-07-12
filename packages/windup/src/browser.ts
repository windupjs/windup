import { Stagehand } from "@browserbasehq/stagehand";
import { computeSignature, type RawElement } from "./signature.js";

/** Elemento interativo cru extraído da página (base de prompt, sig e mapa). */
export interface RawPageElement extends RawElement {
  placeholder?: string;
  text?: string;
}

/**
 * Fronteira única com o Stagehand v3. Executor, verificador e planejador
 * falam apenas com esta interface — se for preciso trocar o motor (ex.:
 * Playwright puro), muda só este arquivo.
 *
 * Nenhum método aqui usa LLM: só page/locator determinísticos e snapshot
 * da árvore de acessibilidade (page.snapshot() é CDP puro).
 */
export interface Browser {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  /** Espera o seletor ficar visível (acompanha navegações/frames). false se estourar o timeout. */
  waitForVisible(selector: string, timeoutMs: number): Promise<boolean>;
  inputValue(selector: string): Promise<string>;
  url(): string;
  /** Árvore de acessibilidade formatada da página atual (insumo do planejador). */
  snapshotTree(): Promise<string>;
  /** Ids/names/data-test dos elementos interativos (complemento do contexto do planejador). */
  interactiveElements(): Promise<string[]>;
  /** Elementos interativos estruturados (base da assinatura e do mapa do site). */
  interactiveElementsRaw(): Promise<RawPageElement[]>;
  /** Assinatura estrutural da página atual (E1). */
  pageSignature(): Promise<string>;
  /** Título da página atual (metadado do mapa do site). */
  title(): Promise<string>;
  close(): Promise<void>;
}

type StagehandPage = NonNullable<ReturnType<Stagehand["context"]["activePage"]>>;

class StagehandBrowser implements Browser {
  constructor(
    private readonly stagehand: Stagehand,
    private readonly page: StagehandPage,
  ) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  async click(selector: string): Promise<void> {
    // LIMITAÇÃO CONHECIDA DA SPIKE (doc 07-A2): el.click() em vez do clique
    // por coordenadas do Stagehand, cujo burst de Input.dispatchMouseEvent
    // perde cliques de forma aleatória quando há pausa ociosa antes da ação
    // (reproduzido com SLOWMO_MS em qualquer modo). el.click() dispara
    // handlers E default actions, mas gera eventos isTrusted=false — o MVP
    // exige clique real com actionability (estilo Playwright) ou correção
    // upstream no Stagehand. Para não "clicar cego", pré-checks de
    // actionability rodam antes: visível, habilitado e não coberto.
    // O evaluate devolve o problema como string (throw dentro do evaluate é
    // engolido pelo Stagehand como "Uncaught" sem a mensagem).
    const problem = await this.page.evaluate<string | null, string>((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return "element not found";
      el.scrollIntoView({ block: "center" });
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return "element not visible (display/visibility)";
      }
      if ((el as HTMLButtonElement).disabled === true || el.getAttribute("disabled") !== null || el.getAttribute("aria-disabled") === "true") {
        return "element is disabled";
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return "element has no visible area";
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const related = hit !== null && (hit === el || el.contains(hit) || hit.contains(el));
      if (!related) {
        return `element covered by ${hit ? `<${hit.tagName.toLowerCase()}${hit.id ? ` id=${hit.id}` : ""}>` : "(nothing at center point)"}`;
      }
      el.click();
      return null;
    }, selector);
    if (problem) throw new Error(`click ${selector}: ${problem}`);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).fill(value);
  }

  async isVisible(selector: string): Promise<boolean> {
    try {
      return await this.page.locator(selector).isVisible();
    } catch (err) {
      if (process.env.LOG_LEVEL === "debug") {
        console.error(`[browser] isVisible(${selector}) lançou: ${err instanceof Error ? err.message : err}`);
      }
      return false;
    }
  }

  async waitForVisible(selector: string, timeoutMs: number): Promise<boolean> {
    // waitForSelector nativo: re-resolve o frame a cada verificação, ao
    // contrário de um polling de isVisible sobre um frame possivelmente
    // obsoleto após navegação (falhava com pausas longas entre ações).
    try {
      return await this.page.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
    } catch {
      return false;
    }
  }

  async inputValue(selector: string): Promise<string> {
    return this.page.locator(selector).inputValue();
  }

  url(): string {
    return this.page.url();
  }

  async snapshotTree(): Promise<string> {
    const snapshot = await this.page.snapshot();
    return snapshot.formattedTree;
  }

  // Um único evaluate serve o prompt do planejador (interactiveElements),
  // a assinatura de página (pageSignature) e o mapa do site.
  async interactiveElementsRaw(): Promise<RawPageElement[]> {
    return this.page.evaluate<RawPageElement[]>(() => {
      const els = Array.from(
        document.querySelectorAll("input, button, a, select, textarea"),
      );
      return els.map((el) => {
        const tag = el.tagName.toLowerCase();
        return {
          tag,
          id: el.id || undefined,
          name: el.getAttribute("name") ?? undefined,
          dataTest: el.getAttribute("data-test") ?? undefined,
          type: el.getAttribute("type") ?? undefined,
          placeholder: el.getAttribute("placeholder") ?? undefined,
          text: tag === "input" ? undefined : (el.textContent ?? "").trim().slice(0, 40) || undefined,
        };
      });
    });
  }

  async interactiveElements(): Promise<string[]> {
    const raw = await this.interactiveElementsRaw();
    return raw.map((el) => {
      const parts = [el.tag];
      if (el.id) parts.push(`id=${el.id}`);
      if (el.name) parts.push(`name=${el.name}`);
      if (el.dataTest) parts.push(`data-test=${el.dataTest}`);
      if (el.type) parts.push(`type=${el.type}`);
      if (el.placeholder) parts.push(`placeholder=${el.placeholder}`);
      if (el.text) parts.push(`text=${el.text}`);
      return parts.join(" ");
    });
  }

  async pageSignature(): Promise<string> {
    return computeSignature(await this.interactiveElementsRaw());
  }

  async title(): Promise<string> {
    return this.page.title();
  }

  async close(): Promise<void> {
    await this.stagehand.close();
  }
}

export async function launchBrowser(): Promise<Browser> {
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 0,
    disablePino: true,
    logger: () => {},
    localBrowserLaunchOptions: {
      headless: process.env.HEADLESS !== "false",
      // Viewport fixo E janela real do mesmo tamanho: o clique do Stagehand é
      // por coordenadas (CDP) — com viewport emulado maior que a janela real,
      // cliques abaixo da borda da janela caem no vazio (só no headful).
      viewport: { width: 1280, height: 900 },
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: ["--window-size=1280,1000", ...(process.env.CHROME_ARGS?.split(" ") ?? [])],
    },
  });
  await stagehand.init();
  const page = stagehand.context.activePage() ?? (await stagehand.context.newPage());
  return new StagehandBrowser(stagehand, page);
}

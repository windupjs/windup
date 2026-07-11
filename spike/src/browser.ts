import { Stagehand } from "@browserbasehq/stagehand";

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
  inputValue(selector: string): Promise<string>;
  url(): string;
  /** Árvore de acessibilidade formatada da página atual (insumo do planejador). */
  snapshotTree(): Promise<string>;
  /** Ids/names/data-test dos elementos interativos (complemento do contexto do planejador). */
  interactiveElements(): Promise<string[]>;
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
    await this.page.locator(selector).click();
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).fill(value);
  }

  async isVisible(selector: string): Promise<boolean> {
    try {
      return await this.page.locator(selector).isVisible();
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

  async interactiveElements(): Promise<string[]> {
    return this.page.evaluate<string[]>(() => {
      const els = Array.from(
        document.querySelectorAll("input, button, a, select, textarea"),
      );
      return els.map((el) => {
        const tag = el.tagName.toLowerCase();
        const parts = [tag];
        if (el.id) parts.push(`id=${el.id}`);
        const name = el.getAttribute("name");
        if (name) parts.push(`name=${name}`);
        const dataTest = el.getAttribute("data-test");
        if (dataTest) parts.push(`data-test=${dataTest}`);
        const type = el.getAttribute("type");
        if (type) parts.push(`type=${type}`);
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) parts.push(`placeholder=${placeholder}`);
        const text = (el.textContent ?? "").trim().slice(0, 40);
        if (text && tag !== "input") parts.push(`text=${text}`);
        return parts.join(" ");
      });
    });
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
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      ...(process.env.CHROME_ARGS ? { args: process.env.CHROME_ARGS.split(" ") } : {}),
    },
  });
  await stagehand.init();
  const page = stagehand.context.activePage() ?? (await stagehand.context.newPage());
  return new StagehandBrowser(stagehand, page);
}

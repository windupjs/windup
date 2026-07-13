import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { generateScenario, buildAuthoringPrompt, literalCredentials } from "../src/authoring.js";
import { createContext, setContext, getContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SiteMapStore } from "../src/sitemap.js";
import type { LlmClient } from "../src/llm.js";

function fakeClient(responses: string[]): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    provider: "google",
    model: "fake-model",
    prompts,
    async generate({ prompt }) {
      prompts.push(prompt);
      const text = responses[Math.min(prompts.length - 1, responses.length - 1)];
      return { text, tokens: { input: 1000, output: 200 }, truncated: false };
    },
  };
}

const VALID = JSON.stringify({
  scenario_id: "Criar Fatura",
  start_url: "/login",
  task: "Faça login com a conta admin, abra o menu Faturas, clique em Nova fatura, preencha o cliente 'ACME Ltda' e o valor 150,00, salve e verifique que a fatura da ACME aparece na lista.",
});

describe("windup new (autoria assistida de cenários)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-authoring-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  it("gera o arquivo com id kebab-case, start_url como path e registra a autoria no ledger", async () => {
    const client = fakeClient([VALID]);
    const result = await generateScenario("login com admin e criar uma fatura", {}, client);

    expect(result.scenario.scenario_id).toBe("criar-fatura");
    expect(result.scenario.start_url).toBe("/login");
    const written = JSON.parse(await readFile(result.file, "utf8"));
    expect(written.task).toContain("verifique");
    expect(written.hints).toBeUndefined();

    const records = await readdir(getContext().paths.runsDir);
    expect(records.some((f) => f.startsWith("authoring-"))).toBe(true);
    const record = JSON.parse(await readFile(path.join(getContext().paths.runsDir, records[0]), "utf8"));
    expect(record.kind).toBe("authoring");
    expect(record.llm_provider).toBe("google");
  });

  it("injeta o conhecimento do site (rotas + páginas que casam com a instrução) no prompt", async () => {
    const store = await SiteMapStore.load(getContext().paths.mapFile);
    store.upsertStaticPage("/faturas", ["a id=nova-fatura text=Nova fatura"], ["src/Faturas.tsx"]);
    store.upsertStaticPage("/clientes", ["a id=novo-cliente"], ["src/Clientes.tsx"]);
    await store.save();

    const client = fakeClient([VALID]);
    await generateScenario("criar uma fatura nova", {}, client);
    expect(client.prompts[0]).toContain("Rotas conhecidas do app");
    expect(client.prompts[0]).toContain("/faturas");
    expect(client.prompts[0]).toContain("nova-fatura");
  });

  it("start_url inventado (fora do mapa) cai para '/'; páginas sem elementos ficam fora do conhecimento", async () => {
    const store = await SiteMapStore.load(getContext().paths.mapFile);
    store.upsertStaticPage("/faturas", ["a id=nova-fatura"], ["src/Faturas.tsx"]);
    store.upsertStaticPage("/vazia", [], ["src/Vazia.tsx"]);
    await store.save();

    const client = fakeClient([VALID]); // VALID usa start_url "/login", que não está no mapa
    const result = await generateScenario("criar fatura", {}, client);
    expect(result.scenario.start_url).toBe("/");
    expect(client.prompts[0]).not.toContain("/vazia");
  });

  it("sem mapa, o start_url gerado é mantido (não há lista para validar)", async () => {
    const result = await generateScenario("login", {}, fakeClient([VALID]));
    expect(result.scenario.start_url).toBe("/login");
  });

  it("inclui o manifesto (E4) para a task referenciar contas em vez de credenciais literais", async () => {
    setContext(
      createContext(root, {
        config: { ...DEFAULT_CONFIG, context: { credentials: { admin: { user: "ENV:ADMIN_USER", password: "ENV:ADMIN_PASSWORD" } } } },
      }),
    );
    const client = fakeClient([VALID]);
    await generateScenario("login com admin/admin e criar fatura", {}, client);
    expect(client.prompts[0]).toContain("# Manifesto do projeto");
    expect(client.prompts[0]).toContain("refira-se à conta pelo NOME");
  });

  it("id repetido ganha sufixo; --id explícito com colisão exige --force", async () => {
    await mkdir(getContext().paths.scenariosDir, { recursive: true });
    await writeFile(path.join(getContext().paths.scenariosDir, "criar-fatura.json"), "{}");

    const result = await generateScenario("criar fatura", {}, fakeClient([VALID]));
    expect(result.scenario.scenario_id).toBe("criar-fatura-2");

    await expect(generateScenario("criar fatura", { id: "criar-fatura" }, fakeClient([VALID]))).rejects.toThrow(/--force/);
    const forced = await generateScenario("criar fatura", { id: "criar-fatura", force: true }, fakeClient([VALID]));
    expect(forced.scenario.scenario_id).toBe("criar-fatura");
  });

  it("resposta inválida → 1 retry semântico com os erros; segunda falha aborta", async () => {
    const bad = JSON.stringify({ scenario_id: "x", start_url: "/", task: "curta" });
    const client = fakeClient([bad, VALID]);
    const result = await generateScenario("criar fatura", {}, client);
    expect(result.llm_calls).toBe(2);
    expect(client.prompts[1]).toContain("INVÁLIDO");
    expect(client.prompts[1]).toContain("curta demais");

    await expect(generateScenario("criar fatura de novo", {}, fakeClient([bad, bad]))).rejects.toThrow(/after retry/);
  });

  it("sem mapa: o prompt orienta a não inventar telas e sugere o scan", async () => {
    const client = fakeClient([VALID]);
    await generateScenario("criar fatura", {}, client);
    expect(client.prompts[0]).toContain("nenhum ainda");
    expect(client.prompts[0]).toContain("windup scan");
  });

  it("credenciais literais viram conta registrada: .env.local + mapeamento, e a task NÃO contém os valores", async () => {
    expect(literalCredentials("login com kallef@orbitaldev.com.br e senha ka211189 e conferir o saldo"))
      .toEqual(["kallef@orbitaldev.com.br", "ka211189"]);

    const seguro = JSON.stringify({
      scenario_id: "saldo-inter",
      start_url: "/login",
      task: "Acesse /login, entre com a conta kallef e verifique o saldo do banco Inter na listagem de contas bancárias.",
    });
    const client = fakeClient([seguro]);
    const result = await generateScenario("login com kallef@orbitaldev.com.br e senha ka211189 e conferir o saldo do banco inter", {}, client);

    expect(result.registered_account).toBe("kallef");
    expect(client.prompts[0]).toContain('a conta "kallef"');
    expect(result.scenario.task).not.toContain("ka211189");
    const written = await readFile(result.file, "utf8");
    expect(written).not.toContain("ka211189");

    const envLocal = await readFile(path.join(root, ".env.local"), "utf8");
    expect(envLocal).toContain("WINDUP_KALLEF_USER=kallef@orbitaldev.com.br");
    expect(envLocal).toContain("WINDUP_KALLEF_PASSWORD=ka211189");
    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".env.local");
    const mapping = JSON.parse(await readFile(path.join(root, "windup.credentials.json"), "utf8"));
    expect(mapping.accounts.kallef.password).toBe("ENV:WINDUP_KALLEF_PASSWORD");
    expect(JSON.stringify(mapping)).not.toContain("ka211189");
  });

  it("vazamento de credencial na task vira retry; persistindo, é limpo mecanicamente antes de gravar", async () => {
    const vazado = JSON.stringify({
      scenario_id: "saldo",
      start_url: "/login",
      task: "Entre com kallef@orbitaldev.com.br e senha ka211189 e verifique o saldo do banco Inter na listagem.",
    });
    const client = fakeClient([vazado, vazado]); // vaza nas duas tentativas
    const result = await generateScenario("login com kallef@orbitaldev.com.br e senha ka211189 e ver o saldo do inter", {}, client);
    expect(client.prompts[1]).toContain("contém a credencial literal");
    expect(result.scenario.task).not.toContain("ka211189");
    expect(result.scenario.task).not.toContain("kallef@orbitaldev.com.br");
    expect(result.scenario.task).toContain("a conta kallef");
  });

  it("buildAuthoringPrompt lista cenários existentes (id + resumo) e a regra de sugerir depends_on", () => {
    const prompt = buildAuthoringPrompt("criar fatura", "", "", [
      { id: "login", task: "Fazer login com a conta admin e verificar o dashboard." },
      { id: "checkout" },
    ]);
    expect(prompt).toContain("- login: Fazer login com a conta admin");
    expect(prompt).toContain("- checkout");
    expect(prompt).toContain('"depends_on"');
    expect(prompt).toContain("APENAS ids desta lista");
  });

  it("sugestão de depends_on do modelo é aceita quando o id existe (start_url sai); id inventado é filtrado", async () => {
    const dir = getContext().paths.scenariosDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "login.json"), JSON.stringify({ scenario_id: "login", start_url: "/login", task: "Fazer login com a conta admin e verificar o dashboard." }));

    const comDep = JSON.stringify({
      scenario_id: "criar-fatura",
      start_url: "/faturas",
      depends_on: ["login", "cenario-inventado"],
      task: "Já autenticado, abra o menu Faturas, crie uma fatura para a ACME e verifique que ela aparece na lista.",
    });
    const result = await generateScenario("estando logado, criar uma fatura para a ACME", {}, fakeClient([comDep]));

    expect(result.scenario.depends_on).toEqual(["login"]); // inventado filtrado mecanicamente
    expect(result.scenario.start_url).toBeUndefined(); // continua da página final do login
    const written = JSON.parse(await readFile(result.file, "utf8"));
    expect(written.depends_on).toEqual(["login"]);
    expect(written.start_url).toBeUndefined();
  });
});

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
  task: "Log in with the admin account, open the Faturas menu, click Nova fatura, fill in the customer 'ACME Ltda' and the amount 150,00, save and verify that the ACME invoice appears in the list.",
});

describe("windup new (assisted scenario authoring)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "windup-authoring-"));
    setContext(createContext(root));
  });
  afterAll(() => setContext(createContext()));

  it("generates the file with a kebab-case id, start_url as a path and records the authoring in the ledger", async () => {
    const client = fakeClient([VALID]);
    const result = await generateScenario("log in with admin and create an invoice", {}, client);

    expect(result.scenario.scenario_id).toBe("criar-fatura");
    expect(result.scenario.start_url).toBe("/login");
    const written = JSON.parse(await readFile(result.file, "utf8"));
    expect(written.task).toContain("verify");
    expect(written.hints).toBeUndefined();

    const records = await readdir(getContext().paths.runsDir);
    expect(records.some((f) => f.startsWith("authoring-"))).toBe(true);
    const record = JSON.parse(await readFile(path.join(getContext().paths.runsDir, records[0]), "utf8"));
    expect(record.kind).toBe("authoring");
    expect(record.llm_provider).toBe("google");
  });

  it("injects the site knowledge (routes + pages matching the instruction) into the prompt", async () => {
    const store = await SiteMapStore.load(getContext().paths.mapFile);
    store.upsertStaticPage("/faturas", ["a id=nova-fatura text=Nova fatura"], ["src/Faturas.tsx"]);
    store.upsertStaticPage("/clientes", ["a id=novo-cliente"], ["src/Clientes.tsx"]);
    await store.save();

    const client = fakeClient([VALID]);
    await generateScenario("create a new invoice in faturas", {}, client);
    expect(client.prompts[0]).toContain("Known routes of the app");
    expect(client.prompts[0]).toContain("/faturas");
    expect(client.prompts[0]).toContain("nova-fatura");
  });

  it("invented start_url (outside the map) falls back to '/'; pages without elements stay out of the knowledge", async () => {
    const store = await SiteMapStore.load(getContext().paths.mapFile);
    store.upsertStaticPage("/faturas", ["a id=nova-fatura"], ["src/Faturas.tsx"]);
    store.upsertStaticPage("/vazia", [], ["src/Vazia.tsx"]);
    await store.save();

    const client = fakeClient([VALID]); // VALID uses start_url "/login", which is not in the map
    const result = await generateScenario("create an invoice", {}, client);
    expect(result.scenario.start_url).toBe("/");
    expect(client.prompts[0]).not.toContain("/vazia");
  });

  it("without a map, the generated start_url is kept (there is no list to validate against)", async () => {
    const result = await generateScenario("login", {}, fakeClient([VALID]));
    expect(result.scenario.start_url).toBe("/login");
  });

  it("includes the manifest (E4) so the task references accounts instead of literal credentials", async () => {
    setContext(
      createContext(root, {
        config: { ...DEFAULT_CONFIG, context: { credentials: { admin: { user: "ENV:ADMIN_USER", password: "ENV:ADMIN_PASSWORD" } } } },
      }),
    );
    const client = fakeClient([VALID]);
    await generateScenario("log in with admin/admin and create an invoice", {}, client);
    expect(client.prompts[0]).toContain("# Project manifest");
    expect(client.prompts[0]).toContain("refer to the account by NAME");
  });

  it("repeated id gets a suffix; explicit --id with a collision requires --force", async () => {
    await mkdir(getContext().paths.scenariosDir, { recursive: true });
    await writeFile(path.join(getContext().paths.scenariosDir, "criar-fatura.json"), "{}");

    const result = await generateScenario("create an invoice", {}, fakeClient([VALID]));
    expect(result.scenario.scenario_id).toBe("criar-fatura-2");

    await expect(generateScenario("create an invoice", { id: "criar-fatura" }, fakeClient([VALID]))).rejects.toThrow(/--force/);
    const forced = await generateScenario("create an invoice", { id: "criar-fatura", force: true }, fakeClient([VALID]));
    expect(forced.scenario.scenario_id).toBe("criar-fatura");
  });

  it("invalid response → 1 semantic retry with the errors; a second failure aborts", async () => {
    const bad = JSON.stringify({ scenario_id: "x", start_url: "/", task: "short" });
    const client = fakeClient([bad, VALID]);
    const result = await generateScenario("create an invoice", {}, client);
    expect(result.llm_calls).toBe(2);
    expect(client.prompts[1]).toContain("INVALID");
    expect(client.prompts[1]).toContain("too short");

    await expect(generateScenario("create an invoice again", {}, fakeClient([bad, bad]))).rejects.toThrow(/after retry/);
  });

  it("without a map: the prompt says not to invent screens and suggests the scan", async () => {
    const client = fakeClient([VALID]);
    await generateScenario("create an invoice", {}, client);
    expect(client.prompts[0]).toContain("none yet");
    expect(client.prompts[0]).toContain("windup scan");
  });

  it("literal credentials become a registered account: .env.local + mapping, and the task does NOT contain the values", async () => {
    expect(literalCredentials("log in with kallef@orbitaldev.com.br and password ka211189 and check the balance"))
      .toEqual(["kallef@orbitaldev.com.br", "ka211189"]);

    const seguro = JSON.stringify({
      scenario_id: "saldo-inter",
      start_url: "/login",
      task: "Go to /login, sign in with the kallef account and verify the Inter bank balance in the bank account list.",
    });
    const client = fakeClient([seguro]);
    const result = await generateScenario("log in with kallef@orbitaldev.com.br and password ka211189 and check the inter bank balance", {}, client);

    expect(result.registered_account).toBe("kallef");
    expect(client.prompts[0]).toContain('the account "kallef"');
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

  it("credential leaked into the task becomes a retry; if it persists, it is scrubbed mechanically before writing", async () => {
    const vazado = JSON.stringify({
      scenario_id: "saldo",
      start_url: "/login",
      task: "Sign in with kallef@orbitaldev.com.br and password ka211189 and verify the Inter bank balance in the listing.",
    });
    const client = fakeClient([vazado, vazado]); // leaks on both attempts
    const result = await generateScenario("log in with kallef@orbitaldev.com.br and password ka211189 and see the inter balance", {}, client);
    expect(client.prompts[1]).toContain("contains the literal credential");
    expect(result.scenario.task).not.toContain("ka211189");
    expect(result.scenario.task).not.toContain("kallef@orbitaldev.com.br");
    expect(result.scenario.task).toContain("the account kallef");
  });

  it("buildAuthoringPrompt lists existing scenarios (id + summary) and the rule for suggesting depends_on", () => {
    const prompt = buildAuthoringPrompt("create an invoice", "", "", [
      { id: "login", task: "Log in with the admin account and verify the dashboard." },
      { id: "checkout" },
    ]);
    expect(prompt).toContain("- login: Log in with the admin account");
    expect(prompt).toContain("- checkout");
    expect(prompt).toContain('"depends_on"');
    expect(prompt).toContain("ONLY ids from this list");
  });

  it("the model's depends_on suggestion is accepted when the id exists (start_url is dropped); invented ids are filtered out", async () => {
    const dir = getContext().paths.scenariosDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "login.json"), JSON.stringify({ scenario_id: "login", start_url: "/login", task: "Log in with the admin account and verify the dashboard." }));

    const comDep = JSON.stringify({
      scenario_id: "criar-fatura",
      start_url: "/faturas",
      depends_on: ["login", "cenario-inventado"],
      task: "Already authenticated, open the Faturas menu, create an invoice for ACME and verify that it appears in the list.",
    });
    const result = await generateScenario("while logged in, create an invoice for ACME", {}, fakeClient([comDep]));

    expect(result.scenario.depends_on).toEqual(["login"]); // invented id filtered mechanically
    expect(result.scenario.start_url).toBeUndefined(); // continues from the login's final page
    const written = JSON.parse(await readFile(result.file, "utf8"));
    expect(written.depends_on).toEqual(["login"]);
    expect(written.start_url).toBeUndefined();
  });
});

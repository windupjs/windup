import { intro, outro, text, isCancel, cancel, note } from "@clack/prompts";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

/**
 * `windup init` — cria windup.config.ts, .windup/ (gitignored) e um cenário
 * de exemplo. Idempotente: config existente aborta sem sobrescrever.
 * A detecção de framework só é GRAVADA por ora (gancho do P2/scan).
 */
export async function runInit(cwd: string = process.cwd()): Promise<void> {
  const configFile = path.join(cwd, "windup.config.ts");
  if (await exists(configFile)) {
    console.log(`[windup] ${configFile} já existe — nada a fazer (edite-o diretamente).`);
    return;
  }

  intro("windup init — dê corda uma vez, o replay anda sozinho");

  const framework = await detectFramework(cwd);
  if (framework) note(`Framework detectado: ${framework}`, "detecção");

  const baseUrl = await ask("URL base do app em teste?", "http://localhost:3000");
  const model = await ask("Modelo de LLM para o planejador?", "gemini-2.5-flash");
  const scenariosDir = await ask("Pasta dos cenários?", "e2e/scenarios");

  const config = `import { defineConfig } from "windupjs";

export default defineConfig({
  baseUrl: ${JSON.stringify(baseUrl)},
  llm: { provider: "google", model: ${JSON.stringify(model)} },
  scenarios: ${JSON.stringify(scenariosDir)},
  framework: ${JSON.stringify(framework)},
  // P2 — indexação do projeto (ainda não usado):
  // scan: { include: ["src/**"], dynamic: { enabled: false }, llmAssist: { enabled: true, maxCalls: 20 } },
  // Manifesto do projeto (SPEC-001): convenções, credenciais por ENV, vocabulário do domínio.
  context: {},
});
`;
  await writeFile(configFile, config);

  await mkdir(path.join(cwd, ".windup"), { recursive: true });
  await ensureGitignore(cwd, ".windup/");

  const scenariosPath = path.join(cwd, scenariosDir);
  await mkdir(scenariosPath, { recursive: true });
  const exampleFile = path.join(scenariosPath, "exemplo.json");
  if (!(await exists(exampleFile))) {
    await writeFile(
      exampleFile,
      `${JSON.stringify(
        {
          scenario_id: "exemplo",
          start_url: "/",
          task: "Descreva a tarefa em linguagem natural e termine dizendo o que verificar (ex.: '...e verificar que o título X aparece'). Segredos: use value_ref na dica abaixo.",
          hints: ["Opcional: conhecimento do site que ajude o planejador (padrões de seletor, fluxos). Apague se não precisar."],
        },
        null,
        2,
      )}\n`,
    );
  }

  outro(`Pronto: windup.config.ts + ${scenariosDir}/exemplo.json + .windup/ (gitignored).
Próximo passo: escreva um cenário e rode "npx windup run <id>". Defina GOOGLE_GENERATIVE_AI_API_KEY no .env.`);
}

async function ask(message: string, defaultValue: string): Promise<string> {
  // Sem TTY (CI, pipes): usa defaults em vez de travar no prompt.
  if (!process.stdin.isTTY) {
    console.log(`[windup] ${message} → ${defaultValue} (sem TTY, usando default)`);
    return defaultValue;
  }
  const answer = await text({ message, placeholder: defaultValue, defaultValue });
  if (isCancel(answer)) {
    cancel("init cancelado.");
    process.exit(1);
  }
  return answer || defaultValue;
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function detectFramework(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (pkg.workspaces) console.log("[windup] aviso: monorepo detectado — índice por app fica para depois (SPEC-002); seguindo com a raiz.");
    if (deps.next) return "next";
    if (deps["@remix-run/react"] || deps["@remix-run/node"]) return "remix";
    if (deps["react-router"] || deps["react-router-dom"]) return "react-router";
    if (deps.vue || deps.nuxt) return deps.nuxt ? "nuxt" : "vue";
    if (deps.svelte || deps["@sveltejs/kit"]) return "svelte";
    if (deps.react) return "react";
    return null;
  } catch {
    return null;
  }
}

async function ensureGitignore(cwd: string, entry: string): Promise<void> {
  const file = path.join(cwd, ".gitignore");
  try {
    const content = await readFile(file, "utf8");
    if (content.split("\n").some((l) => l.trim() === entry || l.trim() === entry.replace(/\/$/, ""))) return;
    await appendFile(file, `\n${entry}\n`);
  } catch {
    await writeFile(file, `${entry}\n`);
  }
}

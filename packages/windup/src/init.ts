import { intro, outro, text, isCancel, cancel, note } from "@clack/prompts";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

/**
 * `windup init` — creates windup.config.ts, .windup/ (gitignored) and an
 * example scenario. Idempotent: an existing config aborts without overwrite.
 * Framework detection is only RECORDED for now (used by `windup scan`).
 */
export async function runInit(cwd: string = process.cwd()): Promise<void> {
  const configFile = path.join(cwd, "windup.config.ts");
  if (await exists(configFile)) {
    console.log(`windup.config.ts already exists — nothing to do. Edit it directly.`);
    return;
  }

  intro("windup init");

  const framework = await detectFramework(cwd);
  if (framework) note(`Framework detected: ${framework}`, "project");

  const baseUrl = await ask("Base URL of the app under test", "http://localhost:3000");
  const model = await ask("LLM model for the planner", "gemini-3.1-flash-lite");
  const scenariosDir = await ask("Scenarios directory", "e2e/scenarios");

  const config = `import { defineConfig } from "windupjs";

export default defineConfig({
  baseUrl: ${JSON.stringify(baseUrl)},
  llm: { provider: "google", model: ${JSON.stringify(model)} },
  scenarios: ${JSON.stringify(scenariosDir)},
  framework: ${JSON.stringify(framework)},
  // Project indexing (windup scan):
  // scan: { include: ["src/**"], dynamic: { enabled: false }, llmAssist: { enabled: true, maxCalls: 20 } },
  // Project manifest: conventions, ENV-referenced credentials, domain vocabulary.
  context: {},
});
`;
  await writeFile(configFile, config);

  await mkdir(path.join(cwd, ".windup"), { recursive: true });
  await ensureGitignore(cwd, ".windup/");

  const scenariosPath = path.join(cwd, scenariosDir);
  await mkdir(scenariosPath, { recursive: true });
  const exampleFile = path.join(scenariosPath, "example.json");
  if (!(await exists(exampleFile))) {
    await writeFile(
      exampleFile,
      `${JSON.stringify(
        {
          scenario_id: "example",
          start_url: "/",
          task: "Describe the test in natural language and end with what to verify, e.g. '...and verify that the dashboard heading appears'. For secrets, reference environment variables instead of literal values.",
          hints: ["Optional: site-specific knowledge that helps the planner (selector patterns, flows). Delete if not needed."],
        },
        null,
        2,
      )}\n`,
    );
  }

  outro(`Created windup.config.ts, ${scenariosDir}/example.json and .windup/ (gitignored).

  Next steps:
    1. Add GOOGLE_GENERATIVE_AI_API_KEY to your .env
    2. npx windup scan          index your project's routes into the site map
    3. Write a scenario in ${scenariosDir}/ and run: npx windup run <scenario-id>`);
}

async function ask(message: string, defaultValue: string): Promise<string> {
  // No TTY (CI, pipes): fall back to defaults instead of hanging on a prompt.
  if (!process.stdin.isTTY) {
    console.log(`${message}: ${defaultValue} (no TTY, using default)`);
    return defaultValue;
  }
  const answer = await text({ message, placeholder: defaultValue, defaultValue });
  if (isCancel(answer)) {
    cancel("init cancelled.");
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
    if (pkg.workspaces) console.log("warning: monorepo detected — per-app indexes are on the roadmap; proceeding with the repository root.");
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

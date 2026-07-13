import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getContext } from "./context.js";
import { createLlmClient, type LlmClient } from "./llm.js";
import { estimateCostUsd } from "./metrics.js";
import { buildManifestSection } from "./planner.js";
import { SiteMapStore } from "./sitemap.js";
import { startPath } from "./start-url.js";

/**
 * `windup new` — scenario generator (assisted authoring): the author writes a
 * raw instruction ("login with admin and create an invoice") and the LLM,
 * acting as a test manager, turns it into a well-written scenario — enriched
 * with the site knowledge (scan/map) and the project manifest (E4).
 *
 * The result is a FILE for the author to review and commit, never an execution:
 * authoring and execution are distinct phases on purpose — the scenario remains
 * knowledge curated by the team (doc 07), the LLM only reduces the effort of
 * writing it well.
 */
export interface AuthoredScenario {
  scenario_id: string;
  /** Absent in a dependent scenario: continues from the depends_on final page. */
  start_url?: string;
  task: string;
  hints?: string[];
  depends_on?: string[];
}

export interface AuthoringResult {
  file: string;
  scenario: AuthoredScenario;
  /** Account registered automatically from literal credentials in the instruction. */
  registered_account?: string;
  llm_calls: number;
  tokens: { input: number; output: number };
  model: string;
  provider: string;
  est_cost_usd: number;
}

const AUTHORING_SCHEMA = {
  type: "object",
  required: ["scenario_id", "start_url", "task"],
  properties: {
    scenario_id: { type: "string" },
    start_url: { type: "string" },
    task: { type: "string" },
    hints: { type: "array", items: { type: "string" } },
    depends_on: { type: "array", items: { type: "string" } },
  },
};

/** Budgets under the same discipline as the planner: prompt of ≈ constant size. */
const MAP_BUDGET_CHARS = 8_000;

export interface ExistingScenario {
  id: string;
  task?: string;
}

export function buildAuthoringPrompt(
  instruction: string,
  siteKnowledge: string,
  manifestSection: string,
  existing: ExistingScenario[],
  registeredAccount?: string,
): string {
  const knowledgeSection = siteKnowledge
    ? `\n# Site knowledge (real routes and elements, from scan and runs)\nUse ONLY screens/routes/elements listed here when detailing the flow; do NOT invent screens that are not listed. If the knowledge does not cover part of the flow, describe that part in terms of the goal (without inventing selectors).\n\n${siteKnowledge}\n`
    : "\n# Site knowledge\n(none yet — describe the flow in terms of the goal, without inventing screens or selectors; suggest the author run `windup scan`)\n";
  const existingSection = existing.length
    ? `\n# Existing scenarios (the new scenario_id must NOT repeat these ids)\n${existing
        .slice(0, 20)
        .map((e) => `- ${e.id}${e.task ? `: ${e.task.slice(0, 140)}` : ""}`)
        .join("\n")}\n
If the instruction's flow PRESUPPOSES a state that one of these scenarios already produces \
(e.g. being logged in → login scenario; company selected → scenario that selects it), \
also return "depends_on": ["<id>"] with those ids — ONLY ids from this list, never \
invented — and write the task starting from their FINAL STATE, without repeating their steps.\n`
    : "";
  const credsSection = registeredAccount
    ? `\n# Registered credentials\nThe literal credentials from the instruction were safely registered as the account "${registeredAccount}" in the Manifest. In the task, refer to them ONLY as "the account ${registeredAccount}" — NEVER write the literal email/username/password in the task or in the hints.\n`
    : "";
  return `You are an experienced E2E test manager. Turn the raw instruction below into a well-written test scenario for Windup (natural-language tests with deterministic execution).

# Author's raw instruction
${instruction}
${knowledgeSection}${manifestSection}${credsSection}${existingSection}
# What to return (JSON)
- "scenario_id": kebab-case, short and descriptive of the flow (e.g. "create-invoice").
- "start_url": relative path where the flow starts, chosen EXACTLY from the list of known routes when it exists (never invent a path — not even conventions like "/index.html"); "/" when in doubt. Never include host/port.
- "task": the instruction rewritten as a clear, specific and executable user flow, in step-by-step prose:
  - refer to screens, menus and buttons by their REAL names from the site knowledge when they exist;
  - for form filling, specify CONCRETE fictional values (names, emails, amounts);
  - if the instruction mentions an account that exists in the Project manifest (including the account indicated in the "Registered credentials" section, if any), refer to the account by NAME (e.g. "the admin account") — NEVER write literal email/username/password in the task;
  - the task MUST end by saying WHAT TO VERIFY: an observable condition that proves success (message displayed, item in the list, URL of the destination screen);
  - write the task in the SAME language as the author's instruction.
- "hints": OPTIONAL — at most 3 selector/screen hints taken from the site knowledge that help the planner; omit if they add nothing.

Respond only with the scenario JSON.`;
}

function kebab(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Literal credentials provided in the instruction (emails and passwords). They
 * are test input: the generated task MUST preserve them, otherwise the planner
 * has no password and invents one (seen in dogfooding: silently wrong login
 * and a confusing failure 3 actions later). Exported for testing.
 */
export function literalCredentials(instruction: string): string[] {
  const found = new Set<string>();
  for (const m of instruction.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) found.add(m[0]);
  for (const m of instruction.matchAll(/(?:senha|password|pass)\s*[:=]?\s+(\S+)/gi)) found.add(m[1].replace(/[.,;]$/, ""));
  return [...found];
}

function validate(data: unknown, instruction = "", registeredAccount?: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const s = data as Partial<AuthoredScenario> | null;
  if (!s || typeof s !== "object") errors.push("response is not a JSON object");
  else {
    if (!s.scenario_id || typeof s.scenario_id !== "string") errors.push("scenario_id missing");
    if (!s.task || typeof s.task !== "string" || s.task.trim().length < 20) errors.push("task missing or too short (rewrite the complete flow, ending with what to verify)");
    if (!s.start_url || typeof s.start_url !== "string") errors.push("start_url missing (use a path like \"/\")");
    if (s.hints !== undefined && (!Array.isArray(s.hints) || s.hints.some((h) => typeof h !== "string"))) errors.push("hints must be a list of strings");
    if (s.depends_on !== undefined && (!Array.isArray(s.depends_on) || s.depends_on.some((d) => typeof d !== "string"))) errors.push("depends_on must be a list of scenario ids");
    if (s.task && registeredAccount) {
      const haystack = `${s.task} ${(s.hints ?? []).join(" ")}`;
      for (const cred of literalCredentials(instruction)) {
        if (haystack.includes(cred)) {
          errors.push(`the task/hints contains the literal credential "${cred}" — the credentials were registered as the "${registeredAccount}" account; refer to it by name, never by the values`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function generateScenario(
  instruction: string,
  opts: { id?: string; force?: boolean; dependsOn?: string[] } = {},
  client?: LlmClient,
): Promise<AuthoringResult> {
  const ctx = getContext();
  const llm = client ?? createLlmClient();

  const store = await SiteMapStore.load(ctx.paths.mapFile);
  const siteKnowledge = store.sliceForAuthoring(instruction, MAP_BUDGET_CHARS);
  const knownPaths = store.knownPaths();

  // Secure by default: literal credentials in the instruction do NOT go into
  // the scenario (a committed file). They become a registered account — values
  // in .env.local, mapping in windup.credentials.json — and the task references
  // the account; the executor resolves the ENV only at runtime.
  const creds = literalCredentials(instruction);
  let registeredAccount: string | undefined;
  if (creds.length) {
    const { deriveAccountName, registerCredentials } = await import("./secrets.js");
    const email = creds.find((c) => c.includes("@"));
    const password = creds.find((c) => !c.includes("@"));
    const account = deriveAccountName(email);
    const existing = ctx.config.context?.credentials?.[account];
    if (!existing) {
      registerCredentials(account, {
        ...(email ? { user: email } : {}),
        ...(password ? { password } : {}),
      });
    }
    registeredAccount = account;
  }

  const existing: ExistingScenario[] = [];
  try {
    const files = (await readdir(ctx.paths.scenariosDir)).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const id = file.replace(/\.json$/, "");
      try {
        const parsed = JSON.parse(await readFile(path.join(ctx.paths.scenariosDir, file), "utf8")) as { task?: string };
        existing.push({ id, task: parsed.task });
      } catch {
        existing.push({ id });
      }
    }
  } catch {
    // scenariosDir does not exist yet
  }
  const existingIds = existing.map((e) => e.id);

  const tokens = { input: 0, output: 0 };
  let llmCalls = 0;
  const dependsSection = opts.dependsOn?.length
    ? `\n# Declared dependencies\nThis scenario runs AFTER the scenarios ${opts.dependsOn.map((d) => `"${d}"`).join(", ")} (in the same session). Describe the flow starting from their FINAL STATE (e.g. user already authenticated) — do NOT repeat the steps the dependencies already cover.\n`
    : "";
  let prompt = buildAuthoringPrompt(instruction, siteKnowledge, buildManifestSection(), existing, registeredAccount) + dependsSection;
  let scenario: AuthoredScenario | null = null;
  let lastErrors: string[] = [];

  // Same spirit as the planner: 1 short semantic retry with the errors.
  for (let attempt = 1; attempt <= 2 && !scenario; attempt++) {
    const response = await llm.generate({ prompt, schema: AUTHORING_SCHEMA, maxOutputTokens: 2048, temperature: 0.3, seed: attempt * 10 });
    llmCalls += 1;
    tokens.input += response.tokens.input;
    tokens.output += response.tokens.output;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      lastErrors = ["response was not valid JSON"];
    }
    if (parsed) {
      const check = validate(parsed, instruction, registeredAccount);
      if (check.ok) {
        scenario = parsed as AuthoredScenario;
        break;
      }
      // A credential leak on the LAST retry does not abort: the mechanical
      // cleanup below fixes it — the model does not have the final word on
      // what goes into a committed file.
      if (attempt === 2 && check.errors.every((e) => e.includes("contains the literal credential"))) {
        scenario = parsed as AuthoredScenario;
        break;
      }
      lastErrors = check.errors;
    }
    prompt = `You generated the JSON scenario below for the instruction "${instruction}", but it is INVALID.\n\n# Previous response\n${response.text.slice(0, 3000)}\n\n# Errors to fix\n${lastErrors.join("\n")}\n\nReturn the complete corrected scenario (scenario_id, start_url, task and optionally hints). Respond ONLY with the JSON.`;
  }
  if (!scenario) {
    throw new Error(`could not generate a valid scenario after retry: ${lastErrors.join("; ")}`);
  }

  // Belt and suspenders: no literal credential survives in the file.
  if (registeredAccount) {
    for (const cred of creds) {
      scenario.task = scenario.task.split(cred).join(`the account ${registeredAccount}`);
      scenario.hints = scenario.hints?.map((h) => h.split(cred).join(`the account ${registeredAccount}`));
    }
  }

  // Mechanical normalizations (same philosophy as the planner's sanitize):
  // kebab-case id, start_url as a path, uniqueness guaranteed by suffix.
  scenario.scenario_id = kebab(opts.id ?? scenario.scenario_id) || "novo-cenario";
  scenario.start_url = startPath(scenario.start_url ?? "/");
  // Dependencies: the --depends-on flag wins; without it, the model's SUGGESTION
  // counts after a mechanical filter — only ids that actually exist (never invented).
  const suggested = (scenario.depends_on ?? []).filter((d) => existingIds.includes(d));
  const dropped = (scenario.depends_on ?? []).filter((d) => !existingIds.includes(d));
  if (dropped.length) console.warn(`warning: suggested depends_on ignored (unknown scenario ids): ${dropped.join(", ")}`);
  const dependsOn = opts.dependsOn?.length ? opts.dependsOn : suggested;
  delete scenario.depends_on;
  if (dependsOn.length) {
    scenario.depends_on = dependsOn;
    // dependent scenario needs no goto: continues from the dependency's final page
    delete (scenario as Partial<AuthoredScenario>).start_url;
  }
  // An invented start_url (not in the map) derails the entire execution:
  // (a dependent scenario without start_url skips this validation — there is no goto)
  // with a map available, fall back to "/" — the planner sees the real page
  // anyway. Seen in dogfooding: the model invented "/index.html" by
  // convention, a route the real app does not render.
  if (scenario.start_url && knownPaths.length > 0 && !knownPaths.includes(scenario.start_url)) {
    console.warn(`warning: start_url "${scenario.start_url}" is not a known route — falling back to "/"`);
    scenario.start_url = "/";
  }
  if (scenario.hints && scenario.hints.length === 0) delete scenario.hints;
  if (!opts.force && !opts.id) {
    let candidate = scenario.scenario_id;
    for (let n = 2; existingIds.includes(candidate); n++) candidate = `${scenario.scenario_id}-${n}`;
    scenario.scenario_id = candidate;
  }

  await mkdir(ctx.paths.scenariosDir, { recursive: true });
  const file = path.join(ctx.paths.scenariosDir, `${scenario.scenario_id}.json`);
  if (existsSync(file) && !opts.force) {
    throw new Error(`scenario "${scenario.scenario_id}" already exists (${file}) — use --force to overwrite or --id for another name`);
  }
  await writeFile(file, `${JSON.stringify(scenario, null, 2)}\n`);

  // Authoring spend goes into the SAME ledger (windup costs), like the scan.
  const cost = estimateCostUsd(tokens, llm.model);
  await mkdir(ctx.paths.runsDir, { recursive: true });
  const record = {
    kind: "authoring",
    started_at: new Date().toISOString(),
    scenario_generated: scenario.scenario_id,
    llm_calls: llmCalls,
    llm_model: llm.model,
    llm_provider: llm.provider,
    tokens,
    estimated_cost_usd: cost,
  };
  await writeFile(path.join(ctx.paths.runsDir, `authoring-${record.started_at.replace(/[:.]/g, "-")}.json`), JSON.stringify(record, null, 2));

  return { file, scenario, registered_account: registeredAccount, llm_calls: llmCalls, tokens, model: llm.model, provider: llm.provider, est_cost_usd: cost };
}

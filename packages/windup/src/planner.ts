import type { Browser } from "./browser.js";
import { createLlmClient, type LlmClient } from "./llm.js";
import { PLAN_GEMINI_SCHEMA, validatePlan } from "./schema.js";
import type { Action, Fragment, Plan, Scenario } from "./types.js";
import { PlanGenerationError, type PlanGeneration, type Planner } from "./runner.js";
import { getContext } from "./context.js";

/**
 * COMBINED context budget (~8k tokens ≈ 32k chars, doc 03): when the site map
 * contributes, the initial page tree yields space to the map — the total
 * prompt stays ≈ constant (critical because of flash degeneration).
 */
const PAGE_CONTEXT_MAX_CHARS = 32_000;
const MAP_MAX_CHARS = 8_000;

/** Manifest cap in the prompt (E4): ~1k tokens; same budget discipline as the map. */
const MANIFEST_MAX_CHARS = 4_000;

/**
 * E4 — project manifest (SPEC-001 component 3): the `context` section of
 * windup.config.ts becomes planner context. It is the generalization of hints
 * to the project level: knowledge enters via team INPUT, never via our own
 * code (doc 07). Exported for testing.
 */
export function buildManifestSection(): string {
  const manifest = getContext().config.context;
  if (!manifest) return "";
  const parts: string[] = [];
  if (manifest.conventions?.length) {
    parts.push(`Site conventions:\n${manifest.conventions.map((c) => `- ${c}`).join("\n")}`);
  }
  if (manifest.credentials && Object.keys(manifest.credentials).length) {
    const lines = Object.entries(manifest.credentials).map(
      ([account, fields]) => `- account "${account}": ${Object.entries(fields).map(([k, v]) => `${k} → ${v}`).join(", ")}`,
    );
    parts.push(
      `Available credentials — when the task mentions one of these accounts, the corresponding fills MUST use "value_ref" with the indicated ENV (never "value"), EVEN if the page displays credentials as text — the manifest takes precedence over page content. But if the task provides LITERAL credentials (username/password written in it) without mentioning a manifest account, use the literal values from the task:\n${lines.join("\n")}`,
    );
  }
  if (manifest.vocabulary && Object.keys(manifest.vocabulary).length) {
    parts.push(`Domain vocabulary (task terms → meaning):\n${Object.entries(manifest.vocabulary).map(([t, d]) => `- "${t}": ${d}`).join("\n")}`);
  }
  if (!parts.length) return "";
  return `\n# Project manifest (provided by the team — trust it)\n${parts.join("\n\n").slice(0, MANIFEST_MAX_CHARS)}\n`;
}

function buildPrompt(scenario: Scenario, pageTree: string, interactive: string[], siteKnowledge?: string, fragmentsCatalog?: string, failureContext?: string, continuesFromDependency = false): string {
  // Doc 07 principle: ZERO hardcoded site knowledge in the prompt.
  // Site-specific knowledge only enters via author hints, the site map
  // (E2) or the project manifest (E4) — never via our own code.
  const manifestSection = buildManifestSection();
  const hintsSection = scenario.hints?.length
    ? `\n# Hints provided by the scenario author\n${scenario.hints.join("\n")}\n`
    : "";
  const knowledgeSection = siteKnowledge
    ? `\n# Site knowledge (pages already observed in previous runs)
For the pages listed below, use EXACTLY the listed selectors; only infer \
selectors when the page is not listed here.

${siteKnowledge}\n`
    : "";
  const fragmentsSection = fragmentsCatalog
    ? `\n# Available fragments (ready-made, already-tested action blocks)
When a fragment covers part of the task, use ONE action \
{ "id": "aN", "type": "use", "use": "<fragment_id>" } instead of those actions — \
do NOT regenerate the actions the fragment already covers. After a "use", the state is the \
fragment's POSTCONDITION: continue from there (do not repeat the fragment's fills/clicks; \
the page has already changed). If the fragment alone fulfills the task, the plan is just the \
use action, with nothing after it.

${fragmentsCatalog}\n`
    : "";
  return `You are a browser test automation planner. Generate a JSON action plan \
that fulfills the task below. The plan will be executed DETERMINISTICALLY, action by action, \
with no intelligence at runtime — the selectors must be exact.

# Task
${scenario.task}

${continuesFromDependency
    ? `# Starting point
You are ALREADY INSIDE the app, on the page shown below (final state of the scenario's dependencies — e.g. already authenticated). Do NOT include an initial goto. To reach other screens, NAVIGATE BY CLICKING the visible links and menus (e.g. a[href='/route']) — NEVER use goto actions: reloading the page may lose the session state.`
    : `# Initial URL
${scenario.start_url}
(the executor already navigates to this URL before the first action; do not include a goto for it)`}

# Initial page context (accessibility tree)
${pageTree}

# Interactive elements on the initial page (tag id=... name=... data-test=... type=...)
${interactive.join("\n")}

# Rules
- scenario_id must be exactly "${scenario.scenario_id}"; start_url exactly "${scenario.start_url}"; plan_version "0.1".
- sequential action ids: a1, a2, a3...
- For the initial page, use ONLY CSS selectors of elements present in the context above \
(prefer #id). For subsequent pages, which you are not seeing, infer likely selectors \
from the task and common web conventions (semantic ids/names, data-test). \
Prefer stable selectors.
- Every click/fill/wait_for action requires target.selector AND target.description (human description of the element).
- fill uses "value" with the literal text. Use "value_ref": "ENV:NAME" (without "value") ONLY \
when the task, the hints or the Project manifest explicitly mention that ENV — \
NEVER invent environment variable names. With an ENV defined for a mentioned account, the \
value_ref takes precedence even if the page displays the values.
- Actions that cause navigation must have "expect" with "url" (glob, e.g. "**/inventory.html") \
and/or "selector" of the destination page. The LAST action of the plan MUST have the "expect" field \
proving the task was fulfilled — the final verification is the LAST action's "expect", \
NOT an extra wait_for action.
- timeout_ms: 5000 for simple actions, 10000 for navigations.
- Do NOT include fields that do not apply to the action — never use an empty string as a value. \
click has no value/value_ref/url. The action's "url" field exists ONLY on goto (navigation destination). \
The URL expected after the action goes in expect.url (accepts glob).
- The plan is data, not a program: no conditionals, no loops.
- Generate the SMALLEST plan that fulfills the task: do NOT add actions beyond what was asked — no \
visiting extra pages "to double-check", redundant clicks or additional verification \
steps (the verification is the last action's "expect", not an action).

# Format example (simple login — adapt to the real task)
{
  "plan_version": "0.1",
  "scenario_id": "exemplo",
  "start_url": "https://exemplo.com",
  "actions": [
    { "id": "a1", "type": "fill", "target": { "selector": "#user", "description": "username field" }, "value": "fulano", "timeout_ms": 5000 },
    { "id": "a2", "type": "fill", "target": { "selector": "#pass", "description": "password field" }, "value_ref": "ENV:MINHA_SENHA", "timeout_ms": 5000 },
    { "id": "a3", "type": "click", "target": { "selector": "#entrar", "description": "login button" }, "expect": { "url": "**/home.html", "selector": ".lista" }, "timeout_ms": 10000 }
  ]
}

FINAL REMINDER: the last action of the plan MUST contain the "expect" field proving the task was fulfilled.
${manifestSection}${knowledgeSection}${fragmentsSection}${hintsSection}${failureContext ? `\n# Previous failure context (avoid repeating the mistake)\n${failureContext}\n` : ""}
Respond only with the plan JSON.`;
}

/**
 * The only boundary with the LLM (doc 03): 1 call per cache miss,
 * +1 retry if validation fails, with the error message in the prompt.
 * Provider/model resolved per run (--llm / WINDUP_LLM / config).
 */
export class LlmPlanner implements Planner {
  /** useMap: false = clean A/B without the map knowledge in the prompt (--no-map). */
  constructor(private readonly opts: { useMap?: boolean } = {}) {}

  private call(client: LlmClient, prompt: string, seed: number) {
    return client.generate({
      prompt,
      schema: PLAN_GEMINI_SCHEMA,
      // A 30-action plan fits in ~3k tokens; the cap limits the cost
      // of degenerate generations (observed: 65k tokens in one run).
      maxOutputTokens: 8192,
      // temp > 0 on purpose: with temp 0 the degeneration (loop until
      // MAX_TOKENS) becomes deterministic per prompt — jitter + distinct
      // seeds per attempt escape the degenerate basin.
      temperature: 0.3,
      seed,
    });
  }

  async generate(scenario: Scenario, browser: Browser, failureContext?: string, opts: { skipGoto?: boolean } = {}): Promise<PlanGeneration> {
    // Client created per generation, not in the constructor: cache replays never
    // plan (they must not require a key), and the --llm/--base-url flags have
    // already written to the envs by this point.
    const client = createLlmClient();
    // loadScenario resolves the start_url per environment; the fallback covers direct API calls.
    // skipGoto (depends_on without start_url): the snapshot is of the REAL page where the
    // last dependency ended — the planner no longer plans blind.
    const startUrl = scenario.start_url ?? "/";
    if (!opts.skipGoto) await browser.goto(startUrl);
    // Wait for the app to render before the snapshot (SPA: load is not enough).
    await waitForAnyInteractive(browser);
    const startSig = await browser.pageSignature();

    // Site map slice (E2): pages reachable from the initial one,
    // prioritized by match with the task. The tree yields space to the map
    // so the total prompt stays ≈ constant.
    let siteKnowledge = "";
    if (this.opts.useMap !== false) {
      const { SiteMapStore } = await import("./sitemap.js");
      const { getContext: ctx } = await import("./context.js");
      const store = await SiteMapStore.load(ctx().paths.mapFile);
      siteKnowledge = store.sliceForPrompt(startSig, scenario.task, MAP_MAX_CHARS);
    }
    const treeBudget = siteKnowledge ? PAGE_CONTEXT_MAX_CHARS - MAP_MAX_CHARS : PAGE_CONTEXT_MAX_CHARS;
    const pageTree = (await browser.snapshotTree()).slice(0, treeBudget);
    const interactive = await browser.interactiveElements();

    // Fragment catalog (E3): id + description + postcondition, never the actions.
    const { loadFragments, formatCatalog } = await import("./fragments.js");
    const fragments = await loadFragments();
    const fragmentsCatalog = fragments.length ? formatCatalog(fragments) : undefined;

    const tokens = { input: 0, output: 0 };
    let llmCalls = 0;
    let lastErrors: string[] = [];
    let prompt = buildPrompt(scenario, pageTree, interactive, siteKnowledge, fragmentsCatalog, failureContext, opts.skipGoto === true);
    const promptChars = prompt.length;

    // Two retry levels, of different natures:
    // - semantic (doc 03): plan rejected by validation → 1 retry with the error in the prompt;
    // - transient: flash with structured output sometimes degenerates (token
    //   loop until truncating at MAX_TOKENS) non-deterministically, with the
    //   SAME input that works other times. That is API pathology, not a plan
    //   error — re-call with another seed, up to 3x per semantic attempt.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let plan: Plan | null = null;
      let rawText = "";

      for (let apiTry = 1; apiTry <= 3 && !plan; apiTry++) {
        let response;
        try {
          response = await this.call(client, prompt, attempt * 10 + apiTry);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|timeout|429|500|502|503/i.test(message)) {
            lastErrors = [`network/quota failure calling ${client.provider}: ${message}`];
            await new Promise((r) => setTimeout(r, apiTry * 2000));
            continue;
          }
          throw err;
        }
        llmCalls += 1;
        tokens.input += response.tokens.input;
        tokens.output += response.tokens.output;

        if (process.env.LOG_LEVEL === "debug") {
          console.error(
            `[planner] attempt ${attempt}.${apiTry}: truncated=${response.truncated} out_tokens=${response.tokens.output} len=${response.text.length} tail=${JSON.stringify(response.text.slice(-120))}`,
          );
        }
        if (response.truncated) {
          lastErrors = ["degenerate/truncated response at the token limit — transient API failure"];
          continue;
        }
        try {
          rawText = response.text;
          plan = normalizeActions(sanitizePlan(JSON.parse(rawText))) as Plan;
          if (plan?.actions && fragments.length) plan = dropFragmentEchoes(plan, fragments);
        } catch {
          lastErrors = ["response was not valid JSON — transient API failure"];
        }
      }

      if (plan) {
        const validation = validatePlan(plan);
        // An invented value_ref is the most expensive error (only blows up at
        // runtime): validate against the ENVs actually mentioned in the input.
        if (validation.ok) {
          const allowed = allowedEnvRefs(scenario);
          for (const action of plan.actions) {
            if (action.value_ref && !allowed.has(action.value_ref)) {
              validation.ok = false;
              validation.errors.push(
                `action ${action.id}: value_ref "${action.value_ref}" was not defined by the task, hints or manifest — use the task's literal value or an existing ENV`,
              );
            }
          }
        }
        if (validation.ok) {
          for (const id of inventedPasswordFills(plan, scenario)) {
            console.warn(
              `warning: action ${id} fills a password field with a value not present in the task, hints or manifest — if this is a login, the model invented it; provide the real test credential in the task or via context.credentials`,
            );
          }
          plan.task = scenario.task;
          plan.generated_by = { model: `${client.provider}/${client.model}`, at: new Date().toISOString() };
          return { plan, llm_calls: llmCalls, model: client.model, provider: client.provider, planning_mode: "full", tokens, semantic_retries: attempt - 1, start_sig: startSig, prompt_chars: promptChars };
        }
        lastErrors = validation.errors;
        if (process.env.LOG_LEVEL === "debug") {
          console.error(`[planner] attempt ${attempt} invalid: ${lastErrors.join("; ")}\n${JSON.stringify(plan, null, 2)}`);
        }
      }

      // 1 semantic retry with the error message in the prompt (doc 03); 2nd failure aborts.
      // SHORT retry on purpose: previous plan + errors. Resending the whole
      // prompt with the error notice on top made flash degenerate (uppercase
      // rambling inside the JSON until blowing past MAX_TOKENS).
      prompt = `You generated the JSON action plan below for the task "${scenario.task}", but it is INVALID.

# Previous plan
${plan ? JSON.stringify(plan, null, 2) : rawText.slice(0, 4000)}

# Validation errors to fix
${lastErrors.join("\n")}

# Rules
- click/fill/wait_for require target.selector and target.description; goto requires url.
- fill requires value OR value_ref (exactly one); do not use empty fields or fields that do not apply.
- The LAST action must have the "expect" field (selector and/or url) proving the task was fulfilled.
- scenario_id "${scenario.scenario_id}", start_url "${scenario.start_url}", plan_version "0.1".

Return the complete corrected plan. Respond ONLY with the plan JSON.`;
    }

    throw new PlanGenerationError(
      `invalid plan after retry: ${lastErrors.join("; ")}`,
      tokens,
      llmCalls,
    );
  }
}

/** @deprecated Old name, kept for compatibility — use LlmPlanner. */
export { LlmPlanner as GeminiPlanner };

/**
 * Gemini's structured output tends to fill optional fields with "" instead
 * of omitting them. Recursively removes empty strings, nulls and objects
 * that become empty, before validation (Ajv remains the authority).
 */
export function sanitizePlan(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(sanitizePlan);
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // Literal "undefined"/"null" are model artifacts for "not applicable".
      if (value === "" || value === null || value === undefined || value === "undefined" || value === "null") continue;
      const cleaned = sanitizePlan(value);
      if (cleaned !== null && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      result[key] = cleaned;
    }
    return result;
  }
  return data;
}

/**
 * Removes fields that do not apply to the action type (flash tends to leak
 * them: e.g. "url" or "value" on a click action). Does not change the plan's
 * logic — only discards noise the executor would ignore and the schema would reject.
 */
export function normalizeActions(data: unknown): unknown {
  if (data === null || typeof data !== "object" || !("actions" in data)) return data;
  const plan = data as { actions?: unknown };
  if (!Array.isArray(plan.actions)) return data;
  for (const action of plan.actions as Record<string, unknown>[]) {
    if (action === null || typeof action !== "object") continue;
    switch (action.type) {
      case "click":
      case "wait_for":
        delete action.value;
        delete action.value_ref;
        delete action.url;
        break;
      case "fill":
        delete action.url;
        if (action.value !== undefined && action.value_ref !== undefined) delete action.value_ref;
        break;
      case "goto":
        delete action.value;
        delete action.value_ref;
        delete action.use;
        delete action.target;
        break;
      case "use":
        delete action.value;
        delete action.value_ref;
        delete action.url;
        delete action.target;
        break;
    }
  }
  // Ids are internal bookkeeping (nothing references them): renumbering is always
  // safe and eliminates a whole class of rejection ("1", "step-2", "action3"...).
  (plan.actions as Record<string, unknown>[]).forEach((action, i) => {
    if (action !== null && typeof action === "object") action.id = `a${i + 1}`;
  });

  // The model sometimes expresses the final verification as wait_for instead
  // of expect (or vice versa). wait_for(X) ≡ expect.selector X — normalizes in
  // both directions without changing the meaning.
  const last = plan.actions[plan.actions.length - 1] as Record<string, unknown> | undefined;
  if (last && last.type === "wait_for") {
    const target = (last.target ?? null) as { selector?: string } | null;
    const expect = (last.expect ?? null) as { selector?: string } | null;
    if (!expect?.selector && target?.selector) {
      last.expect = { ...(expect ?? {}), selector: target.selector };
    } else if (expect?.selector && !target?.selector) {
      last.target = { selector: expect.selector, description: "element awaited in the final verification" };
    }
  }
  return data;
}

/**
 * Fragment "echo": models (observed in gpt-5-mini and flash-lite) sometimes
 * repeat the fragment's tail right after the "use" — re-filling the password,
 * re-clicking the button the fragment already clicked — and the plan breaks on
 * the next page. A prompt instruction is not enough across all providers; the
 * removal is MECHANICAL: discards actions immediately after a "use" that
 * duplicate (type+selector) actions of the fragment itself, stopping at the
 * first one that does not duplicate. Legitimate repetitions later in the plan
 * are not touched. Exported for testing.
 */
export function dropFragmentEchoes(plan: Plan, fragments: Fragment[]): Plan {
  const byId = new Map(fragments.map((f) => [f.fragment_id, f]));
  const kept: Action[] = [];
  const actions = plan.actions;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    kept.push(action);
    if (action.type !== "use" || !action.use) continue;
    const fragment = byId.get(action.use);
    if (!fragment) continue;
    const fragmentKeys = new Set(fragment.actions.map((a) => `${a.type}|${a.target?.selector ?? a.url ?? ""}`));
    while (i + 1 < actions.length) {
      const next = actions[i + 1];
      if (!fragmentKeys.has(`${next.type}|${next.target?.selector ?? next.url ?? ""}`)) break;
      // The echo may carry the plan's final verification — preserve the expect
      // on the last kept action before discarding it.
      if (next.expect && !kept[kept.length - 1].expect) kept[kept.length - 1].expect = next.expect;
      i++;
    }
  }
  if (kept.length !== actions.length) {
    kept.forEach((a, idx) => (a.id = `a${idx + 1}`));
    return { ...plan, actions: kept };
  }
  return plan;
}

/**
 * A password-field fill with a value that appears neither in the task, the
 * hints nor the manifest = password INVENTED by the model (seen in dogfooding:
 * "senha123"). Does not block — signing up with a fictional password is
 * legitimate — but warns: in a login, the test will fail far from the cause.
 * Exported for testing.
 */
export function inventedPasswordFills(plan: Plan, scenario: Scenario): string[] {
  const texts = [scenario.task, ...(scenario.hints ?? [])];
  for (const fields of Object.values(getContext().config.context?.credentials ?? {})) {
    texts.push(...Object.values(fields));
  }
  const known = texts.join(" ");
  const suspicious: string[] = [];
  for (const action of plan.actions) {
    if (action.type !== "fill" || !action.value || !action.target) continue;
    const looksPassword = /senha|password|\bpass\b|pwd/i.test(`${action.target.selector} ${action.target.description}`);
    if (looksPassword && !known.includes(action.value)) suspicious.push(action.id);
  }
  return suspicious;
}

/** Legitimately usable ENVs: those mentioned in the task/hints + those in the manifest. */
function allowedEnvRefs(scenario: Scenario): Set<string> {
  const allowed = new Set<string>();
  const texts = [scenario.task, ...(scenario.hints ?? [])];
  const credentials = getContext().config.context?.credentials ?? {};
  for (const fields of Object.values(credentials)) {
    for (const v of Object.values(fields)) texts.push(v);
  }
  for (const text of texts) {
    for (const m of text.matchAll(/ENV:[A-Z0-9_]+/g)) allowed.add(m[0]);
  }
  return allowed;
}

async function waitForAnyInteractive(browser: Browser, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const els = await browser.interactiveElements();
    if (els.length > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

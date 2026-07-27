import { launchBrowser } from "./browser.js";
import { saveCached } from "./cache.js";
import { getContext } from "./context.js";
import { WindupError } from "./errors.js";
import { kebab, writeScenarioFile } from "./authoring.js";
import { inventedPasswordFills, normalizeActions, sanitizePlan } from "./planner.js";
import { validatePlan } from "./schema.js";
import { resolveStartUrl, startPath } from "./start-url.js";
import type { Action, Plan, Scenario } from "./types.js";

export type RecordEvent =
  | { kind: "click"; selector: string; description: string; url: string; unstable?: boolean }
  | { kind: "fill"; selector: string; description: string; value?: string; value_ref?: string; secret?: boolean; url: string; unstable?: boolean }
  | { kind: "assert"; selector: string; description: string; text?: string; url: string; unstable?: boolean }
  | { kind: "finish" };

/**
 * Injected before any page script (string IIFE — never a serialized function,
 * same reason as clock/vitals): a floating toolbar to mark a verification and
 * finish, plus capture-phase click/change listeners that report each real
 * interaction to the exposed `__windupRecord` binding with a stable selector
 * (mirrors the engine's id → data-test → name → type priority) and an
 * accessible description. Toolbar clicks (data-windup-ui) are never recorded.
 */
export const RECORD_INIT_SCRIPT = `(() => {
  if (window.__windupRec) return; window.__windupRec = true;
  var assertMode = false;
  var send = function (e) { try { window.__windupRecord(e); } catch (_) {} };

  // Text that carries a dynamic value (a count, a price) must never become a text anchor — "1Seu carrinhoR$ 35,00Ver carrinho" breaks the moment the value changes.
  function looksDynamic(t) { return /\\d{2,}|[R$€£]\\s*\\d|\\d+[.,]\\d/.test(t); }
  // The element's OWN direct text, not the concatenated textContent of its descendants (which pulls in sibling counts/prices).
  function ownText(el) {
    var direct = "";
    for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3) direct += n.textContent; }
    direct = direct.replace(/\\s+/g, " ").trim();
    return direct || (el.textContent || "").replace(/\\s+/g, " ").trim();
  }
  function isUnique(sel, target) { try { var m = document.querySelectorAll(sel); return m.length === 1 && m[0] === target; } catch (_) { return false; } }
  // "tag >> text=…" is Playwright syntax, not CSS — querySelectorAll can't validate it, so count same-tag elements whose own text matches.
  function uniqueByText(tag, txt, target) {
    try { var all = document.querySelectorAll(tag), hits = []; for (var i = 0; i < all.length; i++) { if (ownText(all[i]).slice(0, 40) === txt) hits.push(all[i]); } return hits.length === 1 && hits[0] === target; } catch (_) { return false; }
  }
  // A short structural path (nearest ancestor id, else tag:nth-of-type chain) — a last resort, always flagged unstable.
  function structural(el) {
    var parts = []; var node = el;
    for (var d = 0; node && node.nodeType === 1 && node !== document.body && d < 5; d++) {
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); return parts.join(" > "); }
      var seg = node.tagName.toLowerCase(); var p = node.parentNode;
      if (p) { var same = 0, idx = 0; for (var j = 0; j < p.children.length; j++) { if (p.children[j].tagName === node.tagName) { same++; if (p.children[j] === node) idx = same; } } if (same > 1) seg += ":nth-of-type(" + idx + ")"; }
      parts.unshift(seg); node = node.parentNode;
    }
    return parts.join(" > ");
  }
  // Returns { selector, unstable }. Tries strong anchors first (id/testid/name/aria-label/placeholder/clean text), accepting the first that UNIQUELY identifies this element; falls back to type-only or a structural path, flagging both unstable so the author knows to add a data-testid.
  function selectorFor(el) {
    if (!el || el === document.body) return { selector: "body", unstable: false };
    var tag = el.tagName.toLowerCase();
    var strong = [];
    if (el.id) strong.push("#" + CSS.escape(el.id));
    var dt = el.getAttribute("data-testid"); if (dt) strong.push("[data-testid=\\"" + dt + "\\"]");
    var dt2 = el.getAttribute("data-test"); if (dt2) strong.push("[data-test=\\"" + dt2 + "\\"]");
    var nm = el.getAttribute("name"); if (nm) strong.push(tag + "[name=\\"" + nm + "\\"]");
    var al = el.getAttribute("aria-label"); if (al) strong.push(tag + "[aria-label=\\"" + al.replace(/"/g, "") + "\\"]");
    var ph = el.getAttribute("placeholder"); if (ph) strong.push(tag + "[placeholder=\\"" + ph + "\\"]");
    for (var i = 0; i < strong.length; i++) { if (isUnique(strong[i], el)) return { selector: strong[i], unstable: false }; }
    // Clean, non-dynamic, unique text on an actionable element is a stable anchor (validated by text count, not querySelectorAll).
    var txt = ownText(el).slice(0, 40);
    if (txt && !looksDynamic(txt) && (tag === "button" || tag === "a" || el.getAttribute("role") === "button") && uniqueByText(tag, txt, el)) return { selector: tag + " >> text=\\"" + txt.replace(/"/g, "") + "\\"", unstable: false };
    // Weak: type-only, accepted only if it happens to be unique — still flagged unstable.
    var ty = el.getAttribute("type"); if ((tag === "input" || tag === "button") && ty) { var w = tag + "[type=\\"" + ty + "\\"]"; if (isUnique(w, el)) return { selector: w, unstable: true }; }
    var st = structural(el);
    return { selector: st || strong[0] || tag, unstable: true };
  }
  function describe(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, 60);
    if (el.id) { var lab = document.querySelector('label[for="' + el.id + '"]'); if (lab && lab.textContent) return lab.textContent.replace(/\\s+/g, " ").trim().slice(0, 60); }
    var ph = el.getAttribute("placeholder"); if (ph) return ph.trim().slice(0, 60);
    var t = ownText(el); if (t) return t.slice(0, 60);
    return el.getAttribute("name") || el.id || el.tagName.toLowerCase();
  }
  function isUi(el) { return !!(el && el.closest && el.closest("[data-windup-ui]")); }

  document.addEventListener("click", function (ev) {
    var el = ev.target; if (isUi(el)) return;
    var act = el.closest && el.closest("button, a, [role=button], input[type=submit], input[type=checkbox], input[type=radio]");
    var target = act || el;
    var s = selectorFor(target);
    var payload = { selector: s.selector, description: describe(target), url: location.href, unstable: s.unstable };
    if (assertMode) { assertMode = false; updateBar(); send({ kind: "assert", selector: payload.selector, description: payload.description, text: ownText(target).slice(0, 60) || undefined, url: payload.url, unstable: s.unstable }); return; }
    send({ kind: "click", selector: payload.selector, description: payload.description, url: payload.url, unstable: s.unstable });
  }, true);

  document.addEventListener("change", function (ev) {
    var el = ev.target; if (isUi(el)) return;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
    if (el.type === "checkbox" || el.type === "radio" || el.type === "submit" || el.type === "button") return;
    var s = selectorFor(el);
    send({ kind: "fill", selector: s.selector, description: describe(el), value: String(el.value == null ? "" : el.value), secret: el.type === "password", url: location.href, unstable: s.unstable });
  }, true);

  var bar, assertBtn;
  function updateBar() { if (assertBtn) { assertBtn.textContent = assertMode ? "◉ clique o elemento a verificar" : "◉ marcar verificação"; assertBtn.style.background = assertMode ? "#a87710" : "#333"; } }
  function build() {
    if (bar && document.body.contains(bar)) return;
    bar = document.createElement("div"); bar.setAttribute("data-windup-ui", "1");
    bar.style.cssText = "position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:8px;padding:8px 10px;background:#1f1b14;border:1px solid #a87710;border-radius:8px;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4)";
    var label = document.createElement("span"); label.textContent = "● windup recording"; label.style.cssText = "color:#d9a441;align-self:center;margin-right:4px";
    assertBtn = document.createElement("button"); assertBtn.setAttribute("data-windup-ui", "1"); assertBtn.style.cssText = "color:#fff;background:#333;border:0;border-radius:5px;padding:6px 10px;cursor:pointer";
    assertBtn.onclick = function () { assertMode = !assertMode; updateBar(); };
    var finishBtn = document.createElement("button"); finishBtn.setAttribute("data-windup-ui", "1"); finishBtn.textContent = "■ finalizar"; finishBtn.style.cssText = "color:#16130e;background:#63c08d;border:0;border-radius:5px;padding:6px 10px;cursor:pointer;font-weight:600";
    finishBtn.onclick = function () { send({ kind: "finish" }); };
    bar.appendChild(label); bar.appendChild(assertBtn); bar.appendChild(finishBtn); document.body.appendChild(bar); updateBar();
  }
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();`;

/** Turns the captured events into a valid Plan (final verification from the last assert, else the final URL). Pure. */
export function buildPlanFromEvents(
  events: RecordEvent[],
  ctx: { scenarioId: string; startUrl: string; finalUrl: string },
): Plan {
  const acts = events.filter((e): e is Extract<RecordEvent, { kind: "click" | "fill" }> => e.kind === "click" || e.kind === "fill");
  const asserts = events.filter((e): e is Extract<RecordEvent, { kind: "assert" }> => e.kind === "assert");
  const actions: Action[] = acts.map((e, i) => {
    const target = { selector: e.selector, description: e.description };
    if (e.kind === "fill") {
      return { id: `a${i + 1}`, type: "fill", target, ...(e.value_ref ? { value_ref: e.value_ref } : { value: e.value ?? "" }), timeout_ms: 5000 } as Action;
    }
    return { id: `a${i + 1}`, type: "click", target, timeout_ms: 5000 } as Action;
  });

  const marked = asserts[asserts.length - 1];
  if (marked) {
    const expect = marked.text ? { text_contains: { selector: marked.selector, text: marked.text } } : { selector: marked.selector };
    actions.push({ id: `a${actions.length + 1}`, type: "wait_for", target: { selector: marked.selector, description: marked.description }, expect, timeout_ms: 5000 } as Action);
  } else {
    // Fallback verification: the final page's path (a bare path matches the pathname).
    const path = safePathname(ctx.finalUrl);
    if (actions.length > 0) actions[actions.length - 1].expect = { url: path };
    else actions.push({ id: "a1", type: "wait_for", target: { selector: "body", description: "the page" }, expect: { url: path }, timeout_ms: 5000 } as Action);
  }

  return { plan_version: "0.1", scenario_id: ctx.scenarioId, start_url: ctx.startUrl, generated_by: { model: "record", at: "" }, actions };
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

/** Drives an interactive headful record session and writes the scenario + cached plan. */
export async function runRecord(opts: { url?: string; id?: string; force?: boolean; useLlm?: boolean }): Promise<{ file: string; scenario_id: string; actions: number; assertion: boolean }> {
  process.env.HEADLESS = "false"; // headful — must be set before the first launch (engine is a lazy singleton)
  const ctx = getContext();
  const startUrl = resolveStartUrl(opts.url ?? ctx.config.baseUrl ?? "/");

  const browser = await launchBrowser({});
  const events: RecordEvent[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => { done = r; });
  await browser.startRecording((ev) => {
    if (ev.kind === "finish") done();
    else events.push(ev);
  });
  await browser.goto(startUrl);
  console.log("● recording — interact in the browser. Use the toolbar to mark a verification and finish (or press Ctrl-C).");

  const onSigint = (): void => done();
  process.once("SIGINT", onSigint);
  await finished;
  process.removeListener("SIGINT", onSigint);

  const finalUrl = browser.url();
  const startSig = await browser.pageSignature().catch(() => undefined);
  await browser.close();

  // Secrets: a typed password never lands in the plan — register it (→ .env.local,
  // gitignored) and emit a value_ref. The account name comes from a nearby user/email fill.
  const emailFill = events.find((e): e is Extract<RecordEvent, { kind: "fill" }> => e.kind === "fill" && !e.secret && /@|user|email|login/i.test(`${e.value ?? ""} ${e.description}`));
  const cleaned: RecordEvent[] = [];
  for (const e of events) {
    if (e.kind === "fill" && e.secret && e.value) {
      const { deriveAccountName, registerCredentials } = await import("./secrets.js");
      const account = deriveAccountName(emailFill?.value);
      const reg = registerCredentials(account, { password: e.value });
      cleaned.push({ ...e, value: undefined, secret: false, value_ref: `ENV:${reg.envs.password}` });
    } else {
      cleaned.push(e);
    }
  }

  // Warn about interactions with no stable anchor (the app exposes no id/testid/name/aria-label there) — these are the ones a DOM shift will break, and exactly where a screen reader would also struggle.
  const unstable = cleaned.filter((e): e is Extract<RecordEvent, { kind: "click" | "fill" }> => (e.kind === "click" || e.kind === "fill") && e.unstable === true);
  if (unstable.length) {
    console.log(`\n⚠ ${unstable.length} interaction(s) have no stable anchor (a11y gap in the app — no id/testid/name/aria-label):`);
    for (const e of unstable.slice(0, 8)) console.log(`    ${e.selector}${e.description ? `  — ${e.description}` : ""}`);
    if (unstable.length > 8) console.log(`    … and ${unstable.length - 8} more`);
    console.log(`  These may break if the DOM shifts. Add a data-testid to those elements, or edit the selector in the scenario/plan.`);
  }

  const baseId = kebab(opts.id ?? deriveId(cleaned, finalUrl)) || "recorded-flow";
  const nInteractions = cleaned.filter((e) => e.kind === "click" || e.kind === "fill").length;
  const assertion = cleaned.some((e) => e.kind === "assert");
  const task = await deriveTask(cleaned, finalUrl, opts.useLlm !== false);

  const scenario: Scenario = { scenario_id: baseId, start_url: startPath(startUrl), task };
  const file = await writeScenarioFile(scenario, { force: opts.force, uniquify: !opts.id }); // finalizes the (unique) id

  const plan = normalizeActions(sanitizePlan(buildPlanFromEvents(cleaned, { scenarioId: scenario.scenario_id, startUrl, finalUrl }))) as Plan;
  plan.task = task; // must equal scenario.task for a cache hit
  const v = validatePlan(plan);
  if (!v.ok) throw new WindupError(`recorded plan is invalid:\n${v.errors.map((e) => `  - ${e}`).join("\n")}\n(the scenario file was written; run \`windup run ${scenario.scenario_id}\` to plan it via LLM instead)`);
  const leaked = inventedPasswordFills(plan, scenario);
  if (leaked.length) throw new WindupError(`a password literal leaked into the recorded plan (${leaked.join(", ")}) — aborting to avoid committing a secret`);

  await saveCached(scenario, plan, startSig);
  console.log(`\n✓ recorded → ${file}  (${nInteractions} interaction(s)${assertion ? " + verification" : ", URL-verified"})`);
  console.log(`  replay at $0:  npx windup run ${scenario.scenario_id}`);
  return { file, scenario_id: scenario.scenario_id, actions: plan.actions.length, assertion };
}

function deriveId(events: RecordEvent[], finalUrl: string): string {
  const path = safePathname(finalUrl).split("/").filter(Boolean).slice(-2).join("-");
  return `record-${path || "flow"}`;
}

/**
 * A readable task synthesized from the VISIBLE LABELS of what was clicked/filled
 * (not "14 interaction(s)") — so a recorded scenario survives a cache invalidation:
 * the self-heal re-plans from a description of the actual flow instead of a blind
 * interaction count. Pure. Consecutive duplicate steps are collapsed; capped so a
 * long flow stays one sentence.
 */
export function synthTask(events: RecordEvent[], finalUrl: string): string {
  const steps = events.filter((e): e is Extract<RecordEvent, { kind: "click" | "fill" }> => e.kind === "click" || e.kind === "fill");
  const phrases: string[] = [];
  for (const e of steps) {
    const label = (e.description || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const phrase = e.kind === "fill" ? (label ? `fill "${label}"` : "fill a field") : label ? `click "${label}"` : "click";
    if (phrases[phrases.length - 1] !== phrase) phrases.push(phrase); // collapse consecutive repeats
  }
  const capped = phrases.slice(0, 12);
  const more = phrases.length > capped.length ? ` (+${phrases.length - capped.length} more)` : "";
  const assertDesc = [...events].reverse().find((e): e is Extract<RecordEvent, { kind: "assert" }> => e.kind === "assert")?.description;
  const seq = capped.length ? capped.join(" → ") : `${steps.length} interaction(s)`;
  return `Recorded flow: ${seq}${more}${assertDesc ? `, verifying "${assertDesc}"` : ""} (ends at ${safePathname(finalUrl)}).`;
}

async function deriveTask(events: RecordEvent[], finalUrl: string, useLlm: boolean): Promise<string> {
  const synth = synthTask(events, finalUrl);
  if (!useLlm) return synth;
  try {
    const { createLlmClient } = await import("./llm.js");
    const llm = createLlmClient();
    const trace = events.filter((e) => e.kind !== "finish").map((e) => JSON.stringify(e)).join("\n");
    const prompt = `A user demonstrated a browser flow. From these captured interactions, write ONE concise sentence (an end-to-end test task) describing what the flow does and what it verifies. Return JSON {"task": "..."}.\n\nInteractions:\n${trace}\n\nFinal URL: ${finalUrl}`;
    const res = await llm.generate({ prompt, schema: { type: "object", required: ["task"], properties: { task: { type: "string" } } }, maxOutputTokens: 256, temperature: 0.3 });
    const task = (JSON.parse(res.text) as { task?: string }).task;
    return task && task.trim().length >= 12 ? task.trim() : synth;
  } catch {
    return synth; // no key / degenerate output — the synthesized task is fine (editable)
  }
}

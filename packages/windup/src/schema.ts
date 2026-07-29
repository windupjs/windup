import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Expect, Plan } from "./types.js";

/**
 * Full JSON Schema of the v0.1 plan (doc 04) — local authority, validated with Ajv.
 */
export const PLAN_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["plan_version", "scenario_id", "start_url", "actions"],
  properties: {
    plan_version: { const: "0.1" },
    scenario_id: { type: "string", minLength: 1 },
    task: { type: "string" },
    start_url: { type: "string", format: "uri" },
    generated_by: {
      type: "object",
      properties: { model: { type: "string" }, at: { type: "string" } },
    },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        required: ["id", "type"],
        properties: {
          id: { type: "string", pattern: "^a[0-9]+$" },
          type: { enum: ["goto", "click", "fill", "wait_for", "use"] },
          target: {
            type: "object",
            required: ["selector", "description"],
            properties: {
              selector: { type: "string" },
              description: { type: "string" },
            },
          },
          value: { type: "string" },
          // "ENV:NAME" (an env var) or a config.resolve name (a runtime value like an OTP).
          // The resolver branch tolerates the LLM's casing/dashes — normalized to a
          // declared name at run time — so a stray "OTP_CODE"/"otp-code" doesn't fail validation.
          value_ref: { type: "string", pattern: "^(ENV:[A-Z0-9_]+|[A-Za-z][A-Za-z0-9_-]*)$" },
          dialog: { type: "string", enum: ["accept", "dismiss"] },
          url: { type: "string", format: "uri" },
          url_ref: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]*$" },
          use: { type: "string" },
          expect: {
            type: "object",
            properties: {
              selector: { type: "string" },
              url: { type: "string" },
              selector_value: {
                type: "object",
                required: ["selector", "value"],
                properties: {
                  selector: { type: "string" },
                  value: { type: "string" },
                },
              },
              text_contains: {
                type: "object",
                required: ["selector", "text"],
                properties: { selector: { type: "string" }, text: { type: "string" } },
              },
              count: {
                type: "object",
                required: ["selector"],
                properties: {
                  selector: { type: "string" },
                  equals: { type: "integer", minimum: 0 },
                  min: { type: "integer", minimum: 0 },
                  max: { type: "integer", minimum: 0 },
                },
              },
              not_visible: { type: "string" },
              attribute: {
                type: "object",
                required: ["selector", "name", "value"],
                properties: { selector: { type: "string" }, name: { type: "string" }, value: { type: "string" } },
              },
            },
          },
          timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
        },
      },
    },
  },
} as const;

/**
 * Relaxed version for Gemini's responseSchema, which accepts only a subset
 * of JSON Schema (no const/pattern/$schema). The local Ajv remains the
 * authority — this version only guides generation.
 */
export const PLAN_GEMINI_SCHEMA = {
  type: "object",
  required: ["plan_version", "scenario_id", "start_url", "actions"],
  properties: {
    plan_version: { type: "string", enum: ["0.1"] },
    scenario_id: { type: "string" },
    task: { type: "string" },
    start_url: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["goto", "click", "fill", "wait_for", "use"] },
          target: {
            type: "object",
            required: ["selector", "description"],
            properties: {
              selector: { type: "string" },
              description: { type: "string" },
            },
          },
          value: { type: "string" },
          value_ref: { type: "string" },
          dialog: { type: "string", enum: ["accept", "dismiss"] },
          url: { type: "string" },
          url_ref: { type: "string" },
          use: { type: "string" },
          expect: {
            type: "object",
            properties: {
              selector: { type: "string" },
              url: { type: "string" },
              selector_value: {
                type: "object",
                required: ["selector", "value"],
                properties: {
                  selector: { type: "string" },
                  value: { type: "string" },
                },
              },
              text_contains: {
                type: "object",
                required: ["selector", "text"],
                properties: { selector: { type: "string" }, text: { type: "string" } },
              },
              count: {
                type: "object",
                required: ["selector"],
                properties: {
                  selector: { type: "string" },
                  equals: { type: "integer" },
                  min: { type: "integer" },
                  max: { type: "integer" },
                },
              },
              not_visible: { type: "string" },
              attribute: {
                type: "object",
                required: ["selector", "name", "value"],
                properties: { selector: { type: "string" }, name: { type: "string" }, value: { type: "string" } },
              },
            },
          },
          timeout_ms: { type: "integer" },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats.default(ajv);
const validateStructure = ajv.compile(PLAN_JSON_SCHEMA);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Layout/landmark selectors that exist on essentially every page. Asserting only
 * that one of them is visible proves nothing beyond "the page loaded", so a plan
 * whose FINAL postcondition is just this can never fail — a green run that looks
 * exactly like evidence while being none. These are web-platform facts (never
 * site knowledge), so the engine may know them.
 */
const LANDMARK_SELECTORS = new Set([
  "body", "html", ":root", "main", "#root", "#app", "#__next", "#___gatsby",
  "[role=main]", '[role="main"]', "div", "span", "section", "article",
  "header", "footer", "nav", "form", "ul", "ol", "table",
]);

function isLandmark(selector: string): boolean {
  return LANDMARK_SELECTORS.has(selector.trim().toLowerCase());
}

/**
 * The selector of a BARE VISIBILITY assertion — one that checks only that an
 * element exists, with no text/count/attribute/value/url alongside it. Returns
 * null for anything else. This is the only shape the live match-count check
 * applies to: `h2` is worthless when the page has five of them, but
 * `text_contains` on `h2` is fine because the assertion is the text.
 */
export function bareSelectorAssertion(expect: Expect | undefined): string | null {
  if (!expect?.selector) return null;
  if (expect.text_contains || expect.count || expect.attribute || expect.selector_value || expect.url) return null;
  return expect.selector;
}

/**
 * True when a postcondition asserts nothing that discriminates a fulfilled task
 * from a merely-loaded page. Any content/value/count/attribute/URL assertion
 * discriminates; bare visibility (or absence) of a landmark does not.
 */
export function trivialExpect(expect: Expect | undefined): boolean {
  if (!expect) return true;
  if (expect.url || expect.selector_value || expect.text_contains || expect.count || expect.attribute) return false;
  if (expect.not_visible) return isLandmark(expect.not_visible);
  if (expect.selector) return isLandmark(expect.selector);
  return true;
}

/**
 * Full validation: structural (Ajv) + semantic (doc 04).
 */
export function validatePlan(data: unknown): ValidationResult {
  if (!validateStructure(data)) {
    const errors = (validateStructure.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
    );
    return { ok: false, errors };
  }

  const plan = data as Plan;
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const action of plan.actions) {
    const where = `action ${action.id}`;

    if (seenIds.has(action.id)) errors.push(`${where}: duplicate id`);
    seenIds.add(action.id);

    if ((action.type === "click" || action.type === "fill" || action.type === "wait_for") && !action.target?.selector) {
      errors.push(`${where}: type=${action.type} requires target.selector`);
    }
    if (action.type === "goto" && !action.url && !action.url_ref) {
      errors.push(`${where}: type=goto requires url (or url_ref for a resolved URL)`);
    }
    if (action.type === "use" && !action.use) {
      errors.push(`${where}: type=use requires the use field with a fragment id`);
    }
    if (action.type === "fill") {
      const hasValue = action.value !== undefined;
      const hasRef = action.value_ref !== undefined;
      if (hasValue === hasRef) {
        errors.push(`${where}: type=fill requires value OR value_ref (exactly one)`);
      }
    }
  }

  const last = plan.actions[plan.actions.length - 1];
  const lastExpect = last.expect ?? {};
  // type=use ends in a fragment whose last action carries its own postcondition.
  const hasAnyExpect =
    lastExpect.selector || lastExpect.url || lastExpect.selector_value ||
    lastExpect.text_contains || lastExpect.count || lastExpect.not_visible || lastExpect.attribute;
  if (last.type !== "use" && !hasAnyExpect) {
    errors.push(`action ${last.id}: the final action must declare expect (selector, url, selector_value, text_contains, count, not_visible or attribute)`);
  } else if (last.type !== "use" && trivialExpect(last.expect)) {
    // A vacuous postcondition is worse than a missing one: it PASSES while
    // proving nothing. Reject it so the planner re-plans (same path as any
    // invalid plan) instead of caching a test that cannot fail.
    errors.push(
      `action ${last.id}: the final postcondition is trivial ("${lastExpect.selector ?? lastExpect.not_visible}" is a landmark that exists on every page) — ` +
        `it passes as long as the page loads, so the test can never fail. Assert something specific to the task instead: ` +
        `text_contains (the exact text the task names), count, attribute, selector_value, an expect.url glob, ` +
        `or a selector that identifies real content (not body/html/main/div/#root).`,
    );
  }

  return { ok: errors.length === 0, errors };
}

import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Plan } from "./types.js";

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
          value_ref: { type: "string", pattern: "^ENV:[A-Z0-9_]+$" },
          url: { type: "string", format: "uri" },
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
          url: { type: "string" },
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
    if (action.type === "goto" && !action.url) {
      errors.push(`${where}: type=goto requires url`);
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
  if (last.type !== "use" && !lastExpect.selector && !lastExpect.url && !lastExpect.selector_value) {
    errors.push(`action ${last.id}: the final action must declare expect (selector, url or selector_value)`);
  }

  return { ok: errors.length === 0, errors };
}

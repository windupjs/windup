import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Plan } from "./types.js";

/**
 * JSON Schema completo do plano v0.1 (doc 04) — autoridade local, validado com Ajv.
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
          type: { enum: ["goto", "click", "fill", "wait_for"] },
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
 * Versão relaxada para o responseSchema do Gemini, que aceita só um
 * subconjunto de JSON Schema (sem const/pattern/$schema). O Ajv local
 * continua sendo a autoridade — esta versão só guia a geração.
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
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        required: ["id", "type"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["goto", "click", "fill", "wait_for"] },
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
 * Validação completa: estrutural (Ajv) + semântica (doc 04).
 */
export function validatePlan(data: unknown): ValidationResult {
  if (!validateStructure(data)) {
    const errors = (validateStructure.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "inválido"}`,
    );
    return { ok: false, errors };
  }

  const plan = data as Plan;
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const action of plan.actions) {
    const where = `ação ${action.id}`;

    if (seenIds.has(action.id)) errors.push(`${where}: id duplicado`);
    seenIds.add(action.id);

    if ((action.type === "click" || action.type === "fill" || action.type === "wait_for") && !action.target?.selector) {
      errors.push(`${where}: type=${action.type} exige target.selector`);
    }
    if (action.type === "goto" && !action.url) {
      errors.push(`${where}: type=goto exige url`);
    }
    if (action.type === "fill") {
      const hasValue = action.value !== undefined;
      const hasRef = action.value_ref !== undefined;
      if (hasValue === hasRef) {
        errors.push(`${where}: type=fill exige value OU value_ref (exatamente um)`);
      }
    }
  }

  const last = plan.actions[plan.actions.length - 1];
  const lastExpect = last.expect ?? {};
  if (!lastExpect.selector && !lastExpect.url && !lastExpect.selector_value) {
    errors.push(`ação ${last.id}: a última ação do plano exige expect (selector, url ou selector_value)`);
  }

  return { ok: errors.length === 0, errors };
}

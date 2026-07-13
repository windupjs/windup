# Validation Spike — Data Schemas

Two artifacts: the **action plan** (what Gemini generates and the executor runs) and the **cache entry** (what persists between executions). Schema version `0.1` — unstable by definition during the spike; every incompatible change increments the minor and invalidates old caches (the `plan_version` field is part of hit validation).

## 1. Action plan (`plan_version: "0.1"`)

```json
{
  "plan_version": "0.1",
  "scenario_id": "saucedemo-checkout",
  "task": "Original task text, for auditing",
  "start_url": "https://www.saucedemo.com",
  "generated_by": { "model": "gemini-2.5-flash", "at": "2026-07-11T14:00:00Z" },
  "actions": [ { "...": "see action schema below" } ]
}
```

### Action schema

```json
{
  "id": "a3",
  "type": "goto | click | fill | wait_for",
  "target": {
    "selector": "#login-button",
    "description": "login button"
  },
  "value": "text to type (fill only)",
  "value_ref": "ENV:SAUCE_PASSWORD (alternative to value; resolved at runtime, never persisted resolved)",
  "url": "https://... (goto only)",
  "expect": {
    "selector": ".inventory_list",
    "url": "**/inventory.html",
    "selector_value": { "selector": "#user-name", "value": "standard_user" }
  },
  "timeout_ms": 10000
}
```

Rules (semantic validation after the schema):

- `id` unique within the plan, sequential (`a1`, `a2`, ...).
- `click`/`fill` require `target.selector`. `goto` requires `url`. `fill` requires `value` **or** `value_ref` (never both).
- `target.description` is mandatory — it is the input for future self-healing (re-locating the element by description when the selector breaks) and serves as plan documentation.
- `expect` is optional per action, but **mandatory on the last action** and recommended on every action that causes navigation. `expect` fields are AND: all present fields must pass.
- `timeout_ms`: default 5000; max. 30000.
- **No free-code field.** The plan is data, not a program. No conditionals, loops, or expressions — if a flow needs those, it is a sign that the scenario should be split, not that the schema should grow.
- The `fallbacks` field (selector variants for self-healing) is **reserved** in the schema but not used in the spike.

### JSON Schema (for Gemini's `responseSchema` and local validation)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["plan_version", "scenario_id", "start_url", "actions"],
  "properties": {
    "plan_version": { "const": "0.1" },
    "scenario_id": { "type": "string", "minLength": 1 },
    "task": { "type": "string" },
    "start_url": { "type": "string", "format": "uri" },
    "actions": {
      "type": "array", "minItems": 1, "maxItems": 30,
      "items": {
        "type": "object",
        "required": ["id", "type"],
        "properties": {
          "id": { "type": "string", "pattern": "^a[0-9]+$" },
          "type": { "enum": ["goto", "click", "fill", "wait_for"] },
          "target": {
            "type": "object",
            "required": ["selector", "description"],
            "properties": {
              "selector": { "type": "string" },
              "description": { "type": "string" }
            }
          },
          "value": { "type": "string" },
          "value_ref": { "type": "string", "pattern": "^ENV:[A-Z0-9_]+$" },
          "url": { "type": "string", "format": "uri" },
          "expect": {
            "type": "object",
            "properties": {
              "selector": { "type": "string" },
              "url": { "type": "string" },
              "selector_value": {
                "type": "object",
                "required": ["selector", "value"],
                "properties": {
                  "selector": { "type": "string" },
                  "value": { "type": "string" }
                }
              }
            }
          },
          "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 30000 }
        }
      }
    }
  }
}
```

`maxItems: 30` is deliberate: it limits the damage of a hallucinated plan and forces short scenarios in the spike.

## 2. Cache entry (`.cache/trajetorias/<scenario_id>.json`)

```json
{
  "cache_version": "0.1",
  "key": {
    "scenario_id": "saucedemo-login",
    "start_url": "https://www.saucedemo.com"
  },
  "plan": { "...": "full plan, as above" },
  "status": "active | stale",
  "stats": {
    "created_at": "2026-07-11T14:00:00Z",
    "last_replayed_at": "2026-07-11T15:30:00Z",
    "replay_count": 10,
    "replay_failures": 0
  }
}
```

- **Hit** = file exists + `status: active` + compatible `cache_version` and `plan.plan_version`.
- **Invalidation** = a verification failure during replay sets `status: stale` (the file is kept for diagnostics; the new plan overwrites it).
- `stats` feeds the validation metrics (replay_count/failures are the evidence for the 10/10 criterion).
- **Page as part of the key:** in the MVP the key gains a `page_signature` (structural hash of the initial DOM) to detect page changes without executing. In the spike, changes are only detected at runtime via verification failure — cheaper to implement and sufficient to validate the mechanism.

## 3. Secrets

`value_ref: "ENV:VAR_NAME"` exists in the schema since v0.1 so that the cache format never has to change because of secrets: the executor resolves the reference at runtime and the real value is never written to disk. In the spike, saucedemo's public credentials may go directly in `value` — but scenario 2 must use `value_ref` in at least one field to exercise the mechanism.

# Spike de Validação — Schemas de Dados

Dois artefatos: o **plano de ações** (o que o Gemini gera e o executor roda) e a **entrada de cache** (o que persiste entre execuções). Versão de schema `0.1` — instável por definição durante a spike; toda mudança incompatível incrementa a minor e invalida caches antigos (campo `plan_version` é parte da validação de hit).

## 1. Plano de ações (`plan_version: "0.1"`)

```json
{
  "plan_version": "0.1",
  "scenario_id": "saucedemo-checkout",
  "task": "Texto original da tarefa, para auditoria",
  "start_url": "https://www.saucedemo.com",
  "generated_by": { "model": "gemini-2.5-flash", "at": "2026-07-11T14:00:00Z" },
  "actions": [ { "...": "ver schema de ação abaixo" } ]
}
```

### Schema de ação

```json
{
  "id": "a3",
  "type": "goto | click | fill | wait_for",
  "target": {
    "selector": "#login-button",
    "description": "botão de login"
  },
  "value": "texto a digitar (só para fill)",
  "value_ref": "ENV:SAUCE_PASSWORD (alternativa a value; resolvida em runtime, nunca persistida resolvida)",
  "url": "https://... (só para goto)",
  "expect": {
    "selector": ".inventory_list",
    "url": "**/inventory.html",
    "selector_value": { "selector": "#user-name", "value": "standard_user" }
  },
  "timeout_ms": 10000
}
```

Regras (validação semântica pós-schema):

- `id` único no plano, sequencial (`a1`, `a2`, ...).
- `click`/`fill` exigem `target.selector`. `goto` exige `url`. `fill` exige `value` **ou** `value_ref` (nunca ambos).
- `target.description` é obrigatória — é o insumo do self-healing futuro (re-localizar o elemento por descrição quando o seletor quebrar) e serve de documentação do plano.
- `expect` é opcional por ação, mas **obrigatório na última ação** e recomendado em toda ação que causa navegação. Campos de `expect` são AND: todos os presentes devem passar.
- `timeout_ms`: default 5000; máx. 30000.
- **Sem campo de código livre.** O plano é dados, não programa. Sem condicionais, loops ou expressões — se um fluxo precisar disso, é sinal de que o cenário deve ser dividido, não de que o schema deve crescer.
- Campo `fallbacks` (variantes de seletor para self-healing) está **reservado** no schema mas não é usado na spike.

### JSON Schema (para `responseSchema` do Gemini e validação local)

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

`maxItems: 30` é deliberado: limita o dano de um plano alucinado e força cenários curtos na spike.

## 2. Entrada de cache (`.cache/trajetorias/<scenario_id>.json`)

```json
{
  "cache_version": "0.1",
  "key": {
    "scenario_id": "saucedemo-login",
    "start_url": "https://www.saucedemo.com"
  },
  "plan": { "...": "plano completo, como acima" },
  "status": "active | stale",
  "stats": {
    "created_at": "2026-07-11T14:00:00Z",
    "last_replayed_at": "2026-07-11T15:30:00Z",
    "replay_count": 10,
    "replay_failures": 0
  }
}
```

- **Hit** = arquivo existe + `status: active` + `cache_version` e `plan.plan_version` compatíveis.
- **Invalidação** = falha de verificação em replay seta `status: stale` (o arquivo é mantido para diagnóstico; o novo plano sobrescreve).
- `stats` alimenta as métricas de validação (replay_count/failures são a evidência do critério 10/10).
- **Página como parte da chave:** no MVP a chave ganha `page_signature` (hash estrutural do DOM inicial) para detectar mudança de página sem executar. Na spike, a mudança só é detectada em runtime pela falha de verificação — mais barato de implementar e suficiente para validar o mecanismo.

## 3. Segredos

`value_ref: "ENV:NOME_DA_VAR"` existe no schema desde a v0.1 para que o formato de cache nunca precise mudar por causa de segredos: o executor resolve a referência em runtime e o valor real jamais é escrito em disco. Na spike, as credenciais públicas do saucedemo podem ir em `value` direto — mas o cenário 2 deve usar `value_ref` em pelo menos um campo para exercitar o mecanismo.

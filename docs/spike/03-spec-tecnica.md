# Spike de Validação — Especificação Técnica

## Stack

| Item | Escolha | Nota |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript | |
| Motor de browser | Stagehand v3 (Browserbase, MIT) | Chromium local via CDP, headless |
| LLM | **Gemini** via API do Google AI Studio | Modelo alvo: `gemini-2.5-flash` (custo baixo, suficiente para gerar JSON estruturado). Formato de modelo no Stagehand: `google/gemini-2.5-flash`, chave via `GOOGLE_GENERATIVE_AI_API_KEY` |
| Cache de trajetórias | Arquivo JSON local (`.cache/trajetorias/*.json`) | Redis vs SQLite fica **em aberto** para o MVP |
| Ambiente | Docker (Node + Chromium) | Ver [05-ambiente.md](05-ambiente.md) |
| CLI | `spike run <cenario> [--no-cache] [--repeat N]` | Sem UI |

**Nota sobre uso do Stagehand:** a spike usa o Stagehand como camada de execução CDP (act sobre seletores determinísticos, observação de DOM, eventos de navegação). A geração do plano é feita por chamada direta ao Gemini com contexto extraído da página — **não** usamos o modo agente do Stagehand, justamente porque a tese do projeto é não delegar o loop de decisão ao LLM.

## Componentes (mínimos da spike)

```
┌─────────┐   miss   ┌──────────────┐
│  Cache   │────────▶│ Planejador   │──▶ Gemini (1 chamada)
│ (JSON)   │         │ (LLM)        │
└────┬────┘         └──────┬───────┘
     │ hit                  │ plano JSON validado (schema)
     ▼                      ▼
┌────────────────────────────────────┐
│ Executor determinístico            │──▶ Stagehand v3 / CDP
│ (loop de ações, zero raciocínio)   │
└────────────────┬───────────────────┘
                 ▼ após cada ação
        ┌────────────────┐  passa  → próxima ação
        │ Verificador     │
        │ (pós-condições) │  falha  → invalida plano → re-planeja (Gemini)
        └────────────────┘
                 ▼ fim do plano
        ┌────────────────┐
        │ Métricas        │──▶ runs/<timestamp>.json
        └────────────────┘
```

### 1. Cache de trajetórias

- Chave: `scenario_id` (string estável definida no arquivo do cenário) + `start_url`.
- Hit → devolve o plano salvo para replay. Miss → aciona o planejador.
- Escrita: só após execução **completa e verificada** do plano.
- Invalidação: falha de verificação em replay marca a entrada como `stale`; próxima execução re-planeja e sobrescreve.
- Sem assinatura de página na spike (decisão de escopo — ver [01-escopo.md](01-escopo.md)).

### 2. Planejador (única fronteira com o LLM)

Entrada do prompt:

- Descrição da tarefa (texto do cenário).
- Contexto da página inicial: accessibility tree / DOM simplificado extraído via Stagehand (`observe()` ou extração direta), truncado a um orçamento fixo de tokens (alvo: ≤ 8k tokens de contexto de página).
- O JSON Schema do plano (o Gemini suporta saída estruturada com `responseSchema` — usar isso, não parsing de texto livre).

Saída: plano JSON. Pipeline de validação:

1. Validação estrutural contra o schema ([04-schemas.md](04-schemas.md)).
2. Validação semântica mínima: toda ação `click`/`fill` tem `target.selector`; última ação tem `expect`.
3. Falha de validação → 1 retry com a mensagem de erro no prompt. Segunda falha → aborta com erro (registrado nas métricas).

**Importante para o experimento:** o planejador vê apenas a página inicial. Para fluxos multi-página (cenário 2), o Gemini precisa prever as etapas seguintes a partir do conhecimento da tarefa. Se isso se mostrar frágil, o fallback documentado é planejamento incremental por página (1 chamada por página nova) — registrar nas métricas qual modo foi necessário, pois isso afeta a tese de custo.

### 3. Executor determinístico

Pseudo-código:

```
plano = cache.get(cenario) ?? planejador.gerar(cenario)
para cada acao em plano.actions:
    stagehand.executar(acao)          # click/fill/goto via seletor, sem LLM
    resultado = verificador.checar(acao.expect, acao.timeout_ms)
    se resultado == FALHA:
        se origem == CACHE:
            cache.invalidar(cenario)
            plano_novo = planejador.gerar(cenario, contexto_da_falha)
            reiniciar execução com plano_novo   # spike: re-planeja o fluxo inteiro
        senão:
            abortar(FALHA_DE_PLANO)             # plano recém-gerado já falhou
se todas passaram: cache.salvar(cenario, plano); métricas.gravar()
```

Tipos de ação suportados na spike: `goto`, `click`, `fill`, `wait_for` (nada mais — sem `select`, `hover`, `scroll`, `press` por enquanto; adicionar só se um cenário exigir).

### 4. Verificador

Pós-condições suportadas na spike, todas baratas (CDP/DOM, sem LLM):

| Pós-condição | Como verifica |
|---|---|
| `expect.selector` | Elemento presente e visível dentro do timeout |
| `expect.url` | URL atual casa com glob pattern (`**/inventory.html`) |
| `expect.selector_value` | Elemento tem o valor esperado (para `fill`) |

`expect_request` (interceptação de rede) fica de fora da spike — o saucedemo não exige, e adiciona complexidade sem contribuir para a validação.

Semântica do timeout: polling do DOM (ou `MutationObserver`) até passar ou estourar `timeout_ms`. Estourar = falha de verificação.

### 5. Métricas

Cada execução grava um `runs/<timestamp>-<cenario>.json`:

```json
{
  "scenario_id": "saucedemo-login",
  "started_at": "2026-07-11T14:00:00Z",
  "cache": "hit | miss | invalidated",
  "llm_calls": 1,
  "llm_model": "gemini-2.5-flash",
  "tokens": { "input": 6200, "output": 480 },
  "estimated_cost_usd": 0.0021,
  "duration_ms": { "total": 8400, "planning": 3100, "execution": 5300 },
  "actions": [
    { "id": "a1", "duration_ms": 350, "verify_ms": 40, "status": "passed" }
  ],
  "result": "passed | failed",
  "failure": null
}
```

Custo estimado = tokens × preço vigente do modelo (tabela de preços em constante no código, com data — preços mudam).

## Fluxos de execução

**Cache miss (1ª execução):** CLI → cache miss → extrai contexto da página → Gemini gera plano → valida → executa ação a ação com verificação → tudo passa → salva no cache → grava métricas.

**Cache hit (replay):** CLI → cache hit → executa plano direto → verificações passam → grava métricas com `llm_calls: 0`.

**Falha em replay (seletor quebrado):** replay → verificação da ação N falha → invalida cache → re-planeja fluxo inteiro via Gemini → executa novo plano → passa → sobrescreve cache. (No MVP isso evolui para re-planejamento parcial com diff de DOM — fora da spike.)

## Decisões em aberto (documentadas, não resolvidas na spike)

| Questão | Opções | Posição atual |
|---|---|---|
| Persistência do cache no MVP | Redis (TTL nativo, multi-worker, exige infra) vs SQLite (zero infra, consultas ricas, single-writer) | Spike usa JSON em disco de propósito para adiar a decisão com dados reais de formato/tamanho das entradas |
| Planejamento de fluxo inteiro vs incremental por página | 1 chamada (mais barato, exige previsão) vs N chamadas (mais robusto, mais caro) | Spike testa fluxo inteiro primeiro; métricas dirão |
| Modelo Gemini definitivo | `gemini-2.5-flash` vs variantes pro | Começar no flash; escalar só se a taxa de planos válidos ficar < 80% |

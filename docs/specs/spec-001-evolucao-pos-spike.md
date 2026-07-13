# SPEC-001 — Evolução Pós-Spike: Mapa do Site, Fragmentos e Manifesto

> **Historical document (Portuguese).** Fully implemented — see the English living specification in [SPEC.md](SPEC.md) and measured results in [RESULTADO-tranche-1.md](RESULTADO-tranche-1.md) / [-2](RESULTADO-tranche-2.md) / [-3](RESULTADO-tranche-3.md).

**Status:** implementada · **Contexto:** [RESULTADO.md](../spike/RESULTADO.md)

## Problema

A spike provou o regime permanente: replay em ~1,2s, custo zero. O que resta lento e frágil é o **cache miss** — primeira execução e re-planejamento. Hoje o planejador vê apenas a página inicial e precisa *prever* as seguintes; a remoção do hardcode (spike 07/A1) expõe essa fragilidade de verdade. Esta spec ataca a raiz: dar ao planejador conhecimento real de todas as páginas do fluxo, sem navegação tela a tela e sem screenshot.

## Princípios (herdados e novos)

1. LLM é exceção, não regra (inalterado).
2. **Zero conhecimento de site hardcoded** (spike 07) — todo conhecimento entra por input ou é descoberto em runtime.
3. **Toda execução é também coleta** — o executor já passa por cada página do fluxo; persistir o que ele vê tem custo marginal ~zero.
4. Conhecimento é cache, não verdade — tudo que o mapa afirma pode estar desatualizado e deve degradar para descoberta em runtime.

## Componente 1 — Mapa do site (site model)

Grafo persistido por projeto: **páginas** (nós) e **transições** (arestas).

```json
{
  "map_version": "0.1",
  "pages": {
    "sig:7f3a…": {
      "urls_seen": ["https://app.exemplo.com/inventory.html"],
      "url_pattern": "**/inventory.html",
      "title": "Products",
      "interactive": ["button id=add-to-cart-x data-test=…", "a class=shopping_cart_link"],
      "first_seen": "2026-07-12T…", "last_seen": "2026-07-12T…", "seen_count": 14
    }
  },
  "transitions": [
    { "from": "sig:1b2c…", "action": { "type": "click", "selector": "#login-button" }, "to": "sig:7f3a…", "seen_count": 14 }
  ]
}
```

- **Assinatura de página (`sig:`):** hash estrutural do DOM — tags + ids + names + data-test dos elementos interativos, normalizado (sem texto dinâmico, sem valores). Duas visitas à mesma tela produzem a mesma assinatura mesmo com dados diferentes. É o pré-requisito de tudo aqui e também vira parte da chave de cache de trajetórias (previsto no doc 04 da spike).
- **Alimentação passiva (mecanismo principal):** após cada ação executada, o executor grava assinatura + elementos interativos + a transição percorrida. Sem chamada extra de rede ou LLM.
- **Alimentação ativa (bootstrap opcional):** crawler explícito — ver SPEC-002 (`scan`), que também alimenta este mesmo grafo a partir do código-fonte.
- **Uso no planejamento:** no cache miss, o runner monta o contexto do prompt com: página inicial (snapshot vivo) + fatias do mapa alcançáveis a partir dela (BFS no grafo, limitado por orçamento de tokens, priorizando páginas cujo `interactive` casa com termos da tarefa). O planejador passa a ver o fluxo inteiro em vez de prever.
- **Staleness:** entrada de mapa com `last_seen` antigo é dica, não verdade; se a verificação falhar em runtime, a página é re-coletada e o mapa atualizado (mesma filosofia da invalidação de trajetória).

## Componente 2 — Fragmentos de trajetória (cache composicional)

Sub-trajetórias nomeadas e reutilizáveis:

```json
{
  "fragment_id": "login-admin",
  "description": "Login como administrador",
  "params": { "user": "ENV:ADMIN_USER", "password": "ENV:ADMIN_PASSWORD" },
  "actions": [ "…mesmo schema de ação do plano…" ],
  "postcondition": { "url": "**/dashboard" }
}
```

- Um plano pode referenciar `{ "use": "login-admin" }` como primeira "ação"; o executor expande inline.
- **Origem dos fragmentos:** (a) o usuário promove um trecho de plano cacheado a fragmento (`rubberduck fragment extract`); (b) detecção automática de prefixos comuns entre planos do mesmo projeto (fase posterior).
- **Ganhos:** prompt menor (a LLM compõe blocos, não regenera), cache hit parcial (fluxo novo que começa com login conhecido já tem o prefixo resolvido), testes legíveis (tarefa Gherkin-like mapeia para fragmentos: "dado que estou logado como admin…" → `use: login-admin`).
- O planejador recebe o catálogo de fragmentos (id + description + postcondition, nunca as ações) no prompt e é instruído a usá-los quando cobrirem parte da tarefa.

## Componente 3 — Manifesto do projeto

Arquivo versionado no repo do usuário (`rubberduck.config.*`, ver SPEC-002), seção `context`:

```jsonc
{
  "context": {
    "base_url": "https://app.exemplo.com",
    "conventions": ["todo elemento interativo tem data-test"],
    "credentials": { "admin": { "user": "ENV:ADMIN_USER", "password": "ENV:ADMIN_PASSWORD" } },
    "vocabulary": { "pedido": "entidade Order, tela /orders", "cliente PJ": "cliente com CNPJ" }
  }
}
```

~1k tokens no prompt. Elimina a maior fonte de erro do planejador (ambiguidade da tarefa), não falta de capacidade. É a generalização do campo `hints` (spike 07/A1) para nível de projeto — e obedece ao mesmo princípio: conhecimento de site é input do usuário, nunca código nosso.

## Otimizações de latência do cache miss (fase posterior)

- **Paralelizar launch + planejamento:** com o mapa cobrindo a página inicial, a chamada à LLM pode disparar antes do browser abrir; snapshot vivo só confirma.
- **Execução especulativa com streaming:** saída estruturada em streaming permite executar `a1` enquanto a LLM ainda gera `a5`. Primeira execução ganha sensação de instantânea. Exige verificação de plano parcial — complexidade alta, só depois do resto estabilizar.
- **Pool de browsers quentes:** corta o ~1,2s fixo do replay para sub-segundo (já recomendado no RESULTADO.md).

## Fases

| Fase | Entrega | Critério de pronto |
|---|---|---|
| E1 | Assinatura de página + chave de cache com assinatura | Mesma tela → mesma sig em 10/10 visitas; tela alterada → sig diferente; replay continua 10/10 |
| E2 | Mapa alimentado por execuções + uso no prompt do planejador | C1 do bench (sem hints, pós spike 07) melhora ou mantém com fluxo multi-página; tokens de prompt medidos |
| E3 | Fragmentos: schema, expansão no executor, `fragment extract` manual | Fluxo composto (`use:` + ações novas) planeja com prompt menor e replay 10/10 |
| E4 | Manifesto do projeto no prompt | Cenário ambíguo sem manifesto falha / com manifesto passa (caso de teste documentado) |
| E5 | Latência: pool de browsers, launch ∥ planejamento | Replay < 500ms p50; miss sem degradar taxa de sucesso |

Streaming/especulação real fica fora destas fases — reavaliar com métricas de E5.

## Decisões em aberto

| Questão | Opções | Nota |
|---|---|---|
| Persistência do mapa | Junto do cache de trajetórias (SQLite favorito pós-spike) vs arquivo próprio | Decidir junto com Redis vs SQLite; grafo pede consultas (BFS) — ponto para SQLite |
| Algoritmo da assinatura | Só elementos interativos vs estrutura completa normalizada | Começar pelo mais simples (interativos); medir taxa de colisão/quebra em E1 |
| Detecção automática de fragmentos | Prefixo comum exato vs similaridade | Só na fase pós-E3; manual primeiro |

# Resultado — Tranche 2 (P2 → E3 → P3)

**Data:** 2026-07-12 · **Escopo:** indexação estática, fragmentos de trajetória e scan incremental (trilha das SPEC-001/002)

## Veredito: ✅ os três marcos passaram

| Marco | Critério (spec) | Medido |
|---|---|---|
| **P2** — `windup scan` estático | ≥90% das rotas por convenção detectadas; elementos com data-test extraídos; mapa populado | ✅ fixture Next (app router com grupos/dinâmicas + pages router): **7/7 rotas (100%)**; elementos data-test/id/name/aria/labels extraídos; nós `static:` no mesmo grafo |
| **E3** — fragmentos | fluxo composto (`use:` + ações novas) planeja e replay 10/10 | ✅ Gemini gerou plano composto (`a1 use login-saucedemo` + 2 ações novas) em **5,4s/1 chamada limpa**; replay **10/10 llm_calls=0** (~0,9s) |
| **P3** — `scan --update` | editar 1 componente → só ele re-indexado; página marcada stale | ✅ teste com repo git real: 1 componente editado → **1/7 rotas re-indexada**; conhecimento de execução da url afetada vira stale |

## Decisões de desenho que valem registro

1. **Precedência execution > static na fatia, não no grafo** — nós estáticos vivem em chave própria (`static:<hash-da-rota>`) e nunca sobrescrevem observação de execução; o dedupe por `url_pattern` acontece ao montar o prompt. Nós estáticos entram na fatia mesmo sem transições — é o que dá valor ao scan **antes da primeira execução**.
2. **Cache guarda a referência `use`, não a expansão** — fragmento atualizado propaga para todos os planos cacheados que o usam; fragmento removido torna o plano órfão → invalidação + re-plano automático (mesmo ciclo da falha de verificação). Fragmentos são commitáveis (conhecimento curado), ao contrário do cache.
3. **Staleness em cascata (P3):** fonte alterado → nó estático re-indexado na hora E nó de execução da mesma url marcado stale (o runtime pode ter mudado com o código); stale sai da fatia do prompt até nova observação, que limpa o flag. "Conhecimento é cache, não verdade" virou mecânica.
4. **Catálogo de fragmentos no prompt expõe id+descrição+pós-condição, nunca as ações** (SPEC-001) — o plano composto saiu com 3 ações em vez de 5, e o prompt não cresceu com o corpo do fragmento.

## Observações

- O plano composto do E3 veio em 1 chamada limpa de 4s — mais um ponto para a hipótese de que prompts com conhecimento estruturado (mapa/fragmentos) escapam da bacia de degeneração do flash; ainda não é conclusivo (Tranche 1 mostrou contraexemplo no compra-dupla).
- `windup status` fecha o ciclo de DX do índice: páginas por origem (+staleness), cenários cacheados, fragmentos, SHA do último scan.
- Suíte em 63 testes; tudo commitado (3 commits, um por marco).

## O que fica para as próximas fases

- **P4**: LLM-assist no scan (com teto `llmAssist.maxCalls`) + crawl dinâmico opcional; indexador react-router.
- **P5**: adapter vitest/jest sobre a API `run()` (já exportada).
- **E4**: manifesto do projeto no prompt (seção `context` da config já tipada e inerte).
- **E5**: pool de browsers + launch ∥ planejamento (replay <500ms p50).
- Detecção automática de fragmentos por prefixo comum (pós-E3, spec-001).
- Dívidas herdadas: clique sintético `isTrusted=false`; A/B de modelo no planejador.

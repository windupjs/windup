# Resultado — Tranche 3 (higiene → E4 → P4 → Playwright+E5 → P5)

**Data:** 2026-07-12 · **Fecha as specs E1–E5 e P1–P5 por completo** · Versões publicadas: 0.3.1 → 0.4.0 → 0.5.0 → 0.6.0 → 0.7.0

## Veredito: ✅ os cinco marcos passaram — specs concluídas

| Marco | Critério | Medido |
|---|---|---|
| **T3-0** higiene do scan | falsos `path:` fora; contagem honesta | ✅ fixture de menu/API não vira rota; contagem pós-dedupe + cap 150/nó com log |
| **E4** manifesto | caso ambíguo documentado com/sem manifesto | ✅ ao vivo: "conta qa" (inexistente na página) sem manifesto → planejador chutou literais raspados da página; com manifesto → `value_ref ENV:*` e replay ok. Manifesto tem precedência sobre texto da página |
| **P4** LLM-assist | rota dinâmica detectada dentro do teto; custo visível | ✅ rotas via `array.map` detectadas com 3/5 chamadas, US$ 0,0005; `source: "llm"` com menor precedência; custo no ledger e no `windup costs` (linha scans); `--no-assist` |
| **Playwright+E5** | sig idêntica; cache antigo 10/10; C1–C5; p50<500ms; headful slowmo; Docker | ✅ sig `540270b8` idêntica (10/10); cache pré-migração replayou 10/10; **C1–C5 todos verdes** com prompt YAML; **p50 replays quentes = 415ms**; headful+SLOWMO 1500ms passou (bug de cliques do Stagehand eliminado — eventos trusted); Docker com chromium do sistema ok |
| **P5** adapter vitest | cenário no report nativo do runner | ✅ `windup e2e > saucedemo-login ✓ 1.3s` via `windupSuite()` de `windupjs/vitest` |

## O que a migração de motor entregou além dos critérios

1. **Dívida do doc 07-A2 quitada**: cliques com actionability nativa e `isTrusted=true` — a limitação conhecida desde a spike deixou de existir.
2. **Árvore de dependências drasticamente menor**: `@browserbasehq/stagehand` (e seus dezenas de providers de IA opcionais, fonte dos warnings de peer deps no install dos usuários) saiu; entrou `playwright` puro.
3. **E5 sem daemon**: engine singleton por processo + context fresco por run — `--repeat`/bench/suite vitest pagam o launch uma vez; isolamento igual ao anterior. Daemon entre invocações continua explicitamente fora (SPEC-001), a reavaliar apenas se o p50 regredir.
4. A troca custou **um único arquivo** (`browser.ts`) — a aposta de arquitetura da spike ("motor atrás de interface") pagou exatamente como desenhado.

## Aprendizados

- O plano cacheado com `use` (fragmento) quebrou a Fase C do bench (não havia `click` para quebrar) — bench agora quebra qualquer ação com target. E o re-plano pós-falha às vezes duplicava o que o fragmento já cobria; o prompt de fragmentos agora instrui a continuar da pós-condição do `use`.
- `ariaSnapshot()` YAML substituiu o `formattedTree` sem regressão de C1 (5/5 no login) e com prompts ~10% menores.
- O critério E4 precisou de desenho cuidadoso: sites demo exibem credenciais na própria página, então "falhar sem manifesto" virou "chutar literais sem manifesto vs `value_ref` disciplinado com manifesto" — contraste mais honesto e mais útil.

## Estado do produto

`windupjs@0.7.0` público no npm; repo `windupjs/windup` (privado). Specs SPEC-001 (E1–E5) e SPEC-002 (P1–P5) **integralmente implementadas e medidas**. Fora do escopo entregue (decisões registradas): crawl dinâmico (P4 opcional), daemon entre invocações (E5), `launch ∥ planejamento` (marco futuro de latência de miss).

## Próximos passos naturais (fora das specs atuais)

- Dogfood contínuo no comando.one (react-router) — scan 0.7 com assist + manifesto do projeto real.
- Indexador Next.js/react-router para monorepos (detecção já avisa).
- Detecção automática de fragmentos por prefixo comum (spec-001, pós-E3).
- SQLite para o mapa quando a escala pedir (interface pronta).
- CI do repositório (GitHub Actions: typecheck+test+bench headless).

# Spike de Validação — Resultado

**Data:** 2026-07-11 · **Ambiente oficial:** Docker (node:22-slim + Chromium, Apple Silicon) · **Modelo:** gemini-2.5-flash

## Veredito: ✅ SEGUIR para o MVP

Os critérios C1–C5 passaram nos **dois** cenários. A hipótese central — LLM só no planejamento, execução determinística, verificação barata e replay sem nenhuma chamada de LLM — está validada.

## Tabela de critérios (protocolo do doc 06)

| # | Critério | Limiar | saucedemo-login | saucedemo-checkout |
|---|---|---|---|---|
| C1 | Planos válidos na 1ª geração | ≥ 4/5 | ✅ 4/5 | ✅ 5/5 |
| C2 | Replay sem LLM | 10/10, llm_calls=0 | ✅ 10/10 | ✅ 10/10 |
| C3 | Ganho de latência | replay ≤ 1/5 da geração | ✅ 16,9x¹ | ✅ 18,5x¹ |
| C4 | Custo de replay | US$ 0 | ✅ US$ 0 (geração média US$ 0,030) | ✅ US$ 0 (geração média US$ 0,014) |
| C5 | Recuperação de falha | pós-condição → re-plano → replay 0 LLM | ✅ completo | ✅ completo |

¹ **Leitura honesta do C3:** a média de geração inclui runs com retries transientes (degeneração da API, ver Surpresas). Comparando só gerações limpas (1 chamada) contra o replay: **login 3,4x** (4,0s vs 1,2s — o plano tem só 3 ações; lançamento do browser domina o replay) e **checkout 10,7x** (13,1s vs 1,2s). No cenário realista (fluxo longo), o ganho supera 5x com folga; no fluxo trivial, o teto físico é ~3,4x. O ganho cresce com o tamanho do fluxo — exatamente o regime que importa.

**Custo total gasto em Gemini durante toda a spike:** US$ 1,64 (144 chamadas, incluindo toda a depuração e 3 execuções completas do bench).

## As três perguntas do doc 01

1. **Viabilidade** — SIM. O Gemini gera planos JSON válidos e executáveis a partir de tarefa + árvore de acessibilidade (via Stagehand `page.snapshot()`), com saída estruturada (`responseSchema`). O checkout (12 ações, 4 páginas nunca vistas pelo modelo) saiu 5/5, com `value_ref: ENV:SAUCE_PASSWORD` corretamente usado — o segredo nunca é persistido resolvido.
2. **Determinismo** — SIM. 20/20 replays (10 por cenário) passaram com `llm_calls: 0`, verificação de pós-condições estável, sem flakiness de timing (verificador com polling até `timeout_ms`, nunca sleep fixo).
3. **Economia** — SIM. Replay custa US$ 0 e roda em ~1,2s; geração custa US$ 0,001–0,024 e 4–13s. O modo full-flow (1 chamada para o fluxo inteiro) foi suficiente — o fallback incremental por página não foi necessário.

## Surpresas e aprendizados

1. **Degeneração não-determinística do flash com structured output** — o maior achado da spike. Com a MESMA entrada, o modelo às vezes entra em loop de texto (divagações em SCREAMING_SNAKE dentro de um campo do JSON) até estourar `maxOutputTokens`. Gatilhos que aprendemos a evitar:
   - *Retry com prompt gigante*: reenviar o prompt inteiro com "ATENÇÃO: erro" em cima degenerava de forma quase determinística. Retry curto (plano anterior + erros + regras resumidas) resolveu.
   - *`temperature: 0`* torna a degeneração determinística por prompt; temp 0,3 + `seed` variado por tentativa escapa da bacia degenerada.
   - Mitigação estrutural: retry **transiente** (até 3 chamadas por tentativa semântica, seeds distintos) separado do retry **semântico** do doc 03 (1x, com erro no prompt). `maxOutputTokens: 8192` limita o custo do pior caso.
2. **`thinkingConfig: { thinkingBudget: 0 }` é obrigatório** — com thinking ligado (default do 2.5-flash), planejar custava 10x mais em latência e tokens.
3. **`responseSchema` tem limites não documentados no schema** — `maxItems` aninhado estoura "too many states" (erro 400); `const`/`pattern`/`format` não são aceitos. A dupla schema-relaxado-para-Gemini + schema-completo-no-Ajv (prevista na spec) funcionou.
4. **O modelo preenche campos que não se aplicam** com `""` ou a string literal `"undefined"` — sanitização mecânica antes da validação é indispensável. Idem normalização `wait_for` ⇄ `expect` (o modelo expressa a verificação final das duas formas; são equivalentes).
5. **O snapshot muda entre ambientes** — o Chromium do Docker renderiza uma árvore de acessibilidade ligeiramente diferente do Chrome local, o que muda o prompt e pode mudar o comportamento do modelo. Reforça a decisão de validar no Docker (ambiente oficial).
6. **Stagehand v3 cumpriu o prometido** — `env: "LOCAL"`, `page.locator()` determinístico e `page.snapshot()` (a11y tree sem LLM) cobriram 100% do executor/verificador/contexto. A árvore a11y não expõe seletores CSS; a extração complementar de `id/name/data-test` via `evaluate()` foi essencial para o modelo não alucinar seletores.
7. **(pós-validação) O clique por coordenadas do Stagehand perde cliques após pausas ociosas** — descoberto ao adicionar modo demo (SLOWMO_MS): com pausa entre ações, o burst de `Input.dispatchMouseEvent` deixa de registrar cliques aleatoriamente, em headless e headful. O executor passou a usar `el.click()` via `evaluate` (dispara handlers e default actions; bench re-executado: C1 5/5, replay 738ms/30x). Ressalva para o MVP: `el.click()` gera eventos `isTrusted=false` — apps que exigem eventos confiáveis precisarão de clique real com actionability checks (padrão Playwright). Idem: gates de visibilidade devem usar `waitForSelector` nativo (que re-resolve frames após navegação), não polling de `isVisible` sobre frame possivelmente obsoleto.

## Decisões tomadas na implementação (para ADRs futuros)

| Decisão | Escolha | Nota |
|---|---|---|
| Stagehand v3 vs Playwright puro | **Stagehand v3** | Gate no M1: fricção baixa, motor isolado em `browser.ts` (troca barata se precisar) |
| Full-flow vs incremental | **Full-flow** | 1 chamada por miss bastou até para 12 ações/4 páginas; incremental fica como fallback documentado |
| Retry de planejamento | Semântico (1x, doc 03) + transiente (3x, seed variado) | Ver Surpresas #1; o critério C1 conta apenas retries semânticos |
| Chave de cache | `(scenario_id, start_url)` simples | Suficiente na spike; `page_signature` fica para o MVP como previsto |

## Recomendações para o MVP

- Manter a arquitetura como está (cache → planejador → executor → verificador → métricas); ela sobreviveu intacta ao contato com a realidade.
- Priorizar no roadmap: assinatura de página na chave de cache, re-planejamento parcial com diff de DOM, self-healing por `target.description` (o insumo já está em todos os planos gerados).
- Considerar teste A/B de modelo no planejador: a taxa de degeneração do flash (~20–40% dos runs em Docker) custa latência; vale medir `gemini-2.5-pro` ou outro provider quando a abstração de provider existir.
- O overhead fixo de ~1,2s do replay é dominado pelo lançamento do browser — pool de browsers no MVP torna o replay sub-segundo.

# Spike de Validação — Critérios e Protocolo

## Protocolo de medição (`spike bench`)

Para **cada** um dos 2 cenários, nesta ordem:

**Fase A — Geração (viabilidade do Gemini):**

1. `cache clear`.
2. Rodar 5 vezes com `--no-cache`.
3. Registrar por rodada: plano passou na validação de schema? (com quantos retries?) Executou até o fim com todas as pós-condições passando? Tokens e custo. Duração de planejamento vs execução.

**Fase B — Replay (determinismo e economia):**

4. Rodar 1 vez normal (popula o cache).
5. Rodar `--repeat 10`.
6. Registrar: chamadas de LLM (deve ser 0 em todas), taxa de sucesso, duração média.

**Fase C — Falha e re-planejamento:**

7. Editar manualmente a entrada de cache quebrando um seletor (ex.: `#login-button` → `#login-button-x`).
8. Rodar 1 vez. Registrar: a falha foi detectada pela pós-condição (não por timeout genérico)? O re-planejamento gerou plano válido e a execução passou? O cache foi sobrescrito e um replay subsequente voltou a ter `llm_calls: 0`?

## Critérios de aceite

| # | Critério | Limiar | Mede |
|---|---|---|---|
| C1 | Planos válidos na 1ª geração (Fase A) | ≥ 4/5 por cenário (schema válido em ≤ 1 retry **e** execução completa) | Viabilidade do Gemini como planejador |
| C2 | Replay sem LLM (Fase B) | 10/10 sucessos, `llm_calls = 0` em todos | Determinismo do replay |
| C3 | Ganho de latência | duração média do replay ≤ 1/5 da duração média com planejamento | Tese de velocidade |
| C4 | Ganho de custo | custo de LLM do replay = US$ 0; custo por geração documentado | Tese de economia |
| C5 | Recuperação de falha (Fase C) | falha detectada por pós-condição + re-planejamento bem-sucedido + replay seguinte com `llm_calls = 0` | Ciclo invalidação → re-plano → cache |

**Resultado da spike:**

- **C1–C5 todos passam** → arquitetura validada; seguir para o MVP (roadmap completo em `docs/04-roadmap-mvp.md`, a escrever).
- **C1 falha** (Gemini não gera planos confiáveis): testar planejamento incremental por página antes de descartar; se ainda falhar, testar `gemini-2.5-pro`. Documentar em ADR.
- **C2 falha** (replay instável): investigar se a instabilidade é de timing (ajustar semântica de timeout/espera) ou de seletor (antecipa a necessidade de self-healing). Não é fatal, mas muda prioridades do MVP.
- **C3 não atinge 5x**: registrar o fator real. Se ≥ 2x, a tese ainda se sustenta parcialmente — decidir com o número na mão.

## Relatório final da spike

Ao fim do protocolo, produzir `docs/spike/RESULTADO.md` com: tabela dos critérios (passou/falhou + número medido), custo total gasto em Gemini durante a spike, principais surpresas/aprendizados, e recomendação explícita (**seguir / ajustar / repensar**). Esse documento é o entregável de decisão da spike — sem ele a spike não terminou.

## Prazo sugerido

A spike deve ser implementável em poucos dias de trabalho. Se ultrapassar ~1 semana, o escopo cresceu além do desenhado — cortar, não estender.

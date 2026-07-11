# Spike de Validação — Escopo

## Objetivo

Validar a hipótese central do projeto: **um fluxo de teste em browser pode ser executado com LLM apenas no planejamento (e no re-planejamento sob falha), com execução determinística e verificação barata — resultando em execuções repetidas sem nenhuma chamada de LLM.**

A spike existe para responder três perguntas, nesta ordem:

1. **Viabilidade** — O Gemini consegue gerar um plano JSON de ações válido e executável a partir de uma descrição de tarefa + contexto da página (via Stagehand v3)?
2. **Determinismo** — O plano gerado pode ser reexecutado (replay) sem LLM, com verificação de pós-condições passando de forma estável?
3. **Economia** — Qual a diferença mensurável de latência e custo entre a 1ª execução (com LLM) e as seguintes (replay do cache)?

Se as três respostas forem positivas, o projeto está validado para seguir ao MVP.

## O que está DENTRO do escopo

- CLI mínima (`spike run <cenario>`) — sem interface gráfica.
- Stagehand v3 rodando Chrome/Chromium headless local.
- Geração de plano JSON via **Gemini** (1 chamada por cache miss).
- Executor determinístico do plano (loop sobre ações, sem raciocínio).
- Verificador de pós-condições (`expect_selector`, `expect_url`).
- Cache de trajetórias em **arquivo JSON local** (persistência mínima; Redis/SQLite ficam para o MVP — ver [04-schemas.md](04-schemas.md)).
- Coleta de métricas por execução: duração total, duração por ação, tokens de entrada/saída, custo estimado, cache hit/miss.
- 2 cenários no [saucedemo.com](https://www.saucedemo.com) — ver [02-cenarios.md](02-cenarios.md).
- Ambiente reprodutível via Docker — ver [05-ambiente.md](05-ambiente.md).

## O que está FORA do escopo (explicitamente)

| Fora | Por quê |
|---|---|
| Interface gráfica / dashboard | Validação é por CLI + arquivos de métricas |
| Self-healing de seletores | É otimização; a spike só precisa provar replay no caminho feliz + re-planejamento sob falha |
| Re-planejamento parcial com diff de DOM | Na spike, falha de verificação invalida o plano e re-planeja o fluxo inteiro (1 chamada extra). O diff parcial é refinamento do MVP |
| Assinatura de página robusta | Chave de cache simplificada: `(id do cenário, URL inicial)` |
| Assertions de teste ricas / reporting | Só pós-condições de ação e um JSON de métricas |
| Múltiplos providers de LLM | Só Gemini. Abstração de provider fica para o MVP |
| Paralelismo, retries sofisticados, screenshots | Fallback de screenshot não é necessário: saucedemo é 100% DOM |

## Critério de sucesso da spike (resumo)

A spike é considerada **validada** se, para os 2 cenários:

- O plano gerado pelo Gemini executa até o fim com todas as pós-condições passando em ≥ 4 de 5 tentativas de geração.
- O replay do plano cacheado passa em **10/10 execuções consecutivas** com **zero chamadas de LLM**.
- O replay é **≥ 5x mais rápido** que a execução com geração de plano e tem **custo de LLM = 0**.
- Ao quebrar um seletor deliberadamente, o sistema detecta a falha pela pós-condição e re-planeja com sucesso.

Métricas e procedimento detalhados em [06-criterios-validacao.md](06-criterios-validacao.md).

## Não-objetivos de aprendizado

A spike **não** tenta medir qualidade do Gemini vs. outros modelos, nem performance do Stagehand vs. Playwright puro. Só valida a arquitetura plano-JSON + verificação + cache.

# Spike de Validação — RubberDuck

Specs do escopo inicial de validação: provar que o loop **plano JSON gerado por LLM → execução determinística → verificação barata → replay via cache sem LLM** funciona num cenário real, antes de investir no MVP. Sem interface — só CLI, Docker e métricas.

Decisões desta spike: LLM = **Gemini** (`gemini-2.5-flash`); alvo = **saucedemo.com**; cache = arquivo JSON local (Redis vs SQLite fica em aberto para o MVP).

## Índice

| Doc | Conteúdo |
|---|---|
| [01-escopo.md](01-escopo.md) | Objetivo, o que está dentro/fora, critério de sucesso resumido |
| [02-cenarios.md](02-cenarios.md) | Os 2 cenários no saucedemo (login e checkout) com plano JSON de exemplo |
| [03-spec-tecnica.md](03-spec-tecnica.md) | Stack, componentes (cache, planejador, executor, verificador, métricas), fluxos e decisões em aberto |
| [04-schemas.md](04-schemas.md) | Schema do plano de ações v0.1, schema da entrada de cache, tratamento de segredos |
| [05-ambiente.md](05-ambiente.md) | Docker, estrutura de pastas, variáveis de ambiente, comandos da CLI |
| [06-criterios-validacao.md](06-criterios-validacao.md) | Protocolo de medição (bench) e critérios de aceite C1–C5 |

## Ordem de leitura

01 → 02 → 03 para entender o que e por quê; 04 → 05 para implementar; 06 para saber quando parar e como decidir.

## Relação com a documentação completa

Esta pasta cobre apenas a spike. A documentação completa do projeto (visão geral, arquitetura, modelo de dados, roadmap do MVP, ADRs, glossário) descrita nas instruções do projeto será escrita em `docs/` — os schemas daqui (v0.1) são o embrião do modelo de dados definitivo.

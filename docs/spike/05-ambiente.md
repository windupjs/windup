# Spike de Validação — Ambiente e Setup

## Princípio

Tudo roda em Docker para reprodutibilidade: qualquer máquina com Docker + uma chave do Gemini executa a spike com um comando. Nenhuma dependência global além do Docker.

## Estrutura do repositório (proposta)

```
RubberDuck/
├── docs/                  # esta documentação
├── spike/
│   ├── src/               # código da spike (TypeScript)
│   ├── scenarios/         # definição dos cenários (YAML ou JSON)
│   │   ├── saucedemo-login.json
│   │   └── saucedemo-checkout.json
│   ├── .cache/trajetorias/   # cache de planos (gitignored)
│   ├── runs/                 # métricas por execução (gitignored)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── .env.example
│   └── package.json
```

### Formato do arquivo de cenário

```json
{
  "scenario_id": "saucedemo-login",
  "start_url": "https://www.saucedemo.com",
  "task": "Fazer login no saucedemo.com com o usuário standard_user e senha secret_sauce e verificar que a lista de produtos aparece."
}
```

O cenário é o input humano; o plano é derivado dele. Cenários são versionados no git; planos (cache) não.

## Docker

**Imagem base:** `node:22-slim` + Chromium e dependências de sistema (fontes, libs gráficas). Alternativa aceitável: partir de `mcr.microsoft.com/playwright:v1.x` que já traz Chromium e libs — decidir na implementação pelo que atritar menos com o Stagehand v3.

**Requisitos do container:**

- Chromium headless funcional (`--no-sandbox` ou usuário não-root com seccomp adequado).
- Variáveis de ambiente via `.env` (nunca commitado).
- Volumes montados para `.cache/` e `runs/` persistirem entre execuções do container — **essencial**: sem volume no `.cache/`, todo run é cache miss e a validação de replay não funciona.

**docker-compose (esboço conceitual):**

```yaml
services:
  spike:
    build: .
    env_file: .env
    volumes:
      - ./.cache:/app/.cache
      - ./runs:/app/runs
      - ./scenarios:/app/scenarios:ro
    command: ["npm", "run", "spike", "--", "run", "saucedemo-login"]
```

## Variáveis de ambiente (`.env.example`)

```
# Chave da API do Gemini (Google AI Studio)
GOOGLE_GENERATIVE_AI_API_KEY=

# Modelo (formato Stagehand: provider/modelo)
LLM_MODEL=google/gemini-2.5-flash

# Credenciais do cenário (exercita value_ref; valores públicos do saucedemo)
SAUCE_USER=standard_user
SAUCE_PASSWORD=secret_sauce

# Execução
HEADLESS=true
LOG_LEVEL=info
```

## Comandos da CLI

| Comando | Efeito |
|---|---|
| `spike run <cenario>` | Executa (cache se existir, senão planeja) |
| `spike run <cenario> --no-cache` | Ignora e não grava cache (mede o caminho LLM isoladamente) |
| `spike run <cenario> --repeat 10` | Executa N vezes em sequência (validação de replay) |
| `spike bench <cenario>` | Roda o protocolo completo de validação do [06-criterios-validacao.md](06-criterios-validacao.md) e imprime o comparativo |
| `spike cache clear` | Apaga o cache de trajetórias |

## Rede e estabilidade

- O container precisa de saída para `saucedemo.com` e `generativelanguage.googleapis.com`.
- saucedemo é estável, mas é serviço de terceiro: falha de rede/indisponibilidade deve ser distinguida de falha de verificação nas métricas (`failure.kind: "network" | "verification" | "plan_invalid"`), para não contaminar os números da validação.

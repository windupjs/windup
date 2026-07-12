# Windup 🥁🦆

**Testes E2E em linguagem natural: a LLM planeja uma vez, o replay roda sozinho.**

Descreva o teste em linguagem natural — *"faça login, adicione o produto ao carrinho, finalize a compra e verifique a mensagem"* — e o Windup o transforma num plano determinístico de ações. Da segunda execução em diante, o teste roda **sem nenhuma chamada de LLM**: ~1 segundo, custo zero, resultado estável.

## Quickstart

```bash
npm i -D windupjs
npx windup init          # 3 perguntas, cria windup.config.ts
npx windup scan          # indexa as rotas do seu projeto (Next.js)
npx windup run checkout  # 1º run: a LLM planeja · 2º em diante: replay ~1s, US$ 0
```

Cenário = JSON com a tarefa em linguagem natural:

```json
{
  "scenario_id": "checkout",
  "start_url": "/",
  "task": "Faça login com o usuário demo e a senha da variável de ambiente DEMO_PASS, adicione o produto X ao carrinho, finalize a compra e verifique a mensagem de pedido concluído."
}
```

Requisitos: Node ≥ 20, `GOOGLE_GENERATIVE_AI_API_KEY` num `.env` (só para planejar; replays não usam LLM) e um Chromium para o Playwright — rode `npx playwright install chromium` uma vez, ou aponte `CHROME_PATH` para um Chrome/Chromium já instalado.

## Comandos

| Comando | Faz |
|---|---|
| `windup init` | Cria config, `.windup/` e cenário de exemplo |
| `windup run <cenario>` | Executa (replay se cacheado; senão planeja) — `--repeat N`, `--no-cache`, `--no-map` |
| `windup scan [--update]` | Indexa rotas/elementos do código-fonte para o mapa do site (incremental via git) |
| `windup fragment extract <cenario> <a1..aN>` | Promove trecho testado a bloco reutilizável |
| `windup status` | Páginas mapeadas, staleness, cenários cacheados, fragmentos |
| `windup bench <cenario>` | Protocolo de validação completo (geração/replay/recuperação) |

## API programática

```ts
import { run } from "windupjs";
const result = await run("checkout");   // RunMetrics: result, llm_calls, custo, ações
```

## Integração com vitest/jest

```ts
// e2e/windup.test.ts
import { windupSuite } from "windupjs/vitest";
await windupSuite();   // um it() por cenário, com report nativo do runner
```

Ou caso a caso: `it("checkout", () => windupTest("checkout"))`. Timeout por cenário e filtro via opções.

## Como funciona

Plano é **dado, não programa**: JSON validado por schema, executado deterministicamente com verificação de pós-condições após cada ação. Falha de verificação invalida o cache e re-planeja sozinho. Toda execução alimenta um **mapa do site** que dá contexto real ao planejador — e o `scan` popula esse mapa direto do seu código antes do primeiro run. O motor não contém conhecimento de nenhum site específico.

## Licença

MIT

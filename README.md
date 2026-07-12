# Windup 🥁🦆

**Testes E2E em linguagem natural: a LLM planeja uma vez, o replay roda sozinho.**

Dê corda uma vez — descreva o teste em português ("faça login, adicione o produto ao carrinho, finalize a compra e verifique a mensagem") — e o Windup transforma isso num plano determinístico de ações. Da segunda execução em diante, o teste roda **sem nenhuma chamada de LLM**: ~1 segundo, custo zero, resultado estável.

```
npm i -D windupjs
npx windup init          # 3 perguntas, cria windup.config.ts
npx windup scan          # indexa as rotas do seu projeto (Next.js)
npx windup run checkout  # 1º run: a LLM planeja · 2º em diante: replay ~1s, US$ 0
```

## Como funciona

```
tarefa em linguagem natural ──▶ planejador (LLM, 1 chamada) ──▶ plano JSON
                                                                   │
        cache de trajetórias ◀── verificação barata ◀── executor determinístico
              │
              └──▶ replays seguintes: zero LLM, ~1s
```

- **Plano é dado, não programa** — JSON validado por schema, sem código gerado.
- **Verificação barata** — pós-condições de DOM/URL após cada ação; falha invalida o plano e re-planeja sozinho.
- **Mapa do site** — toda execução alimenta um grafo de páginas/transições que dá contexto real ao planejador (e o `windup scan` o popula direto do seu código-fonte, antes do primeiro run).
- **Fragmentos** — trechos testados (ex.: login) viram blocos reutilizáveis que a LLM compõe em vez de regenerar.
- **Zero conhecimento de site hardcoded** — o motor conhece frameworks e a web, nunca o SEU site; todo conhecimento entra por input ou é descoberto em runtime.

## Estrutura do repositório

| Pasta | Conteúdo |
|---|---|
| [`packages/windup/`](packages/windup/) | O produto: pacote npm `windupjs` (bin `windup` + API programática) |
| [`docs/specs/`](docs/specs/) | Specs de evolução e resultados medidos de cada tranche |
| [`docs/spike/`](docs/spike/) | A spike que validou a arquitetura (C1–C5) — evidência congelada na tag `spike-validada` |
| [`spike/`](spike/) | Código da spike (congelado; não evolui) |

## Estado

Validado em bench contra cenários reais: geração de plano ≥ 4/5 sem dicas, replay 10/10 com `llm_calls=0`, recuperação automática de seletor quebrado. Planejador default: `gemini-3.1-flash-lite` (~US$ 0,0025/geração). Em desenvolvimento ativo — ainda não publicado no npm.

## Licença

[MIT](LICENSE)

# Resultado — Tranche 1 (E1 → P1 → E2)

**Data:** 2026-07-12 · **Baseline a bater:** C1 multi-página sem hints = checkout 3/5, compra-dupla 5/5 · **Regressão intocável:** replay 10/10 com `llm_calls=0`

## Veredito: ✅ os três marcos passaram; critério E2 batido com folga

| Marco | Critério | Medido |
|---|---|---|
| **E1** — assinatura de página | mesma tela → mesma sig 10/10; alterada → sig ≠; replay 10/10 | ✅ 10/10 sigs idênticas no saucedemo; unit tests de mutação; replay 10/10 (`cache_version` 0.2 com `start_sig`) |
| **P1** — pacote `windupjs` | projeto externo instala via npm e roda sem clonar o repo | ✅ `npm pack` → `npx windup init` (3 perguntas, fallback CI) → 1º run planeja (Gemini), 2º run **1,2s / llm_calls=0**; `import("windupjs")` expõe `run`/`defineConfig` |
| **E2** — mapa do site | C1 sem hints melhora ou mantém; tokens de prompt medidos | ✅ checkout **3/5 → 5/5**; compra-dupla mantém **5/5**; `prompt_chars` ≈ 10,9k reportado por run |

## Números do bench com mapa (sem hints)

| Cenário | C1 | C2 | C3 | custo/geração |
|---|---|---|---|---|
| saucedemo-checkout | 5/5 | 10/10 | 5,7x (6,3s vs 1,1s) | US$ 0,004 |
| saucedemo-compra-dupla | 5/5 | 10/10 | 85,8x (102s vs 1,2s) | US$ 0,068 |

Mapa após 1 execução de compra-dupla + benches: **9 páginas, 17 transições** — inclusive estados distintos da mesma página (inventário com/sem itens no carrinho geram sigs diferentes porque os ids `add-to-cart`⇄`remove` mudam; a limitação prevista do E1 na prática virou cobertura extra: cada estado documenta seus seletores).

## Achados

1. **O mapa resolveu a classe de erro certa.** As falhas do baseline eram seletor plausível-mas-errado em página não vista (`#shopping_cart_container`). Com a instrução "use EXATAMENTE os seletores listados para páginas conhecidas", o checkout foi a 5/5 com `llm_calls=1` limpo e ~6s por geração.
2. **Efeito colateral inesperado e valioso: o prompt com mapa tirou o checkout da bacia de degeneração do flash** (baseline sem hints degenerava em 10/10 gerações; com mapa, zero degeneração no checkout — custo por geração caiu de ~US$ 0,065 para ~US$ 0,004). **Porém não é universal:** as gerações do compra-dupla continuaram degenerando (~100s, US$ 0,068) mesmo com mapa. A degeneração é sensível ao conteúdo exato do prompt; o A/B de modelo no planejador continua prioritário.
3. Coleta passiva custou ~1 evaluate/ação e não degradou o replay (10/10 pós-coleta).
4. `sig_mismatch` ficou em `false` em todos os replays — nenhum falso positivo da assinatura na política leniente até aqui.

## Dívidas mantidas (não são desta tranche)

- Clique sintético `isTrusted=false` (doc 07-A2) — primeiro candidato pós-E2.
- Degeneração do flash no compra-dupla — insumo para o A/B de provider (config `llm` já deixa a troca a 1 linha).
- SQLite para o mapa — reavaliar no P2 com dados de escala (JSON + interface `SiteMapStore` por ora).

## Próxima tranche sugerida (specs)

P2 (`windup scan` estático — Next.js primeiro) → E3 (fragmentos) → P3 (`scan --update` via git), conforme trilha das SPEC-001/002.

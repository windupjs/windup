# Spike — Ajustes Pós-Review (spec de correção)

Correções identificadas na revisão do código da spike (2026-07-11). Três ajustes, em ordem de importância. O A1 invalida parcialmente a evidência do C1 e exige re-execução do bench; os demais são dívidas registradas para não esquecer.

## Princípio transversal: ZERO conhecimento hardcoded de site

**Regra permanente do projeto, válida da spike ao produto final:**

> Nenhum código, prompt ou template pode conter conhecimento específico de um site-alvo — seletores, URLs de páginas internas, convenções de nomenclatura, textos esperados. Todo conhecimento de site entra pelo **input** (arquivo de cenário, tarefa do usuário) ou é **descoberto em runtime** (snapshot da página, extração de elementos). O motor é genérico; o cenário é que conhece o site.

Racional: o produto será usado em sites que nunca vimos. Qualquer dica hardcoded (a) contamina a validação — o sistema parece mais capaz do que é; (b) não escala — não haverá quem escreva dicas para cada site de cliente; (c) mascara a real fronteira de capacidade do planejador, que é exatamente o que precisamos conhecer.

Checklist de conformidade (aplicar em todo PR que toque no planejador):

- Prompt do planejador não menciona nenhum domínio, seletor ou convenção de site específico.
- Exemplos few-shot no prompt usam sites fictícios (`exemplo.com`) com seletores genéricos.
- Nomes de produtos, credenciais e textos esperados vivem só nos arquivos de cenário.
- `git grep -i "saucedemo\|orangehrm\|the-internet" src/` retorna vazio (exceto comentários explicando bugs de terceiros, se houver).

## A1 — Remover dicas do saucedemo do prompt do planejador

**Problema:** `buildPrompt` em `planner.ts` contém seletores do saucedemo hardcoded ("#checkout, #continue, #finish, #first-name... #add-to-cart-<nome>..."). Isso contamina o critério C1: parte do 5/5 do checkout multi-página se explica pela resposta estar no prompt, não pela capacidade do modelo de prever páginas não vistas.

**Mudança:**

1. Remover do prompt todo o trecho de seletores convencionais do saucedemo. A instrução genérica que fica: "Para páginas seguintes à inicial, que você não está vendo, infira seletores prováveis a partir da tarefa e das convenções comuns da web (ids/names semânticos, data-test). Prefira seletores estáveis."
2. Adicionar campo **opcional** `hints: string[]` ao schema do arquivo de cenário — conhecimento site-específico fornecido pelo *usuário* do cenário, injetado no prompt numa seção `# Dicas fornecidas pelo autor do cenário` apenas quando presente. Isso preserva a capacidade sem violar o princípio: a dica é input, não código.

```json
{
  "scenario_id": "saucedemo-checkout",
  "start_url": "https://www.saucedemo.com",
  "task": "…",
  "hints": ["Os botões de adicionar ao carrinho seguem o padrão #add-to-cart-<produto-em-kebab-case>"]
}
```

3. **Re-validar C1 sem hints:** rodar a Fase A do bench (5 gerações, `--no-cache`) para `saucedemo-checkout` e `saucedemo-compra-dupla` com `hints` ausente.
   - **≥ 4/5** → tese de previsão multi-página confirmada de verdade; atualizar RESULTADO.md com os novos números e uma nota sobre a contaminação corrigida.
   - **< 4/5** → registrar no RESULTADO.md que fluxo multi-página **requer** hints do autor ou planejamento incremental por página — isso muda a prioridade do MVP (incremental sobe no roadmap) e precisa ficar explícito, não escondido.

**Aceite:** checklist de conformidade acima passa; bench re-executado; RESULTADO.md atualizado com o desfecho (qualquer que seja).

## A2 — Clique confiável (substituir `el.click()` via `evaluate`)

**Problema:** `browser.ts` clica via `page.evaluate(el.click())` como workaround para o clique por coordenadas do Stagehand perder eventos após pausas ociosas. Consequências: `isTrusted=false` (apps que filtram eventos sintéticos vão falhar em campo) e ausência de actionability checks reais — um elemento coberto por overlay, `disabled` ou fora de viewport "clica" com sucesso na spike e quebraria com usuário real. A spike passa; o produto não passaria.

**Mudança (escopo spike — mitigar e delimitar; solução plena é MVP):**

1. Investigar a causa raiz da perda de cliques por coordenadas do Stagehand (reproduzível com `SLOWMO_MS`). Registrar o achado — se for bug do Stagehand, abrir issue upstream e referenciar no código; pode ser sintoma de algo que afeta `fill` também.
2. Adicionar pré-checks de actionability antes do clique atual, mesmo mantendo o fallback sintético: elemento visível, não `disabled`, não coberto no ponto central (`document.elementFromPoint` compara com o alvo ou descendente). Falha em qualquer check = falha da ação (kind `verification`), não clique cego.
3. Documentar no código e no glossário futuro: clique sintético é **limitação conhecida da spike**; o MVP exige clique confiável (coordenadas + actionability, estilo Playwright, ou correção do Stagehand).

**Aceite:** replay 10/10 continua passando nos cenários existentes; um teste novo prova que clique em elemento coberto por overlay **falha** em vez de "passar" (página de teste local mínima serve).

## A3 — Preservar entrada stale do cache para diagnóstico

**Problema:** `invalidate()` marca `status: stale` prometendo manter o arquivo para diagnóstico, mas o `saveCached()` do re-plano sobrescreve o mesmo caminho — a evidência some. Além disso, `stats` zera a cada re-save, perdendo o histórico de `replay_count`/`replay_failures`.

**Mudança:**

1. `invalidate()` renomeia o arquivo para `<scenario_id>.stale-<timestamp>.json` (mantém no máx. os 3 mais recentes; poda os demais).
2. `saveCached()` após re-plano preserva contadores acumulados: carrega stats da entrada anterior (se houver) e soma, em vez de zerar. Novo campo `plan_generation: N` (quantas vezes o plano deste cenário já foi re-gerado) — insumo barato para detectar cenários instáveis no futuro dashboard.
3. `cache clear` remove também os `.stale-*`.

**Aceite:** teste cobrindo o ciclo replay-falha → invalidate → re-plano → save comprova que o arquivo stale existe em disco e que os contadores acumulam.

## Fora de escopo destes ajustes

Assinatura de página, re-planejamento parcial, self-healing, pool de browsers, Redis/SQLite — continuam sendo MVP ([RESULTADO.md](RESULTADO.md), seção Recomendações). Estes três ajustes fecham a spike com evidência limpa; não abrem frente nova.

## Ordem de execução sugerida

A3 (rápido, destrava testes) → A2 itens 2–3 (pré-checks) → A1 (mudança de prompt + re-bench, que é o mais demorado por envolver chamadas ao Gemini) → A2 item 1 (investigação upstream, pode correr em paralelo). Custo estimado de LLM do re-bench: ~US$ 0,30 (10 gerações × ~US$ 0,03).

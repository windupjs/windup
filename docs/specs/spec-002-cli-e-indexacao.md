# SPEC-002 — Produto: CLI/Lib e Indexação de Projeto

**Status:** proposta · **Complementa:** [SPEC-001](spec-001-evolucao-pos-spike.md) (o `scan` daqui alimenta o mapa do site de lá)

## Forma do produto

**Pacote npm instalado como `devDependency`, executado via `npx rubberduck <cmd>`** (bin no package). Não CLI global.

Racional: versão presa ao projeto (dois projetos podem usar versões diferentes; CI instala a mesma do dev), zero fricção de setup em pipeline, e o pacote dobra como lib (`import { run } from "rubberduck"`) para quem quiser integrar a runner de teste existente (vitest/jest) — a CLI é casca fina sobre a API programática. CLI global pode existir depois como conveniência (`rubberduck init` antes do package.json existir), nunca como forma primária.

**Alvo inicial: projetos JS/TS** (maior base, análise estática mais acessível). O núcleo (planos, cache, mapa, executor) é agnóstico de linguagem — só os *indexadores estáticos* são específicos de ecossistema; outros ecossistemas entram depois via novos indexadores.

## Comandos

| Comando | Faz |
|---|---|
| `rubberduck init` | Cria `rubberduck.config.ts`, `.rubberduck/` (gitignore do cache), detecta framework e sugere config; pergunta o mínimo (base_url, provider de LLM) |
| `rubberduck scan` | Indexação do projeto: estática (código) + dinâmica opcional (crawl leve). Popula o mapa do site |
| `rubberduck scan --update` | Re-indexação incremental: só o que mudou desde o último scan (git diff) |
| `rubberduck run <cenario\|pasta>` | Executa cenário(s) — o `spike run` produtizado |
| `rubberduck fragment extract <cenario> <range>` | Promove trecho de plano cacheado a fragmento (SPEC-001/E3) |
| `rubberduck status` | Estado do índice: páginas mapeadas, staleness, cobertura, cenários cacheados |

## Configuração (`rubberduck.config.ts`)

```ts
export default {
  baseUrl: "http://localhost:3000",
  llm: { provider: "google", model: "gemini-2.5-flash" }, // abstração de provider (recomendação do RESULTADO.md)
  scan: {
    root: ".",                        // pasta do projeto
    include: ["src/**", "app/**"],
    exclude: ["**/*.test.*"],
    dynamic: { enabled: false, maxDepth: 3, maxPages: 50 }, // crawl opcional
    llmAssist: { enabled: true, maxCalls: 20 },             // teto de chamadas LLM por scan
  },
  context: { /* manifesto do projeto — SPEC-001 componente 3 */ },
  scenarios: "e2e/scenarios/",
};
```

Princípios: todo teto explícito (profundidade, páginas, chamadas LLM) — scan nunca surpreende em custo; config commitada, cache não.

## Indexação estática (o diferencial)

Analisar o **código-fonte** dá ao planejador conhecimento que crawl nenhum alcança barato: rotas atrás de login, estados difíceis de reproduzir, seletores estáveis declarados nos componentes. Pipeline em três camadas, da mais barata para a mais cara:

1. **Convenções de framework (sem LLM, sem parser pesado):** detectar framework por `package.json` e extrair rotas por convenção de arquivos — Next.js (`app/`/`pages/`), remix/react-router (file-based ou config), vite+react-router (parse leve das declarações de rota). Saída: lista de rotas com caminho do arquivo-fonte.
2. **Extração de elementos (parse estático):** nos componentes de cada rota, coletar `data-testid`/`data-test`, `id`, `name`, `aria-*`, labels de botões/links e campos de form. Regex/AST leve (ts-morph ou similar), sem executar o app.
3. **LLM-assist (opcional, com teto):** para o que as camadas 1–2 não resolvem (rotas dinâmicas programáticas, componentes muito indiretos), a LLM lê arquivos selecionados e responde num schema fixo ("que rota este arquivo define? que elementos interativos renderiza?"). Limitado por `llmAssist.maxCalls`; resultado marcado com `source: "llm"` e confiança menor no mapa.

Tudo desemboca no **mesmo grafo da SPEC-001**, com nós marcados `source: "static" | "crawl" | "execution"` e a precedência de confiança **execution > crawl > static** — o que foi visto rodando vale mais do que o que foi inferido do código. Página estática que a execução contradisser é corrigida no mapa (princípio "conhecimento é cache, não verdade").

**Conformidade com o zero-hardcode:** indexadores conhecem *frameworks* (Next, react-router — conhecimento genérico e público), nunca *sites*. `git grep` de domínio específico continua tendo que voltar vazio.

## Atualização do índice (evolução do projeto)

**Incremental via git, não watcher.** `scan --update` usa `git diff --name-only <ultimo-scan>..HEAD` (SHA gravado no índice) e re-indexa só arquivos afetados; rotas cujos fontes mudaram têm as páginas marcadas `stale` no mapa.

Racional contra o watcher/daemon: processo residente é complexidade e fonte de bugs; o momento natural de atualizar é *antes de rodar testes*, não a cada save. Integração recomendada: `scan --update` automático no início de `rubberduck run` (rápido, pois é diff) + hook opcional de CI. Um `--watch` pode existir no futuro para DX de quem escreve cenários, como açúcar sobre o incremental — nunca como mecanismo primário.

## Fluxo de primeiro uso (o que o usuário sente)

```
npm i -D rubberduck
npx rubberduck init          # 3 perguntas, cria config
npx rubberduck scan          # ~segundos (estático); mapa inicial do projeto
# escreve e2e/scenarios/checkout.json (tarefa em linguagem natural)
npx rubberduck run checkout  # 1º run: planeja vendo o mapa; 2º em diante: replay ~1s
```

A promessa de produto: **entre o `npm i` e o primeiro teste rodando, minutos — e do segundo run em diante, velocidade de teste unitário.**

## Fases (continuam as E1–E5 da SPEC-001)

| Fase | Entrega | Critério de pronto |
|---|---|---|
| P1 | Empacotamento: bin + API programática, `init`, `run` (migração do código da spike) | Projeto externo instala via npm e roda os cenários da spike sem clonar o repo |
| P2 | `scan` estático camadas 1–2 (Next.js primeiro, depois react-router) | Em projeto Next real: ≥ 90% das rotas por convenção detectadas; elementos com data-test extraídos; mapa populado |
| P3 | `scan --update` incremental via git + `status` | Editar 1 componente → só ele re-indexado; página correspondente marcada stale |
| P4 | LLM-assist com teto + crawl dinâmico opcional | Rotas dinâmicas de projeto-exemplo detectadas dentro do teto de custo; custo por scan reportado |
| P5 | Integração com runner (`import` em vitest/jest) | Cenário rubberduck rodando dentro de um `describe` com report nativo do runner |

Ordem relativa às fases E: P1 pode começar junto de E1; P2+ depende de E2 (mapa existindo). Sugestão de trilha única: E1 → P1 → E2 → P2 → E3 → P3 → demais conforme dor real.

## Decisões em aberto

| Questão | Opções | Nota |
|---|---|---|
| Nome do pacote | **Nome escolhido: Windup** (brinquedo de dar corda — dá corda uma vez [LLM planeja], anda sozinho [replay]; o pato de corda mantém a herança do RubberDuck no logo). Pesquisa 2026-07-12: npm `windup` ocupado por CSS framework abandonado (7 anos — cabível disputa); org `@windup` ocupada; GitHub org `windup` é da Red Hat (ferramenta de migração Java aposentada/rebatizada MTR — categoria distinta, risco baixo) | Plano: pacote `windupjs` ou `@windup-labs/*` + disputa pelo `windup` seco em paralelo; checar domínio (`windup.dev`, `getwindup.com`) e GitHub org alternativa (`windup-labs`) antes do P1. Descartados nesta pesquisa: rubberduck (ocupado), rubber-duck, rubberducky |
| Formato do cenário | JSON atual vs YAML vs Gherkin-like | JSON até E3; a discussão real é junto com fragmentos (legibilidade) |
| Parser AST | ts-morph vs oxc/swc | Decidir no P2 por benchmark de velocidade de scan |
| Monorepos | workspace único vs índice por app | Adiar; detectar e avisar no `init` |

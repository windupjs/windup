# Spike de Validação — Cenários de Teste

Alvo: **https://www.saucedemo.com** — site demo público mantido pela Sauce Labs, feito para automação. Estável, sem captcha, sem rate limit agressivo, 100% renderizado em DOM (sem canvas), com credenciais de teste públicas (`standard_user` / `secret_sauce`).

Dois cenários, em ordem crescente de complexidade. O cenário 1 valida o ciclo básico; o cenário 2 valida um fluxo multi-página com estado.

## Cenário 1 — Login com sucesso

**Tarefa (input do usuário para o planejador):**

> "Fazer login no saucedemo.com com o usuário standard_user e senha secret_sauce e verificar que a lista de produtos aparece."

**Fluxo esperado (referência humana, não é input do sistema):**

1. Navegar para `https://www.saucedemo.com`
2. Preencher `#user-name` com `standard_user`
3. Preencher `#password` com `secret_sauce`
4. Clicar `#login-button`
5. Verificar: URL contém `/inventory.html` e `.inventory_list` presente

**Pós-condição final:** `expect_url: "**/inventory.html"` + `expect_selector: ".inventory_list"`

**Variante negativa (usada no teste de re-planejamento):** rodar o replay com o cache apontando para um seletor quebrado de propósito (ex.: `#login-button-old`). Esperado: verificação da ação falha → plano invalidado → re-planejamento via Gemini → sucesso.

## Cenário 2 — Comprar um produto (fluxo completo)

**Tarefa:**

> "No saucedemo.com, logar com standard_user/secret_sauce, adicionar o item 'Sauce Labs Backpack' ao carrinho, ir ao checkout, preencher nome João, sobrenome Silva, CEP 01000-000, finalizar a compra e verificar a mensagem de pedido concluído."

**Fluxo esperado:**

1. Login (idem cenário 1)
2. Clicar `#add-to-cart-sauce-labs-backpack`
3. Clicar no carrinho (`.shopping_cart_link`) → verificar `/cart.html`
4. Clicar `#checkout` → verificar `/checkout-step-one.html`
5. Preencher `#first-name`, `#last-name`, `#postal-code`
6. Clicar `#continue` → verificar `/checkout-step-two.html`
7. Clicar `#finish` → verificar `/checkout-complete.html`
8. Verificar texto "Thank you for your order" em `.complete-header`

**Pós-condição final:** `expect_url: "**/checkout-complete.html"` + `expect_selector: ".complete-header"`

**Por que este cenário importa:** valida planos com ~10 ações, transições de URL como pós-condição, e replay de fluxo com estado (carrinho). Se o replay passa 10/10 aqui, a hipótese de determinismo está bem suportada.

## Exemplo de plano esperado (cenário 1)

O que o Gemini deve produzir (schema completo em [04-schemas.md](04-schemas.md)):

```json
{
  "plan_version": "0.1",
  "scenario_id": "saucedemo-login",
  "start_url": "https://www.saucedemo.com",
  "actions": [
    {
      "id": "a1",
      "type": "fill",
      "target": { "selector": "#user-name", "description": "campo de usuário" },
      "value": "standard_user",
      "expect": { "selector_value": { "selector": "#user-name", "value": "standard_user" } },
      "timeout_ms": 5000
    },
    {
      "id": "a2",
      "type": "fill",
      "target": { "selector": "#password", "description": "campo de senha" },
      "value": "secret_sauce",
      "timeout_ms": 5000
    },
    {
      "id": "a3",
      "type": "click",
      "target": { "selector": "#login-button", "description": "botão de login" },
      "expect": {
        "url": "**/inventory.html",
        "selector": ".inventory_list"
      },
      "timeout_ms": 10000
    }
  ]
}
```

Observações: nem toda ação precisa de `expect` (a2 não tem — o custo de verificar cada `fill` é opcional na spike); a última ação de cada bloco de navegação **deve** ter `expect` com `url` e/ou `selector`, senão o verificador não tem o que verificar.

## Segredos nos cenários

As credenciais do saucedemo são públicas, então na spike elas podem aparecer no plano em texto claro. A spec de schemas já prevê o campo `value_ref` (referência a variável de ambiente) para o MVP não gravar segredos reais em cache — ver [04-schemas.md](04-schemas.md).

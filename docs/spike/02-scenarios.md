# Validation Spike — Test Scenarios

Target: **https://www.saucedemo.com** — public demo site maintained by Sauce Labs, built for automation. Stable, no captcha, no aggressive rate limiting, 100% DOM-rendered (no canvas), with public test credentials (`standard_user` / `secret_sauce`).

Two scenarios, in increasing order of complexity. Scenario 1 validates the basic cycle; scenario 2 validates a multi-page flow with state.

## Scenario 1 — Successful login

**Task (user input to the planner):**

> "Log in to saucedemo.com with the user standard_user and password secret_sauce and verify that the product list appears."

**Expected flow (human reference, not system input):**

1. Navigate to `https://www.saucedemo.com`
2. Fill `#user-name` with `standard_user`
3. Fill `#password` with `secret_sauce`
4. Click `#login-button`
5. Verify: URL contains `/inventory.html` and `.inventory_list` is present

**Final post-condition:** `expect_url: "**/inventory.html"` + `expect_selector: ".inventory_list"`

**Negative variant (used in the re-planning test):** run the replay with the cache pointing to a deliberately broken selector (e.g., `#login-button-old`). Expected: action verification fails → plan invalidated → re-planning via Gemini → success.

## Scenario 2 — Buy a product (full flow)

**Task:**

> "On saucedemo.com, log in with standard_user/secret_sauce, add the item 'Sauce Labs Backpack' to the cart, go to checkout, fill in first name João, last name Silva, ZIP code 01000-000, complete the purchase and verify the order-complete message."

**Expected flow:**

1. Login (same as scenario 1)
2. Click `#add-to-cart-sauce-labs-backpack`
3. Click the cart (`.shopping_cart_link`) → verify `/cart.html`
4. Click `#checkout` → verify `/checkout-step-one.html`
5. Fill `#first-name`, `#last-name`, `#postal-code`
6. Click `#continue` → verify `/checkout-step-two.html`
7. Click `#finish` → verify `/checkout-complete.html`
8. Verify the text "Thank you for your order" in `.complete-header`

**Final post-condition:** `expect_url: "**/checkout-complete.html"` + `expect_selector: ".complete-header"`

**Why this scenario matters:** it validates plans with ~10 actions, URL transitions as post-conditions, and replay of a stateful flow (cart). If replay passes 10/10 here, the determinism hypothesis is well supported.

## Example of expected plan (scenario 1)

What Gemini should produce (full schema in [04-schemas.md](04-schemas.md)):

```json
{
  "plan_version": "0.1",
  "scenario_id": "saucedemo-login",
  "start_url": "https://www.saucedemo.com",
  "actions": [
    {
      "id": "a1",
      "type": "fill",
      "target": { "selector": "#user-name", "description": "username field" },
      "value": "standard_user",
      "expect": { "selector_value": { "selector": "#user-name", "value": "standard_user" } },
      "timeout_ms": 5000
    },
    {
      "id": "a2",
      "type": "fill",
      "target": { "selector": "#password", "description": "password field" },
      "value": "secret_sauce",
      "timeout_ms": 5000
    },
    {
      "id": "a3",
      "type": "click",
      "target": { "selector": "#login-button", "description": "login button" },
      "expect": {
        "url": "**/inventory.html",
        "selector": ".inventory_list"
      },
      "timeout_ms": 10000
    }
  ]
}
```

Notes: not every action needs an `expect` (a2 has none — the cost of verifying every `fill` is optional in the spike); the last action of each navigation block **must** have an `expect` with `url` and/or `selector`, otherwise the verifier has nothing to verify.

## Secrets in the scenarios

The saucedemo credentials are public, so in the spike they may appear in the plan in plain text. The schema spec already provides the `value_ref` field (a reference to an environment variable) so the MVP does not write real secrets to cache — see [04-schemas.md](04-schemas.md).

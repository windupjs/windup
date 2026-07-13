# Validation Spike — RubberDuck

Specs for the initial validation scope: prove that the loop **LLM-generated JSON plan → deterministic execution → cheap verification → cached replay without LLM** works in a real scenario, before investing in the MVP. No interface — just CLI, Docker, and metrics.

Decisions for this spike: LLM = **Gemini** (`gemini-2.5-flash`); target = **saucedemo.com**; cache = local JSON file (Redis vs SQLite remains open for the MVP).

## Index

| Doc | Contents |
|---|---|
| [01-scope.md](01-scope.md) | Objective, what is in/out of scope, summarized success criteria |
| [02-scenarios.md](02-scenarios.md) | The 2 saucedemo scenarios (login and checkout) with an example JSON plan |
| [03-technical-spec.md](03-technical-spec.md) | Stack, components (cache, planner, executor, verifier, metrics), flows, and open decisions |
| [04-schemas.md](04-schemas.md) | Action plan schema v0.1, cache entry schema, secrets handling |
| [05-environment.md](05-environment.md) | Docker, folder structure, environment variables, CLI commands |
| [06-validation-criteria.md](06-validation-criteria.md) | Measurement protocol (bench) and acceptance criteria C1–C5 |
| [07-post-review-fixes.md](07-post-review-fixes.md) | Post-review corrections: zero hardcoded site knowledge (permanent principle), reliable click, stale cache |

## Reading order

01 → 02 → 03 to understand what and why; 04 → 05 to implement; 06 to know when to stop and how to decide.

## Relationship with the full documentation

This folder covers only the spike. The project's full documentation (overview, architecture, data model, MVP roadmap, ADRs, glossary) described in the project instructions will be written in `docs/` — the schemas here (v0.1) are the embryo of the definitive data model.

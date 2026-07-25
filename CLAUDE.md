# Windup — project rules

## Documentation routine (mandatory)

Every change that ships — new feature, new command, new flag, behavior change, config change — MUST update the documentation in the same commit:

1. `packages/windup/README.md` — the npm-facing user docs (commands table, flags, config reference, relevant sections).
2. `docs/specs/SPEC.md` — the living specification (architecture, data formats, principles, limitations).
3. Root `README.md` — only when the pitch/feature list or status changes.
4. **The docs site** — the separate `windupjs/site` repo (Astro). ANY user-facing change (new flag, command, scenario field, behavior) MUST also land on the site, in **all four languages** (`en`, then `es`/`pt`/`zh` — translate the prose, keep code/flags/tokens verbatim). Pages: `commands.md` (flags table), `ci-cd.md`, `scenarios.md`, `configuration.md`, `credentials.md`, `architecture.md`. Do not let the site fall behind releases — mirror it in the same round as the repo docs. `llms-full.txt` is generated from the docs collection (auto-current); the **curated `src/i18n/llmsText.ts`** (the `llms.txt` "fast facts") is hand-written — update it when a scenario field, the scenario JSON schema, or a core CLI fact changes.

ALL repository content is written in **English** — documentation, code comments, LLM prompt templates, test names and commit messages. Functional Portuguese stays only where it is data: regexes matching user input (e.g. `senha|password`) and tokenizer stopword lists. A feature without updated docs is not done. Remember the npm README only updates when a new version is published.

## Zero hardcoded site knowledge (permanent principle)

The engine may know frameworks and the web platform — never a specific site. Before any commit touching `packages/windup/src/`:

```bash
git grep -iE "saucedemo|orangehrm|the-internet" packages/windup/src/
```

must return nothing. Site knowledge enters only via input (scenarios, hints, config manifest) or runtime discovery.

## Release routine

`npm run typecheck && npm test` green → bump version in `packages/windup` → build → commit + push → publish to npm (ephemeral `.npmrc`, never persist the token) → `git tag v<version> && git push --tags` → `gh release create v<version> --title v<version> --notes "<one-line summary>"`. Every npm version MUST have a matching GitHub tag + release. Update SPEC/README **and add a CHANGELOG.md entry** before the publish so the npm page ships the new docs and the changelog stays current.

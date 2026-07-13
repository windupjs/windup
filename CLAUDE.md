# Windup — project rules

## Documentation routine (mandatory)

Every change that ships — new feature, new command, new flag, behavior change, config change — MUST update the documentation in the same commit:

1. `packages/windup/README.md` — the npm-facing user docs (commands table, flags, config reference, relevant sections).
2. `docs/specs/SPEC.md` — the living specification (architecture, data formats, principles, limitations).
3. Root `README.md` — only when the pitch/feature list or status changes.

All documentation is written in **English**. A feature without updated docs is not done. Remember the npm README only updates when a new version is published.

## Zero hardcoded site knowledge (permanent principle)

The engine may know frameworks and the web platform — never a specific site. Before any commit touching `packages/windup/src/`:

```bash
git grep -iE "saucedemo|orangehrm|the-internet" packages/windup/src/
```

must return nothing. Site knowledge enters only via input (scenarios, hints, config manifest) or runtime discovery.

## Release routine

`npm run typecheck && npm test` green → bump version in `packages/windup` → build → commit + push → publish to npm (ephemeral `.npmrc`, never persist the token). Update SPEC/README before the publish so the npm page ships the new docs.

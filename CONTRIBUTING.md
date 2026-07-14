# Contributing to Windup

Thanks for your interest! Windup is a natural-language E2E testing tool where the
LLM plans once and replays run deterministically. This guide gets you set up and
explains the few conventions that keep the codebase honest.

## Setup

```bash
git clone https://github.com/windupjs/windup
cd windup
npm install            # from the repo root (npm workspaces)
cd packages/windup
npm run build
npm test               # ~150 tests, LLM-hermetic (no API key needed)
```

To run scenarios against a real browser you need a `GOOGLE_GENERATIVE_AI_API_KEY`
(or `OPENAI_API_KEY`) in `packages/windup/.env.local`. The test suite does **not**
need one — it fakes the LLM.

## Project conventions

These are non-negotiable; PRs that break them will be asked to change:

- **Everything is in English** — code, comments, LLM prompt templates, tests,
  commit messages. The only Portuguese left is functional data (regexes that
  match user input, tokenizer stopwords, fixtures that exercise non-ASCII).
- **Zero hardcoded site knowledge.** The engine may know frameworks and the web,
  never a specific site. Before committing anything under `packages/windup/src/`:
  ```bash
  git grep -iE "saucedemo|orangehrm|the-internet" packages/windup/src/   # must be empty
  ```
  Site knowledge enters only via scenarios, hints, or the config manifest.
- **Plans are data, not code.** No conditionals or loops in plans; deterministic
  execution; every action carries a verifiable postcondition.
- **Prompts are tuned code.** Any change to an LLM prompt template must be
  revalidated live (small models regress easily) before it merges — run a few
  fresh generations across the default model and at least one other provider.
- **Docs travel with the change.** A feature or flag updates the package README
  and `docs/specs/SPEC.md` in the same PR.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run build
```

Keep changes focused. New behavior gets a test. If your change touches a prompt,
say in the PR how you revalidated it.

## Reporting bugs and requesting features

Use the issue templates. For security issues, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## License

By contributing you agree that your contributions are licensed under the
project's [MIT license](LICENSE).

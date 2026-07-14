# Security

## Reporting a vulnerability

Please report security issues privately via a GitHub Security Advisory on the
repository, or by email to the maintainer. Do not open a public issue for
undisclosed vulnerabilities.

## Threat model

Windup runs your app in a real browser and feeds page content to an LLM for
**planning** (never for execution). The design keeps that boundary safe:

- **Plans are data, not code.** The planner's output is a schema-validated JSON
  action plan, executed deterministically. A page cannot make Windup run
  arbitrary code, shell out, or read the filesystem through the plan.
- **Untrusted page content is delimited.** Accessibility snapshots and element
  lists captured from the app under test are wrapped and explicitly marked as
  untrusted data in every prompt (planner, `--summary`, `--suggest`); the model
  is instructed to treat them as data to analyze, never as instructions. Only
  the task and the tool's own rules are authoritative.
- **Residual risk.** A crafted or compromised page could still bias a *generated
  plan or a summary* (it cannot execute code). Run Windup against applications
  you control, in test environments — the same posture you already use for E2E
  tests. Review scenarios before trusting them in CI.

## Credentials and secrets

- Credential **values** never enter scenarios, plans, the trajectory cache, or
  LLM prompts. Scenarios and plans carry only references (`value_ref:
  "ENV:VAR"`), resolved at execution time. Values live in `.env.local`
  (gitignored) or CI secrets. See "Test credentials" in the README.
- `windup new` detects credentials typed in an instruction and auto-registers
  them as an account, scrubbing the literal values from the generated scenario.

## Local artifacts

The `.windup/` directory (trajectory cache, run ledger, `failure_snapshot`, site
map) can contain content captured from the app under test — including data
rendered on screen. It is gitignored by default. Do not commit it, and treat it
as you would any test-environment data. `windup.credentials.json` contains only
ENV-variable names, never values, and is safe to commit.

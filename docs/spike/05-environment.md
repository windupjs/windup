# Validation Spike — Environment and Setup

## Principle

Everything runs in Docker for reproducibility: any machine with Docker + a Gemini key runs the spike with a single command. No global dependency other than Docker.

## Repository structure (proposed)

```
RubberDuck/
├── docs/                  # this documentation
├── spike/
│   ├── src/               # spike code (TypeScript)
│   ├── scenarios/         # scenario definitions (YAML or JSON)
│   │   ├── saucedemo-login.json
│   │   └── saucedemo-checkout.json
│   ├── .cache/trajetorias/   # plan cache (gitignored)
│   ├── runs/                 # per-execution metrics (gitignored)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── .env.example
│   └── package.json
```

### Scenario file format

```json
{
  "scenario_id": "saucedemo-login",
  "start_url": "https://www.saucedemo.com",
  "task": "Log in to saucedemo.com with the user standard_user and password secret_sauce and verify that the product list appears."
}
```

The scenario is the human input; the plan is derived from it. Scenarios are versioned in git; plans (cache) are not.

## Docker

**Base image:** `node:22-slim` + Chromium and system dependencies (fonts, graphics libs). Acceptable alternative: start from `mcr.microsoft.com/playwright:v1.x`, which already ships Chromium and libs — decide during implementation based on what causes the least friction with Stagehand v3.

**Container requirements:**

- Working headless Chromium (`--no-sandbox` or a non-root user with an appropriate seccomp profile).
- Environment variables via `.env` (never committed).
- Volumes mounted so `.cache/` and `runs/` persist across container executions — **essential**: without a volume on `.cache/`, every run is a cache miss and replay validation does not work.

**docker-compose (conceptual sketch):**

```yaml
services:
  spike:
    build: .
    env_file: .env
    volumes:
      - ./.cache:/app/.cache
      - ./runs:/app/runs
      - ./scenarios:/app/scenarios:ro
    command: ["npm", "run", "spike", "--", "run", "saucedemo-login"]
```

## Environment variables (`.env.example`)

```
# Gemini API key (Google AI Studio)
GOOGLE_GENERATIVE_AI_API_KEY=

# Model (Stagehand format: provider/model)
LLM_MODEL=google/gemini-2.5-flash

# Scenario credentials (exercises value_ref; public saucedemo values)
SAUCE_USER=standard_user
SAUCE_PASSWORD=secret_sauce

# Execution
HEADLESS=true
LOG_LEVEL=info
```

## CLI commands

| Command | Effect |
|---|---|
| `spike run <scenario>` | Executes (cache if present, otherwise plans) |
| `spike run <scenario> --no-cache` | Ignores and does not write cache (measures the LLM path in isolation) |
| `spike run <scenario> --repeat 10` | Executes N times in sequence (replay validation) |
| `spike bench <scenario>` | Runs the full validation protocol from [06-validation-criteria.md](06-validation-criteria.md) and prints the comparison |
| `spike cache clear` | Deletes the trajectory cache |

## Network and stability

- The container needs outbound access to `saucedemo.com` and `generativelanguage.googleapis.com`.
- saucedemo is stable, but it is a third-party service: network failure/unavailability must be distinguished from verification failure in the metrics (`failure.kind: "network" | "verification" | "plan_invalid"`), so as not to contaminate the validation numbers.

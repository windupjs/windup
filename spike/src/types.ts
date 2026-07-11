export type ActionType = "goto" | "click" | "fill" | "wait_for";

export interface ActionTarget {
  selector: string;
  description: string;
}

export interface ExpectSelectorValue {
  selector: string;
  value: string;
}

export interface Expect {
  selector?: string;
  url?: string;
  selector_value?: ExpectSelectorValue;
}

export interface Action {
  id: string;
  type: ActionType;
  target?: ActionTarget;
  value?: string;
  value_ref?: string;
  url?: string;
  expect?: Expect;
  timeout_ms?: number;
}

export interface Plan {
  plan_version: "0.1";
  scenario_id: string;
  task?: string;
  start_url: string;
  generated_by?: { model: string; at: string };
  actions: Action[];
}

export interface Scenario {
  scenario_id: string;
  start_url: string;
  task: string;
}

export type CacheStatus = "active" | "stale";

export interface CacheEntry {
  cache_version: "0.1";
  key: { scenario_id: string; start_url: string };
  plan: Plan;
  status: CacheStatus;
  stats: {
    created_at: string;
    last_replayed_at: string | null;
    replay_count: number;
    replay_failures: number;
  };
}

export type FailureKind = "network" | "verification" | "plan_invalid";

export type CacheOutcome = "hit" | "miss" | "invalidated";

export interface ActionMetrics {
  id: string;
  duration_ms: number;
  verify_ms: number;
  status: "passed" | "failed";
}

export interface RunMetrics {
  scenario_id: string;
  started_at: string;
  cache: CacheOutcome;
  llm_calls: number;
  llm_model: string | null;
  planning_mode: "full" | "incremental" | null;
  tokens: { input: number; output: number };
  estimated_cost_usd: number;
  duration_ms: { total: number; planning: number; execution: number };
  actions: ActionMetrics[];
  result: "passed" | "failed";
  failure: { kind: FailureKind; action_id: string | null; message: string } | null;
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

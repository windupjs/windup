export type ActionType = "goto" | "click" | "fill" | "wait_for" | "use";

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
  /** type=use: id do fragmento a expandir inline (E3). */
  use?: string;
  expect?: Expect;
  timeout_ms?: number;
}

/**
 * Fragmento de trajetória (SPEC-001, componente 2): sub-trajetória nomeada e
 * reutilizável. Vive versionado no repo do usuário (é conhecimento curado),
 * ao contrário do cache. O plano referencia { type: "use", use: "<id>" } e o
 * runner expande inline antes de executar.
 */
export interface Fragment {
  fragment_id: string;
  description: string;
  /** Documentação dos segredos/parâmetros (as ações usam value_ref ENV:*). */
  params?: Record<string, string>;
  actions: Action[];
  postcondition?: Expect;
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
  /** Conhecimento site-específico fornecido pelo AUTOR do cenário (doc 07: nada de site hardcoded no motor). */
  hints?: string[];
}

export type CacheStatus = "active" | "stale";

export interface CacheEntry {
  cache_version: "0.2";
  key: {
    scenario_id: string;
    start_url: string;
    /** Assinatura estrutural da página inicial no momento do plano (E1). */
    start_sig?: string;
  };
  plan: Plan;
  status: CacheStatus;
  stats: {
    created_at: string;
    last_replayed_at: string | null;
    replay_count: number;
    replay_failures: number;
    /** Quantas vezes o plano deste cenário já foi (re)gerado — detector de cenário instável. */
    plan_generation: number;
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
  /** Retries semânticos do planejador (doc 03 permite ≤1); null se não planejou. */
  plan_semantic_retries: number | null;
  /**
   * E1, política leniente: true se a sig da página inicial divergiu da gravada
   * no cache (o replay segue mesmo assim); null quando não havia sig comparável.
   */
  sig_mismatch: boolean | null;
  /** Tamanho do prompt de planejamento em chars (E2); null se não planejou. */
  prompt_chars: number | null;
  tokens: { input: number; output: number };
  estimated_cost_usd: number;
  duration_ms: { total: number; planning: number; execution: number };
  actions: ActionMetrics[];
  result: "passed" | "failed";
  failure: { kind: FailureKind; action_id: string | null; message: string } | null;
  /** Plano executado (diagnóstico; ausente se a geração falhou antes de haver plano). */
  plan?: Plan;
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

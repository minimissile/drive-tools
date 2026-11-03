/** Native tool-calling messages. Reasoning fields are opaque provider context, never UI copy. */
export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: AgentToolCall[];
  reasoning?: string | null;
  /** Preserve every block and its order exactly when returning tool results. */
  reasoning_details?: Record<string, unknown>[];
}

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | AgentAssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface AgentBudgetScope {
  planId: string;
  cycleId: string;
  dayLimitMicros: number;
  cycleLimitMicros: number;
}

export interface AgentTurnInput {
  model?: string;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  maxOutputTokens?: number;
  /** Remaining caller budget, checked in addition to ledger-backed scope limits. */
  maxCostMicros: number;
  budgetScope: AgentBudgetScope;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentTurnResult {
  message: AgentAssistantMessage;
  finishReason: string | null;
  costMicros: number | null;
  /** False means stop the cycle before executing tools; the reservation is retained. */
  costKnown: boolean;
  /** Local api_calls identifier. No key or prompt is included in ledger messages. */
  requestId: string;
  reservedMicros: number;
}

/**
 * AgentAdapter — the single contract every Agent backend must satisfy.
 * Upper layers (Orchestrator, Conversation, UI) MUST NOT import any concrete
 * vendor SDK; they only depend on this contract.
 *
 * Mapping to PRD §5.4.1.
 */

export interface AgentAdapter {
  readonly id: string;                   // "claude-code" | "codex" | "doubao" | "mock"
  readonly displayName: string;
  readonly capabilities: Capabilities;

  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
  cancel(taskId: string): Promise<void>;
  estimateCost(req: ChatRequest): CostEstimate;
  health(): Promise<HealthStatus>;
}

export interface Capabilities {
  streaming: boolean;
  toolUse: boolean;
  codeExecution: boolean;
  fileEdit: boolean;
  webBrowse: boolean;
  maxContextTokens: number;
  supportedLangs: string[];
}

export interface ChatRequest {
  taskId: string;                        // logical task id; used for cancel() and tracing
  model?: string;                        // optional override
  systemPrompt?: string;
  messages: Message[];
  tools?: ToolSchema[];
  workspace?: WorkspaceRef;
  budget?: Budget;
  metadata?: Record<string, unknown>;    // free-form, e.g. conversationId, planId
}

export interface Budget {
  maxTokens?: number;
  maxTimeMs?: number;
  maxCostUsd?: number;
}

export interface WorkspaceRef {
  id: string;
  /** opaque snapshot id the adapter can fetch via WorkspaceService */
  snapshotId: string;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Either a plain string OR multi-part content (text / image / tool_result). */
  content: string | ContentPart[];
  /** For role='tool', the id of the originating tool_call. */
  toolCallId?: string;
  /** For role='assistant', any tool_calls it issued. */
  toolCalls?: ToolCall[];
  name?: string;                          // optional sender name (helpful in multi-agent groups)
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string }
  | { type: 'tool_result'; toolCallId: string; result: unknown };

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type JSONSchema = Record<string, unknown>;

/**
 * Unified streaming event the adapter emits.
 * The upper layer should be able to render ALL adapters using ONLY this event type.
 */
export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; callId: string; result: unknown }
  | { type: 'file_patch'; path: string; diff: string }       // unified diff
  | { type: 'done'; usage: TokenUsage; finishReason: FinishReason }
  | { type: 'error'; error: AdapterErrorPayload };

export type FinishReason = 'stop' | 'length' | 'tool_use' | 'cancelled' | 'error';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  latencyMs: number;
}

export interface AdapterErrorPayload {
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

export type AdapterErrorCode =
  | 'RATE_LIMITED'
  | 'CONTEXT_OVERFLOW'
  | 'TOOL_UNAVAILABLE'
  | 'UPSTREAM_5XX'
  | 'UPSTREAM_4XX'
  | 'CANCELLED'
  | 'AUTH'
  | 'INTERNAL';

export interface CostEstimate {
  /** Rough upper bound based on prompt size + capability. */
  estimatedCostUsd: number;
  promptTokens: number;
}

export interface HealthStatus {
  ok: boolean;
  latencyMs?: number;
  notes?: string;
}

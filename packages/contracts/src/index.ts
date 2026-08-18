export interface CredentialStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTotalTimeoutMs?: number;
  requestId?: string;
  onProgress?: (progress: ToolProgress) => void;
}

export interface ToolProgress {
  progress?: number;
  total?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; name: string; uri: string; description?: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text: string } | { uri: string; mimeType?: string; blob: string } }
  | { type: "unknown"; value: unknown };

export interface ToolResult {
  content: ToolContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export interface ToolTransport {
  listTools(options?: CallOptions): Promise<ToolDescriptor[]>;
  callTool(name: string, input: Record<string, unknown>, options?: CallOptions): Promise<ToolResult>;
  close(): Promise<void>;
}

export type ExitCode = 0 | 1 | 2 | 3 | 4;

export interface CommandResult<T> {
  ok: boolean;
  command: string;
  data?: T;
  content?: ToolContentBlock[];
  error?: { code: string; message: string };
  meta: { durationMs: number; requestId?: string };
}

export type ProgressEvent =
  | { type: "status"; message: string }
  | { type: "tool-start"; name: string }
  | { type: "tool-complete"; name: string; durationMs: number }
  | { type: "retry"; attempt: number; delayMs: number; reason: string };

export class LivepeerAgentError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: ExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "LivepeerAgentError";
  }
}

export interface AgentRuntimeInfo {
  username?: string;
  provider: string;
  model: string;
  accessTier: "anonymous" | "authenticated";
  agentToolNames: string[];
  serverToolCount: number;
  contextTokens?: number;
  costUsd?: number;
}

export interface AgentApprovalRequest {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
}

export interface AgentInteraction {
  approve(request: AgentApprovalRequest): Promise<boolean>;
  requestInput(request: AgentQuestion): Promise<string | undefined>;
}

export type AgentEvent =
  | { type: "status"; message?: string }
  | { type: "message"; role: "user" | "assistant"; text: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-end"; toolCallId: string; toolName: string; result?: ToolResult; error?: string }
  | { type: "runtime-info"; info: AgentRuntimeInfo };

export interface TerminalAgentRuntime {
  info(): AgentRuntimeInfo;
  submit(input: string, signal?: AbortSignal): Promise<void>;
  abort(reason?: unknown): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  newSession(): Promise<void>;
  saveSession(): Promise<void>;
  close(): Promise<void>;
}

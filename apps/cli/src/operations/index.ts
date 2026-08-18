import type {
  CallOptions,
  CommandResult,
  ToolDescriptor,
  ToolResult,
  ToolTransport,
} from "@livepeer-agent/contracts";

export type OperationOptions = Pick<CallOptions, "signal" | "onProgress">;

export interface CliOperations {
  listTools(options?: OperationOptions): Promise<CommandResult<ToolDescriptor[]>>;
  describeTool(name: string, options?: OperationOptions): Promise<CommandResult<ToolDescriptor>>;
  callTool(name: string, input: Record<string, unknown>, options?: OperationOptions): Promise<CommandResult<unknown>>;
  listCapabilities(input: { kind?: string; limit?: number; offset?: number }, options?: OperationOptions): Promise<CommandResult<unknown>>;
  generateMedia(input: { prompt: string; model?: string; aspect?: string; quality?: string }, options?: OperationOptions): Promise<CommandResult<unknown>>;
  getJob(id: string, options?: OperationOptions): Promise<CommandResult<unknown>>;
  waitForJob(id: string, input: { intervalMs: number; timeoutMs: number }, options?: OperationOptions): Promise<CommandResult<unknown>>;
}

export function createOperations(transport: ToolTransport): CliOperations {
  return {
    listTools: async (options) => run("tools.list", async () => ({ data: await transport.listTools(options) })),
    describeTool: async (name, options) => run("tools.describe", async () => {
      const descriptor = (await transport.listTools(options)).find((tool) => tool.name === name);
      if (!descriptor) return { error: { code: "INPUT", message: `Unknown Livepeer tool: ${name}` } };
      return { data: descriptor };
    }),
    callTool: (name, input, options) => runTool("tools.call", () => transport.callTool(name, input, options)),
    listCapabilities: (input, options) => listCapabilities(transport, input, options),
    generateMedia: (input, options) => runTool("media.generate", () => transport.callTool("create_media", {
      action: "generate",
      prompt: input.prompt,
      ...(input.model ? { model_override: input.model } : {}),
      ...(input.aspect ? { aspect_ratio: input.aspect } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
    }, { ...options, timeoutMs: 120_000, maxTotalTimeoutMs: 20 * 60_000 })),
    getJob: (id, options) => runTool("jobs.get", () => transport.callTool("get_create_media", { job_id: id }, options), jobData),
    waitForJob: (id, input, options) => waitForJob(transport, id, input, options),
  };
}

async function listCapabilities(
  transport: ToolTransport,
  input: { kind?: string; limit?: number; offset?: number },
  options?: OperationOptions,
): Promise<CommandResult<unknown>> {
  const started = Date.now();
  try {
    const result = await transport.callTool("list_capabilities", compact(input), options);
    if (result.isError) return failureFromTool("capabilities.list", started, result);
    if (!isRecord(result.structuredContent) || !Array.isArray(result.structuredContent.capabilities)) {
      return success("capabilities.list", started, toolData(result), result.content);
    }
    const limit = input.limit ?? result.structuredContent.capabilities.length;
    const bounded = {
      ...result.structuredContent,
      capabilities: result.structuredContent.capabilities.slice(0, limit),
    };
    const conciseContent = result.content.filter((block) => block.type !== "text");
    return success("capabilities.list", started, { structuredContent: bounded }, conciseContent);
  } catch (error) {
    return failureFromThrown("capabilities.list", started, error);
  }
}

async function waitForJob(
  transport: ToolTransport,
  id: string,
  input: { intervalMs: number; timeoutMs: number },
  options?: OperationOptions,
): Promise<CommandResult<unknown>> {
  const started = Date.now();
  try {
    while (Date.now() - started < input.timeoutMs) {
      options?.signal?.throwIfAborted();
      const result = await transport.callTool("get_create_media", { job_id: id }, options);
      if (result.isError) return failureFromTool("jobs.wait", started, result);
      const data = jobData(result);
      const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
      options?.onProgress?.({ message: status ? `${id}: ${status}` : `Waiting for ${id}` });
      if (["done", "completed", "succeeded"].includes(status)) return success("jobs.wait", started, data, result.content);
      if (["failed", "cancelled", "canceled"].includes(status)) {
        return failure("jobs.wait", started, status.startsWith("cancel") ? "CANCELLED" : "REMOTE", typeof data.error === "string" ? data.error : `Media job ${id} ${status}.`, result.content);
      }
      await delay(Math.min(input.intervalMs, input.timeoutMs - (Date.now() - started)), options?.signal);
    }
    return failure("jobs.wait", started, "TIMEOUT", `Timed out waiting for media job ${id}.`);
  } catch (error) {
    return failureFromThrown("jobs.wait", started, error);
  }
}

async function runTool(command: string, action: () => Promise<ToolResult>, data: (result: ToolResult) => unknown = toolData): Promise<CommandResult<unknown>> {
  const started = Date.now();
  try {
    const result = await action();
    if (result.isError) return failureFromTool(command, started, result);
    return success(command, started, data(result), result.content);
  } catch (error) {
    return failureFromThrown(command, started, error);
  }
}

async function run<T>(command: string, action: () => Promise<{ data?: T; error?: { code: string; message: string } }>): Promise<CommandResult<T>> {
  const started = Date.now();
  try {
    const result = await action();
    return result.error
      ? failure(command, started, result.error.code, result.error.message)
      : success(command, started, result.data);
  } catch (error) {
    return failureFromThrown(command, started, error);
  }
}

function success<T>(command: string, started: number, data?: T, content?: ToolResult["content"]): CommandResult<T> {
  return { ok: true, command, ...(data !== undefined ? { data } : {}), ...(content ? { content } : {}), meta: { durationMs: Date.now() - started } };
}

function failure<T>(command: string, started: number, code: string, message: string, content?: ToolResult["content"]): CommandResult<T> {
  return { ok: false, command, ...(content ? { content } : {}), error: { code, message: redact(message) }, meta: { durationMs: Date.now() - started } };
}

function failureFromTool<T>(command: string, started: number, result: ToolResult): CommandResult<T> {
  const message = result.content.find((block) => block.type === "text")?.text ?? metadataMessage(result.structuredContent) ?? "Livepeer tool failed.";
  return failure(command, started, classify(result.structuredContent, message), message, result.content);
}

function failureFromThrown<T>(command: string, started: number, error: unknown): CommandResult<T> {
  const value = error as { name?: string; code?: string; message?: string; status?: number; statusCode?: number; exitCode?: number };
  const message = value?.message ?? String(error);
  if (value?.name === "AbortError") return failure(command, started, "CANCELLED", message || "Cancelled.");
  if (value?.name === "TimeoutError" || value?.code === "ETIMEDOUT") return failure(command, started, "TIMEOUT", message);
  const status = value?.status ?? value?.statusCode;
  if (status === 401 || value?.exitCode === 2) return failure(command, started, "AUTH", message);
  if (status === 403) return failure(command, started, "PERMISSION", message);
  return failure(command, started, "REMOTE", message);
}

function classify(value: unknown, message: string): string {
  const serialized = `${JSON.stringify(value)} ${message}`;
  if (/-32602|invalid (?:argument|params)|missing required/iu.test(serialized)) return "INPUT";
  if (/\b401\b|unauthenticated|authentication required|invalid token/iu.test(serialized)) return "AUTH";
  if (/\b403\b|forbidden|permission denied|not authorized/iu.test(serialized)) return "PERMISSION";
  return "REMOTE";
}

function toolData(result: ToolResult): unknown {
  return result.structuredContent === undefined ? undefined : { structuredContent: result.structuredContent, ...(result.isError === undefined ? {} : { isError: result.isError }) };
}

function jobData(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) return result.structuredContent as Record<string, unknown>;
  const text = result.content.find((block) => block.type === "text")?.text;
  const status = text?.match(/(?:Status:\s*|:\s*)(pending|queued|running|done|completed|failed|cancelled)/iu)?.[1];
  return status ? { status: status.toLowerCase() } : {};
}

function metadataMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  return metadataMessage(record.error);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redact(value: string): string {
  return value.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]").slice(0, 2_000);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.max(0, milliseconds));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

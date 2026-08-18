import type { CallOptions, ToolDescriptor, ToolResult, ToolTransport } from "@livepeer-agent/contracts";
import type { LivepeerExecutionClient } from "@livepeer-agent/livepeer-client";

const READ_ONLY = { readOnlyHint: true };

export function routedCatalog(extra: ToolDescriptor[] = []): ToolDescriptor[] {
  return [
    descriptor("list_capabilities", {
      properties: { kind: { type: "string", enum: ["ai", "tool", "mcp"] }, limit: { type: "integer" }, offset: { type: "integer" } },
    }, READ_ONLY),
    descriptor("describe_capability", { required: ["name"], properties: { name: { type: "string" } } }, READ_ONLY),
    descriptor("get_pricing", {
      properties: { kind: { type: "string", enum: ["ai", "tool", "mcp", "all"] }, name: { type: "string" }, bypass_cache: { type: "boolean" } },
    }, READ_ONLY),
    descriptor("me", { properties: {} }),
    descriptor("me_update", {
      properties: { name: { type: "string" }, use_case: { type: "string" }, email: { type: "string" } },
    }),
    descriptor("request_activation", {
      properties: { email: { type: "string" }, emails: { type: "array" } },
    }),
    descriptor("activate", { required: ["code"], properties: { code: { type: "string" } } }),
    descriptor("upload", {
      properties: {
        data: { type: "string" },
        source_url: { type: "string" },
        mime_type: { type: "string" },
        kind: { type: "string", enum: ["image", "video", "audio"] },
        filename: { type: "string" },
      },
    }),
    descriptor("create_media", {
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["generate", "animate", "music", "tts", "mux_audio", "lipsync", "subtitle", "upscale", "publish", "comfy_workflow"] },
        prompt: { type: "string" },
        model_override: { type: "string" },
        max_cost_usd: { type: "number" },
      },
    }),
    descriptor("get_create_media", { required: ["job_id"], properties: { job_id: { type: "string", pattern: "^mjob_[a-z0-9]{6,32}$" } } }, READ_ONLY),
    descriptor("generate_project", {
      required: ["title", "scenes"],
      properties: {
        title: { type: "string" },
        scenes: { type: "array", items: { type: "object" } },
        global_model_override: { type: "string" },
      },
    }),
    descriptor("get_creative_job", { required: ["job_id"], properties: { job_id: { type: "string", pattern: "^cjob_[a-z0-9]{6,32}$" } } }, READ_ONLY),
    descriptor("subscribe_progress", {
      required: ["job_id"], properties: { job_id: { type: "string", pattern: "^(mjob|cjob|ltj|atask|mood)_[a-z0-9]{6,32}$" }, budget_seconds: { type: "integer" } },
    }, READ_ONLY),
    ...extra,
  ];
}

export function descriptor(name: string, inputSchema: Record<string, unknown>, annotations?: Record<string, unknown>): ToolDescriptor {
  return { name, title: name, description: `${name} description`, inputSchema: { type: "object", ...inputSchema }, ...(annotations ? { annotations } : {}) };
}

export class FakeTransport implements ToolTransport, LivepeerExecutionClient {
  readonly calls: Array<{ name: string; input: Record<string, unknown>; options?: CallOptions }> = [];
  listError?: Error;
  result: ToolResult = { content: [{ type: "text", text: "ok" }], structuredContent: { status: "complete" } };
  callImplementation?: (name: string, input: Record<string, unknown>, options?: CallOptions) => Promise<ToolResult>;
  closeCount = 0;

  constructor(readonly catalog: ToolDescriptor[] = routedCatalog()) {}
  readonly capabilities = {
    list: (input = {}, options?: CallOptions) => this.callTool("list_capabilities", input, options),
    describe: (input: { name: string }, options?: CallOptions) => this.callTool("describe_capability", input, options),
    pricing: (input = {}, options?: CallOptions) => this.callTool("get_pricing", input, options),
  };
  readonly profile = {
    get: (options?: CallOptions) => this.callTool("me", {}, options),
    update: (input: Record<string, unknown>, options?: CallOptions) => this.callTool("me_update", input, options),
  };
  readonly access = {
    requestActivation: (input: { email: string }, options?: CallOptions) => this.callTool("request_activation", input, options),
    activate: (input: { code: string }, options?: CallOptions) => this.callTool("activate", input, options),
  };
  readonly assets = { upload: (input: Record<string, unknown>, options?: CallOptions) => this.callTool("upload", input, options) };
  readonly media = {
    create: (input: Record<string, unknown>, options?: CallOptions) => this.callTool("create_media", input, options),
    get: (input: { job_id: string }, options?: CallOptions) => this.callTool("get_create_media", input, options),
  };
  readonly projects = { generate: (input: Record<string, unknown>, options?: CallOptions) => this.callTool("generate_project", input, options) };
  readonly jobs = {
    getCreative: (input: { job_id: string }, options?: CallOptions) => this.callTool("get_creative_job", input, options),
    subscribe: (input: { job_id: string; budget_seconds?: number }, options?: CallOptions) => this.callTool("subscribe_progress", input, options),
  };
  describeOperations(options?: CallOptions): Promise<readonly ToolDescriptor[]> { return this.listTools(options); }
  listTools(options?: CallOptions): Promise<ToolDescriptor[]> {
    options?.signal?.throwIfAborted();
    return this.listError === undefined ? Promise.resolve(structuredClone(this.catalog)) : Promise.reject(this.listError);
  }
  callTool(name: string, input: Record<string, unknown>, options?: CallOptions): Promise<ToolResult> {
    this.calls.push({ name, input, ...(options ? { options } : {}) });
    return this.callImplementation?.(name, input, options) ?? Promise.resolve(this.result);
  }
  close(): Promise<void> { this.closeCount += 1; return Promise.resolve(); }
}

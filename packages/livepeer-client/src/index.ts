import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallOptions,
  ToolContentBlock,
  ToolDescriptor,
  ToolProgress,
  ToolResult,
  ToolTransport,
} from "@livepeer-agent/contracts";

export * from "./execution.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface McpToolTransportOptions {
  bearerToken?: string;
  clientName?: string;
  clientVersion?: string;
}

/** Transport-neutral MCP client used by both anonymous and gateway sessions. */
export class McpToolTransport implements ToolTransport {
  private client: Client;
  private transport: StreamableHTTPClientTransport | undefined;
  private connectPromise: Promise<void> | undefined;

  constructor(
    private readonly endpoint: URL,
    private readonly options: McpToolTransportOptions = {},
  ) {
    assertHttpEndpoint(endpoint);
    this.client = this.createClient();
  }

  async listTools(options: CallOptions = {}): Promise<ToolDescriptor[]> {
    await this.connect(options.signal);
    const tools: ToolDescriptor[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        },
      );
      tools.push(...response.tools.map(normalizeDescriptor));
      cursor = response.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);

    return tools;
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ToolResult> {
    await this.connect(options.signal);
    const raw = await this.client.callTool(
      { name, arguments: input },
      undefined,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        ...(options.maxTotalTimeoutMs === undefined
          ? {}
          : { maxTotalTimeout: options.maxTotalTimeoutMs }),
        ...(options.onProgress === undefined
          ? {}
          : { onprogress: (progress: unknown) => options.onProgress?.(normalizeProgress(progress)) }),
      },
    );
    return normalizeToolResult(raw);
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.connectPromise = undefined;
    this.client = this.createClient();
    if (transport) await transport.close();
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.connectPromise) {
      const headers = new Headers();
      if (this.options.bearerToken) {
        headers.set("authorization", `Bearer ${this.options.bearerToken}`);
      }
      const transport = new StreamableHTTPClientTransport(this.endpoint, {
        requestInit: { headers },
      });
      this.transport = transport;
      this.connectPromise = this.client.connect(
        transport as unknown as Parameters<Client["connect"]>[0],
        signal ? { signal } : undefined,
      ).catch(async (error: unknown) => {
        this.connectPromise = undefined;
        this.transport = undefined;
        await transport.close().catch(() => undefined);
        throw error;
      });
    }
    await this.connectPromise;
  }

  private createClient(): Client {
    return new Client({
      name: this.options.clientName ?? "livepeer-cli",
      version: this.options.clientVersion ?? "0.1.0",
    });
  }
}

/**
 * Daydream credentials are request credentials, not mutable shell-session
 * state. Use a fresh MCP connection for every authenticated operation so an
 * upstream session can never retain or fall back to a keyless principal.
 */
class FreshAuthenticatedMcpToolTransport implements ToolTransport {
  constructor(
    private readonly endpoint: URL,
    private readonly options: McpToolTransportOptions,
  ) {}

  listTools(options?: CallOptions): Promise<ToolDescriptor[]> {
    return this.withTransport((transport) => transport.listTools(options));
  }

  callTool(name: string, input: Record<string, unknown>, options?: CallOptions): Promise<ToolResult> {
    return this.withTransport((transport) => transport.callTool(name, input, options));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private async withTransport<T>(operation: (transport: McpToolTransport) => Promise<T>): Promise<T> {
    const transport = new McpToolTransport(this.endpoint, this.options);
    try {
      return await operation(transport);
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}

export function createAnonymousTransport(
  endpoint: string | URL,
  options: Omit<McpToolTransportOptions, "bearerToken"> = {},
): McpToolTransport {
  return new McpToolTransport(toUrl(endpoint), options);
}

export function createAuthenticatedGatewayTransport(
  endpoint: string | URL,
  bearerToken: string,
  options: Omit<McpToolTransportOptions, "bearerToken"> = {},
): ToolTransport {
  if (bearerToken.trim().length === 0) throw new TypeError("A bearer token is required");
  return new FreshAuthenticatedMcpToolTransport(toUrl(endpoint), { ...options, bearerToken });
}

export function normalizeToolResult(raw: unknown): ToolResult {
  const result = isRecord(raw) ? raw : {};
  const blocks = Array.isArray(result.content) ? result.content : [];
  const content: ToolContentBlock[] = [];

  for (const block of blocks) {
    const normalized = normalizeContentBlock(block);
    content.push(normalized ?? { type: "unknown", value: block });
  }

  const { content: _content, structuredContent, isError, ...responseMetadata } = result;
  void _content;
  const metadata: Record<string, unknown> = { ...responseMetadata };

  return {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(typeof isError === "boolean" ? { isError } : {}),
    ...(Object.keys(metadata).length > 0 ? { meta: metadata } : {}),
  };
}

function normalizeDescriptor(tool: {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: object;
  outputSchema?: object | undefined;
  annotations?: object | undefined;
}): ToolDescriptor {
  // Extra MCP descriptor fields remain available at runtime while the base
  // contract stays usable by transports that only know name/schema.
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
    ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
  };
}

function normalizeContentBlock(block: unknown): ToolContentBlock | undefined {
  if (!isRecord(block) || typeof block.type !== "string") return undefined;
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block as ToolContentBlock : undefined;
    case "image":
    case "audio":
      return typeof block.data === "string" && typeof block.mimeType === "string"
        ? block as ToolContentBlock
        : undefined;
    case "resource_link":
      if (typeof block.uri !== "string") return undefined;
      return {
        ...block,
        name: typeof block.name === "string" ? block.name : block.uri,
      } as ToolContentBlock;
    case "resource":
      return isRecord(block.resource) && typeof block.resource.uri === "string"
        && (typeof block.resource.text === "string" || typeof block.resource.blob === "string")
        ? block as ToolContentBlock
        : undefined;
    default:
      return undefined;
  }
}

function normalizeProgress(value: unknown): ToolProgress {
  if (!isRecord(value)) return {};
  const { progress, total, message, ...metadata } = value;
  return {
    ...(typeof progress === "number" ? { progress } : {}),
    ...(typeof total === "number" ? { total } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function toUrl(value: string | URL): URL {
  return value instanceof URL ? value : new URL(value);
}

function assertHttpEndpoint(endpoint: URL): void {
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new TypeError("MCP endpoint must use HTTP or HTTPS");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

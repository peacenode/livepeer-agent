/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  }>,
  transports: [] as Array<{
    url: URL;
    options: { requestInit?: RequestInit };
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn(async () => undefined);
    listTools = vi.fn(async () => ({ tools: [] }));
    callTool = vi.fn();
    constructor() { sdk.clients.push(this); }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn(async () => undefined);
    constructor(public url: URL, public options: { requestInit?: RequestInit }) {
      sdk.transports.push(this);
    }
  },
}));

import {
  createAnonymousTransport,
  createAuthenticatedGatewayTransport,
  McpToolTransport,
  normalizeToolResult,
} from "./index.js";

describe("McpToolTransport", () => {
  beforeEach(() => {
    sdk.clients.length = 0;
    sdk.transports.length = 0;
  });

  it("returns every server-visible tool across cursor pages", async () => {
    const transport = createAnonymousTransport("https://mcp.example/rpc");
    sdk.clients[0]!.listTools
      .mockResolvedValueOnce({
        tools: [{ name: "one", title: "One", inputSchema: { type: "object" } }],
        nextCursor: "second",
      })
      .mockResolvedValueOnce({
        tools: [{
          name: "operator_only",
          description: "Visible when advertised",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        }],
      });

    const tools = await transport.listTools({ timeoutMs: 25 });
    expect(tools.map(({ name }) => name)).toEqual(["one", "operator_only"]);
    expect(tools[1]).toMatchObject({
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    expect(sdk.clients[0]!.listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: "second" },
      expect.objectContaining({ timeout: 25 }),
    );
  });

  it("keeps known content and metadata without duplicating binary payloads", async () => {
    const transport = new McpToolTransport(new URL("https://mcp.example/rpc"));
    const onProgress = vi.fn();
    sdk.clients[0]!.callTool.mockImplementation(async (_request, _schema, options) => {
      options.onprogress({ progress: 1, total: 2, message: "rendering", stage: "provider" });
      return {
        content: [
          { type: "text", text: "done", annotations: { audience: ["user"] } },
          { type: "image", data: "IMAGE_ONCE", mimeType: "image/png" },
          { type: "audio", data: "AUDIO_ONCE", mimeType: "audio/wav" },
          { type: "resource_link", uri: "https://cdn.example/a", description: "result" },
          { type: "resource", resource: { uri: "memory://result", blob: "BLOB_ONCE" } },
          { type: "future_block", payload: 42 },
        ],
        structuredContent: { assetId: "asset_1" },
        isError: false,
        providerTrace: "trace_1",
      };
    });
    const signal = new AbortController().signal;

    const result = await transport.callTool("generate", { prompt: "kite" }, {
      signal,
      timeoutMs: 20,
      maxTotalTimeoutMs: 40,
      onProgress,
    });

    expect(result.content.map(({ type }) => type)).toEqual([
      "text", "image", "audio", "resource_link", "resource", "unknown",
    ]);
    expect(result.content[3]).toMatchObject({ name: "https://cdn.example/a" });
    expect(result.content[5]).toEqual({
      type: "unknown",
      value: { type: "future_block", payload: 42 },
    });
    expect(result.structuredContent).toEqual({ assetId: "asset_1" });
    expect(result.meta).toEqual({ providerTrace: "trace_1" });
    expect(JSON.stringify(result).match(/IMAGE_ONCE/g)).toHaveLength(1);
    expect(JSON.stringify(result).match(/AUDIO_ONCE/g)).toHaveLength(1);
    expect(JSON.stringify(result).match(/BLOB_ONCE/g)).toHaveLength(1);
    expect(onProgress).toHaveBeenCalledWith({
      progress: 1,
      total: 2,
      message: "rendering",
      metadata: { stage: "provider" },
    });
    expect(sdk.clients[0]!.callTool.mock.calls[0]?.[2]).toMatchObject({
      signal,
      timeout: 20,
      maxTotalTimeout: 40,
      resetTimeoutOnProgress: true,
    });
  });

  it("sends gateway credentials only for authenticated transports", async () => {
    const anonymous = createAnonymousTransport("https://mcp.example/rpc");
    await anonymous.listTools();
    const anonymousHeaders = sdk.transports[0]!.options.requestInit?.headers as Headers;
    expect(anonymousHeaders.get("authorization")).toBeNull();

    const authenticated = createAuthenticatedGatewayTransport(
      "https://auth.example/api/livepeer/mcp",
      "session-token",
    );
    await authenticated.listTools();
    const authenticatedHeaders = sdk.transports[1]!.options.requestInit?.headers as Headers;
    expect(authenticatedHeaders.get("authorization")).toBe("Bearer session-token");
  });

  it("uses a fresh bearer-authenticated MCP connection for every keyed operation", async () => {
    const authenticated = createAuthenticatedGatewayTransport(
      "https://agent.example/api/mcp",
      "daydream-key",
    );

    await authenticated.callTool("me", {});
    await authenticated.callTool("list_capabilities", { kind: "ai" });

    expect(sdk.clients.filter((client) => client.callTool.mock.calls.length > 0)).toHaveLength(2);
    expect(sdk.transports).toHaveLength(2);
    for (const transport of sdk.transports) {
      const headers = transport.options.requestInit?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer daydream-key");
      expect(transport.close).toHaveBeenCalledOnce();
    }
  });

  it("honors pre-aborted calls before connecting", async () => {
    const transport = createAnonymousTransport("https://mcp.example/rpc");
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(transport.listTools({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(sdk.clients[0]!.connect).not.toHaveBeenCalled();
  });
});

describe("normalizeToolResult", () => {
  it("preserves non-object structured content in its first-class field", () => {
    expect(normalizeToolResult({ content: [], structuredContent: ["future"] })).toEqual({
      content: [],
      structuredContent: ["future"],
    });
  });
});

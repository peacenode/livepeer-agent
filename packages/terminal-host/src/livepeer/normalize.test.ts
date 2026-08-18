import { describe, expect, it } from "vitest";
import { normalizeToolResult } from "./normalize.js";

describe("normalizeToolResult", () => {
  it("extracts real IDs, lineage, prompts, capability, model and pricing without inventing fields", () => {
    const raw = {
      content: [{ type: "resource_link" as const, name: "preview", uri: "https://viewer.example/p/1", mimeType: "image/png" }],
      structuredContent: {
        status: "complete",
        job_id: "mjob_abc123",
        projectId: "project_1",
        scenes: [{ scene_index: 0, asset_id: "asset_1", output_url: "https://media.example/1.png", source_urls: ["https://source.example/ref.png"], parent_asset_ids: ["asset_parent"], capability: "image/generate", model_id: "model-1" }],
        pricing: [{ name: "image/generate", display_price_usd: 0, display_unit: "image", unit_kind: "output", model_id: "model-1" }],
      },
    };
    const result = normalizeToolResult(raw, { prompt: "submitted" }, { originalUserPrompt: "original" });
    expect(result.raw).toBe(raw);
    expect(result.status).toBe("complete");
    expect(result.references).toContainEqual(expect.objectContaining({
      assetId: "asset_1", jobId: "mjob_abc123", projectId: "project_1", sceneIndex: 0, capability: "image/generate", modelId: "model-1",
      originalPrompt: "original", submittedPrompt: "submitted", sourceUrls: ["https://source.example/ref.png"], parentAssetIds: ["asset_parent"],
    }));
    expect(result.pricing).toContainEqual({ name: "image/generate", displayPriceUsd: 0, displayUnit: "image", unitKind: "output", modelId: "model-1" });
  });

  it("carries only explicitly supplied parent lineage into returned assets", () => {
    const result = normalizeToolResult({
      content: [], structuredContent: { asset_id: "asset_child", output_url: "https://media.example/child.png" },
    }, {}, {
      parentReferences: [{ assetId: "asset_parent", url: "https://media.example/parent.png", sourceUrls: [], parentAssetIds: [] }],
    });
    expect(result.references).toContainEqual(expect.objectContaining({
      assetId: "asset_child", parentAssetIds: ["asset_parent"], sourceUrls: ["https://media.example/parent.png"],
    }));
  });

  it("preserves the submitted prompt when a status lookup cannot include the original media input", () => {
    const result = normalizeToolResult({
      content: [],
      structuredContent: { status: "complete", job_id: "mjob_prompt", output_url: "https://media.example/prompt.png" },
    }, { job_id: "mjob_prompt" }, { submittedPrompt: "a fox at dusk" });

    expect(result.references).toContainEqual(expect.objectContaining({
      jobId: "mjob_prompt",
      submittedPrompt: "a fox at dusk",
      url: "https://media.example/prompt.png",
    }));
  });

  it("does not fabricate references for plain structured output", () => {
    const result = normalizeToolResult({ content: [{ type: "text", text: "ok" }], structuredContent: { message: "done", count: 2 } }, {});
    expect(result.references).toEqual([]);
    expect(result.pricing).toEqual([]);
  });

  it("preserves raw binary data but redacts it and credential material from the model view", () => {
    const raw = {
      content: [{ type: "image" as const, data: "very-secret-base64", mimeType: "image/png" }],
      structuredContent: {
        asset_id: "asset_1",
        output_url: "https://user:pass@media.example/a.png?token=secret&width=100",
        access_token: "raw-token",
        nested: { apiKey: "raw-key", secret: "raw-secret" },
      },
    };
    const result = normalizeToolResult(raw, {});
    expect(result.raw).toBe(raw);
    const safe = JSON.stringify(result.model);
    expect(safe).not.toContain("very-secret-base64");
    expect(safe).not.toContain("raw-token");
    expect(safe).not.toContain("raw-key");
    expect(safe).not.toContain("raw-secret");
    expect(safe).not.toContain("user:pass");
    expect(safe).not.toContain("token=secret");
    expect(safe).toContain("width=100");
  });

  it("normalizes remote errors without leaking credentials", () => {
    const result = normalizeToolResult({
      isError: true,
      content: [{ type: "text", text: "fallback" }],
      structuredContent: { error: { code: "permission_denied", message: "Authorization: Bearer abc.secret api_key=private" } },
    }, {});
    expect(result).toMatchObject({ isError: true, error: { code: "permission_denied" } });
    expect(result.model.summary).not.toContain("abc.secret");
    expect(result.model.summary).not.toContain("api_key=private");
  });

  it("classifies an unstructured demo restriction by its product message", () => {
    const result = normalizeToolResult({
      isError: true,
      content: [{
        type: "text",
        text: "Demo mode supports list_capabilities and get_pricing only. Verify your email to unlock the full daily allowance.",
      }],
    }, {});

    expect(result.error).toEqual({
      code: "demo_not_allowed",
      message: "Demo mode supports list_capabilities and get_pricing only. Verify your email to unlock the full daily allowance.",
    });
  });

  it("uses structured paginated capability data and omits unpaginated text", () => {
    const publicCapabilities = Array.from({ length: 25 }, (_, index) => ({
      name: `public-ai-${index}`,
      kind: "ai",
      availability: "available",
      input_schema: { properties: { prompt: { type: "string" } } },
    }));
    const result = normalizeToolResult({
      content: [{ type: "text", text: `Unpaginated catalog: ${"noise ".repeat(100)}` }],
      structuredContent: {
        total: 30,
        capabilities: [
          { name: "private-model", kind: "ai", visibility: "private" },
          { name: "offline-model", kind: "ai", availability: "unavailable" },
          { name: "remote-mcp", kind: "mcp", availability: "available" },
          { name: "bridged-tool", kind: "tool", source: "mcp", availability: "available" },
          { name: "ffmpeg-mux", kind: "tool", availability: "available" },
          ...publicCapabilities,
        ],
      },
    }, {});

    const data = result.model.data as { capabilities: Array<{ name: string }>; limit: number; offset: number; returned: number };
    expect(data.limit).toBe(20);
    expect(data.offset).toBe(0);
    expect(data.returned).toBe(20);
    expect(data.capabilities).toHaveLength(20);
    expect(data.capabilities[0]).toEqual({ name: "ffmpeg-mux", kind: "tool", availability: "available" });
    expect(data.capabilities[1]).toMatchObject({
      name: "public-ai-0",
      input_schema: { properties: { prompt: { type: "string" } } },
    });
    expect(result.model.messages).toBeUndefined();
    expect(result.model.summary).not.toContain("Unpaginated catalog");
    expect(result.model.summary).not.toMatch(/private-model|offline-model|remote-mcp|bridged-tool/u);
  });

  it("clamps capability pages to fifty while retaining live AI and deterministic tools", () => {
    const result = normalizeToolResult({
      content: [],
      structuredContent: {
        structuredContent: {
          total: 80,
          capabilities: [
            { name: "ffmpeg", kind: "tool", enabled: true },
            ...Array.from({ length: 70 }, (_, index) => ({ name: `model-${index}`, kind: "ai", status: "active" })),
          ],
        },
      },
    }, { limit: 500, offset: 10 });

    const outer = result.model.data as { structuredContent: { capabilities: Array<{ name: string }>; limit: number; offset: number; returned: number } };
    expect(outer.structuredContent.limit).toBe(50);
    expect(outer.structuredContent.offset).toBe(10);
    expect(outer.structuredContent.returned).toBe(50);
    expect(outer.structuredContent.capabilities).toHaveLength(50);
    expect(outer.structuredContent.capabilities[0]?.name).toBe("ffmpeg");
  });

  it("preserves structured remedies and future task payloads", () => {
    const result = normalizeToolResult({
      isError: true,
      content: [{ type: "text", text: "Verification required" }],
      structuredContent: {
        error: {
          code: "verification_required",
          message: "Verify the account",
          retryable: false,
          resolution: { action: "verify_email", url: "https://example.test/verify?token=private&next=home" },
          field_errors: [{ field: "email", reason: "unverified" }],
        },
        task: {
          id: "task_123",
          steps: [{ id: "render", status: "blocked", artifacts: [{ id: "asset_1" }] }],
          resume_after: "verification",
        },
      },
    }, {});

    const data = result.model.data as {
      error: { retryable: boolean; resolution: { action: string; url: string }; field_errors: unknown[] };
      task: { id: string; steps: unknown[]; resume_after: string };
    };
    expect(result.model.error).toEqual({ code: "verification_required", message: "Verify the account" });
    expect(result.model.messages).toEqual(["Verification required"]);
    expect(data.error).toMatchObject({
      retryable: false,
      resolution: { action: "verify_email" },
      field_errors: [{ field: "email", reason: "unverified" }],
    });
    expect(data.error.resolution.url).not.toContain("token=private");
    expect(data.task).toEqual({
      id: "task_123",
      steps: [{ id: "render", status: "blocked", artifacts: [{ id: "asset_1" }] }],
      resume_after: "verification",
    });
  });

  it("bounds and redacts the complete model-facing payload", () => {
    const circular: Record<string, unknown> = { value: "kept" };
    circular.self = circular;
    const result = normalizeToolResult({
      content: [
        { type: "text", text: `Bearer text-secret ${"m".repeat(3_000)}` },
        { type: "image", data: "raw-image-data", mimeType: "image/png" },
      ],
      structuredContent: {
        access_token: "raw-token",
        signed_url: "https://media.example/a.png?X-Amz-Signature=signed-secret&Expires=123&width=200",
        inline: "data:image/png;base64,raw-inline-data",
        encoded: "a".repeat(400),
        long: "x".repeat(3_000),
        many: Array.from({ length: 75 }, (_, index) => `item-${index}`),
        wide: Object.fromEntries(Array.from({ length: 75 }, (_, index) => [`field_${index}`, index])),
        deep: { a: { b: { c: { d: { e: { f: { g: { h: { leaked: "too deep" } } } } } } } } },
        circular,
        bytes: new Uint8Array([1, 2, 3]),
        embedded: { mimeType: "image/png", data: "short-but-binary" },
        textBudget: Array.from({ length: 20 }, () => "z".repeat(2_000)),
      },
    }, {});

    const serialized = result.model.summary;
    const data = result.model.data as Record<string, unknown>;
    expect(serialized).not.toMatch(/raw-token|signed-secret|raw-inline-data|raw-image-data|text-secret/u);
    expect(serialized).not.toContain("access_token");
    expect(serialized).toContain("width=200");
    expect(data.inline).toBe("[binary or sensitive value omitted]");
    expect(data.encoded).toBe("[binary or sensitive value omitted]");
    expect(data.bytes).toBe("[binary or sensitive value omitted]");
    expect(data.embedded).toBe("[binary or sensitive value omitted]");
    expect((data.long as string).length).toBeLessThanOrEqual(2_000);
    expect(data.many).toHaveLength(50);
    expect(Object.keys(data.wide as object)).toHaveLength(50);
    expect(serialized).toContain("[circular reference omitted]");
    expect(serialized).toContain("[truncated]");
    expect(retainedTextLength(result.model.data)).toBeLessThanOrEqual(20_000);
  });
});

function retainedTextLength(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === "string") return value.length;
  if (value === null || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let total = 0;
  const values: unknown[] = Array.isArray(value)
    ? value as unknown[]
    : Object.values(value as Record<string, unknown>);
  for (const item of values) total += retainedTextLength(item, seen);
  return total;
}

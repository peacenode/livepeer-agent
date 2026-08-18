import { describe, expect, it, vi } from "vitest";
import type { CallOptions, ToolResult, ToolTransport } from "@livepeer-agent/contracts";
import { createMcpLivepeerExecutionClient } from "@livepeer-agent/livepeer-client";
import { createProductCapabilities, formatCapabilityResult } from "./capability-menu.js";

function executionClient(
  list: (input?: Record<string, unknown>, options?: CallOptions) => Promise<ToolResult>,
) {
  const transport: ToolTransport = {
    listTools: () => Promise.resolve([]),
    callTool: (name, input, options) => name === "list_capabilities"
      ? list(input, options)
      : Promise.reject(new Error(`Unexpected operation: ${name}`)),
    close: () => Promise.resolve(),
  };
  return createMcpLivepeerExecutionClient(transport);
}

describe("capability menu", () => {
  it.each([
    ["text-to-image", "flux-image"],
    ["image-to-image", "kontext-edit"],
    ["text-to-video", "seedance-t2v"],
    ["image-to-video", "seedance-i2v"],
    ["text-to-3d", "tripo-t3d"],
    ["image-to-3d", "tripo-i3d"],
    ["audio", "chatterbox-tts"],
    ["ffmpeg", "ffmpeg-mux"],
  ] as const)("filters %s without inventing capability aliases", (category, expected) => {
    const result = formatCapabilityResult(category, {
      content: [],
      structuredContent: {
        capabilities: [
          { name: "flux-image", kind: "ai", model_id: "flux-1", display_price_usd: 0.02, display_unit: "image" },
          { name: "kontext-edit", kind: "ai", model_id: "flux/kontext/edit", display_unit: "image" },
          { name: "seedance-t2v", kind: "ai", model_id: "seedance/text-to-video" },
          { name: "seedance-i2v", kind: "ai", model_id: "seedance/image-to-video" },
          { name: "tripo-t3d", kind: "ai", model_id: "tripo/text-to-3d" },
          { name: "tripo-i3d", kind: "ai", model_id: "tripo/image-to-3d" },
          { name: "chatterbox-tts", kind: "ai", model_id: "chatterbox/text-to-speech" },
          { name: "ffmpeg-mux", kind: "tool" },
        ],
      },
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain(expected);
  });

  it("bounds results and prints only decision-useful public fields", () => {
    const capabilities = Array.from({ length: 50 }, (_, index) => ({
      name: `image-${index}`,
      model_id: `model-${index}`,
      display_price_usd: 0.01,
      display_unit: "image",
      upstream_cost_usd: 99,
      margin: 0.9,
      secret: "never",
    }));
    const result = formatCapabilityResult("text-to-image", { content: [], structuredContent: { capabilities } });
    expect(result.lines).toHaveLength(40);
    expect(result.summary).toBe("Showing 40 of 50 matching capabilities.");
    expect(result.lines.join("\n")).not.toMatch(/upstream|margin|secret|never/);
  });

  it("reads the deterministic operation envelope used by the terminal host", () => {
    const result = formatCapabilityResult("text-to-image", {
      content: [],
      structuredContent: {
        structuredContent: {
          total: 1,
          capabilities: [{ name: "nano-banana", unit_kind: "image", availability: "available" }],
        },
      },
    });
    expect(result.lines).toEqual(["nano-banana"]);
  });

  it("does not classify image-input video or 3D models as image output", () => {
    const structuredContent = {
      capabilities: [
        { name: "still", unit_kind: "image" },
        { name: "seedance-i2v", model_id: "image-to-video", unit_kind: "second" },
        { name: "tripo-i3d", model_id: "image-to-3d", unit_kind: "mesh" },
      ],
    };
    expect(formatCapabilityResult("text-to-image", { content: [], structuredContent }).lines).toEqual(["still"]);
    expect(formatCapabilityResult("image-to-video", { content: [], structuredContent }).lines[0]).toContain("seedance-i2v");
    expect(formatCapabilityResult("image-to-3d", { content: [], structuredContent }).lines[0]).toContain("tripo-i3d");
  });

  it("keeps generation and editing routes separate while preserving the complete catalog", () => {
    const structuredContent = {
      capabilities: [
        { name: "nano-banana", unit_kind: "image" },
        { name: "gpt-image-edit", model_id: "openai/gpt-image/edit", unit_kind: "image" },
        { name: "ltx-t2v", model_id: "fal/ltx/text-to-video", unit_kind: "second" },
        { name: "void-inpaint", model_id: "fal/void-video-inpainting", unit_kind: "second" },
        { name: "audio-inpaint", model_id: "mirelo/inpaint-audio", unit_kind: "second" },
      ],
    };
    expect(formatCapabilityResult("text-to-image", { content: [], structuredContent }).lines).toEqual(["nano-banana"]);
    expect(formatCapabilityResult("image-to-image", { content: [], structuredContent }).lines[0]).toContain("gpt-image-edit");
    expect(formatCapabilityResult("image-to-image", { content: [], structuredContent }).lines).toHaveLength(1);
    expect(formatCapabilityResult("all", { content: [], structuredContent }).lines).toHaveLength(5);
  });

  it("shows only the concise model label and public display price", () => {
    const result = formatCapabilityResult("text-to-image", {
      content: [],
      structuredContent: {
        capabilities: [{
          name: "nano-banana",
          model_id: "fal-ai/nano-banana-2",
          provider: "fal",
          availability: "available",
          display_price_usd: 0.084,
          display_unit: "image",
        }],
      },
    });
    expect(result.lines).toEqual(["nano-banana-2 · $0.084/image"]);
    expect(result.lines.join("\n")).not.toMatch(/fal|available|provider/u);
  });

  it("prefetches one complete catalog and reuses it for every category", async () => {
    const list = vi.fn(() => Promise.resolve({
      content: [],
      structuredContent: {
        capabilities: [
          { name: "nano-banana", model_id: "fal-ai/nano-banana-2", unit_kind: "image" },
          { name: "ffmpeg-mux", kind: "tool" },
        ],
      },
    }));
    const menu = createProductCapabilities(executionClient(list));
    await menu.warm();
    await menu.list("text-to-image", { signal: new AbortController().signal });
    await menu.list("ffmpeg", { signal: new AbortController().signal });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ limit: 200, offset: 0 }, undefined);

    menu.invalidate();
    await menu.list("all", { signal: new AbortController().signal });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a command submitted while the boot prefetch is pending", async () => {
    let resolveCatalog!: (result: { content: never[]; structuredContent: { capabilities: never[] } }) => void;
    const list = vi.fn(() => new Promise<{ content: never[]; structuredContent: { capabilities: never[] } }>((resolve) => {
      resolveCatalog = resolve;
    }));
    const menu = createProductCapabilities(executionClient(list));
    const warming = menu.warm();
    const command = menu.list("text-to-video", { signal: new AbortController().signal });
    resolveCatalog({ content: [], structuredContent: { capabilities: [] } });
    await Promise.all([warming, command]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

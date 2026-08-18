import type { ToolResult } from "@livepeer-agent/contracts";
import type { Theme } from "@livepeer/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createLivepeerToolRegistrations } from "./agent-tools.js";
import { FakeTransport } from "./fixtures.test-support.js";
import { LivepeerToolRouter } from "./router.js";
import type { ModelSafeToolResult } from "./types.js";

const theme = {
  fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
  bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

describe("Livepeer tool rendering", () => {
  it("self-renders informational tools without a colored background", async () => {
    const { router, definition } = await tool("get_pricing");

    expect(definition.renderShell).toBe("self");
    const call = definition.renderCall?.({ name: "fal-ai/flux" }, theme, context());
    const result = definition.renderResult?.(
      agentResult(model({
        pricing: [{ name: "fal-ai/flux", displayPriceUsd: 0.04, displayUnit: "image" }],
      })),
      { expanded: false, isPartial: false },
      theme,
      context(),
    );

    expect(call?.render(80).join("\n")).toContain("Checking pricing");
    expect(call?.render(80).join("\n")).not.toContain("<bg:");
    expect(result?.render(80).join("\n")).toContain("flux · $0.04/image");
    expect(result?.render(80).join("\n")).toContain("<fg:livepeerHint>ctrl+o</fg>  Expand for details");
    expect(result?.render(80).join("\n")).not.toContain("<bg:");
    await router.close();
  });

  it("keeps generated media branded and exposes safe expanded details", async () => {
    const { router, definition } = await tool("create_media");
    const call = definition.renderCall?.(
      { action: "generate", model_override: "fal-ai/flux/dev", duration: 9 },
      theme,
      context(),
    );
    const result = definition.renderResult?.(
      agentResult(model({
        status: "complete",
        references: [{
          assetId: "asset_1",
          jobId: "mjob_1",
          projectId: "project_1",
          kind: "image",
          url: "https://media.example/result.png",
          modelId: "fal-ai/flux/dev",
          originalPrompt: "make a launch image",
          submittedPrompt: "a fox at dusk",
          sourceUrls: ["https://media.example/source.png"],
          parentAssetIds: ["asset_parent"],
        }],
        pricing: [{ name: "fal-ai/flux/dev", displayPriceUsd: 0.04, displayUnit: "image" }],
      })),
      { expanded: true, isPartial: false },
      theme,
      context(),
    );

    expect(call?.render(100).join("\n")).toContain("<bg:livepeerToolBg>");
    expect(call?.render(100).join("\n")).toContain("Generating media · flux/dev · 9s");
    const rendered = result?.render(100).join("\n") ?? "";
    const renderedLines = result?.render(100) ?? [];
    expect(rendered).toContain("<bg:livepeerToolBg>");
    expect(rendered).toContain("Image ready");
    expect(rendered).toContain("Model: flux/dev");
    expect(rendered).toContain("Asset ID: asset_1");
    expect(rendered).toContain("Job ID: mjob_1");
    expect(rendered).toContain("Project ID: project_1");
    expect(rendered).toContain("URL: https://media.example/result.png");
    expect(rendered).toContain("Original prompt: make a launch image");
    expect(rendered).toContain("Submitted prompt: a fox at dusk");
    expect(rendered).toContain("Price: flux/dev · $0.04/image");
    expect(renderedLines.at(-1)).toBe(`<bg:livepeerToolBg>${" ".repeat(100)}</bg>`);
    await router.close();
  });

  it("renders an MCP progress message in the active tool card", async () => {
    const { router, definition } = await tool("subscribe_progress", "authenticated");
    const result = definition.renderResult?.(
      agentResult(model({ status: "running", messages: ["Rendering scene 1 · 1/2"] })),
      { expanded: false, isPartial: true },
      theme,
      context(),
    );

    expect(result?.render(100).join("\n")).toContain("Rendering scene 1 · 1/2");
    await router.close();
  });

  it("renders native attachment upload as one clean status without paths or encoded data", async () => {
    const { router, definition } = await tool("upload");
    const args = { path: "/Users/person/Pictures/source image.png" };
    const call = definition.renderCall?.(args, theme, context(false, args));
    const result = definition.renderResult?.(
      agentResult(model({
        status: "complete",
        references: [{
          kind: "image",
          url: "https://agent.livepeer.org/a/signed-source-url",
          originalPrompt: "/Users/person/Pictures/source image.png animate this",
          sourceUrls: [],
          parentAssetIds: [],
        }],
        data: { mime_type: "image/jpeg", bytes: 262_484, storage: "livepeer-agent" },
      })),
      { expanded: true, isPartial: false },
      theme,
      context(false, args),
    );

    const renderedCall = call?.render(100).join("\n") ?? "";
    const renderedResult = result?.render(100).join("\n") ?? "";
    expect(renderedCall).toContain("Uploading source image.png");
    expect(renderedCall).not.toContain("/Users/person");
    expect(renderedResult).toContain("Image ready");
    expect(renderedResult).toContain("File: source image.png");
    expect(renderedResult).toContain("Type: image/jpeg");
    expect(renderedResult).toContain("Size: 256 KB");
    expect(renderedResult).toContain("Storage: Livepeer");
    expect(renderedResult).not.toContain("signed-source-url");
    expect(renderedResult).not.toContain("Original prompt");
    expect(`${renderedCall}${renderedResult}`).not.toContain("base64");
    await router.close();
  });

  it("shows the server's activation tier message instead of a generic success label", async () => {
    const { router, definition } = await tool("activate");
    const result = definition.renderResult?.(
      agentResult(model({
        messages: ["Activated: keyless PREVIEW allowance only; premium models still require a Daydream key."],
      })),
      { expanded: false, isPartial: false },
      theme,
      context(),
    );

    const rendered = result?.render(100).join("\n") ?? "";
    expect(rendered).toContain("keyless PREVIEW allowance only");
    expect(rendered).not.toContain("Livepeer operation complete");
    await router.close();
  });

  it("returns and renders ordinary routed failures with the error treatment", async () => {
    const { router, transport, definition } = await tool("list_capabilities");
    transport.result = routedError("provider_failed", "Provider unavailable");
    const executed = await definition.execute("failure-1", {}, undefined, undefined, {} as never);
    const result = definition.renderResult?.(
      executed,
      { expanded: false, isPartial: false },
      theme,
      context(true),
    );

    expect(executed.details).toMatchObject({ isError: true });
    const rendered = result?.render(80).join("\n") ?? "";
    expect(rendered).toContain("<bg:toolErrorBg>");
    expect(rendered).toContain("Failed · Provider unavailable");
    expect(rendered).not.toContain("provider_failed");
    await router.close();
  });

  it("renders the failed stage, model, duration, cause, and safe retry guidance", async () => {
    const { router, definition } = await tool("create_media");
    const args = { action: "animate", model_override: "minimax-h3-i2v", duration: 9 };
    const details = model({
      isError: true,
      error: {
        code: "livepeer_transport_failed",
        message: "Livepeer connection failed during animation submission; no job ID was returned to this client.",
      },
      data: {
        stage: "animation submission",
        model: "minimax-h3-i2v",
        durationSeconds: 9,
        cause: "UND_ERR_SOCKET: socket disconnected before response",
        retryAdvice: "Check Livepeer activity before retrying to avoid a duplicate paid job.",
      },
    });
    const result = definition.renderResult?.(
      agentResult(details),
      { expanded: true, isPartial: false },
      theme,
      context(true, args),
    );

    const rendered = result?.render(100).join("\n") ?? "";
    expect(rendered).toContain("Stage: Animation submission");
    expect(rendered).toContain("Model: minimax-h3-i2v");
    expect(rendered).toContain("Duration: 9s");
    expect(rendered).toContain("Cause: UND_ERR_SOCKET: socket disconnected before response");
    expect(rendered).toContain("Next: Check Livepeer activity before retrying");
    await router.close();
  });

  it("returns demo exhaustion to the owned waitlist renderer without exposing the error code", async () => {
    const { router, transport, definition } = await tool("create_media");
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? { content: [{ type: "text", text: "ok" }], structuredContent: { pricing: [] } }
      : routedError("demo_budget_exhausted", "Free preview reached."));
    const input = { action: "generate", prompt: "a fox at dusk", model_override: "fal-ai/flux" };
    await definition.approval?.("media-waitlist", input);
    const executed = await definition.execute("media-waitlist", input, undefined, undefined, {} as never);
    const renderContext = context(true);
    const call = definition.renderCall?.(input, theme, renderContext);
    const result = definition.renderResult?.(
      executed,
      { expanded: false, isPartial: false },
      theme,
      renderContext,
    );

    expect(executed.details).toMatchObject({ isError: true });
    const rendered = result?.render(80).join("\n") ?? "";
    expect(call?.render(80)).toEqual([]);
    expect(rendered).toContain("Join the waitlist");
    expect(rendered).toContain("earlyaccess.livepeer.org");
    expect(rendered).toContain("Browse models and pricing");
    expect(rendered).toContain("Generate images");
    expect(rendered).toContain("Animate 1 video clip per day");
    expect(rendered).toContain("Daily demo limit reached");
    expect(rendered).toContain("Remaining today: 0");
    expect(rendered).not.toContain("demo_budget_exhausted");
    expect(rendered).not.toContain("<bg:");
    await router.close();
  });

  it("renders an email-verification remedy when MCP requests email verification", async () => {
    const { router, transport, definition } = await tool("create_media");
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? { content: [{ type: "text", text: "ok" }], structuredContent: { pricing: [] } }
      : routedError(
        "demo_not_allowed",
        "Demo mode supports image generation only. Verify your email to unlock the full daily allowance.",
      ));
    const input = { action: "upscale", image_url: "https://media.example/result.png", model_override: "ffmpeg/upscale" };
    await definition.approval?.("media-demo-gate", input);
    const executed = await definition.execute("media-demo-gate", input, undefined, undefined, {} as never);
    const renderContext = context(true);
    const call = definition.renderCall?.(input, theme, renderContext);
    const result = definition.renderResult?.(
      executed,
      { expanded: false, isPartial: false },
      theme,
      renderContext,
    );

    const rendered = result?.render(80).join("\n") ?? "";
    expect(call?.render(80)).toEqual([]);
    expect(rendered).toContain("Email verification required");
    expect(rendered).toContain("Verify the email attached to this Daydream key");
    expect(rendered).toContain("ask the agent: verify my email");
    expect(rendered).not.toContain("livepeer key add");
    expect(rendered).not.toContain("Join the waitlist");
    expect(rendered).not.toContain("earlyaccess.livepeer.org");
    expect(rendered).not.toContain("demo_not_allowed");
    expect(rendered).not.toContain("<bg:");
    await router.close();
  });

  it("shows a numeric remaining demo count when the server includes one", async () => {
    const { router, transport, definition } = await tool("create_media");
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? { content: [{ type: "text", text: "ok" }], structuredContent: { pricing: [] } }
      : routedError("demo_not_allowed", "Upscaling is not included. 2 media turns remaining today."));
    const input = { action: "upscale", image_url: "https://media.example/result.png", model_override: "ffmpeg/upscale" };
    await definition.approval?.("media-demo-remaining", input);
    const executed = await definition.execute("media-demo-remaining", input, undefined, undefined, {} as never);
    const result = definition.renderResult?.(
      executed,
      { expanded: false, isPartial: false },
      theme,
      context(true),
    );

    expect(result?.render(80).join("\n")).toContain("Remaining today: 2 media turns");
    await router.close();
  });

  it("hides internal coding-policy cascade failures after a stopped Livepeer action", async () => {
    const { router, definition } = await tool("get_pricing");
    const renderContext = context(true);
    const call = definition.renderCall?.({}, theme, renderContext);
    const result = definition.renderResult?.(
      {
        content: [{ type: "text", text: "The current action was stopped by coding policy." }],
        details: undefined,
      },
      { expanded: false, isPartial: false },
      theme,
      renderContext,
    );

    expect(call?.render(80)).toEqual([]);
    expect(result?.render(80)).toEqual([]);
    await router.close();
  });
});

async function tool(
  name: "list_capabilities" | "describe_capability" | "get_pricing" | "activate" | "upload" | "create_media" | "subscribe_progress",
  access: "anonymous" | "authenticated" = "anonymous",
) {
  const router = new LivepeerToolRouter();
  const transport = new FakeTransport();
  await router.reload(access, transport);
  const definition = createLivepeerToolRegistrations(router)
    .find((registration) => registration.name === name)!.definition;
  return { router, transport, definition };
}

function context(isError = false, args: Record<string, unknown> = {}) {
  return {
    args,
    toolCallId: "tool-1",
    invalidate: () => undefined,
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError,
  };
}

function model(overrides: Partial<ModelSafeToolResult> = {}): ModelSafeToolResult {
  return {
    isError: false,
    references: [],
    pricing: [],
    summary: "{}",
    ...overrides,
  };
}

function agentResult(details: ModelSafeToolResult) {
  return { content: [{ type: "text" as const, text: details.summary }], details };
}

function routedError(code: string, message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `[${code}] ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

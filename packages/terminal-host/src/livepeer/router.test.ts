import type { ToolResult } from "@livepeer-agent/contracts";
import { describe, expect, it } from "vitest";
import { createLivepeerToolRegistrations } from "./agent-tools.js";
import { FakeTransport } from "./fixtures.test-support.js";
import { LivepeerToolRouter } from "./router.js";

describe("LivepeerToolRouter", () => {
  it("publishes catalog metadata atomically and preserves an authenticated generation on reload failure", async () => {
    const router = new LivepeerToolRouter();
    const first = new FakeTransport();
    const snapshot = await router.reload("authenticated", first);
    expect(snapshot).toMatchObject({ generation: 1, access: "authenticated", serverToolCount: 13 });
    const failing = new FakeTransport();
    failing.listError = new Error("offline");
    await expect(router.reload("authenticated", failing)).rejects.toThrow("offline");
    expect(router.snapshot()).toEqual(snapshot);
    expect(first.closeCount).toBe(0);
    expect(failing.closeCount).toBe(1);
    await router.close();
  });

  it("downgrades an anonymous catalog failure to an empty generation", async () => {
    const router = new LivepeerToolRouter();
    const first = new FakeTransport();
    await router.reload("authenticated", first);
    const failing = new FakeTransport();
    failing.listError = new Error("offline");
    const downgraded = await router.reload("anonymous", failing);
    expect(downgraded).toMatchObject({ generation: 2, access: "anonymous", serverToolCount: 0, routes: [] });
    expect(downgraded.diagnostics).toContainEqual(expect.objectContaining({ code: "catalog_load_failed" }));
    expect(first.closeCount).toBe(1);
    await router.close();
    expect(failing.closeCount).toBe(1);
  });

  it("captures the transport generation for in-flight calls", async () => {
    const router = new LivepeerToolRouter();
    const first = new FakeTransport();
    let resolve!: (result: ToolResult) => void;
    first.callImplementation = () => new Promise<ToolResult>((done) => { resolve = done; });
    await router.reload("anonymous", first);
    const pending = router.call("list_capabilities", {});
    const second = new FakeTransport();
    await router.reload("anonymous", second);
    expect(first.closeCount).toBe(0);
    await router.call("list_capabilities", {});
    expect(second.calls).toHaveLength(1);
    resolve({ content: [{ type: "text", text: "old" }] });
    await pending;
    expect(first.closeCount).toBe(1);
    await router.close();
  });

  it("shares an in-flight lease when the same transport publishes a new generation", async () => {
    const router = new LivepeerToolRouter();
    const transport = new FakeTransport();
    let resolve!: (result: ToolResult) => void;
    transport.callImplementation = () => new Promise<ToolResult>((done) => { resolve = done; });
    await router.reload("anonymous", transport);
    const pending = router.call("list_capabilities", {});
    await router.reload("authenticated", transport);
    await router.close();
    expect(transport.closeCount).toBe(0);
    resolve({ content: [{ type: "text", text: "done" }] });
    await pending;
    expect(transport.closeCount).toBe(1);
  });

  it("propagates abort and route timeouts", async () => {
    const router = new LivepeerToolRouter();
    const transport = new FakeTransport();
    transport.callImplementation = (_name, _input, options) => {
      options?.signal?.throwIfAborted();
      return Promise.resolve(transport.result);
    };
    await router.reload("anonymous", transport);
    await router.call("create_media", { action: "generate" });
    expect(transport.calls[0]?.options).toMatchObject({ timeoutMs: 120_000, maxTotalTimeoutMs: 1_200_000 });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(router.call("list_capabilities", {}, {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.calls).toHaveLength(1);
    await router.close();
  });

  it("registers exact names and returns only model-safe normalized details", async () => {
    const router = new LivepeerToolRouter();
    const transport = new FakeTransport();
    transport.result = {
      content: [{ type: "image", data: "base64-secret", mimeType: "image/png" }],
      structuredContent: { asset_id: "asset_1", output_url: "https://media.example/image.png?token=secret" },
    };
    await router.reload("anonymous", transport);
    const registrations = createLivepeerToolRegistrations(router);
    expect(registrations.map(({ name }) => name)).toEqual([
      "list_capabilities", "get_pricing", "me", "request_activation", "activate", "upload", "create_media", "generate_project",
    ]);
    const tool = registrations.find(({ name }) => name === "create_media")!.definition;
    const input = { action: "generate", prompt: "a fox", model_override: "fal-ai/flux" };
    await tool.approval?.("call-1", input);
    const result = await tool.execute("call-1", input, undefined, undefined, {} as never);
    expect(JSON.stringify(result)).not.toContain("base64-secret");
    expect(JSON.stringify(result)).not.toContain("token=secret");
    expect(result.content[0]).toMatchObject({ type: "text" });
    await router.close();
  });
});

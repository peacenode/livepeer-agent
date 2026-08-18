import { fileURLToPath } from "node:url";
import type { ToolResult } from "@livepeer-agent/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLivepeerToolRegistrations } from "./agent-tools.js";
import { FakeTransport, routedCatalog } from "./fixtures.test-support.js";
import { LivepeerToolRouter } from "./router.js";
import type { ModelSafeToolResult, OperationContext } from "./types.js";

afterEach(() => vi.useRealTimers());

describe("Livepeer agent tool approvals", () => {
  it("publishes stable host guidance, terse snippets, and live schema details for every routed tool", async () => {
    const catalog = routedCatalog().map((descriptor) => ({
      ...descriptor,
      description: `upstream constraints for ${descriptor.name}`,
    }));
    const router = new LivepeerToolRouter("authenticated");
    await router.reload("authenticated", new FakeTransport(catalog));
    const registrations = createLivepeerToolRegistrations(router);

    expect(registrations).toHaveLength(12);
    expect(registrations.some(({ name }) => name === "describe_capability")).toBe(false);
    for (const { name, definition } of registrations) {
      expect(definition.description).toContain(`Live schema details: upstream constraints for ${name}`);
      expect(definition.promptSnippet).toBeTruthy();
      expect(definition.promptSnippet!.length).toBeLessThan(definition.description.length);
      expect(definition.promptSnippet).not.toContain("upstream constraints");
    }
    expect(registrations.find(({ name }) => name === "create_media")?.definition.description).toContain("explicit model_override");
    expect(registrations.find(({ name }) => name === "upload")?.definition.description).toContain("Never use bash");
    expect(registrations.find(({ name }) => name === "generate_project")?.definition.description).toContain("host performs the dry run");
    expect(registrations.map(({ name }) => String(name))).not.toContain("submit_creative_job");
    await router.close();
  });

  it("verifies the existing credential without exposing bulk email or minting a replacement key", async () => {
    const router = new LivepeerToolRouter("authenticated");
    const transport = new FakeTransport();
    await router.reload("authenticated", transport);
    const registrations = createLivepeerToolRegistrations(router);
    const update = registrations.find(({ name }) => name === "me_update")!.definition;
    const request = registrations.find(({ name }) => name === "request_activation")!.definition;
    const activate = registrations.find(({ name }) => name === "activate")!.definition;

    const requestSchema = request.parameters as unknown as { required?: string[]; properties?: Record<string, unknown> };
    expect(requestSchema.required).toContain("email");
    expect(requestSchema.properties?.emails).toBeUndefined();
    expect(request.description).toContain("does not mint or replace the Daydream API key");
    expect(request.description).toContain("sign-me-up");
    expect(request.description).toContain("Never claim the email was sent until this tool returns success");
    expect(request.description).toContain("activation increases only the preview allowance");
    expect(activate.description).toContain("Never summarize keyless PREVIEW activation as full model access");
    expect(activate.description).toContain("If no code was supplied");

    const updateInput = { email: "person@example.com" };
    await expect(update.execute("profile-unapproved", updateInput, undefined, undefined, {} as never)).rejects.toThrow("explicit approval");
    const updateDisclosure = await update.approval?.("profile", updateInput);
    expect(updateDisclosure).toMatchObject({ title: "Update Livepeer profile" });
    expect(updateDisclosure?.message).toContain("keep the current Daydream API key");
    await update.execute("profile", updateInput, undefined, undefined, {} as never);

    const requestInput = { email: "person@example.com", emails: ["other@example.com"] };
    const requestDisclosure = await request.approval?.("request", requestInput);
    expect(requestDisclosure).toMatchObject({ title: "Send Livepeer activation email" });
    await request.execute("request", requestInput, undefined, undefined, {} as never);
    expect(transport.calls.at(-1)).toMatchObject({
      name: "request_activation",
      input: { email: "person@example.com" },
    });

    const activateInput = { code: "  one-time-code  " };
    const activateDisclosure = await activate.approval?.("activate", activateInput);
    expect(activateDisclosure).toMatchObject({ title: "Activate Livepeer access" });
    expect(activateDisclosure?.message).not.toContain("one-time-code");
    await activate.execute("activate", activateInput, undefined, undefined, {} as never);
    expect(transport.calls.at(-1)).toMatchObject({ name: "activate", input: { code: "one-time-code" } });
    await router.close();
  });

  it("returns no approval request for automatic routes", async () => {
    const { router, transport, tool } = await harness("list_capabilities");

    await expect(tool.approval?.("read-1", { kind: "ai" })).resolves.toBeUndefined();
    expect(transport.calls).toEqual([]);

    await tool.execute("read-1", { kind: "ai" }, undefined, undefined, {} as never);
    expect(transport.calls).toHaveLength(1);
    await router.close();
  });

  it("turns an attached image path into a native Livepeer upload without exposing bytes to the model", async () => {
    const path = fileURLToPath(new URL("../../../pi-coding-agent/src/modes/interactive/assets/clankolas.png", import.meta.url));
    const { router, transport, tool } = await harness("upload", () => ({ originalUserPrompt: `Animate ${path}` }));
    const schema = tool.parameters as unknown as { required?: string[]; properties?: Record<string, unknown> };

    expect(schema).toMatchObject({ required: ["path"], additionalProperties: false });
    expect(schema.properties?.path).toMatchObject({ type: "string", minLength: 1 });
    await expect(tool.approval?.("upload-1", { path })).resolves.toBeUndefined();
    await tool.execute("upload-1", { path }, undefined, undefined, {} as never);

    const call = transport.calls.at(-1);
    expect(call?.name).toBe("upload");
    expect(call?.input.mime_type).toMatch(/^image\//u);
    expect(call?.input.kind).toBe("image");
    expect(call?.input.filename).toBe("clankolas.png");
    expect(typeof call?.input.data).toBe("string");
    expect(call?.input.path).toBeUndefined();
    expect((call?.input.data as string).length).toBeGreaterThan(100);
    const blocked = await tool.execute("upload-invented", { path: "/tmp/not-attached.png" }, undefined, undefined, {} as never);
    expect(blocked.details).toMatchObject({
      isError: true,
      error: { code: "livepeer_tool_failed" },
    });
    expect((blocked.details as ModelSafeToolResult).error?.message).toContain("requires user approval");
    await router.close();
  });

  it("uploads an exact local image path registered by a host tool", async () => {
    const path = fileURLToPath(new URL("../../../pi-coding-agent/src/modes/interactive/assets/clankolas.png", import.meta.url));
    const { router, transport } = await harness("upload");
    const tool = createLivepeerToolRegistrations(
      router,
      () => ({ originalUserPrompt: "Upload the browser captures" }),
      undefined,
      { isAllowed: (candidate) => candidate === path },
    ).find((registration) => registration.name === "upload")!.definition;

    await expect(tool.approval?.("upload-browser-screenshot", { path })).resolves.toBeUndefined();
    await tool.execute("upload-browser-screenshot", { path }, undefined, undefined, {} as never);

    expect(transport.calls.at(-1)).toMatchObject({
      name: "upload",
      input: { filename: "clankolas.png", mime_type: "image/png", kind: "image" },
    });
    await router.close();
  });

  it("fails closed for a valid local image without user or host provenance", async () => {
    const path = fileURLToPath(new URL("../../../pi-coding-agent/src/modes/interactive/assets/clankolas.png", import.meta.url));
    const { router, transport, tool } = await harness("upload");

    const blocked = await tool.execute("upload-untrusted", { path }, undefined, undefined, {} as never);

    expect(blocked.details).toMatchObject({
      isError: true,
      error: { code: "livepeer_tool_failed" },
    });
    expect(transport.calls).toEqual([]);
    await router.close();
  });

  it("offers approval for an otherwise untrusted local image and uploads only the approved path", async () => {
    const path = fileURLToPath(new URL("../../../pi-coding-agent/src/modes/interactive/assets/clankolas.png", import.meta.url));
    const { router, transport, tool } = await harness("upload", () => ({ originalUserPrompt: "Upload that image" }));

    const disclosure = await tool.approval?.("upload-approved", { path });

    expect(disclosure).toEqual({
      title: "Approve image upload",
      message: expect.stringMatching(new RegExp(`^File: clankolas\\.png\\nPath: ${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\nSize: \\d+(?:\\.\\d+)? (?:B|KB|MB)\\nDestination: Livepeer$`, "u")) as string,
    });
    await tool.execute("upload-approved", { path }, undefined, undefined, {} as never);
    expect(transport.calls.at(-1)).toMatchObject({
      name: "upload",
      input: { filename: "clankolas.png", mime_type: "image/png", kind: "image" },
    });

    await tool.approval?.("upload-changed", { path });
    await expect(tool.execute("upload-changed", { path: `${path}.png` }, undefined, undefined, {} as never))
      .rejects.toThrow("upload path changed after approval");
    expect(transport.calls).toHaveLength(1);
    await router.close();
  });

  it("defaults and clamps list_capabilities before transport and returns the full safe summary", async () => {
    const { router, transport, tool } = await harness("list_capabilities");
    transport.result = {
      content: [{ type: "text", text: "unpaginated text" }],
      structuredContent: {
        capabilities: [{ name: "flux", kind: "ai", availability: "available", constraints: { aspect_ratios: ["1:1"] } }],
      },
    };

    const first = await tool.execute("list-default", { kind: "ai" }, undefined, undefined, {} as never);
    await tool.execute("list-clamped", { kind: "tool", limit: 500 }, undefined, undefined, {} as never);

    expect(transport.calls).toEqual([
      expect.objectContaining({ name: "list_capabilities", input: { kind: "ai", limit: 20 } }),
      expect.objectContaining({ name: "list_capabilities", input: { kind: "tool", limit: 50 } }),
    ]);
    const content = first.content[0];
    expect(content?.type).toBe("text");
    const summary = JSON.parse(content?.type === "text" ? content.text : "{}") as { data?: unknown; messages?: unknown };
    expect(summary.data).toMatchObject({ capabilities: [{ name: "flux", constraints: { aspect_ratios: ["1:1"] } }], limit: 20 });
    expect(summary.messages).toBeUndefined();
    await router.close();
  });

  it("searches every capability page behind one named-model tool call", async () => {
    const { router, transport, tool } = await harness("list_capabilities");
    const schema = tool.parameters as unknown as { properties?: Record<string, unknown> };
    expect(schema.properties?.query).toMatchObject({ type: "string", minLength: 1 });
    transport.callImplementation = (_name, input) => {
      const offset = Number(input.offset ?? 0);
      const capability = offset === 100
        ? { name: "minimax-h3-i2v", model_id: "minimax/h3/image-to-video", display_price_usd: 0.12, display_unit: "second" }
        : { name: `unrelated-${offset}`, model_id: `vendor/unrelated-${offset}` };
      return Promise.resolve(result({
        total: 101,
        returned: offset === 100 ? 1 : 50,
        offset,
        capabilities: [capability],
      }));
    };

    const found = await tool.execute("find-minimax", { kind: "ai", query: "minimax h3" }, undefined, undefined, {} as never);

    expect(transport.calls.map(({ input }) => input)).toEqual([
      { kind: "ai", limit: 50, offset: 0 },
      { kind: "ai", limit: 50, offset: 50 },
      { kind: "ai", limit: 50, offset: 100 },
    ]);
    expect(found.details).toMatchObject({
      isError: false,
      data: {
        query: "minimax h3",
        total: 1,
        capabilities: [{ name: "minimax-h3-i2v", model_id: "minimax/h3/image-to-video" }],
      },
    });
    await router.close();
  });

  it("requires model_override and does not accept legacy media aliases", async () => {
    const { router, transport, tool } = await harness("create_media");
    const schema = tool.parameters as unknown as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("model_override");
    expect(schema.properties?.model_override).toMatchObject({ type: "string", minLength: 1 });
    expect(schema.properties?.max_cost_usd).toBeUndefined();

    for (const input of [
      { action: "generate", model: "legacy" },
      { action: "generate", capability: "legacy" },
      { action: "generate", model_id: "legacy" },
      { action: "generate", model_override: "   " },
    ]) {
      expect(() => tool.approval?.("invalid-media", input)).toThrow("nonempty model_override");
    }
    expect(transport.calls).toEqual([]);
    await router.close();
  });

  it("discloses routed create_media scope and read-only pricing before mutation", async () => {
    const { router, transport, tool } = await harness("create_media");
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04, display_unit: "image", unit_kind: "image" }] })
      : result({ status: "submitted", job_id: "mjob_abcdef" }));
    const input = {
      action: "generate",
      model_override: "fal-ai/flux",
      route: "create_media",
      scope: "2 square images",
      max_attempts: 2,
      prompt: "a fox at dusk",
    };

    expect(tool.description).toContain("call this tool directly");
    expect(tool.description).toContain("Do not ask for a separate conversational yes");

    await expect(tool.execute("unapproved", input, undefined, undefined, {} as never)).rejects.toThrow(
      "create_media execution requires a successful approval preflight",
    );
    expect(transport.calls).toEqual([]);

    const disclosure = await tool.approval?.("media-1", input);

    expect(transport.calls).toEqual([expect.objectContaining({
      name: "get_pricing",
      input: { kind: "all", name: "fal-ai/flux" },
    })]);
    expect(disclosure).toMatchObject({ title: "Approve Livepeer generate" });
    expect(disclosure?.message).toBe([
      "Model: fal-ai/flux",
      "Scope: 2 square images",
      "Price: $0.04 USD · image",
    ].join("\n"));

    await tool.execute("media-1", input, undefined, undefined, {} as never);
    expect(transport.calls[1]).toMatchObject({ name: "create_media", input });
    await router.close();
  });

  it("returns immediately when create_media already includes completed media", async () => {
    const { router, transport, tool } = await authenticatedMediaHarness();
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] })
      : result({ status: "complete", job_id: "mjob_ready1", output_url: "https://media.example/ready.png" }));
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "ready now" };

    await tool.approval?.("ready", input);
    const completed = await tool.execute("ready", input, undefined, undefined, {} as never);

    expect(transport.calls.map(({ name }) => name)).toEqual(["get_pricing", "create_media"]);
    expect(completed.details).toMatchObject({ status: "complete", references: [expect.objectContaining({ url: "https://media.example/ready.png" })] });
    await router.close();
  });

  it("keeps one create_media call active through queued, processing, and completed status reads", async () => {
    vi.useFakeTimers();
    const { router, transport, tool } = await authenticatedMediaHarness((_toolCallId, input) => ({
      requestId: "request-1",
      originalUserPrompt: `original: ${String(input.prompt)}`,
    }));
    let statusReads = 0;
    transport.callImplementation = (name) => {
      if (name === "get_pricing") return Promise.resolve(result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] }));
      if (name === "create_media") return Promise.resolve(result({ status: "queued", job_id: "mjob_poll01", model_id: "fal-ai/flux" }));
      statusReads += 1;
      return Promise.resolve(statusReads === 1
        ? result({ status: "processing", job_id: "mjob_poll01", model_id: "fal-ai/flux" })
        : result({ job_id: "mjob_poll01", asset_id: "asset_1", model_id: "fal-ai/flux", output_url: "https://media.example/final.png" }));
    };
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "a fox at dusk" };
    const onUpdate = vi.fn();

    await tool.approval?.("poll", input);
    const pending = tool.execute("poll", input, undefined, onUpdate, {} as never);
    await vi.advanceTimersByTimeAsync(4_000);
    const completed = await pending;

    expect(transport.calls.map(({ name }) => name)).toEqual([
      "get_pricing", "create_media", "get_create_media", "get_create_media",
    ]);
    expect(transport.calls.filter(({ name }) => name === "create_media")).toHaveLength(1);
    expect(onUpdate.mock.calls.map(([update]) => (update as { details?: ModelSafeToolResult }).details?.status))
      .toEqual(["queued", "processing", undefined]);
    expect(completed.details).toMatchObject({
      isError: false,
      references: [expect.objectContaining({
        assetId: "asset_1",
        jobId: "mjob_poll01",
        modelId: "fal-ai/flux",
        url: "https://media.example/final.png",
        originalPrompt: "original: a fox at dusk",
        submittedPrompt: "a fox at dusk",
      })],
    });
    await router.close();
  });

  it.each(["failed", "cancelled", "canceled"])("returns %s media jobs as terminal tool failures", async (status) => {
    vi.useFakeTimers();
    const { router, transport, tool } = await authenticatedMediaHarness();
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] })
      : name === "create_media"
        ? result({ status: "queued", job_id: "mjob_failed" })
        : result({ status, job_id: "mjob_failed" }));
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "failure case" };

    await tool.approval?.(`failure-${status}`, input);
    const pending = tool.execute(`failure-${status}`, input, undefined, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(2_000);
    const failed = await pending;

    expect(failed.details).toMatchObject({ isError: true, status });
    expect((failed.details as ModelSafeToolResult).error?.message).toContain(status);
    await router.close();
  });

  it("fails clearly when an authenticated nonterminal response has no job ID", async () => {
    const { router, transport, tool } = await authenticatedMediaHarness();
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] })
      : result({ status: "queued" }));
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "missing job" };

    await tool.approval?.("missing-job", input);
    const failed = await tool.execute("missing-job", input, undefined, undefined, {} as never);
    expect(failed.details).toMatchObject({
      isError: true,
      error: { code: "livepeer_tool_failed" },
      data: { stage: "media submission", model: "fal-ai/flux" },
    });
    expect((failed.details as ModelSafeToolResult).error?.message).toContain("nonterminal result without a job_id");
    await router.close();
  });

  it("returns actionable transport diagnostics instead of a bare fetch failure", async () => {
    const { router, transport, tool } = await harness("create_media");
    const input = { action: "animate", model_override: "minimax-h3-i2v", duration: 9, prompt: "shake hands" };
    await tool.approval?.("network-failure", input);
    const cause = Object.assign(new Error("socket disconnected before response"), { code: "UND_ERR_SOCKET" });
    transport.callImplementation = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }));

    const failed = await tool.execute("network-failure", input, undefined, undefined, {} as never);

    expect(failed.details).toMatchObject({
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
      },
    });
    expect(JSON.stringify((failed.details as ModelSafeToolResult).data)).toContain("duplicate paid job");
    await router.close();
  });

  it("returns the latest pending job without error after the ten-minute wait deadline", async () => {
    vi.useFakeTimers();
    const { router, transport, tool } = await authenticatedMediaHarness();
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] })
      : name === "create_media"
        ? result({ status: "queued", job_id: "mjob_timeout" })
        : result({ status: "processing", job_id: "mjob_timeout" }));
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "slow render" };

    await tool.approval?.("timeout", input);
    const pending = tool.execute("timeout", input, undefined, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const timedOut = await pending;

    expect(timedOut.details).toMatchObject({ isError: false, status: "processing", references: [expect.objectContaining({ jobId: "mjob_timeout" })] });
    expect(transport.calls.filter(({ name }) => name === "create_media")).toHaveLength(1);
    await router.close();
  });

  it("cancels immediately while waiting between media status reads", async () => {
    vi.useFakeTimers();
    const { router, transport, tool } = await authenticatedMediaHarness();
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] })
      : result({ status: "queued", job_id: "mjob_abort1" }));
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "cancel delay" };
    const controller = new AbortController();

    await tool.approval?.("abort-delay", input);
    const pending = tool.execute("abort-delay", input, controller.signal, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.calls.some(({ name }) => name === "get_create_media")).toBe(false);
    await router.close();
  });

  it("propagates cancellation from an in-flight media status request", async () => {
    vi.useFakeTimers();
    const { router, transport, tool } = await authenticatedMediaHarness();
    let statusStarted!: () => void;
    const started = new Promise<void>((resolve) => { statusStarted = resolve; });
    transport.callImplementation = (name, _input, options) => {
      if (name === "get_pricing") return Promise.resolve(result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] }));
      if (name === "create_media") return Promise.resolve(result({ status: "queued", job_id: "mjob_abort2" }));
      statusStarted();
      return new Promise<ToolResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
    };
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "cancel request" };
    const controller = new AbortController();

    await tool.approval?.("abort-request", input);
    const pending = tool.execute("abort-request", input, controller.signal, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(2_000);
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.calls.filter(({ name }) => name === "get_create_media")).toHaveLength(1);
    await router.close();
  });

  it("leaves anonymous queued jobs recoverable when status lookup is not routed", async () => {
    const { router, transport, tool } = await harness("create_media");
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "fal-ai/flux", display_price_usd: 0.04 }] })
      : result({ status: "queued", job_id: "mjob_keyless" }));
    const input = { action: "generate", model_override: "fal-ai/flux", prompt: "keyless" };

    await tool.approval?.("keyless", input);
    const queued = await tool.execute("keyless", input, undefined, undefined, {} as never);

    expect(queued.details).toMatchObject({ isError: false, status: "queued", references: [expect.objectContaining({ jobId: "mjob_keyless" })] });
    expect(transport.calls.map(({ name }) => name)).toEqual(["get_pricing", "create_media"]);
    await router.close();
  });

  it("uses the user-owned session budget instead of a model-supplied media cap", async () => {
    const router = new LivepeerToolRouter();
    const transport = new FakeTransport();
    await router.reload("anonymous", transport);
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "gemini-image", display_price_usd: 0.0041, display_unit: "image" }] })
      : result({ status: "submitted", job_id: "mjob_budget" }));
    const tool = createLivepeerToolRegistrations(router, undefined, { maxCostUsd: () => 0.03 })
      .find((registration) => registration.name === "create_media")!.definition;
    const input = { action: "generate", model_override: "gemini-image", prompt: "keyframe", max_cost_usd: 0.0041 };

    const disclosure = await tool.approval?.("budgeted-media", input);
    expect(disclosure?.message).toContain("Price: $0.0041 USD · image");
    await tool.execute("budgeted-media", input, undefined, undefined, {} as never);
    expect(transport.calls.at(-1)).toMatchObject({
      name: "create_media",
      input: { action: "generate", model_override: "gemini-image", prompt: "keyframe", max_cost_usd: 0.03 },
    });
    await router.close();
  });

  it("removes model-supplied media caps when the user budget is off", async () => {
    const router = new LivepeerToolRouter();
    const transport = new FakeTransport();
    await router.reload("anonymous", transport);
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "gemini-image", display_price_usd: 0.0263, display_unit: "image" }] })
      : result({ status: "submitted", job_id: "mjob_uncapped" }));
    const tool = createLivepeerToolRegistrations(router, undefined, { maxCostUsd: () => undefined })
      .find((registration) => registration.name === "create_media")!.definition;
    const properties = (tool.parameters as unknown as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties.max_cost_usd).toBeUndefined();
    expect(tool.description).toContain("do not supply max_cost_usd");

    const input = {
      action: "generate",
      model_override: "gemini-image",
      prompt: "a dog with a sock",
      max_cost_usd: 0.01,
      maxCostUsd: 0.02,
    };
    const disclosure = await tool.approval?.("uncapped-media", input);
    expect(disclosure?.message).toContain("Price: $0.0263 USD · image");
    await tool.execute("uncapped-media", input, undefined, undefined, {} as never);
    expect(transport.calls.at(-1)).toMatchObject({
      name: "create_media",
      input: { action: "generate", model_override: "gemini-image", prompt: "a dog with a sock" },
    });
    await router.close();
  });

  it("explicitly discloses unavailable create_media pricing", async () => {
    const { router, transport, tool } = await harness("create_media");
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ status: "unavailable" }, true)
      : result({ status: "submitted" }));

    const disclosure = await tool.approval?.("media-unknown", { action: "animate", model_override: "video-model" });

    expect(disclosure?.message).toBe([
      "Model: video-model",
      "Scope: one animate operation",
      "Price: unavailable",
    ].join("\n"));
    expect(transport.calls.map(({ name }) => name)).toEqual(["get_pricing"]);
    await router.close();
  });

  it("prices a named deterministic model_override through the all-kind catalog", async () => {
    const { router, transport, tool } = await harness("create_media");
    transport.callImplementation = (name) => Promise.resolve(name === "get_pricing"
      ? result({ pricing: [{ name: "ffmpeg/upscale", display_price_usd: 0.01, display_unit: "operation" }] })
      : result({ status: "complete" }));

    const disclosure = await tool.approval?.("deterministic-price", {
      action: "upscale",
      model_override: "ffmpeg/upscale",
      image_url: "https://media.example/input.png",
    });

    expect(transport.calls).toEqual([expect.objectContaining({
      name: "get_pricing",
      input: { kind: "all", name: "ffmpeg/upscale" },
    })]);
    expect(disclosure?.message).toContain("Price: $0.01 USD · operation");
    await router.close();
  });

  it("runs generate_project exactly as dry-run then confirmed with preserved input and context", async () => {
    const operationContext = {
      requestId: "project-request",
      originalUserPrompt: "make the launch film",
      parentReferences: [],
    };
    let contextCalls = 0;
    const { router, transport, tool } = await harness("generate_project", () => {
      contextCalls += 1;
      return operationContext;
    });
    transport.callImplementation = (_name, input) => Promise.resolve(input.confirm === false
      ? result({
          resolved_routes: [{ scene: 0, route: "image_then_video" }],
          downgrades: [{ scene: 1, from: "hq", to: "balanced" }],
          itemized_estimate: [{ scene: 0, usd: 0.2 }],
          unknown_estimates: ["music"],
          total_estimate_usd: 0.2,
          max_attempts: 3,
        })
      : result({ status: "submitted", project_id: "project_1" }));
    const input = {
      title: "Launch",
      scenes: [{ prompt: "exact scene prompt" }, { prompt: "second exact prompt" }],
      global_model_override: "fal-ai/flux",
      confirm: true,
      max_attempts: 4,
    };

    const disclosure = await tool.approval?.("project-1", input);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({
      name: "generate_project",
      input: { ...input, confirm: false },
    });
    expect(disclosure?.message).toContain("Resolved routes: [{\"scene\":0,\"route\":\"image_then_video\"}]");
    expect(disclosure?.message).toContain("Downgrades: [{\"scene\":1,\"from\":\"hq\",\"to\":\"balanced\"}]");
    expect(disclosure?.message).toContain("Itemized estimate: [{\"scene\":0,\"usd\":0.2}]");
    expect(disclosure?.message).toContain("Unknown estimate items: [\"music\"]");
    expect(disclosure?.message).toContain("Total estimate: $0.2000 USD");
    expect(disclosure?.message).toContain("Maximum attempts: 3");

    const executed = await tool.execute("project-1", input, undefined, undefined, {} as never);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]).toMatchObject({ name: "generate_project", input: { ...input, confirm: true } });
    expect(transport.calls[1]?.input.scenes).toEqual(input.scenes);
    expect(contextCalls).toBe(1);
    expect(executed.details).toMatchObject({ references: [expect.objectContaining({ originalPrompt: "make the launch film" })] });
    await router.close();
  });

  it("requires explicit project scene routes while allowing stock only for generate_project", async () => {
    const { router, transport, tool } = await harness("generate_project");
    const schemaText = JSON.stringify(tool.parameters);
    expect(schemaText).toContain("global_model_override");
    expect(schemaText).toContain('"source":{"const":"stock"}');

    expect(() => tool.approval?.("legacy-project", {
      title: "Legacy",
      globalModelOverride: "legacy-alias",
      scenes: [{ prompt: "one" }],
    })).toThrow("global_model_override");
    expect(() => tool.approval?.("missing-project", {
      title: "Missing",
      scenes: [{ prompt: "one", model: "legacy-alias" }],
    })).toThrow("Scene 1 is missing model_override");
    expect(transport.calls).toEqual([]);

    await tool.approval?.("stock-project", {
      title: "Stock",
      scenes: [{ prompt: "one", source: "stock" }, { prompt: "two", model_override: "fal-ai/flux" }],
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.input).toMatchObject({ confirm: false });
    await router.close();
  });

  it("blocks generate_project execution when preflight fails or the approved input changes", async () => {
    const { router, transport, tool } = await harness("generate_project");
    const input = { title: "Blocked", scenes: [{ prompt: "keep this" }], global_model_override: "fal-ai/flux" };

    await expect(tool.execute("missing", input, undefined, undefined, {} as never)).rejects.toThrow(
      "requires a successful approval preflight",
    );
    expect(transport.calls).toEqual([]);

    transport.callImplementation = () => Promise.resolve({
      isError: true,
      content: [{ type: "text", text: "estimate unavailable" }],
      structuredContent: { error: { code: "preflight_failed", message: "estimate unavailable" } },
    });
    await expect(tool.approval?.("failed", input)).rejects.toThrow(
      "generate_project preflight failed: [preflight_failed] estimate unavailable",
    );
    expect(transport.calls).toHaveLength(1);

    transport.callImplementation = () => Promise.resolve(result({ total_estimate_usd: 1 }));
    await tool.approval?.("changed", input);
    await expect(tool.execute(
      "changed",
      { ...input, title: "Changed after approval" },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("input changed after approval preflight");
    expect(transport.calls).toHaveLength(2);
    await router.close();
  });

  it("streams MCP status into the working row and re-subscribes a progress watch until completion", async () => {
    vi.useFakeTimers();
    const router = new LivepeerToolRouter("authenticated");
    const transport = new FakeTransport();
    await router.reload("authenticated", transport);
    let subscriptions = 0;
    transport.callImplementation = (_name, _input, options) => {
      subscriptions += 1;
      options?.onProgress?.({
        progress: subscriptions,
        total: 2,
        message: `Rendering scene ${subscriptions}`,
        metadata: { status: "running", stage: "provider" },
      });
      return Promise.resolve(subscriptions === 1
        ? result({ status: "running", job_id: "cjob_tracking", completed: 1, total: 2, should_resubscribe: true })
        : result({
          status: "complete",
          job_id: "cjob_tracking",
          completed: 2,
          total: 2,
          output_url: "https://media.example/tracked.mp4",
        }));
    };
    const tool = createLivepeerToolRegistrations(router)
      .find((registration) => registration.name === "subscribe_progress")!.definition;
    const input = { job_id: "cjob_tracking", budget_seconds: 25 };
    const onUpdate = vi.fn();
    const setWorkingMessage = vi.fn();

    const pending = tool.execute(
      "tracking",
      input,
      undefined,
      onUpdate,
      { hasUI: true, ui: { setWorkingMessage } } as never,
    );
    await vi.advanceTimersByTimeAsync(500);
    const completed = await pending;

    expect(transport.calls.map(({ name }) => name)).toEqual([
      "subscribe_progress",
      "subscribe_progress",
    ]);
    expect(setWorkingMessage.mock.calls.flat()).toContain("Rendering scene 1 · 1/2");
    expect(setWorkingMessage.mock.calls.flat()).toContain("Rendering scene 2 · 2/2");
    expect(setWorkingMessage).toHaveBeenLastCalledWith();
    expect(onUpdate.mock.calls.some(([update]) =>
      (update as { details?: ModelSafeToolResult }).details?.messages?.includes("Rendering scene 1 · 1/2")))
      .toBe(true);
    expect(completed.details).toMatchObject({
      status: "complete",
      references: [expect.objectContaining({ url: "https://media.example/tracked.mp4" })],
    });
    await router.close();
  });

  it("fails closed when a project dry-run exceeds the session budget", async () => {
    const router = new LivepeerToolRouter();
    const transport = new FakeTransport();
    await router.reload("anonymous", transport);
    transport.callImplementation = () => Promise.resolve(result({ total_estimate_usd: 0.75 }));
    const tool = createLivepeerToolRegistrations(router, undefined, { maxCostUsd: () => 0.5 })
      .find((registration) => registration.name === "generate_project")!.definition;

    await expect(tool.approval?.("over-budget", { title: "Launch", scenes: [{ prompt: "one" }], global_model_override: "fal-ai/flux" }))
      .rejects.toThrow("Project estimate $0.7500 exceeds the $0.50 session budget");
    expect(transport.calls).toHaveLength(1);
    await router.close();
  });
});

async function harness(
  name: "list_capabilities" | "upload" | "create_media" | "generate_project",
  context?: (toolCallId: string, input: Record<string, unknown>) => OperationContext,
) {
  const router = new LivepeerToolRouter();
  const transport = new FakeTransport();
  await router.reload("anonymous", transport);
  const tool = createLivepeerToolRegistrations(router, context).find((registration) => registration.name === name)!.definition;
  return { router, transport, tool };
}

async function authenticatedMediaHarness(
  context?: (toolCallId: string, input: Record<string, unknown>) => OperationContext,
) {
  const router = new LivepeerToolRouter("authenticated");
  const transport = new FakeTransport();
  await router.reload("authenticated", transport);
  const tool = createLivepeerToolRegistrations(router, context)
    .find((registration) => registration.name === "create_media")!.definition;
  return { router, transport, tool };
}

function result(structuredContent: Record<string, unknown>, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: isError ? "unavailable" : "ok" }],
    structuredContent,
  };
}

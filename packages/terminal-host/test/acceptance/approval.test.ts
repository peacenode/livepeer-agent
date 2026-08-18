import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ToolApprovalRequest,
  type ToolDefinition,
} from "@livepeer/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createLivepeerToolRegistrations } from "../../src/livepeer/agent-tools.js";
import { FakeTransport } from "../../src/livepeer/fixtures.test-support.js";
import { LivepeerToolRouter } from "../../src/livepeer/router.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

describe("owned Livepeer shell approval surface", () => {
  it("feeds safe Livepeer result data into the next model turn without removing coding tools", async () => {
    const marker = "safe-capability-marker";
    const router = new LivepeerToolRouter();
    const transport = new FakeTransport();
    transport.callImplementation = (name) =>
      Promise.resolve(
        name === "list_capabilities"
          ? {
              content: [{ type: "text", text: "Current capability catalog" }],
              structuredContent: {
                capabilities: [
                  {
                    name: marker,
                    description: "A safe capability description for the next model turn.",
                    input_schema: { type: "object", properties: { prompt: { type: "string" } } },
                  },
                ],
                api_key: "must-not-reach-model-context",
              },
            }
          : { content: [{ type: "text", text: "ok" }], structuredContent: {} },
      );
    await router.reload("anonymous", transport);
    cleanup.push(() => router.close());

    let nextTurnContext = "";
    const tools = createLivepeerToolRegistrations(router).map(({ definition }) => definition as ToolDefinition);
    const harness = await createHarness(
      tools,
      [
        toolMessage("list_capabilities", { kind: "ai", limit: 10, offset: 0 }),
        (context) => {
          nextTurnContext = JSON.stringify(context);
          return textMessage("catalog observed");
        },
      ],
      { builtinTools: true },
    );

    expect(harness.runtime.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "write", "list_capabilities"]),
    );
    await harness.runtime.session.prompt("Inspect the current capability catalog.");

    expect(nextTurnContext).toContain(marker);
    expect(nextTurnContext).toContain("A safe capability description for the next model turn.");
    expect(nextTurnContext).not.toContain("must-not-reach-model-context");
  });

  it("executes an automatic host tool without prompting", async () => {
    let executions = 0;
    const harness = await createHarness(
      [tool("hosted_read", () => { executions += 1; }, () => undefined)],
      [toolMessage("hosted_read", {}), textMessage("done")],
    );
    const requests: ToolApprovalRequest[] = [];
    await bindApproval(harness.runtime, (request) => { requests.push(request); return Promise.resolve(true); });

    await harness.runtime.session.prompt("read");

    expect(executions).toBe(1);
    expect(requests).toEqual([]);
    expect(assistantCount(harness.runtime)).toBe(2);
  });

  it("terminates host tools on denial, cancellation, and approval-preflight failure", async () => {
    let deniedExecutions = 0;
    const denied = await createHarness(
      [tool("paid_media", () => { deniedExecutions += 1; }, () => ({ title: "Approve media", message: "Price: $1" }))],
      [toolMessage("paid_media", { prompt: "preserve me" }), textMessage("must not continue")],
    );
    await bindApproval(denied.runtime, () => Promise.resolve(false));
    await denied.runtime.session.prompt("deny");
    expect(deniedExecutions).toBe(0);
    expect(assistantCount(denied.runtime)).toBe(1);

    let cancelledExecutions = 0;
    const cancelled = await createHarness(
      [tool("paid_media", () => { cancelledExecutions += 1; }, () => ({ title: "Approve media", message: "Price: $1" }))],
      [toolMessage("paid_media", {})],
    );
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    await bindApproval(cancelled.runtime, async (_request, signal) => {
      approvalStarted();
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return false;
    });
    const cancelledPrompt = cancelled.runtime.session.prompt("cancel");
    await started;
    await cancelled.runtime.session.abort();
    await cancelledPrompt;
    expect(cancelledExecutions).toBe(0);
    expect(assistantCount(cancelled.runtime)).toBe(1);

    let failedExecutions = 0;
    const failed = await createHarness(
      [tool("paid_media", () => { failedExecutions += 1; }, () => { throw new Error("estimate unavailable"); })],
      [toolMessage("paid_media", {}), textMessage("must not continue")],
    );
    let approvalCalls = 0;
    await bindApproval(failed.runtime, () => { approvalCalls += 1; return Promise.resolve(true); });
    await failed.runtime.session.prompt("preflight fails");
    expect(failedExecutions).toBe(0);
    expect(approvalCalls).toBe(0);
    expect(assistantCount(failed.runtime)).toBe(1);
  });

  it("applies coding policy to host-provided write tools", async () => {
    let executions = 0;
    const harness = await createHarness(
      [tool("write", () => { executions += 1; })],
      [toolMessage("write", { path: "never-written.txt" })],
    );
    const requests: ToolApprovalRequest[] = [];
    await bindApproval(harness.runtime, (request) => { requests.push(request); return Promise.resolve(false); });

    await harness.runtime.session.prompt("write");

    expect(executions).toBe(0);
    expect(requests).toMatchObject([{ toolName: "write", title: "Approve write" }]);
    expect(assistantCount(harness.runtime)).toBe(1);
  });

});

type HarnessResponse = AssistantMessage | ((context: unknown) => AssistantMessage);

async function createHarness(
  tools: ToolDefinition[],
  responses: HarnessResponse[],
  options: { builtinTools?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "livepeer-shell-approval-"));
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const model = harnessModel();
  let responseIndex = 0;
  const provider = harnessProvider(model, (context) => {
    const response = responses[responseIndex++] ?? textMessage("unexpected continuation");
    return typeof response === "function" ? response(context) : response;
  });
  const credentials = new MemoryCredentialStore({
    harness: { type: "api_key", key: "test-only" },
  });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider);
  const settingsManager = SettingsManager.inMemory({ quietStartup: true });
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: root,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
        model,
        customTools: tools,
        ...(options.builtinTools ? {} : { noTools: "builtin" as const }),
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: root,
    sessionManager: SessionManager.inMemory(cwd),
  });
  cleanup.push(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  return { runtime };
}

function tool(
  name: string,
  execute: () => void,
  approval?: ToolDefinition["approval"],
): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    ...(approval ? { approval } : {}),
    execute() {
      execute();
      return Promise.resolve({ content: [{ type: "text", text: `${name} complete` }], details: undefined });
    },
  };
}

function harnessModel(): Model<Api> {
  return {
    id: "approval-model",
    name: "Approval Model",
    api: "test-api",
    provider: "harness",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
}

function harnessProvider(model: Model<Api>, next: (context: unknown) => AssistantMessage): Provider {
  const respond = (_model: Model<Api>, context: unknown) => {
    const message = next(context);
    const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Incomplete event cannot finish a stream.");
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    });
    return stream;
  };
  const provider: Provider = {
    id: "harness",
    name: "Harness",
    auth: { apiKey: { name: "Harness", resolve: () => Promise.resolve({ auth: { apiKey: "test-only" } }) } },
    getModels: () => [model],
    stream: respond,
    streamSimple: respond,
  };
  return provider;
}

function toolMessage(name: string, args: Record<string, unknown>): AssistantMessage {
  return message([{ type: "toolCall", id: `${name}-call`, name, arguments: args }], "toolUse");
}

function textMessage(text: string): AssistantMessage {
  return message([{ type: "text", text }], "stop");
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "harness",
    model: "approval-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

type ApprovalHandler = (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<boolean>;

async function bindApproval(runtime: AgentSessionRuntime, handler: ApprovalHandler): Promise<void> {
  await runtime.session.bindExtensions({ toolApprovalHandler: handler });
}

function assistantCount(runtime: AgentSessionRuntime): number {
  return runtime.session.messages.filter(({ role }) => role === "assistant").length;
}

class MemoryCredentialStore implements CredentialStore {
  private readonly values: Map<string, Credential>;
  constructor(initial: Readonly<Record<string, Credential>>) { this.values = new Map(Object.entries(initial)); }
  read(providerId: string): Promise<Credential | undefined> { return Promise.resolve(this.values.get(providerId)); }
  list(): Promise<readonly CredentialInfo[]> {
    return Promise.resolve([...this.values].map(([providerId, credential]) => ({ providerId, type: credential.type })));
  }
  async modify(providerId: string, update: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const next = await update(this.values.get(providerId));
    if (next) this.values.set(providerId, next);
    return next ?? this.values.get(providerId);
  }
  delete(providerId: string): Promise<void> { this.values.delete(providerId); return Promise.resolve(); }
}

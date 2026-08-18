import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type OAuthAuth,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type InteractiveModeOptions,
} from "@livepeer/pi-coding-agent";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const XtermTerminal = xterm.Terminal;
const originalPath = process.env.PATH;
const originalOffline = process.env.LIVEPEER_OFFLINE;
const temporaryPaths: string[] = [];

beforeEach(async () => {
  process.env.LIVEPEER_OFFLINE = "1";
  const tools = await mkdtemp(join(tmpdir(), "livepeer-shell-tools-"));
  temporaryPaths.push(tools);
  for (const name of ["fd", "rg"]) {
    const path = join(tools, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
  process.env.PATH = `${tools}:${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalOffline === undefined) delete process.env.LIVEPEER_OFFLINE;
  else process.env.LIVEPEER_OFFLINE = originalOffline;
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("owned Livepeer shell lifecycle", () => {
  for (const [width, oauthMode] of [[56, "browser"], [80, "device"], [120, "manual"]] as const) {
    it(`completes ${oauthMode} OAuth and reusable streamed turns at ${width} columns`, async () => {
      const harness = await createHarness({ width, oauthMode });
      const exit = mockProcessExit();
      await harness.mode.init();
      void harness.mode.run();
      await new Promise((resolve) => setTimeout(resolve, 100));

      await harness.terminal.waitForText("text-to-image models");
      expect(harness.terminal.transcript()).toContain("text-to-image models");
      harness.terminal.submit("/login harness");
      await waitFor(() => harness.oauthEvents.length === 1);
      if (oauthMode === "manual") {
        await harness.terminal.waitForText("Paste the callback code");
        harness.terminal.submit("callback-code");
      }
      await harness.terminal.waitForText("Logged in to Harness OAuth");

      harness.terminal.submit("first turn");
      await harness.terminal.waitForText("STREAMED_RESPONSE_1");
      harness.terminal.submit("second turn");
      await harness.terminal.waitForText("STREAMED_RESPONSE_2");

      const screen = harness.terminal.lines();
      expect(screen.every((line) => [...line].length <= width)).toBe(true);
      expect(harness.terminal.transcript()).not.toMatch(/\bearendil\b|\bpi\b|\.pi(?:\/|\b)|pi\.dev/iu);
      expect(harness.oauthEvents).toContain(oauthMode);

      harness.terminal.sendInput("\u0004");
      await waitFor(() => exit.mock.calls.length === 1);
      expect(exit).toHaveBeenCalledWith(0);
    });
  }

  it("cancels an active turn with Ctrl-C and accepts another prompt", async () => {
    const harness = await createHarness({ width: 80, oauthMode: "browser", initiallyAuthenticated: true });
    const exit = mockProcessExit();
    await harness.mode.init();
    void harness.mode.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await harness.terminal.waitForText("text-to-image models");

    harness.terminal.submit("slow turn");
    try {
      await waitFor(() => harness.streamCalls === 1);
    } catch {
      throw new Error(`Model stream was not invoked. Output:\n${harness.terminal.transcript().slice(-2_000)}`);
    }
    harness.terminal.sendInput("\u0003");
    await waitFor(() => harness.abortedStreams === 1);
    harness.terminal.submit("after cancel");
    await harness.terminal.waitForText("STREAMED_RESPONSE_2");

    harness.terminal.sendInput("\u0004");
    await waitFor(() => exit.mock.calls.length === 1);
  });

  it("starts fresh by default and restores only when resume is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "livepeer-shell-session-"));
    temporaryPaths.push(root);
    const credentials = new MemoryCredentialStore({
      harness: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
    });

    const first = await createHarness({ width: 80, oauthMode: "browser", root, credentials, initiallyAuthenticated: true });
    let exit = mockProcessExit();
    await first.mode.init();
    void first.mode.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.terminal.waitForText("text-to-image models");
    first.terminal.submit("persist this turn");
    await first.terminal.waitForText("STREAMED_RESPONSE_1");
    first.terminal.sendInput("\u0004");
    await waitFor(() => exit.mock.calls.length === 1);
    vi.restoreAllMocks();

    const fresh = await createHarness({ width: 80, oauthMode: "browser", root, credentials, initiallyAuthenticated: true });
    exit = mockProcessExit();
    await fresh.mode.init();
    void fresh.mode.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fresh.terminal.waitForText("text-to-image models");
    expect(fresh.terminal.text()).not.toContain("persist this turn");
    fresh.terminal.sendInput("\u0004");
    await waitFor(() => exit.mock.calls.length === 1);
    vi.restoreAllMocks();

    const resumed = await createHarness({ width: 80, oauthMode: "browser", root, credentials, initiallyAuthenticated: true, resume: true });
    exit = mockProcessExit();
    await resumed.mode.init();
    void resumed.mode.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await resumed.terminal.waitForText("persist this turn");
    expect(resumed.terminal.text()).toContain("STREAMED_RESPONSE_1");
    resumed.terminal.sendInput("\u0004");
    await waitFor(() => exit.mock.calls.length === 1);
  });
});

type OAuthMode = "browser" | "device" | "manual";

interface HarnessOptions {
  width: number;
  oauthMode: OAuthMode;
  root?: string;
  credentials?: MemoryCredentialStore;
  initiallyAuthenticated?: boolean;
  resume?: boolean;
}

async function createHarness(options: HarnessOptions) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "livepeer-shell-acceptance-"));
  if (!options.root) temporaryPaths.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "config");
  const sessionDirectory = join(agentDir, "sessions", "v2");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDirectory, { recursive: true })]);
  const credentials = options.credentials ?? new MemoryCredentialStore(options.initiallyAuthenticated ? {
    harness: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
  } : {});
  const oauthEvents: string[] = [];
  let streamCalls = 0;
  let abortedStreams = 0;
  const provider = createHarnessProvider(options.oauthMode, oauthEvents, () => ++streamCalls, () => ++abortedStreams);
  const sessionManager = options.resume
    ? SessionManager.continueRecent(cwd, sessionDirectory)
    : SessionManager.create(cwd, sessionDirectory);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager: runtimeSessionManager,
    sessionStartEvent,
  }) => {
    const settingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir);
    settingsManager.setTuiMode("regular");
    settingsManager.setQuietStartup(false);
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(provider);
    const model = modelRuntime.getModel("harness", "harness-model");
    if (!model) throw new Error("Harness model registration failed.");
    const resourceLoader = new DefaultResourceLoader({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "You are a test-only Livepeer shell.",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: runtimeSessionManager,
      model,
      noTools: "all",
      ...(sessionStartEvent ? { sessionStartEvent } : {}),
    });
    return {
      ...created,
      services: { cwd: runtimeCwd, agentDir: runtimeAgentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] },
      diagnostics: [],
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
  const terminal = new HarnessTerminal(options.width, 80);
  const modeOptions = { terminal, verbose: true, tuiMode: "regular" } as InteractiveModeOptions & { terminal: HarnessTerminal };
  const mode = new InteractiveMode(runtime, modeOptions);
  return {
    mode,
    terminal,
    oauthEvents,
    get streamCalls() { return streamCalls; },
    get abortedStreams() { return abortedStreams; },
  };
}

function createHarnessProvider(
  oauthMode: OAuthMode,
  events: string[],
  onStream: () => number,
  onAbort: () => number,
): Provider {
  const model: Model<Api> = {
    id: "harness-model",
    name: "Harness Model",
    api: "test-api",
    provider: "harness",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
  const oauth: OAuthAuth = {
    name: "Harness OAuth",
    login: async (interaction) => {
      if (oauthMode === "browser") {
        events.push("browser");
        interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize" });
      } else if (oauthMode === "device") {
        events.push("device");
        interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://auth.example.test/device" });
      } else {
        events.push("manual");
        await interaction.prompt({ type: "manual_code", message: "Paste the callback code" });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
    },
    refresh: (credential) => Promise.resolve(credential),
    toAuth: () => Promise.resolve({ apiKey: "access" }),
  };
  const respond = (_model: Model<Api>, _context: unknown, streamOptions?: SimpleStreamOptions) => {
    const call = onStream();
    const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Incomplete model event cannot finish a stream.");
      },
    );
    const message = assistantMessage(model, `STREAMED_RESPONSE_${call}`);
    const delay = call === 1 && streamOptions?.signal ? 300 : 20;
    const timer = setTimeout(() => emitMessage(stream, message), delay);
    streamOptions?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      onAbort();
      const aborted = { ...message, content: [], stopReason: "aborted" as const, errorMessage: "cancelled" };
      stream.push({ type: "error", reason: "aborted", error: aborted });
    }, { once: true });
    return stream;
  };
  return {
    id: "harness",
    name: "Harness OAuth",
    auth: { oauth },
    getModels: () => [model],
    stream: respond,
    streamSimple: respond,
  } as Provider;
}

function assistantMessage(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emitMessage(stream: EventStream<AssistantMessageEvent, AssistantMessage>, message: AssistantMessage): void {
  const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial });
  partial.content = [{ type: "text", text: "" }];
  stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
  const text = message.content[0]?.type === "text" ? message.content[0].text : "";
  for (const delta of text.match(/.{1,5}/gu) ?? []) {
    const block = partial.content[0];
    if (block?.type === "text") block.text += delta;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
  }
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: { ...partial } });
  stream.push({ type: "done", reason: "stop", message });
}

class MemoryCredentialStore implements CredentialStore {
  private readonly values: Map<string, Credential>;
  constructor(initial: Readonly<Record<string, Credential>> = {}) { this.values = new Map(Object.entries(initial)); }
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

class HarnessTerminal {
  private readonly xterm;
  private readonly output: string[] = [];
  private input: ((data: string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;
  constructor(readonly columns: number, readonly rows: number) {
    this.xterm = new XtermTerminal({ cols: columns, rows, allowProposedApi: true });
  }
  start(onInput: (data: string) => void, onResize: () => void): void { this.input = onInput; this.resizeHandler = onResize; }
  stop(): void { this.input = undefined; this.resizeHandler = undefined; }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.output.push(data); this.xterm.write(data); }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(lines: number): void { if (lines) this.write(`\u001b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor(): void { this.write("\u001b[?25l"); }
  showCursor(): void { this.write("\u001b[?25h"); }
  clearLine(): void { this.write("\u001b[K"); }
  clearFromCursor(): void { this.write("\u001b[J"); }
  clearScreen(): void { this.write("\u001b[2J\u001b[H"); }
  setTitle(title: string): void { this.write(`\u001b]0;${title}\u0007`); }
  setProgress(): void {}
  sendInput(data: string): void { this.input?.(data); }
  submit(text: string): void { this.sendInput(text); this.sendInput("\r"); }
  async flush(): Promise<void> { await new Promise<void>((resolve) => this.xterm.write("", resolve)); }
  lines(): string[] {
    const lines: string[] = [];
    for (let index = 0; index < this.xterm.buffer.active.length; index += 1) {
      lines.push(this.xterm.buffer.active.getLine(index)?.translateToString(true) ?? "");
    }
    return lines;
  }
  text(): string { return this.lines().join("\n"); }
  transcript(): string {
    return this.output.join("").replaceAll(String.fromCodePoint(27), "").replaceAll(String.fromCodePoint(7), "");
  }
  async waitForText(text: string): Promise<void> {
    try {
      await waitFor(async () => { await this.flush(); return this.text().includes(text) || this.transcript().includes(text); });
    } catch {
      throw new Error(`Timed out waiting for ${JSON.stringify(text)}. Output:\n${this.transcript().slice(-2_000)}`);
    }
  }
}

function mockProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for owned shell state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

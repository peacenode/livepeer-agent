/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";
import type { CredentialStore, ToolDescriptor, ToolResult, ToolTransport } from "@livepeer-agent/contracts";
import type { CliIO } from "../io/index.js";
import { createOperations } from "../operations/index.js";
import type { ProviderStore } from "../operations/provider-store.js";
import type { ProviderAuthManager } from "../operations/provider-auth.js";
import { runCli, type CliDependencies } from "./program.js";

class FakeTransport implements ToolTransport {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  constructor(readonly tools: ToolDescriptor[], readonly results: Record<string, ToolResult> = {}) {}
  async listTools(): Promise<ToolDescriptor[]> { return this.tools; }
  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> { this.calls.push({ name, input }); return this.results[name] ?? { content: [{ type: "text", text: "ok" }] }; }
  async close(): Promise<void> {}
}

class MemoryCredentials implements CredentialStore {
  constructor(private value?: string) {}
  async get() { return this.value; }
  async set(value: string) { this.value = value; }
  async delete() { this.value = undefined; }
}

function harness(options: { tty?: boolean; stdin?: string; transport?: FakeTransport; environment?: NodeJS.ProcessEnv } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const promptSecret = vi.fn(async () => "daydream-secret");
  const transport = options.transport ?? new FakeTransport([
    { name: "list_capabilities", description: "Catalog", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "create_media", inputSchema: { type: "object" } },
  ], { list_capabilities: { content: [], structuredContent: { capabilities: [{ name: "flux" }] } } });
  const io: CliIO = {
    stdinIsTTY: options.tty ?? false,
    stdoutIsTTY: options.tty ?? false,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    readStdin: async () => options.stdin ?? "{}",
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => "manual-code"),
    promptSecret,
  };
  const providers = new Map<string, string>();
  const providerStore: ProviderStore = {
    add: async (provider, key) => { providers.set(provider, key); },
    remove: async (provider) => { providers.delete(provider); },
    list: async () => (["openai", "anthropic"] as const).map((provider) => ({ provider, configured: providers.has(provider) })),
  };
  const daydreamCredentials = new MemoryCredentials();
  let codexConfigured = false;
  let browserInstalled = false;
  const providerAuth: ProviderAuthManager = {
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://chatgpt.example/authorize" });
      codexConfigured = true;
    },
    logout: async () => { codexConfigured = false; },
    list: async () => [{ provider: "openai-codex", configured: codexConfigured, type: "oauth" }],
  };
  const dependencies: CliDependencies = {
    operations: createOperations(transport), daydreamCredentials, providers: providerStore, providerAuth,
    browser: {
      status: async () => ({
        installed: browserInstalled,
        cliInstalled: browserInstalled,
        browserInstalled,
        version: "test",
        root: "/config/livepeer/browser",
        ...(!browserInstalled ? { guidance: "Run `livepeer browser install` before using browser tools." } : {}),
      }),
      install: async () => {
        browserInstalled = true;
        return { installed: true, cliInstalled: true, browserInstalled: true, version: "test", root: "/config/livepeer/browser" };
      },
    },
    updater: {
      check: vi.fn(async () => ({ currentVersion: "0.1.0", latestVersion: "0.1.1", updateAvailable: true, updated: false })),
      install: vi.fn(async () => ({ currentVersion: "0.1.0", latestVersion: "0.1.1", updateAvailable: true, updated: true })),
    },
    runAgent: vi.fn(async () => undefined), close: () => transport.close(), environment: options.environment ?? {},
  };
  const run = (args: string[]) => runCli(["node", "livepeer", ...args], dependencies, { io });
  return { run, stdout, stderr, transport, providers, daydreamCredentials, io, promptSecret };
}

describe("deterministic CLI", () => {
  it("checks for and installs terminal releases explicitly", async () => {
    const app = harness();
    expect(await app.run(["update", "--check", "--json"])).toBe(0);
    expect(JSON.parse(app.stdout.at(-1)!)).toMatchObject({ data: { latestVersion: "0.1.1", updateAvailable: true, updated: false } });
    expect(app.stdout.at(-1)).toContain("livepeer update");
    expect(await app.run(["update", "--json"])).toBe(0);
    expect(JSON.parse(app.stdout.at(-1)!)).toMatchObject({ data: { latestVersion: "0.1.1", updated: true } });
    expect(app.stdout.at(-1)).toContain("Restart any open agent");
  });

  it("emits one stable JSON envelope for an authenticated read-only capability request", async () => {
    const app = harness();
    expect(await app.run(["capabilities", "list", "--limit", "5", "--json"])).toBe(0);
    expect(app.stdout).toHaveLength(1);
    expect(JSON.parse(app.stdout[0]!)).toMatchObject({ ok: true, command: "capabilities.list", data: { structuredContent: { capabilities: [{ name: "flux" }] } } });
    expect(app.transport.calls).toEqual([{ name: "list_capabilities", input: { limit: 5 } }]);
  });

  it("reads JSON from stdin and permits annotated read-only tools without --yes", async () => {
    const app = harness({ stdin: "{\"kind\":\"ai\"}" });
    expect(await app.run(["tools", "call", "list_capabilities", "--input", "-", "--json"])).toBe(0);
    expect(app.transport.calls[0]).toEqual({ name: "list_capabilities", input: { kind: "ai" } });
  });

  it("requires --yes for noninteractive mutating commands", async () => {
    const app = harness({ stdin: "{\"prompt\":\"kite\"}" });
    expect(await app.run(["tools", "call", "create_media", "--input", "-", "--json"])).toBe(1);
    expect(JSON.parse(app.stdout[0]!)).toMatchObject({ ok: false, error: { code: "INPUT" } });
    expect(app.transport.calls).toHaveLength(0);
  });

  it("stores provider credentials locally without treating them as Livepeer login", async () => {
    const app = harness();
    expect(await app.run(["provider", "add", "openai", "--api-key", "sk-test-value", "--json"])).toBe(0);
    expect(app.providers.get("openai")).toBe("sk-test-value");
    expect(app.stdout.join("")).not.toContain("sk-test-value");
  });

  it("reports and installs the managed terminal browser explicitly", async () => {
    const app = harness();
    expect(await app.run(["browser", "status", "--json"])).toBe(0);
    expect(JSON.parse(app.stdout.at(-1)!)).toMatchObject({ data: { installed: false, version: "test" } });
    expect(await app.run(["browser", "install", "--json"])).toBe(0);
    expect(JSON.parse(app.stdout.at(-1)!)).toMatchObject({ data: { installed: true, browserInstalled: true } });
  });

  it("stores, reports, and removes a Daydream key without printing it", async () => {
    const app = harness({ tty: true });
    expect(await app.run(["key", "add", "--json"])).toBe(0);
    await expect(app.daydreamCredentials.get()).resolves.toBe("daydream-secret");
    expect(app.stdout.join("")).not.toContain("daydream-secret");
    expect(app.promptSecret).toHaveBeenCalledOnce();

    expect(await app.run(["key", "status", "--json"])).toBe(0);
    expect(JSON.parse(app.stdout.at(-1)!)).toMatchObject({ data: { configured: true, source: "stored" } });
    expect(await app.run(["key", "remove", "--json"])).toBe(0);
    await expect(app.daydreamCredentials.get()).resolves.toBeUndefined();
  });

  it("imports an explicit environment key without returning the raw value", async () => {
    const app = harness({ environment: { DAYDREAM_API_KEY: "environment-secret" } });
    expect(await app.run(["key", "add", "--from-env", "--json"])).toBe(0);
    await expect(app.daydreamCredentials.get()).resolves.toBe("environment-secret");
    expect(app.stdout.join("")).not.toContain("environment-secret");
  });

  it.each([
    {
      name: "keyless preview",
      localKey: false,
      identity: { key_class: "demo", profile: null },
      expected: { state: "keyless_preview", localKeyConfigured: false, credentialApplied: false, profileAttached: false },
    },
    {
      name: "activated keyless profile",
      localKey: false,
      identity: { key_class: "demo", profile: { email: "preview@example.test" } },
      expected: { state: "keyless_profile", localKeyConfigured: false, credentialApplied: false, profileAttached: true, emailAttached: true },
    },
    {
      name: "Daydream key without profile",
      localKey: true,
      identity: { key_class: "daydream", profile: null },
      expected: { state: "daydream_key", localKeyConfigured: true, credentialApplied: true, profileAttached: false },
    },
    {
      name: "Daydream key with profile",
      localKey: true,
      identity: { key_class: "daydream", profile: { email: "creator@example.test" } },
      expected: { state: "daydream_profile", localKeyConfigured: true, credentialApplied: true, profileAttached: true, emailAttached: true },
    },
    {
      name: "configured key not applied",
      localKey: true,
      identity: { key_class: "demo", profile: null },
      expected: { state: "credential_mismatch", localKeyConfigured: true, credentialApplied: false },
    },
  ])("reports effective MCP access for $name without exposing identity values", async ({ localKey, identity, expected }) => {
    const transport = new FakeTransport([], { me: { content: [], structuredContent: identity } });
    const app = harness({ tty: localKey, transport });
    if (localKey) expect(await app.run(["key", "add", "--json"])).toBe(0);
    expect(await app.run(["access", "status", "--json"])).toBe(0);
    const output = JSON.parse(app.stdout.at(-1)!) as { data: Record<string, unknown> };
    expect(output.data).toMatchObject(expected);
    expect(output.data).not.toHaveProperty("email");
    expect(output.data).not.toHaveProperty("principal_id");
    expect(app.transport.calls.at(-1)).toEqual({ name: "me", input: {} });
  });

  it("connects and disconnects ChatGPT through Pi OAuth without exposing credentials", async () => {
    const app = harness();
    expect(await app.run(["provider", "login", "openai-codex", "--json"])).toBe(0);
    expect(app.stderr.join(" ")).toContain("https://chatgpt.example/authorize");
    expect(app.stdout.join(" ")).not.toContain("manual-code");
    expect(await app.run(["provider", "list", "--json"])).toBe(0);
    expect((JSON.parse(app.stdout.at(-1)!) as { data: unknown[] }).data[0]).toEqual({ provider: "openai-codex", configured: true, type: "oauth" });
    expect(await app.run(["provider", "logout", "openai-codex", "--json"])).toBe(0);
  });

  it("does not retain an unbounded server summary when structured capabilities exist", async () => {
    const transport = new FakeTransport([], {
      list_capabilities: {
        content: [{ type: "text", text: "UNBOUNDED SERVER CATALOG" }],
        structuredContent: { total: 3, capabilities: [{ name: "one" }, { name: "two" }, { name: "three" }] },
      },
    });
    const app = harness({ transport });
    expect(await app.run(["capabilities", "list", "--limit", "2", "--json"])).toBe(0);
    const result = JSON.parse(app.stdout[0]!) as unknown as { data: { structuredContent: { capabilities: unknown[] } } };
    expect(result.data.structuredContent.capabilities).toHaveLength(2);
    expect(app.stdout[0]).not.toContain("UNBOUNDED SERVER CATALOG");
  });

  it("maps remote, auth, and cancellation failures to stable exit codes", async () => {
    const remote = harness({ transport: new FakeTransport([], { broken: { content: [{ type: "text", text: "No capacity" }], isError: true } }) });
    expect(await remote.run(["tools", "call", "broken", "--input", "-", "--yes", "--json"])).toBe(3);
    const auth = harness({ transport: new FakeTransport([], { broken: { content: [{ type: "text", text: "Authentication required" }], structuredContent: { status: 401 }, isError: true } }) });
    expect(await auth.run(["tools", "call", "broken", "--input", "-", "--yes", "--json"])).toBe(2);
  });
});

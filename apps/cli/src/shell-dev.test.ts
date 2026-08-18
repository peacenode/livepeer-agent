import type { Credential, CredentialInfo, CredentialStore as ModelCredentialStore, Models } from "@earendil-works/pi-ai";
import { FakeCredentialStore, FakeToolTransport } from "@livepeer-agent/contracts/testing";
import type { LivepeerInteractiveOptions } from "@livepeer-agent/terminal-host";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAuthManager } from "./operations/provider-auth.js";
import { createSharedModelRuntime, routeAgentShell, type AgentShellRouteOptions } from "./shell-dev.js";

describe("forked shell production route", () => {
  it.each([false, true])("passes the exact shared credential store and resume=%s to the forked shell", async (resume) => {
    const harness = createHarness({ XDG_CONFIG_HOME: "/tmp/livepeer-shell-test-config" }, resume);
    await expect(routeAgentShell(harness.options)).resolves.toBe("forked");

    expect(harness.createShellAdapter).toHaveBeenCalledOnce();
    expect(harness.runInteractive).toHaveBeenCalledOnce();
    const launch = harness.runInteractive.mock.calls[0]?.[0];
    expect(launch).toMatchObject({
      cwd: "/workspace/project",
      configRoot: "/tmp/livepeer-shell-test-config/livepeer",
      resume,
      shell: harness.shell,
    });
    expect(launch?.services.modelCredentials).toBe(harness.modelCredentials);
    await expect(launch?.services.execution.describeOperations()).resolves.toEqual([
      expect.objectContaining({ name: "capabilities_list" }),
    ]);
  });

  it("creates one credential store and gives that same instance to the model registry", () => {
    const modelCredentials = createModelCredentialStore();
    const models = createModels();
    const createModelCredentials = vi.fn(() => modelCredentials);
    const createProviderModels = vi.fn((received: ModelCredentialStore) => {
      expect(received).toBe(modelCredentials);
      return models;
    });

    const shared = createSharedModelRuntime({ createModelCredentials, createModels: createProviderModels });
    expect(createModelCredentials).toHaveBeenCalledOnce();
    expect(createProviderModels).toHaveBeenCalledOnce();
    expect(shared).toEqual({ modelCredentials, models });
  });
});

function createHarness(environment: NodeJS.ProcessEnv, resume = false) {
  const modelCredentials = createModelCredentialStore();
  const shell = { run: vi.fn(() => Promise.resolve()) };
  const runInteractive = vi.fn<(options: LivepeerInteractiveOptions) => Promise<void>>(() => Promise.resolve());
  const createShellAdapter = vi.fn(() => shell);
  const transport = new FakeToolTransport();
  const providerAuth: ProviderAuthManager = {
    list: () => Promise.resolve([{ provider: "openai-codex", configured: true, type: "oauth" }]),
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
  };
  const options: AgentShellRouteOptions = {
    environment,
    resume,
    cwd: "/workspace/project",
    modelCredentials,
    models: createModels(),
    providerAuth,
    livepeerCredentials: new FakeCredentialStore(),
    transport,
    runInteractive,
    createShellAdapter,
  };
  return { options, modelCredentials, shell, runInteractive, createShellAdapter };
}

function createModelCredentialStore(): ModelCredentialStore {
  const values = new Map<string, Credential>();
  return {
    read: (providerId) => Promise.resolve(values.get(providerId)),
    list: (): Promise<readonly CredentialInfo[]> => Promise.resolve([...values].map(([providerId, credential]) => ({ providerId, type: credential.type }))),
    modify: async (providerId, update) => {
      const next = await update(values.get(providerId));
      if (next) values.set(providerId, next);
      return next ?? values.get(providerId);
    },
    delete: (providerId) => { values.delete(providerId); return Promise.resolve(); },
  };
}

function createModels(): Models {
  return {
    getModels: () => [],
    getModel: () => undefined,
  } as unknown as Models;
}

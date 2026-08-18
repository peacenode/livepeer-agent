import { describe, expect, it } from "vitest";
import {
  createFakeCredentialStore,
  createFakeExecutionClient,
  createFakeLivepeerAccess,
  createFakeModelCredentialStore,
  createFakeModelPort,
  createFakeOAuthPort,
  createFakeToolTransport,
} from "./index.js";

describe("terminal-host fixtures", () => {
  it("provides stateful credential, model, OAuth, and Livepeer key ports", async () => {
    const credential = createFakeCredentialStore();
    await credential.set("token");
    expect(await credential.get()).toBe("token");

    const modelCredential = createFakeModelCredentialStore();
    await modelCredential.modify("openai-codex", () => Promise.resolve({
      type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000,
    }));
    expect(await modelCredential.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);

    const models = createFakeModelPort();
    await models.select({ provider: "openai-codex", model: "gpt-test" });
    expect(models.current()).toEqual({ provider: "openai-codex", model: "gpt-test" });

    const oauth = createFakeOAuthPort();
    await oauth.login("openai-codex", { prompt: () => Promise.resolve("code"), notify: () => undefined });
    expect(await oauth.list()).toContainEqual({ provider: "openai-codex", configured: true });

    const access = createFakeLivepeerAccess();
    await access.credentials.set("daydream-key");
    expect(await access.credentials.get()).toBe("daydream-key");
  });

  it("provides transport and execution-client fixtures", async () => {
    const descriptor = { name: "list_capabilities", inputSchema: { type: "object" } };
    const transport = createFakeToolTransport([descriptor]);
    expect(await transport.listTools()).toEqual([descriptor]);
    await transport.callTool(descriptor.name, { limit: 3 });
    expect(transport.calls).toEqual([{ name: descriptor.name, input: { limit: 3 } }]);

    const execution = createFakeExecutionClient([descriptor]);
    expect(await execution.describeOperations()).toEqual([descriptor]);
    await execution.capabilities.list({ limit: 3 });
    expect(execution.calls).toEqual([{ name: descriptor.name, input: { limit: 3 } }]);
  });
});

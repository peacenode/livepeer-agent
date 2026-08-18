import type { ToolTransport } from "@livepeer-agent/contracts";
import { FakeCredentialStore, FakeToolTransport } from "@livepeer-agent/contracts/testing";
import { describe, expect, it, vi } from "vitest";
import { createAgentTransport, createLazyTransport, verifyAgentCredential } from "./index.js";

describe("reloadable terminal transport", () => {
  it("constructs the interactive agent transport directly from the resolved key", async () => {
    const daydreamCredentials = new FakeCredentialStore("stored-bearer");
    const anonymous = vi.fn((): ToolTransport => new FakeToolTransport());
    const directBearer = vi.fn((): ToolTransport => new FakeToolTransport());

    await createAgentTransport(
      "https://agent.livepeer.org/api/mcp",
      "environment-bearer",
      daydreamCredentials,
      { anonymous, directBearer },
    );

    expect(directBearer).toHaveBeenCalledWith("https://agent.livepeer.org/api/mcp", "stored-bearer");
    expect(anonymous).not.toHaveBeenCalled();
  });

  it("preflights the configured key and rejects a silent demo downgrade", async () => {
    const authenticated = new FakeToolTransport([], {
      me: { content: [], structuredContent: { key_class: "daydream", principal_id: "principal" } },
    });
    await expect(verifyAgentCredential(authenticated, true)).resolves.toBeUndefined();
    expect(authenticated.calls).toEqual([{ name: "me", input: {} }]);

    const downgraded = new FakeToolTransport([], {
      me: { content: [], structuredContent: { key_class: "demo", principal_id: "anonymous" } },
    });
    await expect(verifyAgentCredential(downgraded, true)).rejects.toMatchObject({
      code: "daydream_key_not_applied",
      exitCode: 2,
    });
  });

  it("uses anonymous MCP access when no Daydream key is configured", async () => {
    const anonymous = vi.fn((): ToolTransport => new FakeToolTransport([
      { name: "list_capabilities", inputSchema: { type: "object" } },
    ]));
    const directBearer = vi.fn((): ToolTransport => new FakeToolTransport());
    const transport = createLazyTransport("https://agent.livepeer.org/api/mcp", {
      anonymous,
      directBearer,
    });

    await expect(transport.accessTier()).resolves.toBe("anonymous");
    await expect(transport.listTools()).resolves.toHaveLength(1);
    expect(anonymous).toHaveBeenCalledWith("https://agent.livepeer.org/api/mcp");
    expect(directBearer).not.toHaveBeenCalled();
  });

  it("prefers a stored Daydream key over the environment fallback", async () => {
    const daydreamCredentials = new FakeCredentialStore("stored-bearer");
    const directBearer = vi.fn((): ToolTransport => new FakeToolTransport());
    const transport = createLazyTransport(
      "https://agent.livepeer.org/api/mcp",
      {
        anonymous: vi.fn((): ToolTransport => new FakeToolTransport()),
        directBearer,
      },
      "environment-bearer",
      daydreamCredentials,
    );

    await expect(transport.accessTier()).resolves.toBe("authenticated");
    await transport.listTools();
    expect(directBearer).toHaveBeenCalledWith("https://agent.livepeer.org/api/mcp", "stored-bearer");
  });

  it("fails closed before forwarding a Daydream key to an endpoint override", async () => {
    const secret = "never-render-this-key";
    const directBearer = vi.fn((): ToolTransport => new FakeToolTransport());
    const transport = createLazyTransport(
      "https://override.test/mcp",
      {
        anonymous: vi.fn((): ToolTransport => new FakeToolTransport()),
        directBearer,
      },
      secret,
    );

    await expect(transport.listTools()).rejects.toMatchObject({ code: "unsafe_daydream_endpoint" });
    await expect(transport.accessTier()).rejects.toThrow("default Livepeer MCP endpoint");
    expect(directBearer).not.toHaveBeenCalled();
    expect(JSON.stringify(transport)).not.toContain(secret);
  });
});

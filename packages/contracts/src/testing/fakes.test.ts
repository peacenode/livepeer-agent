import { describe, expect, it } from "vitest";
import { FakeCredentialStore, FakeToolTransport } from "./index.js";

describe("foundation fakes", () => {
  it("stores an isolated Daydream credential", async () => {
    const credentials = new FakeCredentialStore();
    await credentials.set("fake-daydream-key");
    await expect(credentials.get()).resolves.toBe("fake-daydream-key");
  });

  it("records fake MCP calls without external requests", async () => {
    const transport = new FakeToolTransport();
    const tools = await transport.listTools();
    const result = await transport.callTool(tools[0]!.name, { limit: 5 });
    expect(transport.calls).toEqual([{ name: "capabilities_list", input: { limit: 5 } }]);
    expect(result.isError).not.toBe(true);
  });
});

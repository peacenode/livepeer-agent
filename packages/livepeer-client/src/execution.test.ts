import { FakeToolTransport } from "@livepeer-agent/contracts/testing";
import { describe, expect, it } from "vitest";
import { createMcpLivepeerExecutionClient } from "./execution.js";

describe("Livepeer execution client", () => {
  it("maps domain operations onto the current MCP adapter", async () => {
    const transport = new FakeToolTransport();
    const client = createMcpLivepeerExecutionClient(transport);

    await client.capabilities.list({ kind: "ai", limit: 20 });
    await client.profile.get();
    await client.media.create({ action: "generate", model_override: "flux-dev" });
    await client.projects.generate({ title: "Two scenes", scenes: [] });

    expect(transport.calls).toEqual([
      { name: "list_capabilities", input: { kind: "ai", limit: 20 } },
      { name: "me", input: {} },
      { name: "create_media", input: { action: "generate", model_override: "flux-dev" } },
      { name: "generate_project", input: { title: "Two scenes", scenes: [] } },
    ]);
  });

  it("has no domain operation that can delegate reasoning to Storyboard", () => {
    const client = createMcpLivepeerExecutionClient(new FakeToolTransport());
    const serializedSurface = JSON.stringify(Object.keys(client));

    expect(serializedSurface).not.toContain("submit_agent_task");
    expect(serializedSurface).not.toContain("submit_creative_job");
    expect(serializedSurface).not.toContain("auto_plan");
  });
});

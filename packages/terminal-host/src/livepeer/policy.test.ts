import { describe, expect, it } from "vitest";
import { descriptor, routedCatalog } from "./fixtures.test-support.js";
import { buildRoutes } from "./policy.js";

describe("Livepeer routed-tool policy", () => {
  it("exposes only the exact anonymous names and preserves approval policy", () => {
    const extra = [
      descriptor("fal_generate", { properties: {} }),
      descriptor("create_media_v2", { properties: {} }),
      descriptor("admin_list_users", { properties: {} }),
    ];
    const built = buildRoutes(routedCatalog(extra), "anonymous");
    expect(built.routes.map(({ name }) => name)).toEqual([
      "list_capabilities", "get_pricing", "me", "request_activation", "activate", "upload", "create_media", "generate_project",
    ]);
    expect(Object.fromEntries(built.routes.map(({ name, approval }) => [name, approval]))).toEqual({
      list_capabilities: "automatic",
      get_pricing: "automatic",
      me: "automatic",
      request_activation: "required",
      activate: "required",
      upload: "automatic",
      create_media: "required",
      generate_project: "required",
    });
  });

  it("adds authenticated media and existing-key activation routes without provider tools", () => {
    const built = buildRoutes(routedCatalog([
      descriptor("operator_delete", { properties: {} }),
      descriptor("submit_creative_job", { properties: { auto_plan: { type: "boolean" } } }),
      descriptor("submit_agent_task", { properties: { prompt: { type: "string" } } }),
    ]), "authenticated");
    expect(built.routes.map(({ name }) => name)).toEqual([
      "list_capabilities", "describe_capability", "get_pricing", "me", "me_update",
      "request_activation", "activate", "upload", "create_media", "get_create_media", "generate_project",
      "get_creative_job", "subscribe_progress",
    ]);
    const names = built.routes.map(({ name }) => String(name));
    expect(names).not.toContain("submit_creative_job");
    expect(names).not.toContain("submit_agent_task");
  });

  it("fails closed when a known tool's schema drifts", () => {
    const catalog = routedCatalog().map((tool) => tool.name === "create_media"
      ? { ...tool, inputSchema: { type: "object", required: ["provider"], properties: { provider: { type: "string" } } } }
      : tool);
    const built = buildRoutes(catalog, "anonymous");
    expect(built.routes.some(({ name }) => name === "create_media")).toBe(false);
    expect(built.diagnostics).toContainEqual(expect.objectContaining({ tool: "create_media", code: "incompatible_schema" }));
  });
});

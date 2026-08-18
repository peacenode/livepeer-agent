import { describe, expect, it, vi } from "vitest";
import type { BrowserAutomation } from "./automation.js";
import { createBrowserToolDefinitions } from "./tools.js";

function fakeBrowser(): BrowserAutomation {
  return {
    open: vi.fn(() => Promise.resolve({ text: '- heading "Page"', session: "livepeer-test" })),
    snapshot: vi.fn(() => Promise.resolve({ text: '- button "Submit" [ref=e3]', session: "livepeer-test" })),
    act: vi.fn(() => Promise.resolve({ text: '- text: "Saved"', session: "livepeer-test" })),
    screenshot: vi.fn(() => Promise.resolve({ data: "aW1hZ2U=", mimeType: "image/png" as const, path: "/tmp/page.png", session: "livepeer-test" })),
    closeSession: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

describe("browser tool definitions", () => {
  it("exposes a compact native browser surface with prompt routing", () => {
    const definitions = createBrowserToolDefinitions(fakeBrowser());
    expect(definitions.map(({ name }) => name)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_action",
      "browser_screenshot",
      "browser_close",
    ]);
    expect(definitions[0]?.promptGuidelines?.join(" ")).toContain("do not scrape websites with bash");
  });

  it("requires host approval for webpage mutations but not read-only movement", async () => {
    const action = createBrowserToolDefinitions(fakeBrowser()).find(({ name }) => name === "browser_action")!;
    expect(await action.approval?.("call", { action: "hover", ref: "e2" })).toBeUndefined();
    expect(await action.approval?.("call", { action: "click", ref: "e2" })).toMatchObject({
      title: "Approve browser interaction",
    });
    expect(await action.approval?.("call", { action: "fill", ref: "e2", value: "secret" })).toMatchObject({
      message: expect.stringContaining("6 characters") as string,
    });
  });

  it("executes against the current Pi session and returns the fresh snapshot", async () => {
    const act = vi.fn(() => Promise.resolve({ text: '- text: "Saved"', session: "livepeer-test" }));
    const browser: BrowserAutomation = { ...fakeBrowser(), act };
    const action = createBrowserToolDefinitions(browser).find(({ name }) => name === "browser_action")!;
    const result = await action.execute(
      "call",
      { action: "fill", ref: "e3", value: "hello" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-id" } } as never,
    );
    expect(act).toHaveBeenCalledWith("session-id", { action: "fill", ref: "e3", value: "hello" }, undefined);
    expect(result.content).toEqual([{ type: "text", text: '- text: "Saved"' }]);
  });

  it("registers screenshots as host-created local images", async () => {
    const onScreenshot = vi.fn();
    const screenshot = createBrowserToolDefinitions(fakeBrowser(), { onScreenshot })
      .find(({ name }) => name === "browser_screenshot")!;

    await screenshot.execute(
      "call",
      {},
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-id" } } as never,
    );

    expect(onScreenshot).toHaveBeenCalledWith("/tmp/page.png");
  });
});

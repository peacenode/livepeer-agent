import { describe, expect, it, vi } from "vitest";
import type { Models } from "@earendil-works/pi-ai";
import { PiProviderAuthManager } from "./provider-auth.js";

describe("Pi provider auth manager", () => {
  it("delegates login, status, and logout to Pi without exposing the credential", async () => {
    const login = vi.fn(() => Promise.resolve({ type: "oauth" as const, access: "secret", refresh: "refresh", expires: 1 }));
    const logout = vi.fn(() => Promise.resolve(undefined));
    const checkAuth = vi.fn(() => Promise.resolve({ type: "oauth" as const, source: "OAuth" }));
    const models = { login, logout, checkAuth } as unknown as Models;
    const manager = new PiProviderAuthManager(models);
    const interaction = { prompt: vi.fn(() => Promise.resolve("")), notify: vi.fn() };

    await manager.login("openai-codex", interaction);
    expect(login).toHaveBeenCalledWith("openai-codex", "oauth", interaction);
    expect(await manager.list()).toEqual([{ provider: "openai-codex", configured: true, type: "oauth" }]);
    await manager.logout("openai-codex");
    expect(logout).toHaveBeenCalledWith("openai-codex", undefined);
  });
});

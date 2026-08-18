import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "./file-credential-store.js";
import { MacOsKeychainCredentialStore, type ProcessExecutor } from "./keychain-credential-store.js";
import { createCredentialStore } from "./index.js";

describe("credential stores", () => {
  it("writes fallback credentials with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "livepeer-credentials-"));
    const path = join(root, "config", "credentials.json");
    const store = new FileCredentialStore(path);
    await store.set("file-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(store.get()).resolves.toBe("file-secret");
    await chmod(path, 0o644);
    await store.set("new-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await store.delete();
    await expect(store.get()).resolves.toBeUndefined();
  });

  it("uses keychain argument arrays without a shell", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProcessExecutor = (command, args) => {
      calls.push({ command, args });
      return Promise.resolve({ exitCode: 0, stdout: args[0] === "find-generic-password" ? "keychain-secret\n" : "", stderr: "" });
    };
    const store = new MacOsKeychainCredentialStore("service", "account", executor);
    await store.set("token; $(unsafe)");
    await expect(store.get()).resolves.toBe("keychain-secret");
    expect(calls[0]).toEqual({
      command: "security",
      args: ["add-generic-password", "-s", "service", "-a", "account", "-w", "token; $(unsafe)", "-U"],
    });
  });

  it("warns and falls back when keychain is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "livepeer-fallback-"));
    const warn = vi.fn();
    const keychain = { get: vi.fn().mockRejectedValue(new Error("unavailable")), set: vi.fn(), delete: vi.fn() };
    const store = createCredentialStore({ platform: "darwin", homeDirectory: root, environment: {}, warn, keychain });
    await expect(store.get()).resolves.toBeUndefined();
    await store.set("fallback-secret");
    await expect(store.get()).resolves.toBe("fallback-secret");
    expect(warn).toHaveBeenCalledOnce();
  });
});

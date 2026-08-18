import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeCredentialStore } from "@livepeer-agent/contracts/testing";
import { createProviderStore, FileProviderStore } from "./provider-store.js";

describe("provider credential storage", () => {
  it("stores each provider in its own system credential entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "livepeer-provider-keychain-"));
    const openai = new FakeCredentialStore();
    const anthropic = new FakeCredentialStore();
    const store = createProviderStore({
      platform: "darwin",
      homeDirectory: root,
      environment: {},
      keychains: { openai, anthropic },
    });

    await store.add("openai", "sk-openai-secret");
    await store.add("anthropic", "sk-anthropic-secret");

    expect(await openai.get()).toBe("sk-openai-secret");
    expect(await anthropic.get()).toBe("sk-anthropic-secret");
    expect(await store.list()).toEqual([
      { provider: "openai", configured: true },
      { provider: "anthropic", configured: true },
    ]);
  });

  it("migrates the legacy providers file and removes the migrated secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "livepeer-provider-migration-"));
    const legacyPath = join(root, "legacy-providers.json");
    const legacy = new FileProviderStore(legacyPath);
    const openai = new FakeCredentialStore();
    await legacy.add("openai", "legacy-secret");
    await legacy.add("anthropic", "keep-until-migrated");
    const store = createProviderStore({
      platform: "darwin",
      homeDirectory: root,
      environment: {},
      keychains: { openai, anthropic: new FakeCredentialStore() },
      legacyPath,
    });

    expect(await store.get("openai")).toBe("legacy-secret");
    expect(await openai.get()).toBe("legacy-secret");
    expect(await readFile(legacyPath, "utf8")).not.toContain("legacy-secret");
    expect(await readFile(legacyPath, "utf8")).toContain("keep-until-migrated");
  });

  it("uses a permission-0600 provider file with a warning when Keychain is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "livepeer-provider-fallback-"));
    const warn = vi.fn();
    const store = createProviderStore({ platform: "linux", homeDirectory: root, environment: {}, warn });
    await store.add("openai", "fallback-secret");

    const path = join(root, ".config", "livepeer", "provider-openai.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.get("openai")).toBe("fallback-secret");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openai provider credential"));
  });
});

import { describe, expect, it } from "vitest";
import { FakeCredentialStore } from "@livepeer-agent/contracts/testing";
import { createPiCredentialStore, KeychainPiCredentialStore } from "./pi-credential-store.js";

describe("Pi OAuth credential storage", () => {
  it("stores typed OAuth state as one provider-specific Keychain value", async () => {
    const keychain = new FakeCredentialStore();
    const store = createPiCredentialStore({
      platform: "darwin",
      environment: {},
      keychains: { "openai-codex": keychain },
    });
    const credential = { type: "oauth" as const, access: "access-secret", refresh: "refresh-secret", expires: Date.now() + 60_000 };

    expect(await store.modify("openai-codex", () => Promise.resolve(credential))).toEqual(credential);
    expect(await store.read("openai-codex")).toEqual(credential);
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
    expect(await keychain.get()).toBe(JSON.stringify(credential));

    await store.delete("openai-codex");
    expect(await store.read("openai-codex")).toBeUndefined();
  });

  it("serializes refresh mutations so a rotated credential is never overwritten", async () => {
    const keychain = new FakeCredentialStore(JSON.stringify({ type: "oauth", access: "a0", refresh: "r0", expires: 1 }));
    const store = new KeychainPiCredentialStore({ "openai-codex": keychain });
    const seen: string[] = [];
    let releaseFirst = (): void => undefined;
    const wait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = store.modify("openai-codex", async (current) => {
      seen.push((current as { access: string }).access);
      await wait;
      return { type: "oauth", access: "a1", refresh: "r1", expires: 2 };
    });
    const second = store.modify("openai-codex", (current) => {
      seen.push((current as { access: string }).access);
      return Promise.resolve({ type: "oauth" as const, access: "a2", refresh: "r2", expires: 3 });
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(seen).toEqual(["a0", "a1"]);
    expect((await store.read("openai-codex") as { access: string }).access).toBe("a2");
  });

  it("rejects malformed stored OAuth state without exposing it", async () => {
    const store = new KeychainPiCredentialStore({ "openai-codex": new FakeCredentialStore("not-json-secret") });
    await expect(store.read("openai-codex")).rejects.toThrow("credential is invalid");
  });
});

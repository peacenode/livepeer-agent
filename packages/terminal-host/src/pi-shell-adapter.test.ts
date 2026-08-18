import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LivepeerInteractiveContext, LivepeerInteractiveServices } from "./index.js";
import {
  MINIMUM_BOOT_DURATION_MS,
  createLivepeerSessionManager,
  createPiInteractiveShellAdapter,
  createSessionBudget,
  remainingBootDuration,
  type PiShellLaunch,
} from "./pi-shell-adapter.js";
import {
  createFakeExecutionClient,
  createFakeLivepeerAccess,
  createFakeModelCredentialStore,
  createFakeModelPort,
  createFakeOAuthPort,
} from "./testing/index.js";

function services(): LivepeerInteractiveServices {
  return {
    models: createFakeModelPort(),
    oauth: createFakeOAuthPort(),
    modelCredentials: createFakeModelCredentialStore(),
    livepeer: createFakeLivepeerAccess(),
    execution: createFakeExecutionClient(),
  };
}

function context(resume: boolean): LivepeerInteractiveContext {
  return {
    cwd: "/project",
    configRoot: "/config/livepeer",
    resume,
    services: services(),
  };
}

describe("Pi interactive shell adapter", () => {

  it("keeps a user-owned per-operation budget for the current shell session", async () => {
    const budget = createSessionBudget();
    expect(await budget.get()).toMatchObject({ status: "No per-operation cap is set." });
    expect(await budget.set(2)).toMatchObject({ maxCostUsd: 2, status: "$2.00 maximum per paid operation." });
    expect(budget.maxCostUsd()).toBe(2);
    expect(await budget.set(undefined)).toMatchObject({ status: "Per-operation cap removed. Paid actions still require approval." });
    expect(budget.maxCostUsd()).toBeUndefined();
  });

  it("keeps the boot animation visible for at least one complete logo cycle", () => {
    expect(MINIMUM_BOOT_DURATION_MS).toBeGreaterThanOrEqual(720);
    expect(remainingBootDuration(1_000, 1_400)).toBe(1_000);
    expect(remainingBootDuration(1_000, 2_500)).toBe(0);
  });

  it.each([
    [false, "fresh"],
    [true, "resume"],
  ] as const)("routes resume=%s to a %s v2 session", async (resume, expectedMode) => {
    const launches: PiShellLaunch[] = [];
    const adapter = createPiInteractiveShellAdapter({ bridge: { run: (launch) => { launches.push(launch); return Promise.resolve(); } } });
    const value = context(resume);
    await adapter.run(value);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.mode).toBe(expectedMode);
    expect(launches[0]?.sessionDirectory).toBe(join(value.configRoot, "sessions", "v2"));
  });

  it("passes the exact injected Keychain-compatible credential store to the Pi bridge", async () => {
    let received: PiShellLaunch | undefined;
    const adapter = createPiInteractiveShellAdapter({ bridge: { run: (launch) => { received = launch; return Promise.resolve(); } } });
    const value = context(false);
    await adapter.run(value);
    expect(received?.modelCredentials).toBe(value.services.modelCredentials);
  });

  it("never derives fresh or resumed sessions from legacy Pi or latest.json paths", async () => {
    const launches: PiShellLaunch[] = [];
    const adapter = createPiInteractiveShellAdapter({ bridge: { run: (launch) => { launches.push(launch); return Promise.resolve(); } } });
    await adapter.run(context(false));
    await adapter.run(context(true));
    for (const launch of launches) {
      expect(launch.sessionDirectory).toBe("/config/livepeer/sessions/v2");
      expect(launch.sessionDirectory).not.toContain("/.pi/");
      expect(launch.sessionDirectory).not.toContain("latest.json");
    }
    expect(launches.map(({ mode }) => mode)).toEqual(["fresh", "resume"]);
  });

  it("isolates session managers to v2 even when legacy state exists", () => {
    const root = mkdtempSync(join(tmpdir(), "livepeer-session-v2-"));
    try {
      const sessionDirectory = join(root, "config", "livepeer", "sessions", "v2");
      mkdirSync(join(root, "config", "livepeer"), { recursive: true });
      mkdirSync(join(root, ".pi", "agent", "sessions"), { recursive: true });
      writeFileSync(join(root, "config", "livepeer", "latest.json"), "{}", "utf8");
      writeFileSync(join(root, ".pi", "agent", "sessions", "legacy.jsonl"), "{}", "utf8");
      const fresh = createLivepeerSessionManager(root, sessionDirectory, "fresh");
      const resumed = createLivepeerSessionManager(root, sessionDirectory, "resume");
      expect(fresh.getSessionDir()).toBe(sessionDirectory);
      expect(resumed.getSessionDir()).toBe(sessionDirectory);
      expect(fresh.getSessionFile()).toContain(`${sessionDirectory}/`);
      expect(resumed.getSessionFile()).toContain(`${sessionDirectory}/`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps OAuth prompts cancellable through the injected signal", async () => {
    const oauth = createFakeOAuthPort();
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(oauth.login("openai-codex", {
      signal: controller.signal,
      prompt: () => Promise.resolve("unused"),
      notify: () => undefined,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});

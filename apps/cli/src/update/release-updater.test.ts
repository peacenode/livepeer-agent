import { describe, expect, it, vi } from "vitest";
import { compareVersions, createReleaseUpdater } from "./release-updater.js";

describe("release updater", () => {
  it("compares stable semantic versions", () => {
    expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0-beta.1", "0.1.0")).toBe(-1);
  });

  it("reports an available public release without installing it", async () => {
    const runInstaller = vi.fn(() => Promise.resolve());
    const updater = createReleaseUpdater({
      currentVersion: "0.1.0",
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ tag_name: "v0.1.1" }), { status: 200 }))),
      installerPath: "/bundle/install.sh",
      runInstaller,
    });
    await expect(updater.check()).resolves.toEqual({
      currentVersion: "0.1.0",
      latestVersion: "0.1.1",
      updateAvailable: true,
      updated: false,
    });
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("runs the bundled installer only when a newer release exists", async () => {
    const runInstaller = vi.fn(() => Promise.resolve());
    const updater = createReleaseUpdater({
      currentVersion: "0.1.0",
      environment: { HOME: "/user/home" },
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ tag_name: "v0.2.0" }), { status: 200 }))),
      installerPath: "/bundle/install.sh",
      runInstaller,
    });
    await expect(updater.install()).resolves.toMatchObject({ latestVersion: "0.2.0", updated: true });
    expect(runInstaller).toHaveBeenCalledWith("/bundle/install.sh", { HOME: "/user/home" }, undefined);
  });
});

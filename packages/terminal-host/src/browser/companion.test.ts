import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ManagedBrowserCompanion,
  PLAYWRIGHT_CLI_VERSION,
  type BrowserCommandOptions,
  type BrowserCommandRunner,
} from "./companion.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed browser companion", () => {
  it("reports actionable status before installation", async () => {
    const root = await temporaryRoot();
    const companion = new ManagedBrowserCompanion(root, { run: () => Promise.resolve({ stdout: "", stderr: "" }) });
    await expect(companion.status()).resolves.toMatchObject({
      installed: false,
      cliInstalled: false,
      browserInstalled: false,
      version: PLAYWRIGHT_CLI_VERSION,
      guidance: "Run `livepeer browser install` before using browser tools.",
    });
  });

  it("pins the CLI, installs a browser, and records readiness", async () => {
    const root = await temporaryRoot();
    const calls: BrowserCommandOptions[] = [];
    const paths = new ManagedBrowserCompanion(root).paths;
    const runner: BrowserCommandRunner = {
      async run(options) {
        calls.push(options);
        if (options.args.includes(`@playwright/cli@${PLAYWRIGHT_CLI_VERSION}`)) {
          await mkdir(dirname(paths.cliPath), { recursive: true });
          await writeFile(paths.cliPath, "// fake cli\n");
        }
        return { stdout: "ok", stderr: "" };
      },
    };
    const companion = new ManagedBrowserCompanion(root, runner, {});
    await expect(companion.install()).resolves.toMatchObject({ installed: true, browserInstalled: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain(`@playwright/cli@${PLAYWRIGHT_CLI_VERSION}`);
    expect(calls[1]?.args.slice(-2)).toEqual(["install-browser", "chromium"]);
    expect(calls[1]?.environment).toMatchObject({
      PLAYWRIGHT_BROWSERS_PATH: companion.paths.browsersRoot,
      PWTEST_DAEMON_SESSION_DIR: companion.paths.daemonRoot,
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "livepeer-browser-test-"));
  roots.push(root);
  return root;
}

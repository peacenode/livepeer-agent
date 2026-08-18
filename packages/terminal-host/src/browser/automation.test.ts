import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlaywrightCliBrowser } from "./automation.js";
import { resolveManagedBrowserPaths, type BrowserCommandOptions, type BrowserCommandRunner } from "./companion.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Playwright CLI browser", () => {
  it("opens an authenticated-safe URL and returns raw accessibility snapshots", async () => {
    const root = await temporaryRoot();
    const paths = resolveManagedBrowserPaths(root);
    await mkdir(dirname(paths.cliPath), { recursive: true });
    await writeFile(paths.cliPath, "// fake\n");
    const calls: BrowserCommandOptions[] = [];
    const runner: BrowserCommandRunner = {
      run(options) {
        calls.push(options);
        return Promise.resolve({
          stdout: options.args.includes("snapshot") ? '- heading "Example" [level=1]\n- link "Next" [ref=e2]\n' : "ok",
          stderr: "",
        });
      },
    };
    const browser = new PlaywrightCliBrowser(paths, runner, {});
    const result = await browser.open("session/unsafe", "https://user:secret@example.test/page", { headed: true });
    expect(result.text).toContain('link "Next" [ref=e2]');
    expect(calls[0]?.args).toContain("https://example.test/page");
    expect(calls[0]?.args).toContain(`--config=${paths.configPath}`);
    expect(calls[0]?.args).toContain("--headed");
    expect(calls[0]?.environment).toMatchObject({ PWTEST_DAEMON_SESSION_DIR: paths.daemonRoot });
    expect(calls[1]?.args.slice(-2)).toEqual(["snapshot", "--raw"]);
  });

  it("uses refs for actions and rejects non-web protocols", async () => {
    const root = await temporaryRoot();
    const paths = resolveManagedBrowserPaths(root);
    await mkdir(dirname(paths.cliPath), { recursive: true });
    await writeFile(paths.cliPath, "// fake\n");
    const calls: BrowserCommandOptions[] = [];
    const runner: BrowserCommandRunner = {
      run(options) { calls.push(options); return Promise.resolve({ stdout: "snapshot", stderr: "" }); },
    };
    const browser = new PlaywrightCliBrowser(paths, runner, {});
    await expect(browser.open("one", "file:///etc/passwd")).rejects.toThrow("http and https");
    await browser.act("one", { action: "fill", ref: "e7", value: "hello" });
    expect(calls[0]?.args.slice(-3)).toEqual(["fill", "e7", "hello"]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "livepeer-browser-runtime-"));
  roots.push(root);
  return root;
}

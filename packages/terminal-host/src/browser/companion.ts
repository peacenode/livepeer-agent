import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLAYWRIGHT_CLI_VERSION = "0.1.18";

export interface BrowserCommandResult {
  stdout: string;
  stderr: string;
}

export interface BrowserCommandOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
}

export interface BrowserCommandRunner {
  run(options: BrowserCommandOptions): Promise<BrowserCommandResult>;
}

export interface ManagedBrowserPaths {
  root: string;
  companionRoot: string;
  cliPath: string;
  markerPath: string;
  configPath: string;
  browsersRoot: string;
  daemonRoot: string;
  profileRoot: string;
  artifactRoot: string;
}

export interface ManagedBrowserStatus {
  installed: boolean;
  cliInstalled: boolean;
  browserInstalled: boolean;
  version: string;
  root: string;
  guidance?: string;
}

export interface BrowserInstallOptions {
  force?: boolean;
  signal?: AbortSignal;
  onProgress?(message: string): void;
}

interface BrowserInstallMarker {
  version: string;
  browserInstalled: boolean;
  installedAt: string;
}

const MAX_COMMAND_OUTPUT = 2_000_000;

export function resolveManagedBrowserPaths(configRoot: string): ManagedBrowserPaths {
  const root = join(configRoot, "browser");
  const companionRoot = join(root, "companion");
  return {
    root,
    companionRoot,
    cliPath: join(companionRoot, "node_modules", "@playwright", "cli", "playwright-cli.js"),
    markerPath: join(root, "installed.json"),
    configPath: join(root, "cli.config.json"),
    browsersRoot: join(root, "browsers"),
    daemonRoot: join(root, "daemon"),
    profileRoot: join(root, "profiles", "default"),
    artifactRoot: join(root, "artifacts"),
  };
}

export class ManagedBrowserCompanion {
  readonly paths: ManagedBrowserPaths;

  constructor(
    configRoot: string,
    private readonly runner: BrowserCommandRunner = createBrowserCommandRunner(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.paths = resolveManagedBrowserPaths(configRoot);
  }

  async status(): Promise<ManagedBrowserStatus> {
    const cliInstalled = await exists(this.paths.cliPath);
    const marker = await readMarker(this.paths.markerPath);
    const browserInstalled = marker?.version === PLAYWRIGHT_CLI_VERSION && marker.browserInstalled;
    const installed = cliInstalled && browserInstalled;
    return {
      installed,
      cliInstalled,
      browserInstalled,
      version: PLAYWRIGHT_CLI_VERSION,
      root: this.paths.root,
      ...(!installed ? { guidance: "Run `livepeer browser install` before using browser tools." } : {}),
    };
  }

  async install(options: BrowserInstallOptions = {}): Promise<ManagedBrowserStatus> {
    const current = await this.status();
    if (current.installed && !options.force) return current;
    options.signal?.throwIfAborted();
    await mkdir(this.paths.companionRoot, { recursive: true });
    options.onProgress?.(`Installing Playwright CLI ${PLAYWRIGHT_CLI_VERSION}…`);
    await this.runner.run({
      command: "npm",
      args: [
        "install",
        "--prefix", this.paths.companionRoot,
        "--no-save",
        "--no-package-lock",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        `@playwright/cli@${PLAYWRIGHT_CLI_VERSION}`,
      ],
      ...(options.signal ? { signal: options.signal } : {}),
      environment: this.environment,
    });
    if (!await exists(this.paths.cliPath)) {
      throw new Error("Playwright CLI installation completed without producing the expected executable.");
    }
    options.onProgress?.("Installing the managed Chromium browser…");
    await writeBrowserConfig(this.paths);
    await this.runner.run({
      command: process.execPath,
      args: [this.paths.cliPath, "install-browser", "chromium"],
      cwd: this.paths.root,
      ...(options.signal ? { signal: options.signal } : {}),
      environment: managedEnvironment(this.paths, this.environment),
    });
    const marker: BrowserInstallMarker = {
      version: PLAYWRIGHT_CLI_VERSION,
      browserInstalled: true,
      installedAt: new Date().toISOString(),
    };
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(this.paths.markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    return this.status();
  }
}

export function managedEnvironment(paths: ManagedBrowserPaths, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    NO_UPDATE_NOTIFIER: "1",
    PLAYWRIGHT_BROWSERS_PATH: paths.browsersRoot,
    PWTEST_DAEMON_SESSION_DIR: paths.daemonRoot,
    PLAYWRIGHT_MCP_OUTPUT_DIR: paths.artifactRoot,
  };
}

export function createBrowserCommandRunner(): BrowserCommandRunner {
  return {
    run: (options) => new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      const child = spawn(options.command, [...options.args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.environment ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer) => {
        if (current.length >= MAX_COMMAND_OUTPUT) return current;
        return `${current}${chunk.toString()}`.slice(0, MAX_COMMAND_OUTPUT);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const abort = () => child.kill("SIGTERM");
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) {
          reject(new DOMException("Browser command cancelled.", "AbortError"));
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || `process exited with ${signal ?? code ?? "an unknown status"}`;
        reject(new Error(`Playwright browser command failed: ${detail}`));
      });
    }),
  };
}

async function readMarker(path: string): Promise<BrowserInstallMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<BrowserInstallMarker>;
    if (typeof value.version !== "string" || value.browserInstalled !== true || typeof value.installedAt !== "string") return undefined;
    return value as BrowserInstallMarker;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeBrowserConfig(paths: ManagedBrowserPaths): Promise<void> {
  const config = {
    browser: {
      browserName: "chromium",
      launchOptions: { channel: "chromium" },
    },
    outputDir: paths.artifactRoot,
  };
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

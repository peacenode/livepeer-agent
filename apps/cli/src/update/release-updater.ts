import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_RELEASES_API = "https://api.github.com/repos/peacenode/livepeer-agent-releases/releases/latest";

export interface ReleaseUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  updated: boolean;
}

export interface ReleaseUpdater {
  check(signal?: AbortSignal): Promise<ReleaseUpdateStatus>;
  install(signal?: AbortSignal): Promise<ReleaseUpdateStatus>;
}

export interface ReleaseUpdaterOptions {
  currentVersion: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  installerPath?: string;
  runInstaller?: (installerPath: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>;
}

export function createReleaseUpdater(options: ReleaseUpdaterOptions): ReleaseUpdater {
  const environment = options.environment ?? process.env;
  const fetchRelease = options.fetch ?? globalThis.fetch;
  const installerPath = options.installerPath ?? fileURLToPath(new URL("./install.sh", import.meta.url));
  const runInstaller = options.runInstaller ?? runShellInstaller;

  const check = async (signal?: AbortSignal): Promise<ReleaseUpdateStatus> => {
    const response = await fetchRelease(environment.LIVEPEER_AGENT_RELEASES_API ?? DEFAULT_RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `livepeer-agent/${options.currentVersion}`,
      },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Could not check for Livepeer Agent updates (HTTP ${response.status}).`);
    const release = await response.json() as { tag_name?: unknown };
    if (typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release.tag_name)) {
      throw new Error("The latest Livepeer Agent release has an invalid version tag.");
    }
    const latestVersion = release.tag_name.slice(1);
    return {
      currentVersion: options.currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, options.currentVersion) > 0,
      updated: false,
    };
  };

  return {
    check,
    install: async (signal) => {
      const status = await check(signal);
      if (!status.updateAvailable) return status;
      await runInstaller(installerPath, environment, signal);
      return { ...status, updated: true };
    },
  };
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
    if (!match) throw new Error(`Invalid release version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.numbers.length; index += 1) {
    const difference = a.numbers[index]! - b.numbers[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

async function runShellInstaller(installerPath: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", [installerPath], { env: environment, signal, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      if (code === 0) resolve();
      else reject(new Error(`Livepeer Agent installer failed${exitSignal ? ` (${exitSignal})` : ` with exit code ${String(code)}`}.`));
    });
  });
}

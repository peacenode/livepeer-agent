import { execFile } from "node:child_process";
import type { CredentialStore } from "@livepeer-agent/contracts";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessExecutor = (command: string, args: readonly string[]) => Promise<ProcessResult>;

const execute: ProcessExecutor = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8", shell: false }, (error, stdout, stderr) => {
      const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? (error as unknown as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });

export class MacOsKeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly service = "livepeer-agent",
    private readonly account = "terminal",
    private readonly executor: ProcessExecutor = execute,
  ) {}

  async get(): Promise<string | undefined> {
    const result = await this.executor("security", ["find-generic-password", "-s", this.service, "-a", this.account, "-w"]);
    if (result.exitCode === 44 || (result.exitCode === 1 && result.stderr.includes("could not be found"))) return undefined;
    if (result.exitCode !== 0) throw new Error("macOS Keychain is unavailable");
    return result.stdout.trim() || undefined;
  }

  async set(token: string): Promise<void> {
    const result = await this.executor("security", ["add-generic-password", "-s", this.service, "-a", this.account, "-w", token, "-U"]);
    if (result.exitCode !== 0) throw new Error("Could not save credentials in macOS Keychain");
  }

  async delete(): Promise<void> {
    const result = await this.executor("security", ["delete-generic-password", "-s", this.service, "-a", this.account]);
    if (result.exitCode !== 0 && result.exitCode !== 44 && !result.stderr.includes("could not be found")) {
      throw new Error("Could not remove credentials from macOS Keychain");
    }
  }
}

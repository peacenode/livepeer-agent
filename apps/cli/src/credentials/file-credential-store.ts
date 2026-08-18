import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialStore } from "@livepeer-agent/contracts";

interface CredentialFile {
  accessToken: string;
}

export class FileCredentialStore implements CredentialStore {
  constructor(readonly path: string) {}

  async get(): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof value === "object" && value !== null && "accessToken" in value && typeof value.accessToken === "string") {
        return value.accessToken;
      }
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(token: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    const value: CredentialFile = { accessToken: token };
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

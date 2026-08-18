import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@livepeer-agent/contracts";
import { FileCredentialStore } from "./file-credential-store.js";
import { MacOsKeychainCredentialStore } from "./keychain-credential-store.js";

export * from "./file-credential-store.js";
export * from "./keychain-credential-store.js";

class FallbackCredentialStore implements CredentialStore {
  private fallbackActive = false;
  private warned = false;

  constructor(
    private readonly primary: CredentialStore,
    private readonly fallback: CredentialStore,
    private readonly warn: (message: string) => void,
    private readonly warning: string,
  ) {}

  async get(): Promise<string | undefined> {
    if (this.fallbackActive) return this.fallback.get();
    try {
      const primary = await this.primary.get();
      if (primary) return primary;
      const fallback = await this.fallback.get();
      if (fallback) {
        this.activateFallback();
        return fallback;
      }
      return undefined;
    } catch {
      this.activateFallback();
      return this.fallback.get();
    }
  }

  async set(token: string): Promise<void> {
    if (!this.fallbackActive) {
      try {
        await this.primary.set(token);
        await this.fallback.delete();
        return;
      } catch {
        this.activateFallback();
      }
    }
    await this.fallback.set(token);
  }

  async delete(): Promise<void> {
    if (!this.fallbackActive) {
      try {
        await this.primary.delete();
      } catch {
        this.activateFallback();
      }
    }
    await this.fallback.delete();
  }

  private activateFallback(): void {
    this.fallbackActive = true;
    if (!this.warned) {
      this.warned = true;
      this.warn(this.warning);
    }
  }
}

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  warn?: (message: string) => void;
  keychain?: CredentialStore;
  service?: string;
  account?: string;
  fileName?: string;
  warningLabel?: string;
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const environment = options.environment ?? process.env;
  const configRoot = environment.XDG_CONFIG_HOME ?? join(options.homeDirectory ?? homedir(), ".config");
  const file = new FileCredentialStore(join(configRoot, "livepeer", options.fileName ?? "credentials.json"));
  const warning = `System credential storage is unavailable; using a local permission-0600 ${options.warningLabel ?? "credential"} file.`;
  if ((options.platform ?? process.platform) !== "darwin") {
    (options.warn ?? console.error)(warning);
    return file;
  }
  return new FallbackCredentialStore(
    options.keychain ?? new MacOsKeychainCredentialStore(options.service, options.account),
    file,
    options.warn ?? console.error,
    warning,
  );
}

export function createDaydreamCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  return createCredentialStore({
    ...options,
    service: options.service ?? "livepeer-agent-daydream",
    account: options.account ?? "mcp",
    fileName: options.fileName ?? "daydream-credentials.json",
    warningLabel: options.warningLabel ?? "Daydream API-key credential",
  });
}

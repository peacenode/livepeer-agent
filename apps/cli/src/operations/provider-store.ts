import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CredentialStore } from "@livepeer-agent/contracts";
import { createCredentialStore, type CredentialStoreOptions } from "../credentials/index.js";

export type ModelProvider = "openai" | "anthropic";
type ProviderFile = Partial<Record<ModelProvider, string>>;

export interface ProviderStore {
  add(provider: ModelProvider, apiKey: string): Promise<void>;
  remove(provider: ModelProvider): Promise<void>;
  list(): Promise<Array<{ provider: ModelProvider; configured: boolean }>>;
}

export class CredentialProviderStore implements ProviderStore {
  constructor(
    private readonly stores: Record<ModelProvider, CredentialStore>,
    private readonly legacy = new FileProviderStore(),
  ) {}

  async add(provider: ModelProvider, apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new TypeError("API key cannot be empty.");
    await this.stores[provider].set(apiKey.trim());
  }

  async remove(provider: ModelProvider): Promise<void> {
    await this.stores[provider].delete();
    await this.legacy.remove(provider);
  }

  async list(): Promise<Array<{ provider: ModelProvider; configured: boolean }>> {
    return Promise.all((["openai", "anthropic"] as const).map(async (provider) => ({
      provider,
      configured: Boolean(await this.get(provider)),
    })));
  }

  async get(provider: ModelProvider): Promise<string | undefined> {
    const stored = await this.stores[provider].get();
    if (stored) return stored;
    const legacy = await this.legacy.get(provider);
    if (!legacy) return undefined;
    await this.stores[provider].set(legacy);
    await this.legacy.remove(provider);
    return legacy;
  }
}

export interface ProviderStoreOptions extends Omit<CredentialStoreOptions, "keychain" | "service" | "account" | "fileName" | "warningLabel"> {
  keychains?: Partial<Record<ModelProvider, CredentialStore>>;
  legacyPath?: string;
}

export function createProviderStore(options: ProviderStoreOptions = {}): CredentialProviderStore {
  const environment = options.environment ?? process.env;
  const configRoot = environment.XDG_CONFIG_HOME ?? join(options.homeDirectory ?? homedir(), ".config");
  const make = (provider: ModelProvider) => createCredentialStore({
    ...options,
    environment,
    ...(options.keychains?.[provider] ? { keychain: options.keychains[provider] } : {}),
    service: "livepeer-agent-model-provider",
    account: provider,
    fileName: `provider-${provider}.json`,
    warningLabel: `${provider} provider credential`,
  });
  return new CredentialProviderStore(
    { openai: make("openai"), anthropic: make("anthropic") },
    new FileProviderStore(options.legacyPath ?? join(configRoot, "livepeer", "providers.json")),
  );
}

export class FileProviderStore implements ProviderStore {
  constructor(readonly path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "livepeer", "providers.json")) {}

  async add(provider: ModelProvider, apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new TypeError("API key cannot be empty.");
    const values = await this.read();
    values[provider] = apiKey.trim();
    await this.write(values);
  }

  async remove(provider: ModelProvider): Promise<void> {
    const values = await this.read();
    delete values[provider];
    if (Object.keys(values).length === 0) {
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      return;
    }
    await this.write(values);
  }

  async list(): Promise<Array<{ provider: ModelProvider; configured: boolean }>> {
    const values = await this.read();
    return (["openai", "anthropic"] as const).map((provider) => ({ provider, configured: Boolean(values[provider]) }));
  }

  async get(provider: ModelProvider): Promise<string | undefined> {
    return (await this.read())[provider];
  }

  private async read(): Promise<ProviderFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(value: ProviderFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

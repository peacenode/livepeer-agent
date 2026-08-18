import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore as PiCredentialStore,
} from "@earendil-works/pi-ai";
import type { CredentialStore } from "@livepeer-agent/contracts";
import { createCredentialStore, type CredentialStoreOptions } from "./index.js";

const SUPPORTED_OAUTH_PROVIDERS = ["openai-codex"] as const;
export type OAuthProvider = (typeof SUPPORTED_OAUTH_PROVIDERS)[number];

export class KeychainPiCredentialStore implements PiCredentialStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly stores: Readonly<Record<OAuthProvider, CredentialStore>>) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const store = this.store(providerId);
    if (!store) return undefined;
    const serialized = await store.get();
    options?.signal?.throwIfAborted();
    if (!serialized) return undefined;
    return parseCredential(serialized, providerId);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const entries: CredentialInfo[] = [];
    for (const providerId of SUPPORTED_OAUTH_PROVIDERS) {
      const credential = await this.read(providerId, options);
      if (credential) entries.push({ providerId, type: credential.type });
    }
    return entries;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const store = this.requireStore(providerId);
    const previous = this.queues.get(providerId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.queues.set(providerId, queued);
    await previous;
    try {
      options?.signal?.throwIfAborted();
      const existing = await this.read(providerId, options);
      const next = await fn(existing);
      options?.signal?.throwIfAborted();
      if (next !== undefined) await store.set(JSON.stringify(next));
      return next ?? existing;
    } finally {
      release();
      if (this.queues.get(providerId) === queued) this.queues.delete(providerId);
    }
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    const store = this.requireStore(providerId);
    await this.lock(providerId, async () => {
      options?.signal?.throwIfAborted();
      await store.delete();
      options?.signal?.throwIfAborted();
    });
  }

  private store(providerId: string): CredentialStore | undefined {
    return SUPPORTED_OAUTH_PROVIDERS.includes(providerId as OAuthProvider)
      ? this.stores[providerId as OAuthProvider]
      : undefined;
  }

  private requireStore(providerId: string): CredentialStore {
    const store = this.store(providerId);
    if (!store) throw new Error(`Unsupported OAuth credential provider: ${providerId}`);
    return store;
  }

  private async lock<T>(providerId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(providerId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.queues.set(providerId, queued);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.queues.get(providerId) === queued) this.queues.delete(providerId);
    }
  }
}

export interface PiCredentialStoreOptions extends Omit<CredentialStoreOptions, "keychain" | "service" | "account" | "fileName" | "warningLabel"> {
  keychains?: Partial<Record<OAuthProvider, CredentialStore>>;
}

export function createPiCredentialStore(options: PiCredentialStoreOptions = {}): KeychainPiCredentialStore {
  const make = (provider: OAuthProvider) => createCredentialStore({
    ...options,
    ...(options.keychains?.[provider] ? { keychain: options.keychains[provider] } : {}),
    service: "livepeer-agent-pi-oauth",
    account: provider,
    fileName: `oauth-${provider}.json`,
    warningLabel: `${provider} OAuth credential`,
  });
  return new KeychainPiCredentialStore({ "openai-codex": make("openai-codex") });
}

function parseCredential(serialized: string, providerId: string): Credential {
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new Error(`Stored ${providerId} credential is invalid; log in again.`); }
  if (!value || typeof value !== "object" || !("type" in value) || !["oauth", "api_key"].includes(String(value.type))) {
    throw new Error(`Stored ${providerId} credential is invalid; log in again.`);
  }
  return value as Credential;
}

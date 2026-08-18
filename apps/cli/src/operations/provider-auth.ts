import type { AuthInteraction, Models } from "@earendil-works/pi-ai";
import { LivepeerAgentError } from "@livepeer-agent/contracts";
import type { OAuthProvider } from "../credentials/pi-credential-store.js";

export interface ProviderAuthManager {
  login(provider: OAuthProvider, interaction: AuthInteraction): Promise<void>;
  logout(provider: OAuthProvider, signal?: AbortSignal): Promise<void>;
  list(signal?: AbortSignal): Promise<Array<{ provider: OAuthProvider; configured: boolean; type: "oauth" }>>;
}

export class PiProviderAuthManager implements ProviderAuthManager {
  constructor(readonly models: Models) {}

  async login(provider: OAuthProvider, interaction: AuthInteraction): Promise<void> {
    try { await this.models.login(provider, "oauth", interaction); }
    catch (error) { throw normalizeAuthError(provider, error); }
  }

  async logout(provider: OAuthProvider, signal?: AbortSignal): Promise<void> {
    try { await this.models.logout(provider, signal ? { signal } : undefined); }
    catch (error) { throw normalizeAuthError(provider, error); }
  }

  async list(signal?: AbortSignal): Promise<Array<{ provider: OAuthProvider; configured: boolean; type: "oauth" }>> {
    try {
      const configured = Boolean(await this.models.checkAuth("openai-codex", signal ? { signal } : undefined));
      return [{ provider: "openai-codex", configured, type: "oauth" }];
    } catch (error) { throw normalizeAuthError("openai-codex", error); }
  }
}

function normalizeAuthError(provider: OAuthProvider, error: unknown): LivepeerAgentError {
  if ((error as { name?: string }).name === "AbortError") {
    return new LivepeerAgentError("CANCELLED", "Provider login cancelled.", 4, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LivepeerAgentError("AUTH", `${provider} authentication failed: ${message}`, 2, { cause: error });
}

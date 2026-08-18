import { resolve } from "node:path";
import type { CredentialStore as ModelCredentialStore } from "@earendil-works/pi-ai";
import type {
  CredentialStore,
} from "@livepeer-agent/contracts";
import type { LivepeerExecutionClient } from "@livepeer-agent/livepeer-client";

export type ModelProviderId = "openai" | "openai-codex" | "anthropic";

export interface ModelDescriptor {
  provider: ModelProviderId;
  id: string;
  label?: string;
}

export interface ModelSelection {
  provider: ModelProviderId;
  model: string;
}

/** Model discovery and selection stay independent of Pi's concrete registry. */
export interface ModelPort {
  list(signal?: AbortSignal): Promise<readonly ModelDescriptor[]>;
  current(): ModelSelection | undefined;
  select(selection: ModelSelection, signal?: AbortSignal): Promise<void>;
}

export type OAuthPrompt =
  | { type: "input"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };

export type OAuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "info" | "progress"; message: string };

export interface OAuthInteraction {
  signal?: AbortSignal;
  prompt(request: OAuthPrompt): Promise<string>;
  notify(event: OAuthEvent): void;
}

export interface ModelOAuthPort {
  list(signal?: AbortSignal): Promise<readonly { provider: ModelProviderId; configured: boolean }[]>;
  login(provider: ModelProviderId, interaction: OAuthInteraction): Promise<void>;
  logout(provider: ModelProviderId, signal?: AbortSignal): Promise<void>;
}

/** Product authentication is intentionally distinct from model-provider OAuth. */
export interface LivepeerAccessPort {
  credentials: CredentialStore;
}

export interface LivepeerInteractiveServices {
  models: ModelPort;
  oauth: ModelOAuthPort;
  /** One local credential source shared with the fork's ModelRuntime. */
  modelCredentials: ModelCredentialStore;
  livepeer: LivepeerAccessPort;
  execution: LivepeerExecutionClient;
}

export interface LivepeerInteractiveContext {
  cwd: string;
  configRoot: string;
  resume: boolean;
  services: LivepeerInteractiveServices;
}

/**
 * The adapter boundary implemented by the owned @livepeer/pi-coding-agent
 * shell. Product packages do not import Pi application-shell internals.
 */
export interface InteractiveShellAdapter {
  run(context: LivepeerInteractiveContext): Promise<void>;
}

export interface LivepeerInteractiveOptions extends LivepeerInteractiveContext {
  shell?: InteractiveShellAdapter;
}

export class InteractiveShellUnavailableError extends Error {
  readonly code = "LIVEPEER_INTERACTIVE_SHELL_UNAVAILABLE";

  constructor() {
    super("The Livepeer interactive shell adapter is not installed.");
    this.name = "InteractiveShellUnavailableError";
  }
}

/**
 * Production host seam. The CLI injects the tested Pi shell adapter; callers
 * that omit it fail instead of silently starting a second agent runtime.
 */
export async function runLivepeerInteractive(options: LivepeerInteractiveOptions): Promise<void> {
  const shell = options.shell;
  if (!shell) throw new InteractiveShellUnavailableError();
  await shell.run({
    cwd: resolve(options.cwd),
    configRoot: resolve(options.configRoot),
    resume: options.resume,
    services: options.services,
  });
}

export {
  createPiInteractiveShellAdapter,
  createLivepeerSessionManager,
  type PiCodingAgentBridge,
  type PiInteractiveShellAdapterOptions,
  type PiShellLaunch,
} from "./pi-shell-adapter.js";
export * from "./livepeer/index.js";
export * from "./browser/index.js";
export * from "./capability-menu.js";
export * from "./resources/index.js";

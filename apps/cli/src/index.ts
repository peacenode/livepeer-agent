#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerBundledShellOAuthFlows } from "@livepeer/pi-coding-agent";
import {
  LivepeerAgentError,
  type CredentialStore,
  type ToolTransport,
} from "@livepeer-agent/contracts";
import { createProviderModels } from "@livepeer-agent/model-providers";
import { ManagedBrowserCompanion, createBrowserCommandRunner } from "@livepeer-agent/terminal-host";
import { createAnonymousTransport, createAuthenticatedGatewayTransport } from "@livepeer-agent/livepeer-client";
import { runCli, type CliDependencies } from "./commands/program.js";
import { createDaydreamCredentialStore } from "./credentials/index.js";
import { createPiCredentialStore } from "./credentials/pi-credential-store.js";
import { createOperations } from "./operations/index.js";
import { PiProviderAuthManager } from "./operations/provider-auth.js";
import { createProviderStore } from "./operations/provider-store.js";
import { createSharedModelRuntime, routeAgentShell } from "./shell-dev.js";
import { createReleaseUpdater } from "./update/release-updater.js";
import cliManifest from "../package.json" with { type: "json" };

export { createProgram, runCli } from "./commands/program.js";
export { createOperations } from "./operations/index.js";

const DEFAULT_MCP_URL = "https://agent.livepeer.org/api/mcp";
// Pi deliberately keeps Node-only OAuth modules behind variable imports. Our
// standalone esbuild artifact has no adjacent node_modules tree, so register
// Pi's public static-loader entrypoint before any provider login can run.
registerBundledShellOAuthFlows();

export function createDefaultDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  daydreamCredentials: CredentialStore = createDaydreamCredentialStore({ environment }),
): CliDependencies {
  const configRoot = join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "livepeer");
  const transport = createLazyTransport(
    environment.LIVEPEER_MCP_URL ?? DEFAULT_MCP_URL,
    defaultTransportFactories,
    environment.DAYDREAM_API_KEY,
    daydreamCredentials,
  );
  const providers = createProviderStore({ environment });
  const { modelCredentials, models } = createSharedModelRuntime({
    createModelCredentials: () => createPiCredentialStore({ environment }),
    createModels: createProviderModels,
  });
  const providerAuth = new PiProviderAuthManager(models);
  const operations = createOperations(transport);
  return {
    operations,
    daydreamCredentials,
    providers,
    providerAuth,
    browser: new ManagedBrowserCompanion(configRoot, createBrowserCommandRunner(), environment),
    updater: createReleaseUpdater({ currentVersion: cliManifest.version, environment }),
    environment,
    runAgent: async ({ resume }) => {
      const agentTransport = await createAgentTransport(
        environment.LIVEPEER_MCP_URL ?? DEFAULT_MCP_URL,
        environment.DAYDREAM_API_KEY,
        daydreamCredentials,
      );
      try {
        const keyConfigured = Boolean(
          (await daydreamCredentials.get())?.trim() || environment.DAYDREAM_API_KEY?.trim(),
        );
        await verifyAgentCredential(agentTransport, keyConfigured);
        await routeAgentShell({
          environment,
          resume,
          modelCredentials,
          models,
          providerAuth,
          livepeerCredentials: daydreamCredentials,
          transport: agentTransport,
        });
      } finally {
        await agentTransport.close().catch(() => undefined);
      }
    },
    close: () => transport.close(),
  };
}

export interface ReloadableToolTransport extends ToolTransport {
  reload(): Promise<void>;
  accessTier(): Promise<"anonymous" | "authenticated">;
}

export interface TransportFactories {
  anonymous(url: string): ToolTransport;
  directBearer(url: string, token: string): ToolTransport;
}

const defaultTransportFactories: TransportFactories = {
  anonymous: createAnonymousTransport,
  directBearer: createAuthenticatedGatewayTransport,
};

/** Resolve the agent's credential once and construct an unambiguous transport. */
export async function createAgentTransport(
  endpoint: string,
  daydreamApiKey?: string,
  daydreamCredentials?: CredentialStore,
  factories: TransportFactories = defaultTransportFactories,
): Promise<ToolTransport> {
  const bearer = (await daydreamCredentials?.get())?.trim() || daydreamApiKey?.trim() || undefined;
  if (!bearer) return factories.anonymous(endpoint);
  if (endpoint !== DEFAULT_MCP_URL) throw unsafeDaydreamEndpointError();
  return factories.directBearer(DEFAULT_MCP_URL, bearer);
}

/**
 * Establish the MCP session before background capability warming begins and
 * fail closed when a locally configured key was not accepted by the server.
 */
export async function verifyAgentCredential(
  transport: ToolTransport,
  keyConfigured: boolean,
): Promise<void> {
  const result = await transport.callTool("me", {});
  if (!keyConfigured) return;
  const profile = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  if (result.isError || profile?.key_class !== "daydream") {
    throw new LivepeerAgentError(
      "daydream_key_not_applied",
      "A Daydream API key is configured, but Livepeer MCP did not accept it for the interactive agent. The agent was stopped instead of silently entering demo mode.",
      2,
    );
  }
}

export function createLazyTransport(
  anonymousUrl: string,
  factories: TransportFactories = defaultTransportFactories,
  daydreamApiKey?: string,
  daydreamCredentials?: CredentialStore,
): ReloadableToolTransport {
  let pending: Promise<ToolTransport> | undefined;
  const directBearer = async () => (await daydreamCredentials?.get())?.trim() || daydreamApiKey?.trim() || undefined;
  const select = async (): Promise<ToolTransport> => {
    const bearer = await directBearer();
    if (bearer) {
      if (anonymousUrl !== DEFAULT_MCP_URL) throw unsafeDaydreamEndpointError();
      return factories.directBearer(DEFAULT_MCP_URL, bearer);
    }
    return factories.anonymous(anonymousUrl);
  };
  const effectiveAccessTier = async (): Promise<"anonymous" | "authenticated"> => {
    if (!await directBearer()) return "anonymous";
    if (anonymousUrl !== DEFAULT_MCP_URL) throw unsafeDaydreamEndpointError();
    // Storyboard treats a valid Daydream key as a real API-key credential,
    // not as keyless demo access. The upstream server remains the authority:
    // invalid or expired keys fail at the MCP call instead of being silently
    // downgraded to the anonymous tool policy.
    return "authenticated";
  };
  const get = () => pending ??= select();
  const release = async () => {
    const value = await pending?.catch(() => undefined);
    pending = undefined;
    await value?.close();
  };
  return {
    listTools: async (options) => (await get()).listTools(options),
    callTool: async (name, input, options) => (await get()).callTool(name, input, options),
    close: release,
    reload: async () => { await release().catch(() => undefined); },
    accessTier: effectiveAccessTier,
  };
}

function unsafeDaydreamEndpointError(): LivepeerAgentError {
  return new LivepeerAgentError(
    "unsafe_daydream_endpoint",
    "DAYDREAM_API_KEY can only be used with the default Livepeer MCP endpoint. Unset LIVEPEER_MCP_URL or unset DAYDREAM_API_KEY.",
    1,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv, createDefaultDependencies());
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}

import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AuthInteraction, CredentialStore as ModelCredentialStore, Model, Models } from "@earendil-works/pi-ai";
import type {
  CredentialStore,
  ToolTransport,
} from "@livepeer-agent/contracts";
import { createMcpLivepeerExecutionClient } from "@livepeer-agent/livepeer-client";
import {
  createPiInteractiveShellAdapter,
  runLivepeerInteractive,
  type InteractiveShellAdapter,
  type LivepeerInteractiveOptions,
  type LivepeerInteractiveServices,
  type ModelSelection,
  type OAuthInteraction,
} from "@livepeer-agent/terminal-host";
import type { ProviderAuthManager } from "./operations/provider-auth.js";

type ShellModels = Pick<Models, "getModels" | "getModel">;
type RunInteractive = (options: LivepeerInteractiveOptions) => Promise<void>;
type CreateShellAdapter = () => InteractiveShellAdapter;

export interface SharedModelRuntime<TModels> {
  modelCredentials: ModelCredentialStore;
  models: TModels;
}

export interface SharedModelRuntimeFactories<TModels> {
  createModelCredentials(): ModelCredentialStore;
  createModels(credentials: ModelCredentialStore): TModels;
}

/** Creates the only model credential store used by both model discovery and the shell. */
export function createSharedModelRuntime<TModels>(factories: SharedModelRuntimeFactories<TModels>): SharedModelRuntime<TModels> {
  const modelCredentials = factories.createModelCredentials();
  return { modelCredentials, models: factories.createModels(modelCredentials) };
}

export interface ShellDevelopmentPorts {
  modelCredentials: ModelCredentialStore;
  models: ShellModels;
  providerAuth: ProviderAuthManager;
  livepeerCredentials: CredentialStore;
  transport: ToolTransport;
}

export interface AgentShellRouteOptions extends ShellDevelopmentPorts {
  environment: NodeJS.ProcessEnv;
  resume: boolean;
  cwd?: string;
  runInteractive?: RunInteractive;
  createShellAdapter?: CreateShellAdapter;
}

/** Production route: the forked coding-agent shell is the sole interactive owner. */
export async function routeAgentShell(options: AgentShellRouteOptions): Promise<"forked"> {
  const services = createShellServices(options);
  const configRoot = join(options.environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "livepeer");
  await (options.runInteractive ?? runLivepeerInteractive)({
    cwd: options.cwd ?? process.cwd(),
    configRoot,
    resume: options.resume,
    services,
    shell: (options.createShellAdapter ?? createPiInteractiveShellAdapter)(),
  });
  return "forked";
}

function createShellServices(ports: ShellDevelopmentPorts): LivepeerInteractiveServices {
  let selected: ModelSelection | undefined;
  return {
    modelCredentials: ports.modelCredentials,
    models: {
      list: (signal) => {
        signal?.throwIfAborted();
        return Promise.resolve(ports.models.getModels().map(toModelDescriptor));
      },
      current: () => selected,
      select: (selection, signal) => {
        signal?.throwIfAborted();
        if (!ports.models.getModel(selection.provider, selection.model)) {
          throw new Error(`Unknown model: ${selection.provider}/${selection.model}`);
        }
        selected = selection;
        return Promise.resolve();
      },
    },
    oauth: {
      list: async (signal) => (await ports.providerAuth.list(signal)).map(({ provider, configured }) => ({ provider, configured })),
      login: (provider, interaction) => {
        if (provider !== "openai-codex") throw new Error(`OAuth is not available for ${provider}.`);
        return ports.providerAuth.login(provider, adaptOAuthInteraction(interaction));
      },
      logout: (provider, signal) => {
        if (provider !== "openai-codex") throw new Error(`OAuth is not available for ${provider}.`);
        return ports.providerAuth.logout(provider, signal);
      },
    },
    livepeer: {
      credentials: ports.livepeerCredentials,
    },
    execution: createMcpLivepeerExecutionClient(ports.transport),
  };
}

function toModelDescriptor(model: Model<Api>) {
  return { provider: model.provider as ModelSelection["provider"], id: model.id, ...(model.name ? { label: model.name } : {}) };
}

function adaptOAuthInteraction(interaction: OAuthInteraction): AuthInteraction {
  return {
    ...(interaction.signal ? { signal: interaction.signal } : {}),
    prompt: (request) => interaction.prompt(request.type === "select"
      ? { type: "select", message: request.message, options: request.options }
      : { type: "input", message: request.message, ...(request.placeholder ? { placeholder: request.placeholder } : {}) }),
    notify: (event) => interaction.notify(event),
  };
}

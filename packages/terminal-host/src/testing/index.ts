import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore as ModelCredentialStore,
} from "@earendil-works/pi-ai";
import type {
  CallOptions,
  CredentialStore,
  ToolDescriptor,
  ToolResult,
  ToolTransport,
} from "@livepeer-agent/contracts";
import {
  createMcpLivepeerExecutionClient,
  type LivepeerExecutionClient,
} from "@livepeer-agent/livepeer-client";
import type {
  InteractiveShellAdapter,
  LivepeerAccessPort,
  LivepeerInteractiveContext,
  ModelDescriptor,
  ModelOAuthPort,
  ModelPort,
  ModelProviderId,
  ModelSelection,
  OAuthInteraction,
} from "../index.js";

export function createFakeCredentialStore(initial?: string): CredentialStore & { value: string | undefined } {
  return {
    value: initial,
    get() { return Promise.resolve(this.value); },
    set(token) { this.value = token; return Promise.resolve(); },
    delete() { this.value = undefined; return Promise.resolve(); },
  };
}

export function createFakeModelCredentialStore(initial: Readonly<Record<string, Credential>> = {}): ModelCredentialStore & {
  values: Map<string, Credential>;
} {
  const values = new Map(Object.entries(initial));
  const throwIfAborted = (options?: AuthOperationOptions) => options?.signal?.throwIfAborted();
  return {
    values,
    read(providerId, options) { throwIfAborted(options); return Promise.resolve(values.get(providerId)); },
    list(options): Promise<readonly CredentialInfo[]> {
      throwIfAborted(options);
      return Promise.resolve([...values].map(([providerId, credential]) => ({ providerId, type: credential.type })));
    },
    async modify(providerId, update, options) {
      throwIfAborted(options);
      const next = await update(values.get(providerId));
      throwIfAborted(options);
      if (next) values.set(providerId, next);
      return next ?? values.get(providerId);
    },
    delete(providerId, options) { throwIfAborted(options); values.delete(providerId); return Promise.resolve(); },
  };
}

export function createFakeLivepeerAccess(): LivepeerAccessPort & {
  credentials: CredentialStore & { value: string | undefined };
} {
  const credentials = createFakeCredentialStore();
  return { credentials };
}

export function createFakeModelPort(initial?: ModelSelection): ModelPort & {
  selected: ModelSelection | undefined;
  selections: ModelSelection[];
} {
  const models: ModelDescriptor[] = [
    { provider: "openai-codex", id: "gpt-test", label: "GPT Test" },
    { provider: "anthropic", id: "claude-test", label: "Claude Test" },
  ];
  return {
    selected: initial,
    selections: [],
    list(signal) { signal?.throwIfAborted(); return Promise.resolve(models); },
    current() { return this.selected; },
    select(selection, signal) {
      signal?.throwIfAborted();
      this.selected = selection;
      this.selections.push(selection);
      return Promise.resolve();
    },
  };
}

export function createFakeOAuthPort(configured: readonly ModelProviderId[] = []): ModelOAuthPort & {
  logins: ModelProviderId[];
  logouts: ModelProviderId[];
} {
  const enabled = new Set(configured);
  return {
    logins: [],
    logouts: [],
    list(signal) {
      signal?.throwIfAborted();
      return Promise.resolve((["openai-codex", "openai", "anthropic"] as const).map((provider) => ({ provider, configured: enabled.has(provider) })));
    },
    async login(provider: ModelProviderId, interaction: OAuthInteraction) {
      interaction.signal?.throwIfAborted();
      this.logins.push(provider);
      interaction.notify({ type: "auth_url", url: "https://oauth.example.test/authorize" });
      await interaction.prompt({ type: "input", message: "Authorization code" });
      enabled.add(provider);
    },
    logout(provider, signal) {
      signal?.throwIfAborted();
      this.logouts.push(provider);
      enabled.delete(provider);
      return Promise.resolve();
    },
  };
}

export function createFakeToolTransport(descriptors: ToolDescriptor[] = [], results: Record<string, ToolResult> = {}): ToolTransport & {
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  closed: boolean;
} {
  return {
    calls: [],
    closed: false,
    listTools(options?: CallOptions) { options?.signal?.throwIfAborted(); return Promise.resolve(descriptors); },
    callTool(name, input, options) {
      options?.signal?.throwIfAborted();
      this.calls.push({ name, input });
      return Promise.resolve(results[name] ?? { content: [{ type: "text", text: `${name} completed` }] });
    },
    close() { this.closed = true; return Promise.resolve(); },
  };
}

export function createFakeExecutionClient(
  descriptors: ToolDescriptor[] = [],
  results: Record<string, ToolResult> = {},
): LivepeerExecutionClient & {
  calls: Array<{ name: string; input: Record<string, unknown> }>;
} {
  const transport = createFakeToolTransport(descriptors, results);
  return Object.assign(createMcpLivepeerExecutionClient(transport), { calls: transport.calls });
}

export function createFakeShellAdapter(run?: (context: LivepeerInteractiveContext) => Promise<void>): InteractiveShellAdapter & {
  contexts: LivepeerInteractiveContext[];
} {
  return {
    contexts: [],
    async run(context) {
      this.contexts.push(context);
      await run?.(context);
    },
  };
}

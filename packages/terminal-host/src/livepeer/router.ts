import type { CallOptions, ToolDescriptor, ToolResult } from "@livepeer-agent/contracts";
import type {
  ActivationInput,
  ActivationRequestInput,
  CapabilityNameInput,
  JobInput,
  LivepeerExecutionClient,
  ProgressInput,
} from "@livepeer-agent/livepeer-client";
import { normalizeToolResult } from "./normalize.js";
import { buildRoutes } from "./policy.js";
import type {
  LivepeerAccessMode,
  LivepeerToolName,
  NormalizedToolResult,
  OperationContext,
  RoutedLivepeerTool,
  RoutedLivepeerToolPort,
  RoutedToolSnapshot,
  RoutingDiagnostic,
} from "./types.js";

interface GenerationState {
  snapshot: RoutedToolSnapshot;
  lease?: ClientLease;
}

interface ClientLease {
  client: LivepeerExecutionClient;
  activeCalls: number;
  retired: boolean;
  closePromise?: Promise<void>;
}

export class LivepeerToolRouter implements RoutedLivepeerToolPort {
  private state: GenerationState;
  private nextGeneration = 1;

  constructor(initialAccess: LivepeerAccessMode = "anonymous") {
    this.state = emptyState(0, initialAccess, []);
  }

  snapshot(): RoutedToolSnapshot { return cloneSnapshot(this.state.snapshot); }

  async reload(access: LivepeerAccessMode, client: LivepeerExecutionClient, signal?: AbortSignal): Promise<RoutedToolSnapshot> {
    signal?.throwIfAborted();
    let catalog: ToolDescriptor[];
    try {
      catalog = [...await client.describeOperations(signal ? { signal } : undefined)];
      signal?.throwIfAborted();
    } catch (error) {
      if (access === "authenticated") {
        if (client !== this.state.lease?.client) await client.close().catch(() => undefined);
        throw error;
      }
      const diagnostic: RoutingDiagnostic = { code: "catalog_load_failed", message: "The anonymous Livepeer tool catalog could not be loaded; no model-facing tools are enabled." };
      const next = emptyState(this.nextGeneration++, access, [diagnostic]);
      next.lease = this.leaseFor(client);
      await this.swap(next);
      return cloneSnapshot(next.snapshot);
    }
    const built = buildRoutes(catalog, access);
    const next: GenerationState = {
      snapshot: {
        generation: this.nextGeneration++,
        access,
        serverToolCount: catalog.length,
        routes: built.routes,
        diagnostics: built.diagnostics,
      },
      lease: this.leaseFor(client),
    };
    await this.swap(next);
    return cloneSnapshot(next.snapshot);
  }

  async call(
    name: LivepeerToolName,
    input: Record<string, unknown>,
    context: OperationContext = {},
    options: CallOptions = {},
  ): Promise<NormalizedToolResult> {
    const captured = this.state;
    const route = captured.snapshot.routes.find((candidate) => candidate.name === name);
    if (!route || !captured.lease) throw new Error(`Livepeer tool is not routed for this session: ${name}`);
    const lease = captured.lease;
    lease.activeCalls += 1;
    try {
      options.signal?.throwIfAborted();
      const result = await callExecutionClient(lease.client, name, input, callOptions(route, options));
      return normalizeToolResult(result, input, context);
    } finally {
      lease.activeCalls -= 1;
      await this.closeIfIdle(lease);
    }
  }

  async close(): Promise<void> {
    const current = this.state;
    this.state = emptyState(this.nextGeneration++, current.snapshot.access, []);
    if (current.lease) {
      current.lease.retired = true;
      await this.closeIfIdle(current.lease);
    }
  }

  private async swap(next: GenerationState): Promise<void> {
    const previous = this.state;
    this.state = next;
    if (!previous.lease || previous.lease === next.lease) return;
    previous.lease.retired = true;
    await this.closeIfIdle(previous.lease);
  }

  private leaseFor(client: LivepeerExecutionClient): ClientLease {
    if (this.state.lease?.client === client) return this.state.lease;
    return { client, activeCalls: 0, retired: false };
  }

  private async closeIfIdle(lease: ClientLease): Promise<void> {
    if (!lease.retired || lease.activeCalls > 0) return;
    lease.closePromise ??= lease.client.close().catch(() => undefined);
    await lease.closePromise;
  }
}

function callExecutionClient(
  client: LivepeerExecutionClient,
  name: LivepeerToolName,
  input: Record<string, unknown>,
  options: CallOptions,
): Promise<ToolResult> {
  switch (name) {
    case "list_capabilities": return client.capabilities.list(input, options);
    case "describe_capability": return client.capabilities.describe(input as unknown as CapabilityNameInput, options);
    case "get_pricing": return client.capabilities.pricing(input, options);
    case "me": return client.profile.get(options);
    case "me_update": return client.profile.update(input, options);
    case "request_activation": return client.access.requestActivation(input as unknown as ActivationRequestInput, options);
    case "activate": return client.access.activate(input as unknown as ActivationInput, options);
    case "upload": return client.assets.upload(input, options);
    case "create_media": return client.media.create(input, options);
    case "get_create_media": return client.media.get(input as unknown as JobInput, options);
    case "generate_project": return client.projects.generate(input, options);
    case "get_creative_job": return client.jobs.getCreative(input as unknown as JobInput, options);
    case "subscribe_progress": return client.jobs.subscribe(input as unknown as ProgressInput, options);
  }
}

function callOptions(route: RoutedLivepeerTool, options: CallOptions): CallOptions {
  return {
    ...options,
    timeoutMs: options.timeoutMs ?? route.timeoutMs,
    ...(options.maxTotalTimeoutMs !== undefined
      ? { maxTotalTimeoutMs: options.maxTotalTimeoutMs }
      : route.maxTotalTimeoutMs === undefined ? {} : { maxTotalTimeoutMs: route.maxTotalTimeoutMs }),
  };
}

function emptyState(
  generation: number,
  access: LivepeerAccessMode,
  diagnostics: RoutingDiagnostic[],
): GenerationState {
  return {
    snapshot: { generation, access, serverToolCount: 0, routes: [], diagnostics },
  };
}

function cloneSnapshot(snapshot: RoutedToolSnapshot): RoutedToolSnapshot {
  return structuredClone(snapshot);
}

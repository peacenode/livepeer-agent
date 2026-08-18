import type {
  CallOptions,
  ToolDescriptor,
  ToolResult,
  ToolTransport,
} from "@livepeer-agent/contracts";

export interface CapabilityListInput extends Record<string, unknown> {
  kind?: string;
  limit?: number;
  offset?: number;
  query?: string;
}

export interface CapabilityNameInput extends Record<string, unknown> {
  name: string;
}

export interface PricingInput extends Record<string, unknown> {
  kind?: string;
  name?: string;
  bypass_cache?: boolean;
}

export interface ProfileUpdateInput extends Record<string, unknown> {
  name?: string;
  use_case?: string;
  email?: string;
}

export interface ActivationRequestInput extends Record<string, unknown> {
  email: string;
}

export interface ActivationInput extends Record<string, unknown> {
  code: string;
}

export interface JobInput extends Record<string, unknown> {
  job_id: string;
}

export interface ProgressInput extends JobInput {
  budget_seconds?: number;
}

export type ExecutionInput = Record<string, unknown>;

/**
 * First-party Livepeer service boundary consumed by the terminal harness.
 *
 * The interface intentionally contains execution, identity, asset, and durable
 * job operations only. Agent delegation and server-side planning are not part
 * of this client; the local harness owns reasoning and sequencing.
 */
export interface LivepeerExecutionClient {
  describeOperations(options?: CallOptions): Promise<readonly ToolDescriptor[]>;
  capabilities: {
    list(input?: CapabilityListInput, options?: CallOptions): Promise<ToolResult>;
    describe(input: CapabilityNameInput, options?: CallOptions): Promise<ToolResult>;
    pricing(input?: PricingInput, options?: CallOptions): Promise<ToolResult>;
  };
  profile: {
    get(options?: CallOptions): Promise<ToolResult>;
    update(input: ProfileUpdateInput, options?: CallOptions): Promise<ToolResult>;
  };
  access: {
    requestActivation(input: ActivationRequestInput, options?: CallOptions): Promise<ToolResult>;
    activate(input: ActivationInput, options?: CallOptions): Promise<ToolResult>;
  };
  assets: {
    upload(input: ExecutionInput, options?: CallOptions): Promise<ToolResult>;
  };
  media: {
    create(input: ExecutionInput, options?: CallOptions): Promise<ToolResult>;
    get(input: JobInput, options?: CallOptions): Promise<ToolResult>;
  };
  projects: {
    generate(input: ExecutionInput, options?: CallOptions): Promise<ToolResult>;
  };
  jobs: {
    getCreative(input: JobInput, options?: CallOptions): Promise<ToolResult>;
    subscribe(input: ProgressInput, options?: CallOptions): Promise<ToolResult>;
  };
  close(): Promise<void>;
}

/** MCP remains one transport adapter; it is not the harness's product model. */
export function createMcpLivepeerExecutionClient(transport: ToolTransport): LivepeerExecutionClient {
  const call = (name: string, input: Record<string, unknown>, options?: CallOptions) =>
    transport.callTool(name, input, options);

  return {
    describeOperations: (options) => transport.listTools(options),
    capabilities: {
      list: (input = {}, options) => call("list_capabilities", input, options),
      describe: (input, options) => call("describe_capability", input, options),
      pricing: (input = {}, options) => call("get_pricing", input, options),
    },
    profile: {
      get: (options) => call("me", {}, options),
      update: (input, options) => call("me_update", input, options),
    },
    access: {
      requestActivation: (input, options) => call("request_activation", input, options),
      activate: (input, options) => call("activate", input, options),
    },
    assets: {
      upload: (input, options) => call("upload", input, options),
    },
    media: {
      create: (input, options) => call("create_media", input, options),
      get: (input, options) => call("get_create_media", input, options),
    },
    projects: {
      generate: (input, options) => call("generate_project", input, options),
    },
    jobs: {
      getCreative: (input, options) => call("get_creative_job", input, options),
      subscribe: (input, options) => call("subscribe_progress", input, options),
    },
    close: () => transport.close(),
  };
}

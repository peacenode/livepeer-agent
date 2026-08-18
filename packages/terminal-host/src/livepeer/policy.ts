import type { ToolDescriptor } from "@livepeer-agent/contracts";
import type {
  LivepeerAccessMode,
  LivepeerToolName,
  RoutedLivepeerTool,
  RoutingDiagnostic,
} from "./types.js";

interface Policy {
  anonymous: boolean;
  approval: RoutedLivepeerTool["approval"];
  timeoutMs: number;
  maxTotalTimeoutMs?: number;
  guard(descriptor: ToolDescriptor): boolean;
}

const READ_TIMEOUT = 120_000;
const GENERATION_TIMEOUT = 120_000;
const MAX_GENERATION_TIMEOUT = 20 * 60_000;

const POLICIES: Record<LivepeerToolName, Policy> = {
  list_capabilities: {
    anonymous: true, approval: "automatic", timeoutMs: READ_TIMEOUT,
    guard: (tool) => readOnly(tool) && hasProperties(tool, ["kind", "limit", "offset"])
      && enumIncludes(tool, "kind", ["ai", "tool", "mcp"]),
  },
  describe_capability: {
    anonymous: false, approval: "automatic", timeoutMs: READ_TIMEOUT,
    guard: (tool) => readOnly(tool) && requires(tool, ["name"]) && propertyType(tool, "name", "string"),
  },
  get_pricing: {
    anonymous: true, approval: "automatic", timeoutMs: READ_TIMEOUT,
    guard: (tool) => readOnly(tool) && hasProperties(tool, ["kind", "name", "bypass_cache"])
      && enumIncludes(tool, "kind", ["ai", "tool", "mcp", "all"]),
  },
  me: {
    anonymous: true, approval: "automatic", timeoutMs: READ_TIMEOUT,
    guard: (tool) => schema(tool).type === "object",
  },
  me_update: {
    anonymous: false, approval: "required", timeoutMs: READ_TIMEOUT,
    guard: (tool) => hasProperties(tool, ["name", "use_case", "email"])
      && propertyType(tool, "name", "string") && propertyType(tool, "use_case", "string")
      && propertyType(tool, "email", "string"),
  },
  request_activation: {
    anonymous: true, approval: "required", timeoutMs: READ_TIMEOUT,
    guard: (tool) => propertyType(tool, "email", "string"),
  },
  activate: {
    anonymous: true, approval: "required", timeoutMs: READ_TIMEOUT,
    guard: (tool) => requires(tool, ["code"]) && propertyType(tool, "code", "string"),
  },
  upload: {
    anonymous: true, approval: "automatic", timeoutMs: READ_TIMEOUT,
    guard: (tool) => hasProperties(tool, ["data", "mime_type", "kind", "filename"])
      && propertyType(tool, "data", "string") && propertyType(tool, "mime_type", "string")
      && propertyType(tool, "kind", "string") && propertyType(tool, "filename", "string"),
  },
  create_media: {
    anonymous: true, approval: "required", timeoutMs: GENERATION_TIMEOUT, maxTotalTimeoutMs: MAX_GENERATION_TIMEOUT,
    guard: (tool) => requires(tool, ["action"]) && propertyType(tool, "action", "string")
      && enumIncludes(tool, "action", ["generate", "animate", "music", "tts", "mux_audio", "lipsync", "subtitle", "upscale", "publish", "comfy_workflow"]),
  },
  get_create_media: {
    anonymous: false, approval: "automatic", timeoutMs: READ_TIMEOUT,
    guard: (tool) => readOnly(tool) && requires(tool, ["job_id"])
      && patternIs(tool, "job_id", "^mjob_[a-z0-9]{6,32}$"),
  },
  generate_project: {
    anonymous: true, approval: "required", timeoutMs: GENERATION_TIMEOUT, maxTotalTimeoutMs: MAX_GENERATION_TIMEOUT,
    guard: (tool) => requires(tool, ["title", "scenes"])
      && propertyType(tool, "title", "string") && propertyType(tool, "scenes", "array"),
  },
  get_creative_job: {
    anonymous: false, approval: "automatic", timeoutMs: READ_TIMEOUT,
    guard: (tool) => readOnly(tool) && requires(tool, ["job_id"])
      && patternIs(tool, "job_id", "^cjob_[a-z0-9]{6,32}$"),
  },
  subscribe_progress: {
    anonymous: false, approval: "automatic", timeoutMs: 30_000,
    guard: (tool) => readOnly(tool) && requires(tool, ["job_id"])
      && patternIs(tool, "job_id", "^(mjob|cjob|ltj|atask|mood)_[a-z0-9]{6,32}$")
      && propertyType(tool, "budget_seconds", "integer"),
  },
};

export function buildRoutes(
  catalog: readonly ToolDescriptor[],
  access: LivepeerAccessMode,
): { routes: RoutedLivepeerTool[]; diagnostics: RoutingDiagnostic[] } {
  const byName = new Map(catalog.map((descriptor) => [descriptor.name, descriptor]));
  const routes: RoutedLivepeerTool[] = [];
  const diagnostics: RoutingDiagnostic[] = [];
  for (const [name, policy] of Object.entries(POLICIES) as Array<[LivepeerToolName, Policy]>) {
    if (access === "anonymous" && !policy.anonymous) continue;
    const descriptor = byName.get(name);
    if (!descriptor) {
      diagnostics.push({ tool: name, code: "missing", message: `${name} is not advertised by this Livepeer session.` });
      continue;
    }
    if (!policy.guard(descriptor)) {
      diagnostics.push({ tool: name, code: "incompatible_schema", message: `${name} was omitted because its live schema is incompatible with the routed contract.` });
      continue;
    }
    routes.push({
      name,
      descriptor: structuredClone(descriptor),
      approval: policy.approval,
      timeoutMs: policy.timeoutMs,
      ...(policy.maxTotalTimeoutMs === undefined ? {} : { maxTotalTimeoutMs: policy.maxTotalTimeoutMs }),
    });
  }
  return { routes, diagnostics };
}

function schema(tool: ToolDescriptor): Record<string, unknown> { return tool.inputSchema; }
function properties(tool: ToolDescriptor): Record<string, unknown> {
  const value = schema(tool).properties;
  return isRecord(value) ? value : {};
}
function property(tool: ToolDescriptor, name: string): Record<string, unknown> | undefined {
  const value = properties(tool)[name];
  return isRecord(value) ? value : undefined;
}
function readOnly(tool: ToolDescriptor): boolean { return tool.annotations?.readOnlyHint === true; }
function hasProperties(tool: ToolDescriptor, names: string[]): boolean { return names.every((name) => property(tool, name)); }
function requires(tool: ToolDescriptor, names: string[]): boolean {
  const required = schema(tool).required;
  return Array.isArray(required) && names.every((name) => required.includes(name));
}
function propertyType(tool: ToolDescriptor, name: string, type: string): boolean { return property(tool, name)?.type === type; }
function enumIncludes(tool: ToolDescriptor, name: string, expected: string[]): boolean {
  const values = property(tool, name)?.enum;
  return Array.isArray(values) && expected.every((value) => values.includes(value));
}
function patternIs(tool: ToolDescriptor, name: string, expected: string): boolean { return property(tool, name)?.pattern === expected; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

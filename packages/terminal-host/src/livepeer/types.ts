import type { CallOptions, ToolDescriptor, ToolResult } from "@livepeer-agent/contracts";
import type { LivepeerExecutionClient } from "@livepeer-agent/livepeer-client";

export const LIVEPEER_TOOL_NAMES = [
  "list_capabilities",
  "describe_capability",
  "get_pricing",
  "me",
  "me_update",
  "request_activation",
  "activate",
  "upload",
  "create_media",
  "get_create_media",
  "generate_project",
  "get_creative_job",
  "subscribe_progress",
] as const;

export type LivepeerToolName = (typeof LIVEPEER_TOOL_NAMES)[number];
export type LivepeerAccessMode = "anonymous" | "authenticated";
export type RouteApproval = "automatic" | "required";

export interface RoutedLivepeerTool {
  name: LivepeerToolName;
  descriptor: ToolDescriptor;
  approval: RouteApproval;
  timeoutMs: number;
  maxTotalTimeoutMs?: number;
}

export interface RoutingDiagnostic {
  tool?: LivepeerToolName;
  code: "missing" | "incompatible_schema" | "catalog_load_failed";
  message: string;
}

export interface RoutedToolSnapshot {
  generation: number;
  access: LivepeerAccessMode;
  serverToolCount: number;
  routes: readonly RoutedLivepeerTool[];
  diagnostics: readonly RoutingDiagnostic[];
}

export interface OperationContext {
  requestId?: string;
  originalUserPrompt?: string;
  submittedPrompt?: string;
  parentReferences?: readonly AssetReference[];
}

export interface AssetReference {
  assetId?: string;
  jobId?: string;
  projectId?: string;
  sceneIndex?: number;
  kind?: "image" | "video" | "audio" | "3d" | "text";
  url?: string;
  capability?: string;
  modelId?: string;
  originalPrompt?: string;
  submittedPrompt?: string;
  sourceUrls: string[];
  parentAssetIds: string[];
}

export interface PricingReference {
  name: string;
  displayPriceUsd?: number;
  displayUnit?: string;
  unitKind?: string;
  modelId?: string;
}

export interface ModelSafeToolResult {
  isError: boolean;
  error?: { code?: string; message: string };
  status?: string;
  references: AssetReference[];
  pricing: PricingReference[];
  messages?: string[];
  data?: unknown;
  summary: string;
}

export interface NormalizedToolResult {
  raw: ToolResult;
  isError: boolean;
  error?: { code?: string; message: string };
  status?: string;
  references: AssetReference[];
  pricing: PricingReference[];
  model: ModelSafeToolResult;
}

export interface RoutedLivepeerToolPort {
  snapshot(): RoutedToolSnapshot;
  reload(access: LivepeerAccessMode, client: LivepeerExecutionClient, signal?: AbortSignal): Promise<RoutedToolSnapshot>;
  call(name: LivepeerToolName, input: Record<string, unknown>, context?: OperationContext, options?: CallOptions): Promise<NormalizedToolResult>;
  close(): Promise<void>;
}

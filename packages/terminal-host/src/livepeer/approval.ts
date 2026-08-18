import type { ToolDefinition } from "@livepeer/pi-coding-agent";
import type { NormalizedToolResult, OperationContext, RoutedLivepeerTool, RoutedLivepeerToolPort } from "./types.js";

export interface HostToolApprovalDisclosure {
  title: string;
  message: string;
  risk?: "standard" | "destructive";
}

export type ApprovalCapableToolDefinition = ToolDefinition & {
  approval?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => HostToolApprovalDisclosure | undefined | Promise<HostToolApprovalDisclosure | undefined>;
};

export interface ApprovalController {
  approval(
    toolCallId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostToolApprovalDisclosure | undefined>;
  prepareExecution(
    toolCallId: string,
    input: Record<string, unknown>,
  ): { input: Record<string, unknown>; context?: OperationContext };
}

export interface LivepeerBudgetPolicy {
  maxCostUsd(): number | undefined;
}

interface ProjectPreflight {
  fingerprint: string;
  context: OperationContext;
}

export function createApprovalController(
  route: RoutedLivepeerTool,
  router: RoutedLivepeerToolPort,
  context?: (toolCallId: string, input: Record<string, unknown>) => OperationContext,
  budget?: LivepeerBudgetPolicy,
): ApprovalController {
  const projectPreflights = new Map<string, ProjectPreflight>();
  const mediaPreflights = new Map<string, { context: OperationContext; fingerprint: string; input: Record<string, unknown> }>();
  const accountPreflights = new Map<string, string>();
  return {
    async approval(toolCallId, input, signal) {
      if (route.approval === "automatic") return undefined;
      signal?.throwIfAborted();
      if (route.name === "create_media") {
        const operationContext = context?.(toolCallId, input) ?? { requestId: toolCallId };
        const preparedInput = applyMediaBudget(input, budget?.maxCostUsd());
        const disclosure = await createMediaDisclosure(preparedInput, router, operationContext, signal);
        mediaPreflights.set(toolCallId, { context: operationContext, fingerprint: fingerprint(input), input: preparedInput });
        return disclosure;
      }
      if (route.name === "generate_project") {
        const operationContext = context?.(toolCallId, input) ?? { requestId: toolCallId };
        const preflightInput = { ...input, confirm: false };
        const result = await router.call(
          "generate_project",
          preflightInput,
          operationContext,
          signal ? { signal } : undefined,
        );
        throwOnToolError("generate_project preflight", result);
        enforceProjectBudget(result, budget?.maxCostUsd());
        projectPreflights.set(toolCallId, {
          fingerprint: fingerprint(input),
          context: operationContext,
        });
        return projectDisclosure(input, result, budget?.maxCostUsd());
      }
      if (route.name === "me_update" || route.name === "request_activation" || route.name === "activate") {
        accountPreflights.set(toolCallId, fingerprint(input));
        return accountDisclosure(route.name, input);
      }
      throw new Error(`Approval policy is not implemented for routed Livepeer tool: ${route.name}`);
    },
    prepareExecution(toolCallId, input) {
      if (route.name === "create_media") {
        const preflight = mediaPreflights.get(toolCallId);
        mediaPreflights.delete(toolCallId);
        if (!preflight) throw new Error("create_media execution requires a successful approval preflight.");
        if (preflight.fingerprint !== fingerprint(input)) throw new Error("create_media input changed after approval preflight.");
        return { input: preflight.input, context: preflight.context };
      }
      if (route.name === "me_update" || route.name === "request_activation" || route.name === "activate") {
        const approved = accountPreflights.get(toolCallId);
        accountPreflights.delete(toolCallId);
        if (!approved) throw new Error(`${route.name} execution requires explicit approval.`);
        if (approved !== fingerprint(input)) throw new Error(`${route.name} input changed after approval.`);
        return { input };
      }
      if (route.name !== "generate_project") return { input };
      const preflight = projectPreflights.get(toolCallId);
      projectPreflights.delete(toolCallId);
      if (!preflight) throw new Error("generate_project execution requires a successful approval preflight.");
      if (preflight.fingerprint !== fingerprint(input)) {
        throw new Error("generate_project input changed after approval preflight.");
      }
      return {
        input: { ...input, confirm: true },
        context: preflight.context,
      };
    },
  };
}

function accountDisclosure(
  name: "me_update" | "request_activation" | "activate",
  input: Record<string, unknown>,
): HostToolApprovalDisclosure {
  if (name === "request_activation") {
    return {
      title: "Send Livepeer activation email",
      message: `Recipient: ${firstString(input, ["email"]) ?? "unavailable"}\nPurpose: verify the existing Livepeer credential`,
    };
  }
  if (name === "activate") {
    return {
      title: "Activate Livepeer access",
      message: "Redeem the supplied one-time code for the current Livepeer session.",
    };
  }
  const fields = ["name", "use_case", "email"].filter((field) => firstString(input, [field]) !== undefined);
  return {
    title: "Update Livepeer profile",
    message: `Fields: ${fields.join(", ") || "none"}\nCredential: keep the current Daydream API key`,
  };
}

async function createMediaDisclosure(
  input: Record<string, unknown>,
  router: RoutedLivepeerToolPort,
  operationContext: OperationContext,
  signal: AbortSignal | undefined,
): Promise<HostToolApprovalDisclosure> {
  const target = firstString(input, ["model_override"]);
  if (!target) throw new Error("create_media requires a nonempty model_override before pricing and approval.");
  let pricing = "unavailable";
  if (router.snapshot().routes.some(({ name }) => name === "get_pricing")) {
    try {
      const result = await router.call(
        "get_pricing",
        { kind: "all", name: target },
        operationContext,
        signal ? { signal } : undefined,
      );
      if (!result.isError) pricing = formatPricing(result, target) ?? "unavailable";
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  signal?.throwIfAborted();
  const action = firstString(input, ["action"]) ?? "unavailable";
  return {
    title: `Approve Livepeer ${action}`,
    message: [
      `Model: ${target}`,
      `Scope: ${formatScope(input, action)}`,
      `Price: ${pricing}`,
    ].join("\n"),
  };
}

function projectDisclosure(
  input: Record<string, unknown>,
  result: NormalizedToolResult,
  maxCostUsd?: number,
): HostToolApprovalDisclosure {
  const structured = result.raw.structuredContent;
  const total = findValue(structured, ["total_estimate_usd", "totalEstimateUsd", "estimated_total_usd", "estimatedTotalUsd"]);
  const attempts = findValue(structured, ["max_attempts", "maxAttempts"]);
  return {
    title: "Approve Livepeer project generation",
    message: [
      "Route: generate_project (approved dry run → confirmed execution)",
      `Scope: ${formatProjectScope(input)}`,
      `Models: ${selectedModels(input).join(", ")}`,
      `Resolved routes: ${formatEstimate(findValue(structured, ["resolved_routes", "resolvedRoutes"]))}`,
      `Downgrades: ${formatEstimate(findValue(structured, ["downgrades"]))}`,
      `Itemized estimate: ${formatEstimate(findValue(structured, ["itemized_estimate", "itemizedEstimate"]))}`,
      `Unknown estimate items: ${formatEstimate(findValue(structured, ["unknown_estimates", "unknownEstimates", "unknown_items", "unknownItems"]))}`,
      `Total estimate: ${typeof total === "number" && Number.isFinite(total) ? `$${total.toFixed(4)} USD` : formatEstimate(total)}`,
      `Session budget cap: ${maxCostUsd === undefined ? "not set" : `$${maxCostUsd.toFixed(2)} USD`}`,
      `Maximum attempts: ${formatAttempts(input, attempts)}`,
    ].join("\n"),
  };
}

function applyMediaBudget(input: Record<string, unknown>, maxCostUsd: number | undefined): Record<string, unknown> {
  const sanitized = { ...input };
  delete sanitized.max_cost_usd;
  delete sanitized.maxCostUsd;
  return maxCostUsd === undefined ? sanitized : { ...sanitized, max_cost_usd: maxCostUsd };
}

function enforceProjectBudget(result: NormalizedToolResult, maxCostUsd: number | undefined): void {
  if (maxCostUsd === undefined) return;
  const total = findValue(result.raw.structuredContent, [
    "total_estimate_usd",
    "totalEstimateUsd",
    "estimated_total_usd",
    "estimatedTotalUsd",
  ]);
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error("Project estimate is unavailable, so the session budget cannot be enforced. Raise or disable /budget to continue.");
  }
  if (total > maxCostUsd) {
    throw new Error(`Project estimate $${total.toFixed(4)} exceeds the $${maxCostUsd.toFixed(2)} session budget.`);
  }
}

function throwOnToolError(label: string, result: NormalizedToolResult): void {
  if (!result.isError) return;
  const prefix = result.error?.code ? `[${result.error.code}] ` : "";
  throw new Error(`${label} failed: ${prefix}${result.error?.message ?? "Livepeer returned an error."}`);
}

function formatPricing(result: NormalizedToolResult, target: string): string | undefined {
  const price = result.pricing.find((item) => item.name === target || item.modelId === target);
  if (!price) return undefined;
  const amount = price.displayPriceUsd === undefined ? "price unavailable" : `$${price.displayPriceUsd} USD`;
  return [...new Set([amount, price.displayUnit, price.unitKind].filter((value): value is string => Boolean(value)))].join(" · ");
}

function selectedModels(input: Record<string, unknown>): string[] {
  const global = firstString(input, ["global_model_override"]);
  if (global) return [global];
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  return [...new Set(scenes.flatMap((scene) => {
    if (!isRecord(scene)) return [];
    if (scene.source === "stock") return ["stock"];
    const model = firstString(scene, ["model_override"]);
    return model ? [model] : [];
  }))];
}

function formatScope(input: Record<string, unknown>, action: string): string {
  const explicit = firstString(input, ["scope"]);
  if (explicit) return explicit;
  const count = firstFiniteNumber(input, ["count", "num_outputs", "numOutputs"]);
  return count === undefined ? `one ${action} operation` : `${count} ${action} outputs`;
}

function formatProjectScope(input: Record<string, unknown>): string {
  const title = firstString(input, ["title"]) ?? "untitled project";
  const scenes = Array.isArray(input.scenes) ? input.scenes.length : 0;
  return `${title} · ${scenes} scene${scenes === 1 ? "" : "s"}`;
}

function formatAttempts(input: Record<string, unknown>, preflight?: unknown): string {
  const returned = typeof preflight === "number" && Number.isInteger(preflight) && preflight > 0 ? preflight : undefined;
  return String(returned ?? firstPositiveInteger(input, ["max_attempts", "maxAttempts"]) ?? 1);
}

function formatEstimate(value: unknown): string {
  if (value === undefined || value === null) return "unavailable";
  if (typeof value === "string") return value || "unavailable";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return "unavailable"; }
}

function findValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined) return record[key];
  for (const item of Object.values(record)) {
    const found = findValue(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
  return undefined;
}

function firstFiniteNumber(input: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function firstPositiveInteger(input: Record<string, unknown>, keys: readonly string[]): number | undefined {
  const value = firstFiniteNumber(input, keys);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

function fingerprint(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

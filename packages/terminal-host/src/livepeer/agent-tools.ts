import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { CallOptions, ToolProgress } from "@livepeer-agent/contracts";
import { resizeImage } from "@livepeer/pi-coding-agent";
import {
  createApprovalController,
  type ApprovalCapableToolDefinition,
  type LivepeerBudgetPolicy,
} from "./approval.js";
import { createLivepeerToolRenderers } from "./rendering.js";
import type {
  LivepeerToolName,
  ModelSafeToolResult,
  NormalizedToolResult,
  OperationContext,
  RouteApproval,
  RoutedLivepeerTool,
  RoutedLivepeerToolPort,
} from "./types.js";

const MEDIA_POLL_INTERVAL_MS = 2_000;
const MEDIA_WAIT_TIMEOUT_MS = 10 * 60_000;
const CREATIVE_WAIT_TIMEOUT_MS = 20 * 60_000;
const PROGRESS_SUBSCRIPTION_SECONDS = 25;
const MEDIA_SUCCESS_STATUSES = new Set(["complete", "completed", "done", "succeeded"]);
const MEDIA_FAILURE_STATUSES = new Set(["failed", "cancelled", "canceled"]);
const MAX_LOCAL_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_UPLOAD_BYTES = 2.5 * 1024 * 1024;
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const HOST_TOOL_COPY: Record<LivepeerToolName, { description: string; promptSnippet: string }> = {
  list_capabilities: {
    description: "Find public, available Livepeer AI models and deterministic media tools. When the user names a model or family, pass it as query; the host searches the complete paginated catalog in one clean tool call. Do not manually paginate repeated list calls.",
    promptSnippet: "Find available Livepeer models and tools; use query for a named model family.",
  },
  describe_capability: {
    description: "Describe one advertised Livepeer capability, including its current inputs, constraints, and availability.",
    promptSnippet: "Inspect one Livepeer capability.",
  },
  get_pricing: {
    description: "Get current public display pricing for a named Livepeer model or deterministic tool.",
    promptSnippet: "Get current Livepeer pricing.",
  },
  me: {
    description: "Read the profile and key class associated with the credential MCP actually received. Call this before any email activation flow or when premium access is unexpectedly denied; it is the authority for detecting a keyless shell or the wrong effective key.",
    promptSnippet: "Check the effective Livepeer credential and profile before diagnosing or changing access.",
  },
  me_update: {
    description: "Create or update the profile attached to the current Livepeer credential. Change only fields explicitly supplied by the user. For email verification, attach the supplied email before calling request_activation.",
    promptSnippet: "Attach user-supplied profile fields to the current Livepeer credential.",
  },
  request_activation: {
    description: "Send one activation code to the user-provided email address. Invoke this for explicit verify-email, activate-access, sign-me-up, or send-code intent when the user has supplied an email; ask only for the email when it is missing. Call me first. For an existing Daydream credential, call me_update with that email before request_activation; this verifies the existing credential and does not mint or replace the Daydream API key. For a keyless caller, activation increases only the preview allowance and does not unlock premium models; tell the user to configure their Daydream key instead when premium access is the goal. Never claim the email was sent until this tool returns success.",
    promptSnippet: "Before verification call me; keyless activation changes preview allowance only, while premium access requires the Daydream key to reach MCP.",
  },
  activate: {
    description: "Redeem an actual user-provided activation code for the current Livepeer session. Use only after request_activation has succeeded and the user supplies the received code. If no code was supplied, do not imply that one was sent: ask for an email and use the request_activation flow instead. Report the returned tier and allowance accurately, then call me to verify which principal and key class MCP sees. Never summarize keyless PREVIEW activation as full model access.",
    promptSnippet: "After redeeming a supplied code, report the exact tier and call me; keyless PREVIEW activation is not premium model access.",
  },
  upload: {
    description: "Upload one local image through Livepeer and return a hosted URL. Pass the exact local path from the user's attachment or from browser_screenshot. For any other absolute local image path, call upload directly; the shell asks the user to approve that exact file. The host reads, resizes, and encodes it internally. Never use bash, base64, sips, curl, or temporary files for attached media.",
    promptSnippet: "Upload an attached image or browser screenshot before using it as source media.",
  },
  create_media: {
    description: "Create or transform one media asset with an explicit model_override. A local attachment path is not a source_url: call upload once, then use its returned hosted URL. Never encode attached media with shell commands. The host owns approval and the user's /budget cap; do not supply max_cost_usd.",
    promptSnippet: "Create media with a named model.",
  },
  get_create_media: {
    description: "Read the current status and result of a create_media job by job_id. Do not resubmit work merely because it is still running.",
    promptSnippet: "Check a media job.",
  },
  generate_project: {
    description: "Generate an explicit multi-scene project. Select a global_model_override or a model_override for every non-stock scene; the host performs the dry run, approval, and confirmed execution.",
    promptSnippet: "Generate a routed multi-scene project.",
  },
  get_creative_job: {
    description: "Read one current status snapshot for a creative job by job_id. When the user wants a running job watched through completion, call subscribe_progress instead; the host automatically re-subscribes until terminal status.",
    promptSnippet: "Check a creative job.",
  },
  subscribe_progress: {
    description: "Watch progress for a supported Livepeer job_id. Call once; the host consumes MCP progress notifications and automatically re-subscribes in bounded windows until terminal status or its overall safety timeout. Do not manually poll or tell the user to check back.",
    promptSnippet: "Watch a job through completion; the host re-subscribes automatically.",
  },
};

export interface RoutedToolRegistration {
  name: RoutedLivepeerTool["name"];
  approval: RouteApproval;
  definition: ApprovalCapableToolDefinition;
}

export interface LocalImageUploadPolicy {
  isAllowed(path: string): boolean;
}

/**
 * Creates the exact model-facing tool set for one published router generation.
 * Re-run this after reload and replace the session's custom tools atomically.
 */
export function createLivepeerToolRegistrations(
  router: RoutedLivepeerToolPort,
  context?: (toolCallId: string, input: Record<string, unknown>) => OperationContext,
  budget?: LivepeerBudgetPolicy,
  localImages?: LocalImageUploadPolicy,
): RoutedToolRegistration[] {
  return router.snapshot().routes
    // The public catalog already contains model ID, price, availability, and
    // invocation details. Treating the separately gated description endpoint
    // as a model-facing prerequisite can block an otherwise permitted media
    // call, so keep it available to deterministic CLI callers only.
    .filter((route) => route.name !== "describe_capability")
    .map((route) => ({
    name: route.name,
    approval: route.approval,
    definition: createDefinition(route, router, context, budget, localImages),
    }));
}

function createDefinition(
  route: RoutedLivepeerTool,
  router: RoutedLivepeerToolPort,
  context?: (toolCallId: string, input: Record<string, unknown>) => OperationContext,
  budget?: LivepeerBudgetPolicy,
  localImages?: LocalImageUploadPolicy,
): ApprovalCapableToolDefinition {
  const approval = createApprovalController(route, router, context, budget);
  const localImageApprovals = new Map<string, string>();
  const copy = HOST_TOOL_COPY[route.name];
  const liveDetails = route.descriptor.description?.trim();
  const usage = `${copy.description}${liveDetails ? ` Live schema details: ${liveDetails}` : ""}`;
  const description = route.approval === "required"
    ? `${usage} When the arguments are ready, call this tool directly. Do not ask for a separate conversational yes; the shell obtains approval before execution.`
    : usage;
  return {
    name: route.name,
    label: route.descriptor.title ?? route.name,
    description,
    promptSnippet: copy.promptSnippet,
    parameters: modelFacingSchema(route),
    ...createLivepeerToolRenderers(route.name),
    approval: (toolCallId, params, signal) => {
      const input = prepareToolInput(route, params);
      if (route.name === "upload") {
        const operationContext = context?.(toolCallId, input) ?? { requestId: toolCallId };
        const path = requireNonemptyString(input, "path", "upload requires a local image path.");
        if (!isTrustedLocalImage(path, operationContext, localImages)) {
          return createLocalImageApproval(path, signal).then((disclosure) => {
            localImageApprovals.set(toolCallId, path);
            return disclosure;
          });
        }
      }
      return approval.approval(toolCallId, input, signal);
    },
    execute: async (toolCallId, params, signal, onUpdate, extensionContext) => {
      const input = prepareToolInput(route, params);
      const approvedLocalImage = localImageApprovals.get(toolCallId);
      localImageApprovals.delete(toolCallId);
      if (approvedLocalImage !== undefined && approvedLocalImage !== input.path) {
        throw new Error("upload path changed after approval.");
      }
      const prepared = approval.prepareExecution(toolCallId, input);
      const operationContext = prepared.context ?? context?.(toolCallId, input) ?? { requestId: toolCallId };
      const progress = createLivepeerProgressReporter(route.name, onUpdate, extensionContext);
      progress.set(toolWorkingMessage(route.name, prepared.input));
      try {
        const submitted = route.name === "list_capabilities" && nonemptyString(prepared.input.query)
          ? await searchCapabilities(router, prepared.input, operationContext, signal)
          : await router.call(
            route.name,
            route.name === "upload"
              ? await prepareLocalImageUpload(prepared.input, operationContext, localImages, approvedLocalImage)
              : transportInput(prepared.input),
            operationContext,
            progress.callOptions(signal),
          );
        const submittedPrompt = nonemptyString(prepared.input.prompt) ?? operationContext.submittedPrompt;
        const result = route.name === "create_media"
          ? await waitForMediaJob(router, submitted, {
            ...operationContext,
            ...(submittedPrompt ? { submittedPrompt } : {}),
          }, signal, progress)
          : route.name === "subscribe_progress"
            ? await waitForCreativeJob(router, submitted, operationContext, signal, progress)
          : submitted;
        return modelToolResult(result.model);
      } catch (error) {
        if (isAbortError(error)) throw error;
        return modelToolResult(toolExecutionFailure(route.name, prepared.input, error));
      } finally {
        progress.reset();
      }
    },
  };
}

interface LivepeerProgressReporter {
  callOptions(signal?: AbortSignal, overrides?: Omit<CallOptions, "signal" | "onProgress">): CallOptions;
  reportResult(result: NormalizedToolResult): void;
  set(message: string): void;
  reset(): void;
}

function createLivepeerProgressReporter(
  toolName: LivepeerToolName,
  onUpdate: Parameters<ApprovalCapableToolDefinition["execute"]>[3],
  extensionContext: Parameters<ApprovalCapableToolDefinition["execute"]>[4],
): LivepeerProgressReporter {
  let lastMessage = "";
  const set = (message: string) => {
    const cleaned = cleanProgressMessage(message);
    if (!cleaned || cleaned === lastMessage) return;
    lastMessage = cleaned;
    extensionContext.ui?.setWorkingMessage?.(cleaned);
  };
  const reportProgress = (event: ToolProgress) => {
    const message = progressEventMessage(event, toolName);
    set(message);
    if (!onUpdate) return;
    const details: ModelSafeToolResult = {
      isError: false,
      status: progressStatus(event) ?? "running",
      references: [],
      pricing: [],
      messages: [message],
      data: {
        ...(event.progress === undefined ? {} : { progress: event.progress }),
        ...(event.total === undefined ? {} : { total: event.total }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      },
      summary: "",
    };
    details.summary = JSON.stringify({ ...details, summary: undefined });
    onUpdate(modelToolResult(details));
  };
  return {
    callOptions: (signal, overrides = {}) => ({
      ...overrides,
      ...(signal ? { signal } : {}),
      onProgress: reportProgress,
    }),
    reportResult: (result) => {
      onUpdate?.(modelToolResult(result.model));
      set(progressResultMessage(result, toolName));
    },
    set,
    reset: () => extensionContext.ui?.setWorkingMessage?.(),
  };
}

function progressEventMessage(event: ToolProgress, toolName: LivepeerToolName): string {
  const base = cleanProgressMessage(event.message ?? progressMetadataMessage(event.metadata) ?? toolWorkingMessage(toolName, {}));
  if (event.progress === undefined) return base;
  const count = event.total === undefined ? String(event.progress) : `${event.progress}/${event.total}`;
  return event.total !== undefined && base.replace(/\s+/gu, "").includes(`${event.progress}/${event.total}`)
    ? base
    : `${base} · ${count}`;
}

function progressMetadataMessage(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  for (const key of ["stage", "status", "phase", "detail"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function progressStatus(event: ToolProgress): string | undefined {
  const value = event.metadata?.status ?? event.metadata?.stage;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function progressResultMessage(result: NormalizedToolResult, toolName: LivepeerToolName): string {
  const serverMessage = result.model.messages?.find((message) => message.trim().length > 0);
  if (serverMessage) return serverMessage;
  const status = result.status?.trim();
  const complete = numericNestedValue(result.model.data, ["completed", "completed_count", "completedCount", "scenes_completed"]);
  const total = numericNestedValue(result.model.data, ["total", "total_count", "totalCount", "scene_count", "sceneCount"]);
  const count = complete === undefined ? "" : ` · ${complete}${total === undefined ? "" : `/${total}`}`;
  return status ? `${titleCaseWords(status)}${count}` : toolWorkingMessage(toolName, {});
}

function numericNestedValue(value: unknown, keys: readonly string[]): number | undefined {
  const found = nestedValue(value, keys);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

function cleanProgressMessage(message: string): string {
  return message.replace(/\s+/gu, " ").trim().slice(0, 180) || "Working…";
}

function titleCaseWords(value: string): string {
  const spaced = value.replace(/[_-]+/gu, " ").trim();
  return spaced ? `${spaced[0]?.toUpperCase()}${spaced.slice(1)}` : "Working…";
}

function toolWorkingMessage(toolName: LivepeerToolName, input: Record<string, unknown>): string {
  const jobId = nonemptyString(input.job_id);
  const messages: Record<LivepeerToolName, string> = {
    list_capabilities: "Loading Livepeer capabilities…",
    describe_capability: "Loading capability details…",
    get_pricing: "Checking Livepeer pricing…",
    me: "Checking Livepeer access…",
    me_update: "Updating Livepeer profile…",
    request_activation: "Requesting Livepeer activation…",
    activate: "Activating Livepeer access…",
    upload: "Preparing image upload…",
    create_media: "Submitting media job…",
    get_create_media: jobId ? `Checking media job ${jobId}…` : "Checking media job…",
    generate_project: "Generating Livepeer project…",
    get_creative_job: jobId ? `Checking creative job ${jobId}…` : "Checking creative job…",
    subscribe_progress: jobId ? `Watching job ${jobId}…` : "Watching Livepeer job…",
  };
  return messages[toolName];
}

function nestedValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 6) return undefined;
  if (isRecord(value)) {
    for (const key of keys) if (value[key] !== undefined) return value[key];
    for (const nested of Object.values(value)) {
      const found = nestedValue(nested, keys, depth + 1);
      if (found !== undefined) return found;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const found = nestedValue(nested, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function waitForCreativeJob(
  router: RoutedLivepeerToolPort,
  submitted: NormalizedToolResult,
  context: OperationContext,
  signal: AbortSignal | undefined,
  progress: LivepeerProgressReporter,
): Promise<NormalizedToolResult> {
  if (submitted.isError || creativeJobIsReady(submitted)) return submitted;
  if (creativeJobHasFailed(submitted)) return asCreativeJobFailure(submitted);

  const jobId = submitted.references.find((reference) => reference.jobId)?.jobId;
  if (!jobId) throw new Error("Livepeer job tracking returned a nonterminal result without a job_id.");
  progress.reportResult(submitted);

  const routes = router.snapshot().routes;
  const canSubscribe = routes.some(({ name }) => name === "subscribe_progress");
  const canPoll = routes.some(({ name }) => name === "get_creative_job");
  if (!canSubscribe && !canPoll) return submitted;

  const deadline = Date.now() + CREATIVE_WAIT_TIMEOUT_MS;
  let latest = submitted;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (canSubscribe && remainingMs >= 5_000) {
      const budgetSeconds = Math.min(PROGRESS_SUBSCRIPTION_SECONDS, Math.floor(remainingMs / 1_000));
      progress.set(`Watching Livepeer render ${jobId}…`);
      latest = await router.call(
        "subscribe_progress",
        { job_id: jobId, budget_seconds: budgetSeconds },
        context,
        progress.callOptions(signal, {
          timeoutMs: (budgetSeconds + 5) * 1_000,
          maxTotalTimeoutMs: (budgetSeconds + 5) * 1_000,
        }),
      );
    } else if (canPoll) {
      await abortableDelay(Math.min(MEDIA_POLL_INTERVAL_MS, remainingMs), signal);
      latest = await router.call(
        "get_creative_job",
        { job_id: jobId },
        context,
        progress.callOptions(signal),
      );
    } else {
      break;
    }

    progress.reportResult(latest);
    if (latest.isError || creativeJobIsReady(latest)) return latest;
    if (creativeJobHasFailed(latest)) return asCreativeJobFailure(latest);

    // subscribe_progress normally blocks for its full budget. Avoid a tight
    // loop if an MCP implementation returns a nonterminal snapshot early.
    if (canSubscribe) await abortableDelay(Math.min(500, Math.max(0, deadline - Date.now())), signal);
  }
  return latest;
}

function creativeJobIsReady(result: NormalizedToolResult): boolean {
  return result.references.some((reference) => Boolean(reference.url))
    || MEDIA_SUCCESS_STATUSES.has(normalizedStatus(result));
}

function creativeJobHasFailed(result: NormalizedToolResult): boolean {
  return MEDIA_FAILURE_STATUSES.has(normalizedStatus(result));
}

function asCreativeJobFailure(result: NormalizedToolResult): NormalizedToolResult {
  const status = normalizedStatus(result);
  const jobId = result.references.find((reference) => reference.jobId)?.jobId;
  const error = result.error ?? {
    message: jobId ? `Creative job ${jobId} ${status}.` : `Creative job ${status}.`,
  };
  const model: ModelSafeToolResult = { ...result.model, isError: true, error };
  model.summary = JSON.stringify({ ...model, summary: undefined });
  return { ...result, isError: true, error, model };
}

async function waitForMediaJob(
  router: RoutedLivepeerToolPort,
  submitted: NormalizedToolResult,
  context: OperationContext,
  signal: AbortSignal | undefined,
  progress: LivepeerProgressReporter,
): Promise<NormalizedToolResult> {
  if (submitted.isError || mediaIsReady(submitted)) return submitted;
  if (mediaHasFailed(submitted)) return asMediaFailure(submitted);
  if (!router.snapshot().routes.some(({ name }) => name === "get_create_media")) return submitted;

  const jobId = submitted.references.find((reference) => reference.jobId)?.jobId;
  if (!jobId) throw new Error("create_media returned a nonterminal result without a job_id.");

  let latest = submitted;
  progress.reportResult(latest);
  const deadline = Date.now() + MEDIA_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await abortableDelay(Math.min(MEDIA_POLL_INTERVAL_MS, deadline - Date.now()), signal);
    if (Date.now() >= deadline) break;
    latest = await router.call(
      "get_create_media",
      { job_id: jobId },
      context,
      progress.callOptions(signal),
    );
    progress.reportResult(latest);
    if (latest.isError || mediaIsReady(latest)) return latest;
    if (mediaHasFailed(latest)) return asMediaFailure(latest);
  }
  return latest;
}

function mediaIsReady(result: NormalizedToolResult): boolean {
  return result.references.some((reference) => Boolean(reference.url))
    || MEDIA_SUCCESS_STATUSES.has(normalizedStatus(result));
}

function mediaHasFailed(result: NormalizedToolResult): boolean {
  return MEDIA_FAILURE_STATUSES.has(normalizedStatus(result));
}

function normalizedStatus(result: NormalizedToolResult): string {
  return result.status?.trim().toLowerCase() ?? "";
}

function asMediaFailure(result: NormalizedToolResult): NormalizedToolResult {
  const status = normalizedStatus(result);
  const jobId = result.references.find((reference) => reference.jobId)?.jobId;
  const error = result.error ?? {
    message: jobId ? `Media job ${jobId} ${status}.` : `Media generation ${status}.`,
  };
  const model: ModelSafeToolResult = { ...result.model, isError: true, error };
  model.summary = JSON.stringify({ ...model, summary: undefined });
  return { ...result, isError: true, error, model };
}

function modelToolResult(model: ModelSafeToolResult) {
  return {
    content: [{ type: "text" as const, text: model.summary }],
    details: model,
  };
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function modelFacingSchema(route: RoutedLivepeerTool): Record<string, unknown> {
  if (route.name === "upload") {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Absolute local path from an attachment in the current prompt.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    };
  }
  const schema = structuredClone(route.descriptor.inputSchema);
  if (!isRecord(schema.properties)) return schema;
  if (route.name === "list_capabilities") {
    const limit = isRecord(schema.properties.limit) ? schema.properties.limit : { type: "integer" };
    schema.properties.limit = { ...limit, default: 20, minimum: 1, maximum: 50 };
    schema.properties.query = {
      type: "string",
      minLength: 1,
      description: "Case-insensitive model name or family search, for example 'minimax h3'. Searches every catalog page internally.",
    };
  }
  if (route.name === "create_media") {
    delete schema.properties.max_cost_usd;
    delete schema.properties.maxCostUsd;
    schema.properties.model_override = nonemptyStringSchema(schema.properties.model_override);
    schema.required = uniqueRequired(schema.required, ["model_override"])
      .filter((name) => name !== "max_cost_usd" && name !== "maxCostUsd");
  }
  if (route.name === "request_activation") {
    delete schema.properties.emails;
    schema.properties.email = nonemptyStringSchema(schema.properties.email);
    schema.required = uniqueRequired(schema.required, ["email"]);
  }
  if (route.name === "generate_project") {
    appendProjectRouteConstraint(schema);
  }
  return schema;
}

function prepareToolInput(route: RoutedLivepeerTool, params: unknown): Record<string, unknown> {
  const input = isRecord(params) ? { ...params } : {};
  if (route.name === "list_capabilities") {
    const requested = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 20;
    input.limit = Math.min(requested, 50);
    const query = nonemptyString(input.query);
    if (query) input.query = query;
    else delete input.query;
    return input;
  }
  if (route.name === "create_media") {
    requireNonemptyString(input, "model_override", "create_media requires a nonempty model_override.");
    return input;
  }
  if (route.name === "request_activation") {
    delete input.emails;
    requireNonemptyString(input, "email", "request_activation requires one email address.");
    return input;
  }
  if (route.name === "activate") {
    requireNonemptyString(input, "code", "activate requires the one-time code sent by request_activation.");
    return input;
  }
  if (route.name === "upload") {
    const path = requireNonemptyString(input, "path", "upload requires an attached local image path.");
    return { path };
  }
  if (route.name === "me_update") {
    for (const key of ["name", "use_case", "email"] as const) {
      const value = nonemptyString(input[key]);
      if (value) input[key] = value;
      else delete input[key];
    }
    if (!Object.keys(input).length) throw new Error("me_update requires at least one profile field.");
    return input;
  }
  if (route.name === "generate_project") {
    requireSceneModels(input, "generate_project", true);
    return input;
  }
  return input;
}

function transportInput(input: Record<string, unknown>): Record<string, unknown> {
  const output = { ...input };
  delete output.query;
  return output;
}

async function searchCapabilities(
  router: RoutedLivepeerToolPort,
  input: Record<string, unknown>,
  context: OperationContext,
  signal?: AbortSignal,
): Promise<NormalizedToolResult> {
  const query = requireNonemptyString(input, "query", "Capability search requires a query.");
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  const kind = nonemptyString(input.kind) ?? "ai";
  const capabilities: unknown[] = [];
  const pricing = new Map<string, ModelSafeToolResult["pricing"][number]>();
  let offset = 0;
  let last: NormalizedToolResult | undefined;

  while (offset < 500) {
    signal?.throwIfAborted();
    const page = await router.call(
      "list_capabilities",
      { kind, limit: 50, offset },
      context,
      signal ? { signal } : undefined,
    );
    if (page.isError) return page;
    last = page;
    const data = isRecord(page.model.data) ? page.model.data : {};
    const pageCapabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
    for (const capability of pageCapabilities) {
      if (matchesCapability(capability, tokens)) capabilities.push(capability);
    }
    for (const price of page.pricing) {
      if (matchesText(`${price.name} ${price.modelId ?? ""}`, tokens)) {
        pricing.set(`${price.name}:${price.modelId ?? ""}`, price);
      }
    }
    const total = typeof data.total === "number" ? data.total : undefined;
    const returned = typeof data.returned === "number" ? data.returned : pageCapabilities.length;
    const pageSize = typeof data.limit === "number" && data.limit > 0 ? data.limit : Math.max(returned, pageCapabilities.length);
    offset += pageSize;
    if (returned === 0 || (total !== undefined && offset >= total)) break;
  }

  if (!last) throw new Error("Livepeer returned no capability catalog pages.");
  const model: ModelSafeToolResult = {
    isError: false,
    status: "complete",
    references: [],
    pricing: [...pricing.values()],
    messages: [`Found ${capabilities.length} ${capabilities.length === 1 ? "capability" : "capabilities"} matching “${query}”.`],
    data: { query, total: capabilities.length, capabilities },
    summary: "",
  };
  model.summary = JSON.stringify({ ...model, summary: undefined });
  return { ...last, status: "complete", references: [], pricing: model.pricing, model };
}

function matchesCapability(value: unknown, tokens: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  return matchesText(`${searchableValue(value.name)} ${searchableValue(value.model_id ?? value.modelId)}`, tokens);
}

function searchableValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function matchesText(value: string, tokens: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return tokens.length > 0 && tokens.every((token) => normalized.includes(token));
}

function toolExecutionFailure(
  toolName: LivepeerToolName,
  input: Record<string, unknown>,
  error: unknown,
): ModelSafeToolResult {
  const diagnostic = errorDiagnostic(error);
  const network = diagnostic.message === "fetch failed" || diagnostic.code !== undefined
    && /^(?:E|UND_|ENET|ETIMEDOUT)/u.test(diagnostic.code);
  const action = nonemptyString(input.action);
  const stage = toolName === "create_media"
    ? `${action === "animate" ? "animation" : "media"} submission`
    : `${toolName} request`;
  const message = network
    ? `Livepeer connection failed during ${stage}; no job ID was returned to this client.`
    : `${stage[0]?.toUpperCase()}${stage.slice(1)} failed: ${diagnostic.message}`;
  const data = {
    stage,
    ...(action ? { action } : {}),
    ...(nonemptyString(input.model_override) ? { model: nonemptyString(input.model_override) } : {}),
    ...(typeof input.duration === "number" ? { durationSeconds: input.duration } : {}),
    cause: diagnostic.code ? `${diagnostic.code}: ${diagnostic.cause ?? diagnostic.message}` : diagnostic.cause ?? diagnostic.message,
    retryAdvice: network && toolName === "create_media"
      ? "The submission outcome is unknown. Check Livepeer activity before retrying to avoid a duplicate paid job."
      : "Review the request details, then retry.",
  };
  const model: ModelSafeToolResult = {
    isError: true,
    error: { code: network ? "livepeer_transport_failed" : "livepeer_tool_failed", message },
    references: [],
    pricing: [],
    data,
    summary: "",
  };
  model.summary = JSON.stringify({ ...model, summary: undefined });
  return model;
}

function errorDiagnostic(error: unknown): { message: string; code?: string; cause?: string } {
  const top = error instanceof Error ? error.message : String(error);
  let current = isRecord(error) ? error.cause : undefined;
  let code: string | undefined;
  let cause: string | undefined;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (isRecord(current)) {
      if (!code && typeof current.code === "string") code = current.code;
      if (!cause && typeof current.message === "string" && current.message !== top) cause = current.message;
      current = current.cause;
    } else {
      if (!cause && (typeof current === "string" || typeof current === "number" || typeof current === "boolean")) {
        cause = String(current);
      }
      break;
    }
  }
  return { message: top || "Unknown Livepeer error", ...(code ? { code } : {}), ...(cause ? { cause } : {}) };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

async function prepareLocalImageUpload(
  input: Record<string, unknown>,
  operationContext: OperationContext,
  localImages?: LocalImageUploadPolicy,
  approvedPath?: string,
): Promise<Record<string, unknown>> {
  const path = requireNonemptyString(input, "path", "upload requires an attached local image path.");
  if (!isTrustedLocalImage(path, operationContext, localImages) && approvedPath !== path) {
    throw new Error("upload requires user approval for a local image that was not attached or created by browser_screenshot.");
  }
  const image = await inspectLocalImage(path);

  const bytes = await readFile(path);
  const rawData = bytes.toString("base64");
  const resized = await resizeImage(bytes, image.mimeType, {
    maxWidth: 2_000,
    maxHeight: 2_000,
    maxBytes: MAX_INLINE_UPLOAD_BYTES,
    jpegQuality: 82,
  });
  const prepared = resized ?? (Buffer.byteLength(rawData, "utf8") < MAX_INLINE_UPLOAD_BYTES
    ? { data: rawData, mimeType: image.mimeType }
    : undefined);
  if (!prepared) throw new Error("The attached image could not be prepared for Livepeer upload.");

  return {
    data: prepared.data,
    mime_type: prepared.mimeType,
    kind: "image",
    filename: basename(path),
  };
}

function isTrustedLocalImage(
  path: string,
  operationContext: OperationContext,
  localImages?: LocalImageUploadPolicy,
): boolean {
  return operationContext.originalUserPrompt?.includes(path) === true || localImages?.isAllowed(path) === true;
}

async function inspectLocalImage(path: string): Promise<{ mimeType: string; size: number }> {
  if (!isAbsolute(path)) throw new Error("upload requires an absolute local image path.");
  const mimeType = IMAGE_MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error("upload supports PNG, JPEG, WebP, and GIF images.");
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("The upload path is not a file.");
  if (metadata.size > MAX_LOCAL_UPLOAD_BYTES) throw new Error("The image exceeds Livepeer's 50 MB upload limit.");
  return { mimeType, size: metadata.size };
}

function formatUploadBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

async function createLocalImageApproval(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const image = await inspectLocalImage(path);
  signal?.throwIfAborted();
  return {
    title: "Approve image upload",
    message: [
      `File: ${basename(path)}`,
      `Path: ${path}`,
      `Size: ${formatUploadBytes(image.size)}`,
      "Destination: Livepeer",
    ].join("\n"),
  };
}

function requireSceneModels(
  input: Record<string, unknown>,
  toolName: "generate_project",
  allowStock: boolean,
): void {
  if (nonemptyString(input.global_model_override)) return;
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  const missing = scenes.findIndex((scene) => !isRecord(scene)
    || (!allowStock || scene.source !== "stock") && nonemptyString(scene.model_override) === undefined);
  if (scenes.length === 0 || missing >= 0) {
    const stock = allowStock ? " unless source is exactly \"stock\"" : "";
    const suffix = missing >= 0 ? ` Scene ${missing + 1} is missing model_override${allowStock ? " and is not stock" : ""}.` : " No routed scenes were supplied.";
    throw new Error(`${toolName} requires global_model_override or a nonempty model_override on every scene${stock}.${suffix}`);
  }
}

function requireNonemptyString(input: Record<string, unknown>, key: string, message: string): string {
  const value = nonemptyString(input[key]);
  if (!value) throw new Error(message);
  input[key] = value;
  return value;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function appendProjectRouteConstraint(schema: Record<string, unknown>): void {
  appendAllOf(schema, sceneModelConstraint(true));
}

function sceneModelConstraint(allowStock: boolean): Record<string, unknown> {
  const sceneRoutes: Record<string, unknown>[] = [
    { required: ["model_override"], properties: { model_override: { type: "string", minLength: 1 } } },
  ];
  if (allowStock) sceneRoutes.push({ required: ["source"], properties: { source: { const: "stock" } } });
  return {
    anyOf: [
      {
        required: ["global_model_override"],
        properties: { global_model_override: { type: "string", minLength: 1 } },
      },
      {
        required: ["scenes"],
        properties: {
          scenes: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              anyOf: sceneRoutes,
            },
          },
        },
      },
    ],
  };
}

function appendAllOf(schema: Record<string, unknown>, constraint: Record<string, unknown>): void {
  const current: unknown[] = Array.isArray(schema.allOf) ? schema.allOf as unknown[] : [];
  schema.allOf = [...current, constraint];
}

function nonemptyStringSchema(value: unknown): Record<string, unknown> {
  return { ...(isRecord(value) ? value : { type: "string" }), minLength: 1 };
}

function uniqueRequired(value: unknown, names: string[]): string[] {
  const current = Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  return [...new Set([...current, ...names])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

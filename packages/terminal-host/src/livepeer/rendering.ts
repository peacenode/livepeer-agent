import { hyperlink, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import type { ToolDefinition } from "@livepeer/pi-coding-agent";
import type { LivepeerToolName, ModelSafeToolResult } from "./types.js";

const INFORMATION_TOOLS = new Set<LivepeerToolName>([
  "list_capabilities",
  "describe_capability",
  "get_pricing",
]);

const IDENTITY_TOOLS = new Set<LivepeerToolName>([
  "me",
  "me_update",
  "request_activation",
  "activate",
]);

const WAITLIST_URL = "https://earlyaccess.livepeer.org";
const HIDE_CALL_STATE = "livepeerHideCall";

interface DemoGate {
  kind: "exhausted" | "unsupported";
  remaining?: number;
  resolution?: "configure_key" | "verify_email";
}

type RenderCall = NonNullable<ToolDefinition["renderCall"]>;
type RenderResult = NonNullable<ToolDefinition["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
type RenderResultPayload = Parameters<RenderResult>[0];
type RenderResultOptions = Parameters<RenderResult>[1];
type ToolTheme = Parameters<RenderCall>[1];

export interface LivepeerToolRenderers {
  renderShell: "self";
  renderCall: RenderCall;
  renderResult: RenderResult;
}

export function createLivepeerToolRenderers(toolName: LivepeerToolName): LivepeerToolRenderers {
  return {
    renderShell: "self",
    renderCall: (args, theme, context) => renderCall(toolName, args, theme, context),
    renderResult: (result, options, theme, context) => renderResult(toolName, result, options, theme, context),
  };
}

function renderCall(
  toolName: LivepeerToolName,
  args: unknown,
  theme: ToolTheme,
  context: RenderContext,
): Component {
  const label = theme.fg(context.isError ? "error" : "toolTitle", theme.bold(formatAction(toolName, args)));
  const state = record(context.state);
  if (state) state[HIDE_CALL_STATE] = false;
  const component = INFORMATION_TOOLS.has(toolName) && !context.isError
    ? new Text(label, 0, 0)
    : new Text(label, 1, 1, (text) => theme.bg(context.isError ? "toolErrorBg" : "livepeerToolBg", text));
  return new ConditionalCall(component, state);
}

function renderResult(
  toolName: LivepeerToolName,
  result: RenderResultPayload,
  options: RenderResultOptions,
  theme: ToolTheme,
  context: RenderContext,
): Component {
  const demoGate = getDemoGate(result);
  const hidden = isCodingPolicyCascade(result);
  const state = record(context.state);
  if (state) state[HIDE_CALL_STATE] = Boolean(demoGate) || hidden;
  if (hidden) return new HiddenResult();
  if (demoGate) return new WaitlistNotice(theme, demoGate);

  const details = modelDetails(result.details);
  const isError = context.isError || details?.isError === true;
  const text = isError
    ? formatError(toolName, result, details, options.expanded, theme, context.args)
    : formatResult(toolName, details, options, theme, context.args);
  const color = isError ? "error" : "toolOutput";
  const rendered = theme.fg(color, text);
  if (INFORMATION_TOOLS.has(toolName) && !isError) return new Text(rendered, 0, 0);
  const background = isError ? "toolErrorBg" : "livepeerToolBg";
  return new Text(`${rendered}\n`, 1, 0, (line) => theme.bg(background, line));
}

class ConditionalCall implements Component {
  private readonly component: Component;
  private readonly state: Record<string, unknown> | undefined;

  constructor(component: Component, state: Record<string, unknown> | undefined) {
    this.component = component;
    this.state = state;
  }

  invalidate(): void {
    this.component.invalidate();
  }

  render(width: number): string[] {
    return this.state?.[HIDE_CALL_STATE] === true ? [] : this.component.render(width);
  }
}

class WaitlistNotice implements Component {
  private readonly theme: ToolTheme;
  private readonly gate: DemoGate;

  constructor(theme: ToolTheme, gate: DemoGate) {
    this.theme = theme;
    this.gate = gate;
  }

  invalidate(): void {
    // Static content.
  }

  render(width: number): string[] {
    const panelWidth = Math.max(0, Math.floor(width));
    const center = (content = "") => {
      const fitted = truncateToWidth(content, panelWidth, "");
      const padding = Math.max(0, panelWidth - visibleWidth(fitted));
      const left = Math.floor(padding / 2);
      return `${" ".repeat(left)}${fitted}${" ".repeat(padding - left)}`;
    };
    const link = hyperlink(this.theme.fg("accent", this.theme.bold(WAITLIST_URL)), WAITLIST_URL);
    const empty = this.gate.kind === "exhausted" || this.gate.remaining === 0;
    const keyRequired = this.gate.resolution === "configure_key";
    const emailRequired = this.gate.resolution === "verify_email";
    const reason = emailRequired
      ? "Email verification required"
      : keyRequired
      ? "This action requires a Daydream API key"
      : empty
        ? "Daily demo limit reached"
        : "This action isn’t included in the demo";
    const allowance = empty
      ? "Remaining today: 0"
      : this.gate.remaining === undefined
        ? "Remaining today: not reported"
        : `Remaining today: ${this.gate.remaining} media ${this.gate.remaining === 1 ? "turn" : "turns"}`;
    const nextStep = emailRequired
      ? [
          center(this.theme.fg("customMessageText", this.theme.bold("Verify the email attached to this Daydream key"))),
          center(this.theme.fg("livepeerHint", "ask the agent: verify my email")),
        ]
      : keyRequired
      ? [
          center(this.theme.fg("customMessageText", this.theme.bold("Configure your key, then restart the agent"))),
          center(this.theme.fg("livepeerHint", "livepeer key add")),
        ]
      : [
          center(this.theme.fg("customMessageText", this.theme.bold("Join the waitlist"))),
          center(link),
        ];
    return [
      "",
      center(this.theme.fg("customMessageText", this.theme.bold("Demo access"))),
      center("Browse models and pricing"),
      center("Generate images"),
      center("Animate 1 video clip per day"),
      "",
      center(this.theme.fg("customMessageText", this.theme.bold(reason))),
      ...(keyRequired && this.gate.remaining === undefined ? [] : [center(this.theme.fg("livepeerHint", allowance))]),
      ...nextStep,
      "",
    ];
  }
}

class HiddenResult implements Component {
  invalidate(): void {
    // Static content.
  }

  render(): string[] {
    return [];
  }
}

function formatAction(toolName: LivepeerToolName, args: unknown): string {
  const input = record(args);
  if (toolName === "create_media") {
    const action = stringField(input, "action");
    const label = ({
      animate: "Animating image",
      music: "Creating music",
      tts: "Generating speech",
      mux_audio: "Mixing audio",
      lipsync: "Generating lip sync",
      subtitle: "Creating subtitles",
      upscale: "Upscaling media",
      publish: "Publishing media",
      comfy_workflow: "Running media workflow",
    } satisfies Record<string, string>)[action ?? ""] ?? "Generating media";
    const model = shortModel(stringField(input, "model_override"));
    const duration = numberField(input, "duration");
    return [label, model, duration === undefined ? undefined : `${duration}s`]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  }
  if (toolName === "list_capabilities") {
    const query = stringField(input, "query");
    return query ? `Finding “${truncate(query, 48)}” models` : "Loading capabilities";
  }
  return ({
    describe_capability: "Inspecting capability",
    get_pricing: "Checking pricing",
    me: "Checking Livepeer profile",
    me_update: "Updating Livepeer profile",
    request_activation: "Sending activation code",
    activate: "Activating Livepeer access",
    upload: `Uploading ${basename(stringField(input, "path") ?? "image")}`,
    get_create_media: "Checking media job",
    generate_project: "Preparing project",
    get_creative_job: "Checking project job",
    subscribe_progress: "Watching job progress",
  } satisfies Omit<Record<LivepeerToolName, string>, "create_media" | "list_capabilities">)[toolName];
}

function formatResult(
  toolName: LivepeerToolName,
  details: ModelSafeToolResult | undefined,
  options: RenderResultOptions,
  theme: ToolTheme,
  args: unknown,
): string {
  if (options.isPartial) {
    const progressMessage = details?.messages?.find((message) => message.trim().length > 0)?.trim();
    if (progressMessage) return truncate(progressMessage.replace(/\s+/gu, " "), 180);
    return details?.status?.trim().toLowerCase() === "awaiting_confirmation"
      ? "Approval required"
      : details?.status ? titleCase(details.status) : "Working…";
  }
  const references = details?.references ?? [];
  const pricing = details?.pricing ?? [];
  const firstReference = references[0];
  const firstPrice = pricing[0];
  const firstMessage = details?.messages?.[0]?.trim();
  let headline: string;
  if (IDENTITY_TOOLS.has(toolName) && firstMessage) {
    headline = truncate(firstMessage.replace(/\s+/gu, " "), 600);
  } else if (toolName === "list_capabilities") {
    headline = "Capabilities loaded";
  } else if (toolName === "describe_capability") {
    headline = "Capability details loaded";
  } else if (toolName === "get_pricing" && firstPrice) {
    headline = formatPrice(firstPrice);
  } else if (toolName === "upload") {
    headline = "Image ready";
  } else if (details?.status?.trim().toLowerCase() === "awaiting_confirmation") {
    headline = "Approval required";
  } else if (firstReference) {
    const kind = firstReference.kind ? titleCase(firstReference.kind) : undefined;
    headline = firstReference.url ? `${kind ?? "Media"} ready`
      : firstReference.jobId ? `${kind ?? "Generation"} queued`
      : "Livepeer result ready";
  } else {
    headline = details?.status ? titleCase(details.status) : "Livepeer operation complete";
  }

  const hasDetails = Boolean(details?.status || details?.messages?.length || references.length || pricing.length);
  if (!options.expanded) return hasDetails ? `${headline}\n${expandHint(theme)}` : headline;

  if (toolName === "upload") return formatUploadResult(headline, details, args);

  const lines = [headline, `Tool: ${toolName}`];
  if (details?.status) lines.push(`Status: ${details.status}`);
  for (const message of details?.messages?.slice(1, 4) ?? []) lines.push(truncate(message.replace(/\s+/gu, " "), 600));
  for (const reference of references.slice(0, 8)) {
    const model = shortModel(reference.modelId ?? reference.capability);
    if (model) lines.push(`Model: ${model}`);
    if (reference.assetId) lines.push(`Asset ID: ${reference.assetId}`);
    if (reference.jobId) lines.push(`Job ID: ${reference.jobId}`);
    if (reference.projectId) lines.push(`Project ID: ${reference.projectId}`);
    if (reference.sceneIndex !== undefined) lines.push(`Scene: ${reference.sceneIndex}`);
    if (reference.url) lines.push(`URL: ${reference.url}`);
    if (reference.originalPrompt) lines.push(`Original prompt: ${truncate(reference.originalPrompt, 240)}`);
    if (reference.submittedPrompt) lines.push(`Submitted prompt: ${truncate(reference.submittedPrompt, 240)}`);
    for (const sourceUrl of reference.sourceUrls.slice(0, 4)) lines.push(`Source URL: ${sourceUrl}`);
    for (const parentId of reference.parentAssetIds.slice(0, 4)) lines.push(`Parent asset ID: ${parentId}`);
  }
  for (const price of pricing.slice(0, 8)) lines.push(`Price: ${formatPrice(price)}`);
  return lines.join("\n");
}

function formatError(
  toolName: LivepeerToolName,
  result: RenderResultPayload,
  details: ModelSafeToolResult | undefined,
  expanded: boolean,
  theme: ToolTheme,
  args: unknown,
): string {
  const message = details?.error?.message ?? errorText(result) ?? "Livepeer operation failed";
  const headline = `Failed · ${truncate(message.replace(/\s+/gu, " "), 320)}`;
  const input = record(args);
  const data = record(details?.data);
  const model = stringField(data, "model") ?? stringField(input, "model_override");
  const duration = numberField(data, "durationSeconds") ?? numberField(input, "duration");
  const summary = [model ? `Model: ${shortModel(model) ?? model}` : undefined, duration === undefined ? undefined : `Duration: ${duration}s`]
    .filter((line): line is string => line !== undefined)
    .join(" · ");
  if (!expanded) return `${headline}${summary ? `\n${summary}` : ""}\n${expandHint(theme)}`;

  const lines = [headline, `Tool: ${toolName}`];
  const stage = stringField(data, "stage");
  const cause = stringField(data, "cause");
  const retryAdvice = stringField(data, "retryAdvice");
  if (stage) lines.push(`Stage: ${titleCase(stage)}`);
  if (model) lines.push(`Model: ${shortModel(model) ?? model}`);
  if (duration !== undefined) lines.push(`Duration: ${duration}s`);
  if (cause && cause !== message) lines.push(`Cause: ${truncate(cause.replace(/\s+/gu, " "), 500)}`);
  if (retryAdvice) lines.push(`Next: ${truncate(retryAdvice.replace(/\s+/gu, " "), 500)}`);
  return lines.join("\n");
}

function formatUploadResult(
  headline: string,
  details: ModelSafeToolResult | undefined,
  args: unknown,
): string {
  const input = record(args);
  const data = record(details?.data);
  const path = stringField(input, "path");
  const mimeType = stringField(data, "mime_type");
  const bytes = numberField(data, "bytes");
  const storage = stringField(data, "storage");
  const lines = [headline];
  if (path) lines.push(`File: ${basename(path)}`);
  if (mimeType) lines.push(`Type: ${mimeType}`);
  if (bytes !== undefined) lines.push(`Size: ${formatBytes(bytes)}`);
  if (storage) lines.push(`Storage: ${storage === "livepeer-agent" ? "Livepeer" : storage}`);
  return lines.join("\n");
}

function expandHint(theme: ToolTheme): string {
  return `${theme.fg("livepeerHint", "ctrl+o")}  Expand for details`;
}

function getDemoGate(result: RenderResultPayload): DemoGate | undefined {
  const details = modelDetails(result.details);
  const code = details?.error?.code;
  const text = details?.error?.message ?? errorText(result) ?? "";
  if (code === "demo_budget_exhausted" || /demo_budget_exhausted/u.test(text)) {
    return { kind: "exhausted", remaining: 0 };
  }
  if (code === "demo_not_allowed" || /\[demo_not_allowed\]/u.test(text)) {
    const remaining = demoRemaining(text);
    const resolution = /\bverify (?:the |your )?email\b|\bemail verification\b/iu.test(text)
      ? "verify_email"
      : /\b(?:daydream|api) key\b|\bauthorization:\s*bearer\b/iu.test(text)
        ? "configure_key"
        : undefined;
    return {
      kind: "unsupported",
      ...(remaining === undefined ? {} : { remaining }),
      ...(resolution ? { resolution } : {}),
    };
  }
  return undefined;
}

function demoRemaining(text: string): number | undefined {
  const match = /\b(\d+)\s+(?:media\s+)?(?:turns?|generations?|renders?|clips?)\s+(?:remaining|left)\b/iu.exec(text);
  if (!match?.[1]) return undefined;
  const remaining = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : undefined;
}

function isCodingPolicyCascade(result: RenderResultPayload): boolean {
  return /^The current action was stopped by coding policy\.?$/u.test(errorText(result) ?? "");
}

function errorText(result: RenderResultPayload): string | undefined {
  const text = result.content.find((block) => block.type === "text");
  return text?.type === "text" && text.text.trim() ? text.text.replace(/^Error:\s*/u, "").trim() : undefined;
}

function modelDetails(value: unknown): ModelSafeToolResult | undefined {
  const candidate = record(value);
  if (!candidate || typeof candidate.isError !== "boolean") return undefined;
  const references = Array.isArray(candidate.references) ? candidate.references : undefined;
  const pricing = Array.isArray(candidate.pricing) ? candidate.pricing : undefined;
  if (!references || !pricing || typeof candidate.summary !== "string") return undefined;
  return value as ModelSafeToolResult;
}

function formatPrice(price: ModelSafeToolResult["pricing"][number]): string {
  const model = shortModel(price.modelId ?? price.name) ?? "Current route";
  const unit = price.displayUnit ?? price.unitKind;
  return price.displayPriceUsd === undefined
    ? `${model} · price unavailable`
    : `${model} · $${price.displayPriceUsd}${unit ? `/${unit}` : ""}`;
}

function shortModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function titleCase(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized ? `${normalized[0]?.toUpperCase()}${normalized.slice(1)}` : normalized;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

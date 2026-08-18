import type { ToolContentBlock, ToolResult } from "@livepeer-agent/contracts";
import type {
  AssetReference,
  ModelSafeToolResult,
  NormalizedToolResult,
  OperationContext,
  PricingReference,
} from "./types.js";

const SENSITIVE_KEY = /(?:token|apikey|authorization|password|secret|cookie|signature|credential)/iu;
const OUTPUT_URL_KEYS = new Set(["url", "outputurl", "previewurl", "viewerurl", "asseturl", "mediaurl"]);
const SOURCE_URL_KEYS = new Set(["sourceurl", "sourceurls", "inputurl", "inputurls"]);
const PARENT_ID_KEYS = new Set(["parentassetid", "parentassetids", "inputassetid", "inputassetids"]);
const MODEL_MAX_DEPTH = 8;
const MODEL_MAX_COLLECTION_SIZE = 50;
const MODEL_MAX_STRING_LENGTH = 2_000;
const MODEL_MAX_TEXT_LENGTH = 20_000;
const MODEL_MAX_MESSAGES = 8;
const OMITTED = "[binary or sensitive value omitted]";
const TRUNCATED = "[truncated]";

export function normalizeToolResult(
  result: ToolResult,
  input: Record<string, unknown>,
  context: OperationContext = {},
): NormalizedToolResult {
  const references: AssetReference[] = [];
  const pricing: PricingReference[] = [];
  const statuses: string[] = [];
  const inputPrompt = stringValue(input.prompt) ?? context.submittedPrompt;
  const inherited: ReferenceLineage = {
    ...(context.originalUserPrompt ? { originalPrompt: context.originalUserPrompt } : {}),
    ...(inputPrompt ? { submittedPrompt: inputPrompt } : {}),
    sourceUrls: unique((context.parentReferences ?? []).flatMap((reference) => [
      ...(reference.url ? [reference.url] : []),
      ...reference.sourceUrls,
    ])),
    parentAssetIds: unique((context.parentReferences ?? []).flatMap((reference) => reference.assetId ? [reference.assetId] : [])),
  };
  visit(result.structuredContent, references, pricing, statuses, 0, new WeakSet(), inherited);
  appendResourceLinks(result.content, references, inherited);
  const submittedPrompt = inputPrompt;
  for (const reference of references) {
    if (!reference.submittedPrompt && submittedPrompt) reference.submittedPrompt = submittedPrompt;
    if (!reference.originalPrompt && context.originalUserPrompt) reference.originalPrompt = context.originalUserPrompt;
    reference.sourceUrls = unique(reference.sourceUrls);
    reference.parentAssetIds = unique(reference.parentAssetIds);
  }
  const merged = mergeReferences(references);
  const status = statuses.find(Boolean);
  const error = result.isError ? errorFrom(result) : undefined;
  const normalizedPricing = uniquePricing(pricing);
  const prepared = prepareModelData(result.structuredContent, input);
  const budget: SanitizerBudget = { remainingText: MODEL_MAX_TEXT_LENGTH };
  const data = prepared.value === undefined
    ? undefined
    : sanitizeModelValue(prepared.value, budget, 0, new WeakSet());
  const messages = prepared.capabilityCatalog && !result.isError
    ? []
    : result.content
      .filter((block): block is Extract<ToolContentBlock, { type: "text" }> => block.type === "text")
      .slice(0, MODEL_MAX_MESSAGES)
      .map((block) => sanitizeModelString(block.text, budget))
      .filter((message) => message.length > 0);
  const modelFields: Omit<ModelSafeToolResult, "summary"> = {
    isError: result.isError === true,
    ...(error ? { error } : {}),
    ...(status ? { status } : {}),
    references: merged,
    pricing: normalizedPricing,
    ...(messages.length > 0 ? { messages } : {}),
    ...(data !== undefined ? { data } : {}),
  };
  const model: ModelSafeToolResult = { ...modelFields, summary: JSON.stringify(modelFields) };
  return {
    raw: result,
    isError: result.isError === true,
    ...(error ? { error } : {}),
    ...(status ? { status } : {}),
    references: merged,
    pricing: model.pricing,
    model,
  };
}

function visit(
  value: unknown,
  references: AssetReference[],
  pricing: PricingReference[],
  statuses: string[],
  depth: number,
  seen: WeakSet<object>,
  inherited: ReferenceLineage,
): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) visit(item, references, pricing, statuses, depth + 1, seen, inherited);
    return;
  }
  const record = value as Record<string, unknown>;
  const lineage = lineageFrom(record, inherited);
  const reference = referenceFrom(record, lineage);
  if (reference) references.push(reference);
  const price = pricingFrom(record);
  if (price) pricing.push(price);
  const status = stringValue(record.status);
  if (status) statuses.push(status);
  for (const [key, item] of Object.entries(record)) {
    if (!SENSITIVE_KEY.test(normalizeKey(key))) visit(item, references, pricing, statuses, depth + 1, seen, lineage);
  }
}

interface ReferenceLineage {
  jobId?: string;
  projectId?: string;
  capability?: string;
  modelId?: string;
  originalPrompt?: string;
  submittedPrompt?: string;
  sourceUrls: string[];
  parentAssetIds: string[];
}

function lineageFrom(record: Record<string, unknown>, inherited: ReferenceLineage): ReferenceLineage {
  const direct = normalizedEntries(record);
  const jobId = firstString(direct, ["jobid"]) ?? inherited.jobId;
  const projectId = firstString(direct, ["projectid"]) ?? inherited.projectId;
  const capability = firstString(direct, ["capability", "capabilityname"]) ?? inherited.capability;
  const modelId = firstString(direct, ["modelid", "model"]) ?? inherited.modelId;
  const originalPrompt = firstString(direct, ["originalprompt"]) ?? inherited.originalPrompt;
  const submittedPrompt = firstString(direct, ["submittedprompt", "prompt"]) ?? inherited.submittedPrompt;
  return {
    ...(jobId ? { jobId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(capability ? { capability } : {}),
    ...(modelId ? { modelId } : {}),
    ...(originalPrompt ? { originalPrompt } : {}),
    ...(submittedPrompt ? { submittedPrompt } : {}),
    sourceUrls: unique([
      ...inherited.sourceUrls,
      ...valuesFor(direct, SOURCE_URL_KEYS).flatMap(strings).map(sanitizeUrl).filter(isNonempty),
    ]),
    parentAssetIds: unique([
      ...inherited.parentAssetIds,
      ...valuesFor(direct, PARENT_ID_KEYS).flatMap(strings).filter(isNonempty),
    ]),
  };
}

function referenceFrom(record: Record<string, unknown>, lineage: ReferenceLineage): AssetReference | undefined {
  const direct = normalizedEntries(record);
  const assetId = firstString(direct, ["assetid"]);
  const directJobId = firstString(direct, ["jobid"]);
  const directProjectId = firstString(direct, ["projectid"]);
  const sceneIndex = firstNumber(direct, ["sceneindex"]);
  const url = firstUrl(direct, OUTPUT_URL_KEYS);
  const kind = mediaKind(firstString(direct, ["kind", "outputkind", "mediatype"]));
  if (!assetId && !directJobId && !directProjectId && sceneIndex === undefined && !url) return undefined;
  return {
    ...(assetId ? { assetId } : {}),
    ...(lineage.jobId ? { jobId: lineage.jobId } : {}),
    ...(lineage.projectId ? { projectId: lineage.projectId } : {}),
    ...(sceneIndex === undefined ? {} : { sceneIndex }),
    ...(kind ? { kind } : {}),
    ...(url ? { url } : {}),
    ...(lineage.capability ? { capability: lineage.capability } : {}),
    ...(lineage.modelId ? { modelId: lineage.modelId } : {}),
    ...(lineage.originalPrompt ? { originalPrompt: lineage.originalPrompt } : {}),
    ...(lineage.submittedPrompt ? { submittedPrompt: lineage.submittedPrompt } : {}),
    sourceUrls: lineage.sourceUrls,
    parentAssetIds: lineage.parentAssetIds,
  };
}

function pricingFrom(record: Record<string, unknown>): PricingReference | undefined {
  const entries = normalizedEntries(record);
  const name = firstString(entries, ["name", "capability"]);
  const displayPriceUsd = firstNumber(entries, ["displaypriceusd"]);
  const displayUnit = firstString(entries, ["displayunit"]);
  const unitKind = firstString(entries, ["unitkind"]);
  if (!name || (displayPriceUsd === undefined && !displayUnit && !unitKind)) return undefined;
  const modelId = firstString(entries, ["modelid"]);
  return {
    name,
    ...(displayPriceUsd === undefined ? {} : { displayPriceUsd }),
    ...(displayUnit ? { displayUnit } : {}),
    ...(unitKind ? { unitKind } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function appendResourceLinks(
  content: ToolContentBlock[],
  references: AssetReference[],
  inherited: ReferenceLineage,
): void {
  for (const block of content) {
    if (block.type !== "resource_link") continue;
    const kind = mediaKind(block.mimeType?.split("/")[0]);
    references.push({
      ...(kind ? { kind } : {}),
      url: sanitizeUrl(block.uri),
      ...(inherited.originalPrompt ? { originalPrompt: inherited.originalPrompt } : {}),
      ...(inherited.submittedPrompt ? { submittedPrompt: inherited.submittedPrompt } : {}),
      sourceUrls: inherited.sourceUrls,
      parentAssetIds: inherited.parentAssetIds,
    });
  }
}

function mergeReferences(references: AssetReference[]): AssetReference[] {
  const result: AssetReference[] = [];
  const keys = new Map<string, AssetReference>();
  for (const reference of references) {
    const key = reference.assetId ? `asset:${reference.assetId}`
      : reference.url ? `url:${reference.url}`
      : reference.jobId ? `job:${reference.jobId}:${reference.projectId ?? ""}:${reference.sceneIndex ?? ""}`
      : reference.projectId ? `project:${reference.projectId}:${reference.sceneIndex ?? ""}` : undefined;
    if (!key) { result.push(reference); continue; }
    const previous = keys.get(key);
    if (!previous) { keys.set(key, reference); result.push(reference); continue; }
    merge(previous, reference);
  }
  return result;
}

function merge(target: AssetReference, source: AssetReference): void {
  for (const key of ["assetId", "jobId", "projectId", "sceneIndex", "kind", "url", "capability", "modelId", "originalPrompt", "submittedPrompt"] as const) {
    if (target[key] === undefined && source[key] !== undefined) Object.assign(target, { [key]: source[key] });
  }
  target.sourceUrls = unique([...target.sourceUrls, ...source.sourceUrls]);
  target.parentAssetIds = unique([...target.parentAssetIds, ...source.parentAssetIds]);
}

function errorFrom(result: ToolResult): { code?: string; message: string } {
  const structured = isRecord(result.structuredContent) && isRecord(result.structuredContent.error)
    ? result.structuredContent.error
    : isRecord(result.structuredContent) ? result.structuredContent : undefined;
  const explicitCode = structured && typeof structured.code === "string" ? redactText(structured.code, 100) : undefined;
  const structuredMessage = structured && typeof structured.message === "string" ? structured.message : undefined;
  const textBlock = result.content.find((block) => block.type === "text");
  const textMessage = textBlock?.type === "text" ? textBlock.text : undefined;
  const message = redactText(structuredMessage ?? textMessage ?? "The Livepeer tool failed.", 1_200);
  const code = explicitCode ?? inferProductErrorCode(message);
  return { ...(code ? { code } : {}), message };
}

function inferProductErrorCode(message: string): string | undefined {
  if (/^Demo mode supports\b[\s\S]*\bonly\./iu.test(message.trim())) return "demo_not_allowed";
  return undefined;
}

function redactText(value: string, limit: number): string {
  return value
    .replace(/(?:bearer\s+)[a-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/((?:access_?token|refresh_?token|api_?key|secret|signature|password)\s*[=:]\s*)[^\s,;}]+/giu, "$1[REDACTED]")
    .slice(0, limit);
}

function sanitizeUrl(value: string): string {
  if (value.startsWith("data:")) return "[inline media omitted]";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|key|secret|signature|credential|auth|policy|expires)/iu.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.href;
  } catch { return "[unparseable URL omitted]"; }
}

interface SanitizerBudget {
  remainingText: number;
}

function prepareModelData(
  value: unknown,
  input: Record<string, unknown>,
): { value: unknown; capabilityCatalog: boolean } {
  if (!isRecord(value)) return { value, capabilityCatalog: false };
  const direct = Array.isArray(value.capabilities) ? value : undefined;
  const nested = isRecord(value.structuredContent) && Array.isArray(value.structuredContent.capabilities)
    ? value.structuredContent
    : undefined;
  const catalog = direct ?? nested;
  if (!catalog) return { value, capabilityCatalog: false };

  const requestedLimit = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
    ? input.limit
    : 20;
  const limit = Math.min(requestedLimit, MODEL_MAX_COLLECTION_SIZE);
  const capabilities = (catalog.capabilities as unknown[])
    .filter(isPublicLiveCapability)
    .slice(0, limit);
  const paginated = {
    ...catalog,
    capabilities,
    limit,
    offset: typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0
      ? input.offset
      : typeof catalog.offset === "number" ? catalog.offset : 0,
    returned: capabilities.length,
  };
  return {
    value: direct ? paginated : { ...value, structuredContent: paginated },
    capabilityCatalog: true,
  };
}

function isPublicLiveCapability(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = normalizedEntries(value);
  if (entries.get("private") === true || entries.get("isprivate") === true || entries.get("public") === false) return false;
  const visibility = firstString(entries, ["visibility", "access"])?.toLowerCase();
  if (visibility === "private" || visibility === "internal") return false;

  const kind = firstString(entries, ["kind", "type", "capabilitykind"])?.toLowerCase();
  if (kind && kind !== "ai" && kind !== "tool") return false;
  const bridge = firstString(entries, ["bridge", "bridgetype", "source", "sourcekind", "transport"])?.toLowerCase();
  if (bridge?.startsWith("mcp") || entries.get("mcp") === true || entries.get("mcpbridge") === true || entries.get("ismcp") === true) return false;

  if (entries.get("available") === false || entries.get("availability") === false || entries.get("enabled") === false) return false;
  const availability = firstString(entries, ["availability", "availabilitystatus"])?.toLowerCase();
  if (availability && ["unavailable", "disabled", "offline", "private", "internal"].includes(availability)) return false;
  const status = firstString(entries, ["status"])?.toLowerCase();
  return !status || !["unavailable", "disabled", "offline", "private", "internal"].includes(status);
}

function sanitizeModelValue(
  value: unknown,
  budget: SanitizerBudget,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeModelString(value, budget);
  if (typeof value === "bigint") return sanitizeModelString(value.toString(), budget);
  if (typeof value === "undefined") return undefined;
  if (typeof value === "symbol" || typeof value === "function") return OMITTED;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return OMITTED;
  if (isBinaryPayload(value)) return OMITTED;
  if (depth >= MODEL_MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return "[circular reference omitted]";
  seen.add(value);

  if (Array.isArray(value)) {
    const truncated = value.length > MODEL_MAX_COLLECTION_SIZE;
    const limit = truncated ? MODEL_MAX_COLLECTION_SIZE - 1 : MODEL_MAX_COLLECTION_SIZE;
    const output = value.slice(0, limit).map((item) => {
      const sanitized = sanitizeModelValue(item, budget, depth + 1, seen);
      return sanitized === undefined ? "[undefined omitted]" : sanitized;
    });
    if (truncated) output.push(TRUNCATED);
    return output;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_KEY.test(normalizeKey(key)));
  const truncated = entries.length > MODEL_MAX_COLLECTION_SIZE;
  const limit = truncated ? MODEL_MAX_COLLECTION_SIZE - 1 : MODEL_MAX_COLLECTION_SIZE;
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, limit)) {
    const sanitized = sanitizeModelValue(item, budget, depth + 1, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  if (truncated) output.__livepeer_truncated__ = TRUNCATED;
  return output;
}

function sanitizeModelString(value: string, budget: SanitizerBudget): string {
  if (value.startsWith("data:") || looksLikeBase64(value)) return OMITTED;
  const sanitized = looksLikeUrl(value)
    ? sanitizeUrl(value)
    : redactText(value, MODEL_MAX_STRING_LENGTH);
  const bounded = sanitized.slice(0, Math.min(MODEL_MAX_STRING_LENGTH, budget.remainingText));
  budget.remainingText -= bounded.length;
  if (bounded.length < sanitized.length && budget.remainingText > 0) return `${bounded.slice(0, Math.max(0, bounded.length - 1))}…`;
  return bounded || (sanitized.length > 0 ? TRUNCATED : "");
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function looksLikeBase64(value: string): boolean {
  return value.length > 256 && /^[a-z0-9+/_-]+={0,2}$/iu.test(value);
}

function isBinaryPayload(value: object): boolean {
  if (!isRecord(value)) return false;
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : typeof value.mime_type === "string" ? value.mime_type : undefined;
  if (!mimeType || !/^(?:image|audio|video)\//iu.test(mimeType) && mimeType !== "application/octet-stream") return false;
  return typeof value.data === "string" || typeof value.blob === "string" || ArrayBuffer.isView(value.data) || value.data instanceof ArrayBuffer;
}

function normalizedEntries(record: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(record).filter(([key]) => !SENSITIVE_KEY.test(normalizeKey(key))).map(([key, value]) => [normalizeKey(key), value]));
}
function normalizeKey(key: string): string { return key.replace(/[^a-z0-9]/giu, "").toLowerCase(); }
function firstString(entries: Map<string, unknown>, keys: string[]): string | undefined { for (const key of keys) { const value = stringValue(entries.get(key)); if (value) return value; } return undefined; }
function firstNumber(entries: Map<string, unknown>, keys: string[]): number | undefined { for (const key of keys) { const value = entries.get(key); if (typeof value === "number" && Number.isFinite(value)) return value; } return undefined; }
function firstUrl(entries: Map<string, unknown>, keys: Set<string>): string | undefined { for (const [key, value] of entries) { if (keys.has(key)) { const string = stringValue(value); if (string) return sanitizeUrl(string); } } return undefined; }
function valuesFor(entries: Map<string, unknown>, keys: Set<string>): unknown[] { return [...entries].filter(([key]) => keys.has(key)).map(([, value]) => value); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function mediaKind(value: string | undefined): AssetReference["kind"] | undefined { return value && ["image", "video", "audio", "3d", "text"].includes(value.toLowerCase()) ? value.toLowerCase() as AssetReference["kind"] : undefined; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function uniquePricing(values: PricingReference[]): PricingReference[] { const seen = new Set<string>(); return values.filter((value) => { const key = `${value.name}:${value.modelId ?? ""}:${value.displayUnit ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function isNonempty(value: string): boolean { return Boolean(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

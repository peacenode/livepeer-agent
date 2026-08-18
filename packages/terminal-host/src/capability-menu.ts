import type { ToolResult } from "@livepeer-agent/contracts";
import type {
  ProductCapabilities,
  ProductCapabilityCategory,
  ProductCapabilityListResult,
} from "@livepeer/pi-coding-agent";
import type { LivepeerExecutionClient } from "@livepeer-agent/livepeer-client";

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

const CATEGORY_LABELS: Record<ProductCapabilityCategory, string> = {
  "text-to-image": "Text-to-image models",
  "image-to-image": "Image editing and transformation models",
  "text-to-video": "Text-to-video models",
  "image-to-video": "Image and reference-to-video models",
  "text-to-3d": "Text-to-3D models",
  "image-to-3d": "Image-to-3D models",
  audio: "Speech, music, and audio models",
  ffmpeg: "FFmpeg capabilities",
  all: "Livepeer capability catalog",
};

const CATEGORY_TERMS: Record<Exclude<ProductCapabilityCategory, "all">, readonly string[]> = {
  "text-to-image": ["text-to-image", "text to image", "t2i"],
  "image-to-image": [
    "image-to-image", "image to image", "edit", "inpaint", "outpaint", "fill", "erase", "upscale",
    "remove-background", "bg-remove", "face-swap", "faceswap", "tryon", "vto", "controlnet", "restore",
    "codeformer", "ccsr", "sam-3", "segment", "instant-character", "photomaker", "pulid", "ip-adapter",
    "product-photo",
  ],
  "text-to-video": ["text-to-video", "text to video", "t2v"],
  "image-to-video": [
    "image-to-video", "image to video", "i2v", "reference-to-video", "reference to video", "ref2v",
    "first-last-frame", "transition", "keyframes-to-video", "lipsync", "talking-head",
  ],
  "text-to-3d": ["text-to-3d", "text to 3d", "t3d"],
  "image-to-3d": ["image-to-3d", "image to 3d", "i3d", "multiview-to-3d", "triposplat"],
  audio: ["text-to-speech", "tts", "speech", "music", "text-to-audio", "audio", "sfx", "asr", "whisper"],
  ffmpeg: ["ffmpeg", "mux", "transcode", "subtitle", "watermark", "stitch", "crop"],
};

export interface CachedProductCapabilities extends ProductCapabilities {
  warm(): Promise<void>;
  invalidate(): void;
}

export function createProductCapabilities(client: LivepeerExecutionClient): CachedProductCapabilities {
  let cached: { result: ToolResult; expiresAt: number } | undefined;
  let pending: Promise<ToolResult> | undefined;

  const load = (signal?: AbortSignal): Promise<ToolResult> => {
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
    pending ??= client.capabilities.list({ limit: 200, offset: 0 })
      .then((result) => {
        if (result.isError) throw new Error(readError(result));
        cached = { result, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return signal ? withAbort(pending, signal) : pending;
  };

  return {
    async warm() {
      await load();
    },
    invalidate() {
      cached = undefined;
    },
    async list(category, { signal }) {
      const result = await load(signal);
      return formatCapabilityResult(category, result);
    },
  };
}

export function formatCapabilityResult(
  category: ProductCapabilityCategory,
  result: ToolResult,
): ProductCapabilityListResult {
  const rows = readCapabilityRows(result).filter((row) => matchesCategory(category, row));
  const displayLimit = category === "all" ? 60 : 40;
  const lines = rows.slice(0, displayLimit).map(formatCapabilityRow);
  return {
    title: CATEGORY_LABELS[category],
    lines,
    summary: rows.length > lines.length
      ? `Showing ${lines.length} of ${rows.length} matching capabilities.`
      : `${rows.length} matching ${rows.length === 1 ? "capability" : "capabilities"}.`,
  };
}

function readCapabilityRows(result: ToolResult): Record<string, unknown>[] {
  const outer = asRecord(result.structuredContent);
  const structured = asRecord(outer?.structuredContent) ?? outer;
  const rows = structured?.capabilities;
  return Array.isArray(rows) ? rows.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)) : [];
}

function matchesCategory(category: ProductCapabilityCategory, row: Record<string, unknown>): boolean {
  if (category === "all") return true;
  const tags: unknown[] = Array.isArray(row.tags) ? row.tags as unknown[] : [];
  const searchable = [
    row.name,
    row.kind,
    row.type,
    row.modality,
    row.input_type,
    row.output_type,
    row.unit_kind,
    row.display_unit,
    row.model_id,
    row.description,
    ...tags,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const unit = `${clean(row.unit_kind) ?? ""} ${clean(row.display_unit) ?? ""}`.toLowerCase();
  if (category === "image-to-image") {
    const editLike = CATEGORY_TERMS[category].some((term) => searchable.includes(term));
    const imageOutput = unit.includes("image") || unit.includes("megapixel");
    const explicitImageRoute = /image-to-image|edit-image|faceswapimage|product-photo/u.test(searchable);
    const wrongModality = /video|audio|speech|music|(?:^|[^a-z0-9])3d(?:[^a-z0-9]|$)|mesh/u.test(searchable);
    return editLike && !wrongModality && (imageOutput || explicitImageRoute);
  }
  if (CATEGORY_TERMS[category].some((term) => searchable.includes(term))) return true;
  if (category === "text-to-image") {
    const imageOutput = unit.includes("image") || unit.includes("megapixel");
    const editLike = CATEGORY_TERMS["image-to-image"].some((term) => searchable.includes(term));
    return imageOutput && !editLike && !searchable.includes("video") && !unit.includes("mesh");
  }
  return false;
}

function formatCapabilityRow(row: Record<string, unknown>): string {
  const name = conciseModelLabel(row);
  const price = numberValue(row.display_price_usd) ?? numberValue(row.displayPriceUsd);
  const unit = clean(row.display_unit) ?? clean(row.displayUnit);
  return price === undefined ? name : `${name} · $${price}${unit ? `/${unit}` : ""}`;
}

function conciseModelLabel(row: Record<string, unknown>): string {
  const name = clean(row.name) ?? "unnamed";
  const modelId = clean(row.model_id) ?? clean(row.modelId);
  if (!modelId) return name;
  const parts = modelId.split("/").filter(Boolean);
  const leaf = parts.at(-1);
  const genericRoute = /^(?:text|image|audio|video|reference)-to-(?:image|video|3d|audio|music|speech)$/u;
  if (parts.length === 2 && leaf && !/^v?\d+(?:\.\d+)*$/u.test(leaf) && !genericRoute.test(leaf)) return leaf;
  return name;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): Error {
  const error = new Error("Capability request cancelled.");
  error.name = "AbortError";
  return error;
}

function readError(result: ToolResult): string {
  return result.content.find((block) => block.type === "text")?.text ?? "Unable to load capabilities.";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

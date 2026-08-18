import type { CommandResult, ExitCode, ToolContentBlock, ToolProgress } from "@livepeer-agent/contracts";
import type { CliIO } from "../io/index.js";

export function exitCodeFor(code?: string): ExitCode {
  if (!code) return 0;
  if (code === "INPUT" || code === "usage" || code === "activation_invalid") return 1;
  if (["AUTH", "PERMISSION", "not_authenticated"].includes(code)) return 2;
  if (["CANCELLED", "TIMEOUT", "access_denied", "expired_token"].includes(code)) return 4;
  return 3;
}

export function renderResult(result: CommandResult<unknown>, json: boolean, io: CliIO): ExitCode {
  if (json) io.stdout(`${JSON.stringify(result)}\n`);
  else if (!result.ok) io.stderr(`${result.error?.message ?? "Command failed."}\n`);
  else {
    const rendered = renderHuman(result.data, result.content);
    if (rendered) io.stdout(`${rendered}\n`);
  }
  return exitCodeFor(result.error?.code);
}

export function reportProgress(progress: ToolProgress, io: CliIO): void {
  const count = progress.progress === undefined ? "" : progress.total === undefined
    ? ` ${progress.progress}`
    : ` ${progress.progress}/${progress.total}`;
  io.stderr(`${progress.message ?? "Working"}${count}\n`);
}

function renderHuman(data: unknown, content?: ToolContentBlock[]): string {
  const lines: string[] = [];
  if (typeof data === "string") lines.push(data);
  else if (Array.isArray(data)) lines.push(...data.map(renderItem));
  else if (data !== undefined) lines.push(JSON.stringify(data, null, 2));
  for (const block of content ?? []) {
    if (block.type === "text") lines.push(block.text);
    else if (block.type === "resource_link") lines.push(block.uri);
    else if (block.type === "image") lines.push(`[image ${block.mimeType}]`);
    else if (block.type === "audio") lines.push(`[audio ${block.mimeType}]`);
  }
  return lines.join("\n");
}

function renderItem(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) {
    const item = value as { name: unknown; description?: unknown };
    const name = scalar(item.name);
    return item.description ? `${name}\t${scalar(item.description)}` : name;
  }
  return JSON.stringify(value);
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

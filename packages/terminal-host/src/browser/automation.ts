import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { managedEnvironment, type BrowserCommandRunner, type ManagedBrowserPaths } from "./companion.js";

export type BrowserAction =
  | { action: "click" | "hover" | "check" | "uncheck"; ref: string }
  | { action: "fill" | "select"; ref: string; value: string }
  | { action: "press"; value: string }
  | { action: "go_back" | "go_forward" | "reload" };

export interface BrowserPageSnapshot {
  text: string;
  session: string;
}

export interface BrowserScreenshot {
  data: string;
  mimeType: "image/png";
  path: string;
  session: string;
}

export interface BrowserAutomation {
  open(sessionId: string, url: string, options?: { headed?: boolean }, signal?: AbortSignal): Promise<BrowserPageSnapshot>;
  snapshot(sessionId: string, signal?: AbortSignal): Promise<BrowserPageSnapshot>;
  act(sessionId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserPageSnapshot>;
  screenshot(sessionId: string, signal?: AbortSignal): Promise<BrowserScreenshot>;
  closeSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

const MAX_SNAPSHOT_CHARS = 24_000;

export class PlaywrightCliBrowser implements BrowserAutomation {
  private readonly activeSessions = new Set<string>();

  constructor(
    private readonly paths: ManagedBrowserPaths,
    private readonly runner: BrowserCommandRunner,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async open(sessionId: string, rawUrl: string, options: { headed?: boolean } = {}, signal?: AbortSignal): Promise<BrowserPageSnapshot> {
    const url = publicWebUrl(rawUrl);
    const session = browserSessionName(sessionId);
    await this.ensureInstalled();
    await mkdir(this.paths.profileRoot, { recursive: true });
    await mkdir(join(this.paths.artifactRoot, session), { recursive: true });
    await this.closeOtherSessions(session);
    await this.run(session, [
      "open",
      url,
      `--config=${this.paths.configPath}`,
      `--profile=${this.paths.profileRoot}`,
      ...(options.headed ? ["--headed"] : []),
    ], signal);
    this.activeSessions.add(session);
    return this.snapshot(sessionId, signal);
  }

  async snapshot(sessionId: string, signal?: AbortSignal): Promise<BrowserPageSnapshot> {
    const session = browserSessionName(sessionId);
    await this.ensureInstalled();
    const result = await this.run(session, ["snapshot", "--raw"], signal);
    return { text: bounded(result.stdout.trim() || result.stderr.trim()), session };
  }

  async act(sessionId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserPageSnapshot> {
    const session = browserSessionName(sessionId);
    await this.ensureInstalled();
    await this.run(session, actionArguments(action), signal);
    return this.snapshot(sessionId, signal);
  }

  async screenshot(sessionId: string, signal?: AbortSignal): Promise<BrowserScreenshot> {
    const session = browserSessionName(sessionId);
    await this.ensureInstalled();
    const directory = join(this.paths.artifactRoot, session);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `screenshot-${Date.now()}.png`);
    await this.run(session, ["screenshot", `--filename=${path}`], signal);
    return { data: (await readFile(path)).toString("base64"), mimeType: "image/png", path, session };
  }

  async close(): Promise<void> {
    const sessions = [...this.activeSessions];
    this.activeSessions.clear();
    await Promise.all(sessions.map((session) => this.run(session, ["close"]).catch(() => undefined)));
  }

  async closeSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const session = browserSessionName(sessionId);
    await this.ensureInstalled();
    await this.run(session, ["close"], signal);
    this.activeSessions.delete(session);
  }

  private async closeOtherSessions(current: string): Promise<void> {
    const previous = [...this.activeSessions].filter((session) => session !== current);
    for (const session of previous) {
      await this.run(session, ["close"]).catch(() => undefined);
      this.activeSessions.delete(session);
    }
  }

  private async run(session: string, args: readonly string[], signal?: AbortSignal) {
    const cwd = join(this.paths.artifactRoot, session);
    await mkdir(cwd, { recursive: true });
    return this.runner.run({
      command: process.execPath,
      args: [this.paths.cliPath, `-s=${session}`, ...args],
      cwd,
      ...(signal ? { signal } : {}),
      environment: managedEnvironment(this.paths, this.environment),
    });
  }

  private async ensureInstalled(): Promise<void> {
    try {
      await readFile(this.paths.cliPath);
    } catch {
      throw new Error("Browser support is not installed. Run `livepeer browser install`, then retry.");
    }
  }
}

function actionArguments(action: BrowserAction): string[] {
  switch (action.action) {
    case "click":
    case "hover":
    case "check":
    case "uncheck":
      return [action.action, action.ref];
    case "fill":
    case "select":
      return [action.action, action.ref, action.value];
    case "press":
      return ["press", action.value];
    case "go_back":
      return ["go-back"];
    case "go_forward":
      return ["go-forward"];
    case "reload":
      return ["reload"];
  }
}

function publicWebUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("browser_open requires an absolute http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("browser_open permits only http and https URLs.");
  }
  url.username = "";
  url.password = "";
  return url.toString();
}

function browserSessionName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return `livepeer-${(safe || "session").slice(0, 48)}`;
}

function bounded(value: string): string {
  if (value.length <= MAX_SNAPSHOT_CHARS) return value;
  return `${value.slice(0, MAX_SNAPSHOT_CHARS)}\n… [browser snapshot truncated]`;
}

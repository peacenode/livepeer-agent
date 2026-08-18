import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { CommandResult, CredentialStore } from "@livepeer-agent/contracts";
import { CliInputError, createProcessIO, readJsonInput, type CliIO } from "../io/index.js";
import { renderResult, reportProgress } from "../output/index.js";
import type { CliOperations, OperationOptions } from "../operations/index.js";
import type { ModelProvider, ProviderStore } from "../operations/provider-store.js";
import type { OAuthProvider } from "../credentials/pi-credential-store.js";
import type { ProviderAuthManager } from "../operations/provider-auth.js";
import type { BrowserInstallOptions, ManagedBrowserStatus } from "@livepeer-agent/terminal-host";
import type { ReleaseUpdater } from "../update/release-updater.js";
import cliManifest from "../../package.json" with { type: "json" };

export interface BrowserManagementPort {
  status(): Promise<ManagedBrowserStatus>;
  install(options?: BrowserInstallOptions): Promise<ManagedBrowserStatus>;
}

interface Dependencies {
  operations: CliOperations;
  daydreamCredentials: CredentialStore;
  providers: ProviderStore;
  providerAuth: ProviderAuthManager;
  browser: BrowserManagementPort;
  updater: ReleaseUpdater;
  openBrowser?(url: string): Promise<boolean>;
  runAgent(options: { resume: boolean }): Promise<void>;
  close?(): Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

export interface RunCliOptions {
  io?: CliIO;
  interruptSource?: Pick<NodeJS.Process, "on" | "off">;
  forceExit?: () => void;
}

interface ProgramState { signal: AbortSignal; json: boolean; exitCode: number }
interface JsonOptions { json?: boolean }

export async function runCli(argv: string[], dependencies: Dependencies, options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? createProcessIO();
  const json = argv.slice(2).includes("--json");
  const parseArgv = json ? argv.filter((value, index) => index < 2 || value !== "--json") : argv;
  const controller = new AbortController();
  const interrupts = options.interruptSource ?? process;
  const state: ProgramState = { signal: controller.signal, json, exitCode: 0 };
  let interrupted = false;
  const onInterrupt = () => {
    if (!interrupted) {
      interrupted = true;
      controller.abort(new DOMException("Cancelled by user.", "AbortError"));
    } else if (options.forceExit) options.forceExit();
  };
  interrupts.on("SIGINT", onInterrupt);
  const program = createProgram(dependencies, io, state);
  try {
    await program.parseAsync(parseArgv);
  } catch (error) {
    if (error instanceof CommanderError) {
      const informational = ["commander.helpDisplayed", "commander.version"].includes(error.code);
      state.exitCode = informational ? 0 : 1;
      if (!informational && json) emit(failure(inferCommand(argv), "INPUT", error.message), true, io, state);
    } else {
      emit(fromException(inferCommand(argv), error), json, io, state);
    }
  } finally {
    interrupts.off("SIGINT", onInterrupt);
    try { await dependencies.close?.(); }
    catch (error) {
      io.stderr(`Could not close Livepeer connection: ${(error as Error).message}\n`);
      if (state.exitCode === 0) state.exitCode = 3;
    }
  }
  return state.exitCode;
}

export function createProgram(dependencies: Dependencies, io: CliIO, state: ProgramState): Command {
  const program = new Command()
    .name("livepeer")
    .description("Livepeer media tools and terminal agent")
    .version(cliManifest.version)
    .addOption(jsonOption())
    .showHelpAfterError()
    .configureOutput({
      writeOut: (value) => { if (!state.json) io.stdout(value); },
      writeErr: (value) => { if (!state.json) io.stderr(value); },
    })
    .exitOverride()
    .action(async () => runAgent(false));

  const operationOptions = (): OperationOptions => ({ signal: state.signal, onProgress: (value) => reportProgress(value, io) });
  const output = (result: CommandResult<unknown>, requested = false) => emit(result, state.json || requested, io, state);
  const operation = async (command: string, action: () => Promise<CommandResult<unknown>>, requested = false) => {
    try { output(await action(), requested); }
    catch (error) { output(fromException(command, error), requested); }
  };
  const runAgent = async (resume: boolean) => {
    if (!io.stdinIsTTY || !io.stdoutIsTTY) return output(failure("agent", "INPUT", "The interactive terminal requires a TTY."));
    await local("agent", () => dependencies.runAgent({ resume }));
  };
  const local = async (command: string, action: () => Promise<void>, data?: unknown, requested = false) => {
    const started = Date.now();
    try {
      await action();
      output({ ok: true, command, ...(data !== undefined ? { data } : {}), meta: { durationMs: Date.now() - started } }, requested);
    } catch (error) { output(fromException(command, error, started), requested); }
  };

  program.command("agent").description("Open the interactive terminal agent")
    .option("--resume", "resume the latest session")
    .action((options: { resume?: boolean }) => runAgent(Boolean(options.resume)));

  program.command("update").description("Check for and install the latest Livepeer Agent release")
    .option("--check", "check without installing")
    .addOption(jsonOption())
    .action((options: JsonOptions & { check?: boolean }) => operation("update", async () => {
      const started = Date.now();
      const data = options.check
        ? await dependencies.updater.check(state.signal)
        : await dependencies.updater.install(state.signal);
      const message = data.updated
        ? `Updated Livepeer Agent from ${data.currentVersion} to ${data.latestVersion}. Restart any open agent.`
        : data.updateAvailable
          ? `Livepeer Agent ${data.latestVersion} is available. Run \`livepeer update\`.`
          : `Livepeer Agent is up to date (${data.currentVersion}).`;
      return {
        ok: true,
        command: "update",
        data,
        content: [{ type: "text" as const, text: message }],
        meta: { durationMs: Date.now() - started },
      };
    }, options.json));

  const browser = program.command("browser").description("Manage the terminal agent browser");
  browser.command("status").description("Show whether managed browser support is installed").addOption(jsonOption())
    .action((options: JsonOptions) => operation("browser.status", async () => ({
      ok: true,
      command: "browser.status",
      data: await dependencies.browser.status(),
      meta: { durationMs: 0 },
    }), options.json));
  browser.command("install").description("Install the pinned Playwright CLI and managed Chromium browser")
    .option("--force", "reinstall the pinned browser companion")
    .addOption(jsonOption())
    .action((options: JsonOptions & { force?: boolean }) => operation("browser.install", async () => {
      const started = Date.now();
      const data = await dependencies.browser.install({
        force: Boolean(options.force),
        signal: state.signal,
        onProgress: (message) => { if (!state.json && !options.json) io.stderr(`${message}\n`); },
      });
      return { ok: true, command: "browser.install", data, meta: { durationMs: Date.now() - started } };
    }, options.json));

  const key = program.command("key").description("Manage the Livepeer MCP API key");
  key.command("add").description("Store a Daydream API key securely")
    .option("--stdin", "read the API key from stdin")
    .option("--from-env", "store DAYDREAM_API_KEY from the environment")
    .addOption(jsonOption())
    .action(async (options: JsonOptions & { stdin?: boolean; fromEnv?: boolean }) => {
      if (options.stdin && options.fromEnv) return output(failure("key.add", "INPUT", "Choose either --stdin or --from-env."), options.json);
      const environment = dependencies.environment ?? process.env;
      let value: string | undefined;
      if (options.fromEnv) value = environment.DAYDREAM_API_KEY;
      else if (options.stdin) value = await io.readStdin();
      else if (io.stdinIsTTY) value = await io.promptSecret("Daydream API key:", state.signal);
      else return output(failure("key.add", "INPUT", "Use an interactive terminal, --stdin, or --from-env."), options.json);
      const apiKey = value?.trim();
      if (!apiKey) return output(failure("key.add", "INPUT", options.fromEnv ? "DAYDREAM_API_KEY is not set." : "API key cannot be empty."), options.json);
      await local("key.add", () => dependencies.daydreamCredentials.set(apiKey), {
        configured: true,
        source: "stored",
        next: "livepeer access status",
        restartOpenAgents: true,
      }, options.json);
    });
  key.command("status").description("Show whether a Daydream API key is configured").addOption(jsonOption())
    .action((options: JsonOptions) => operation("key.status", async () => {
      const stored = Boolean(await dependencies.daydreamCredentials.get());
      const environment = Boolean((dependencies.environment ?? process.env).DAYDREAM_API_KEY?.trim());
      return {
        ok: true,
        command: "key.status",
        data: { configured: stored || environment, source: stored ? "stored" : environment ? "environment" : null },
        meta: { durationMs: 0 },
      };
    }, options.json));
  key.command("remove").description("Remove the stored Daydream API key").addOption(jsonOption())
    .action(async (options: JsonOptions) => {
      await dependencies.daydreamCredentials.delete();
      const environment = Boolean((dependencies.environment ?? process.env).DAYDREAM_API_KEY?.trim());
      output({
        ok: true,
        command: "key.remove",
        data: { configured: environment, source: environment ? "environment" : null },
        meta: { durationMs: 0 },
      }, options.json);
    });

  program.command("access").description("Inspect effective Livepeer MCP access").command("status")
    .description("Confirm which credential and profile MCP sees")
    .addOption(jsonOption())
    .action((options: JsonOptions) => operation("access.status", async () => {
      const stored = Boolean((await dependencies.daydreamCredentials.get())?.trim());
      const environment = Boolean((dependencies.environment ?? process.env).DAYDREAM_API_KEY?.trim());
      const localKeyConfigured = stored || environment;
      const result = await dependencies.operations.callTool("me", {}, operationOptions());
      if (!result.ok) return { ...result, command: "access.status" };
      const envelope = record(result.data);
      const identity = record(envelope?.structuredContent);
      const keyClass = typeof identity?.key_class === "string" ? identity.key_class : "unknown";
      const profile = record(identity?.profile);
      const profileAttached = Boolean(profile);
      const emailAttached = typeof profile?.email === "string" && profile.email.trim().length > 0;
      const credentialApplied = keyClass === "daydream";
      const state = accessState(localKeyConfigured, credentialApplied, profileAttached);
      return {
        ok: true,
        command: "access.status",
        data: {
          state,
          localKeyConfigured,
          credentialApplied,
          keyClass,
          profileAttached,
          emailAttached,
          guidance: accessGuidance(state),
        },
        meta: result.meta,
      };
    }, options.json));

  const provider = program.command("provider").description("Manage local model-provider credentials");
  provider.command("add").argument("<provider>", "openai or anthropic", parseProvider)
    .option("--api-key <key>", "API key (prefer the provider environment variable to avoid shell history)")
    .addOption(jsonOption()).action(async (name: ModelProvider, options: JsonOptions & { apiKey?: string }) => {
      const environment = dependencies.environment ?? process.env;
      const apiKey = options.apiKey ?? environment[name === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
      if (!apiKey) return output(failure("provider.add", "INPUT", `Set ${name === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} or pass --api-key.`), options.json);
      await local("provider.add", () => dependencies.providers.add(name, apiKey), { provider: name, configured: true }, options.json);
    });
  provider.command("remove").argument("<provider>", "openai or anthropic", parseProvider).addOption(jsonOption())
    .action((name: ModelProvider, options: JsonOptions) => local("provider.remove", () => dependencies.providers.remove(name), { provider: name, configured: false }, options.json));
  provider.command("login").argument("<provider>", "openai-codex", parseOAuthProvider).addOption(jsonOption())
    .action((name: OAuthProvider, options: JsonOptions) => local("provider.login", async () => {
      await dependencies.providerAuth.login(name, {
        signal: state.signal,
        prompt: (request) => promptForProvider(request, io),
        notify: (event) => notifyProviderAuth(event, io, dependencies.openBrowser ? (url) => dependencies.openBrowser!(url) : undefined),
      });
    }, { provider: name, configured: true, type: "oauth" }, options.json));
  provider.command("logout").argument("<provider>", "openai-codex", parseOAuthProvider).addOption(jsonOption())
    .action((name: OAuthProvider, options: JsonOptions) => local("provider.logout", () => dependencies.providerAuth.logout(name, state.signal), { provider: name, configured: false, type: "oauth" }, options.json));
  provider.command("list").addOption(jsonOption()).action((options: JsonOptions) => operation("provider.list", async () => ({
    ok: true,
    command: "provider.list",
    data: [...await dependencies.providerAuth.list(state.signal), ...await dependencies.providers.list().then((items) => items.map((item) => ({ ...item, type: "api_key" as const })))],
    meta: { durationMs: 0 },
  }), options.json));

  const tools = program.command("tools").description("Inspect and call Livepeer tools");
  tools.command("list").addOption(jsonOption()).action((options: JsonOptions) => operation("tools.list", () => dependencies.operations.listTools(operationOptions()), options.json));
  tools.command("describe").argument("<name>").addOption(jsonOption()).action((name: string, options: JsonOptions) => operation("tools.describe", () => dependencies.operations.describeTool(name, operationOptions()), options.json));
  tools.command("call").argument("<name>").requiredOption("--input <file|->", "JSON object file, or - for stdin")
    .option("--yes", "approve a tool that may make changes").addOption(jsonOption())
    .action(async (name: string, options: JsonOptions & { input: string; yes?: boolean }) => {
      try {
        const input = await readJsonInput(options.input, io);
        const allowed = options.yes || await allowReadOnly(name, dependencies.operations, operationOptions()) || (io.stdinIsTTY && await io.confirm(`Run ${name}?`));
        if (!allowed) return output(failure("tools.call", io.stdinIsTTY ? "CANCELLED" : "INPUT", io.stdinIsTTY ? "Tool call cancelled." : "This tool may make changes. Re-run with --yes."), options.json);
        await operation("tools.call", () => dependencies.operations.callTool(name, input, operationOptions()), options.json);
      } catch (error) { output(fromException("tools.call", error), options.json); }
    });

  program.command("capabilities").description("Inspect Livepeer capabilities").command("list")
    .option("--kind <kind>", "ai, tool, or mcp", parseKind).option("--limit <number>", "maximum results", positiveInteger)
    .option("--offset <number>", "results to skip", nonnegativeInteger).addOption(jsonOption())
    .action((options: JsonOptions & { kind?: string; limit?: number; offset?: number }) => operation("capabilities.list", () => dependencies.operations.listCapabilities(options, operationOptions()), options.json));

  program.command("media").description("Generate media").command("generate").requiredOption("--prompt <text>")
    .option("--model <capability>").option("--aspect <ratio>").option("--quality <quality>", "fast, balanced, or hq", parseQuality)
    .option("--yes", "approve media generation").addOption(jsonOption())
    .action(async (options: JsonOptions & { prompt: string; model?: string; aspect?: string; quality?: string; yes?: boolean }) => {
      const allowed = options.yes || (io.stdinIsTTY && await io.confirm("Generate media?"));
      if (!allowed) return output(failure("media.generate", io.stdinIsTTY ? "CANCELLED" : "INPUT", io.stdinIsTTY ? "Media generation cancelled." : "Media generation requires approval. Re-run with --yes."), options.json);
      await operation("media.generate", () => dependencies.operations.generateMedia(options, operationOptions()), options.json);
    });

  const jobs = program.command("jobs").description("Inspect media jobs");
  jobs.command("get").argument("<id>").addOption(jsonOption()).action((id: string, options: JsonOptions) => operation("jobs.get", () => dependencies.operations.getJob(id, operationOptions()), options.json));
  jobs.command("wait").argument("<id>").option("--interval <seconds>", "poll interval", positiveNumber, 2)
    .option("--timeout <seconds>", "maximum wait", positiveNumber, 600).addOption(jsonOption())
    .action((id: string, options: JsonOptions & { interval: number; timeout: number }) => operation("jobs.wait", () => dependencies.operations.waitForJob(id, { intervalMs: options.interval * 1000, timeoutMs: options.timeout * 1000 }, operationOptions()), options.json));
  return program;
}

async function allowReadOnly(name: string, operations: CliOperations, options: OperationOptions): Promise<boolean> {
  const result = await operations.describeTool(name, options);
  return Boolean(result.ok && result.data?.annotations?.readOnlyHint === true);
}

function emit(result: CommandResult<unknown>, json: boolean, io: CliIO, state: ProgramState): void { state.exitCode = renderResult(result, json, io); }
function failure(command: string, code: string, message: string, started = Date.now()): CommandResult<never> { return { ok: false, command, error: { code, message }, meta: { durationMs: Date.now() - started } }; }
function fromException(command: string, error: unknown, started = Date.now()): CommandResult<never> {
  if (error instanceof CliInputError || error instanceof InvalidArgumentError) return failure(command, "INPUT", error.message, started);
  const value = error as { name?: string; code?: string; message?: string; exitCode?: number; status?: number };
  const message = value?.message ?? String(error);
  if (value?.name === "AbortError") return failure(command, "CANCELLED", message, started);
  if (value?.exitCode === 1) return failure(command, "INPUT", message, started);
  if (value?.exitCode === 2 || value?.status === 401) return failure(command, "AUTH", message, started);
  if (value?.exitCode === 4) return failure(command, "CANCELLED", message, started);
  return failure(command, "REMOTE", message, started);
}
function jsonOption(): Option { return new Option("--json", "emit one stable JSON result"); }
function parseProvider(value: string): ModelProvider { if (value !== "openai" && value !== "anthropic") throw new InvalidArgumentError("choose openai or anthropic"); return value; }
function parseOAuthProvider(value: string): OAuthProvider { if (value !== "openai-codex") throw new InvalidArgumentError("choose openai-codex"); return value; }
function parseKind(value: string): string { if (!["ai", "tool", "mcp"].includes(value)) throw new InvalidArgumentError("choose ai, tool, or mcp"); return value; }
function parseQuality(value: string): string { if (!["fast", "balanced", "hq"].includes(value)) throw new InvalidArgumentError("choose fast, balanced, or hq"); return value; }
function positiveInteger(value: string): number { const n = Number(value); if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("must be a positive integer"); return n; }
function nonnegativeInteger(value: string): number { const n = Number(value); if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be a non-negative integer"); return n; }
function positiveNumber(value: string): number { const n = Number(value); if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be greater than zero"); return n; }
function inferCommand(argv: string[]): string { const p = argv.slice(2).filter((value) => !value.startsWith("-")); return ["tools", "capabilities", "media", "jobs", "provider", "key", "access", "browser"].includes(p[0] ?? "") && p[1] ? `${p[0]}.${p[1]}` : p[0] ?? "agent"; }

type AccessState = "keyless_preview" | "keyless_profile" | "daydream_key" | "daydream_profile" | "credential_mismatch";

function accessState(localKeyConfigured: boolean, credentialApplied: boolean, profileAttached: boolean): AccessState {
  if (localKeyConfigured && !credentialApplied) return "credential_mismatch";
  if (credentialApplied) return profileAttached ? "daydream_profile" : "daydream_key";
  return profileAttached ? "keyless_profile" : "keyless_preview";
}

function accessGuidance(state: AccessState): string {
  switch (state) {
    case "keyless_preview":
      return "Keyless preview is active. Verify email in the agent for preview allowance, or run `livepeer key add` for Daydream models.";
    case "keyless_profile":
      return "A keyless MCP profile is attached. Run `livepeer key add` to use Daydream models; keyless email activation does not unlock them.";
    case "daydream_key":
      return "The Daydream key is active. To attach and verify email for this key, run the agent and say: verify my email.";
    case "daydream_profile":
      return "The Daydream key and an MCP email profile are active. If a gated action requests verification, ask the agent to verify my email.";
    case "credential_mismatch":
      return "A local key exists but MCP did not receive it as a Daydream bearer. Restart open agents, then run `livepeer access status` again.";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function promptForProvider(request: AuthPrompt, io: CliIO): Promise<string> {
  if (request.type === "select") {
    io.stderr(`${request.options.map((option) => `${option.id}: ${option.label}`).join("\n")}\n`);
  }
  return io.prompt(request.message, request.signal);
}

function notifyProviderAuth(event: AuthEvent, io: CliIO, openBrowser?: (url: string) => Promise<boolean>): void {
  if (event.type === "auth_url") {
    io.stderr(`${event.instructions ? `${event.instructions}\n` : ""}Open to continue: ${event.url}\n`);
    void openBrowser?.(event.url).catch(() => undefined);
    return;
  }
  if (event.type === "device_code") {
    io.stderr(`Enter code ${event.userCode} at ${event.verificationUri}\n`);
    return;
  }
  io.stderr(`${event.message}\n`);
  if (event.type === "info") for (const link of event.links ?? []) io.stderr(`${link.label ?? "More information"}: ${link.url}\n`);
}

export type { Dependencies as CliDependencies };

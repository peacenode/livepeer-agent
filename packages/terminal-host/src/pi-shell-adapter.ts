import { join } from "node:path";
import type { CredentialStore as ModelCredentialStore } from "@earendil-works/pi-ai";
import {
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ProductBudget,
  type ToolDefinition,
} from "@livepeer/pi-coding-agent";
import * as PiCodingAgentSdk from "@livepeer/pi-coding-agent";
import { createLivepeerToolRegistrations } from "./livepeer/agent-tools.js";
import {
  ManagedBrowserCompanion,
  PlaywrightCliBrowser,
  createBrowserCommandRunner,
  createBrowserToolDefinitions,
} from "./browser/index.js";
import { LivepeerToolRouter } from "./livepeer/router.js";
import { createProductCapabilities } from "./capability-menu.js";
import { createLivepeerResourceLoader, createLivepeerResourcePlan } from "./resources/index.js";
import type {
  InteractiveShellAdapter,
  LivepeerInteractiveContext,
  ModelSelection,
} from "./index.js";

export const MINIMUM_BOOT_DURATION_MS = 1_400;

export interface PiShellLaunch {
  context: LivepeerInteractiveContext;
  sessionDirectory: string;
  mode: "fresh" | "resume";
  modelCredentials: ModelCredentialStore;
}

/**
 * Testable bridge around the fork application shell. The default implementation
 * below is the only code in this package that knows the fork's concrete SDK.
 */
export interface PiCodingAgentBridge {
  run(launch: PiShellLaunch): Promise<void>;
}

export interface PiInteractiveShellAdapterOptions {
  bridge?: PiCodingAgentBridge;
}

export interface SessionBudget extends ProductBudget {
  maxCostUsd(): number | undefined;
}

export function createSessionBudget(): SessionBudget {
  let value: number | undefined;
  return {
    maxCostUsd: () => value,
    get: () => ({
      ...(value === undefined ? {} : { maxCostUsd: value }),
      status: value === undefined ? "No per-operation cap is set." : `$${value.toFixed(2)} maximum per paid operation.`,
    }),
    set: (next) => {
      value = next;
      return {
        ...(value === undefined ? {} : { maxCostUsd: value }),
        status: value === undefined
          ? "Per-operation cap removed. Paid actions still require approval."
          : `$${value.toFixed(2)} maximum per paid operation.`,
      };
    },
  };
}

export function createPiInteractiveShellAdapter(options: PiInteractiveShellAdapterOptions = {}): InteractiveShellAdapter {
  const bridge = options.bridge ?? new RootExportPiCodingAgentBridge();
  return {
    run: (context) => bridge.run({
      context,
      sessionDirectory: join(context.configRoot, "sessions", "v2"),
      mode: context.resume ? "resume" : "fresh",
      modelCredentials: context.services.modelCredentials,
    }),
  };
}

export function createLivepeerSessionManager(
  cwd: string,
  sessionDirectory: string,
  mode: PiShellLaunch["mode"],
): SessionManager {
  return mode === "resume"
    ? SessionManager.continueRecent(cwd, sessionDirectory)
    : SessionManager.create(cwd, sessionDirectory);
}

class RootExportPiCodingAgentBridge implements PiCodingAgentBridge {
  async run(launch: PiShellLaunch): Promise<void> {
    const bootScreen = createEarlyBootScreen();
    try {
      await this.prepareAndRun(launch, bootScreen);
    } finally {
      bootScreen.stop();
    }
  }

  private async prepareAndRun(launch: PiShellLaunch, bootScreen: EarlyBootScreen): Promise<void> {
    const { context } = launch;
    const productCapabilities = createProductCapabilities(context.services.execution);
    void productCapabilities.warm().catch(() => undefined);
    const agentDir = context.configRoot;
    const sessionManager = createLivepeerSessionManager(context.cwd, launch.sessionDirectory, launch.mode);
    const router = new LivepeerToolRouter(await resolveAccess(context));
    await router.reload(await resolveAccess(context), context.services.execution);
    const productBudget = createSessionBudget();
    const browserCompanion = new ManagedBrowserCompanion(agentDir);
    const browser = new PlaywrightCliBrowser(browserCompanion.paths, createBrowserCommandRunner());
    const browserScreenshots = new Set<string>();
    const customTools = [
      ...createLivepeerToolRegistrations(router, () => {
        const originalUserPrompt = latestUserPrompt(sessionManager);
        return originalUserPrompt ? { originalUserPrompt } : {};
      }, productBudget, { isAllowed: (path) => browserScreenshots.has(path) })
        .map(({ definition }) => definition as ToolDefinition),
      ...createBrowserToolDefinitions(browser, { onScreenshot: (path) => browserScreenshots.add(path) }),
    ];
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir: runtimeAgentDir,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
    }) => {
      const settingsManager = SettingsManager.create(cwd, runtimeAgentDir);
      const modelRuntime = await ModelRuntime.create({
        credentials: launch.modelCredentials,
        modelsPath: null,
        refreshOnCreate: false,
      });
      const resourcePlan = createLivepeerResourcePlan({
        cwd,
        configRoot: runtimeAgentDir,
      });
      const resourceLoader = createLivepeerResourceLoader(resourcePlan, settingsManager);
      await resourceLoader.reload();

      const requested = context.services.models.current();
      const model = await resolveSelectedModel(modelRuntime, requested, launch.modelCredentials);
      const created = await createAgentSession({
        cwd,
        agentDir: runtimeAgentDir,
        modelRuntime,
        settingsManager,
        resourceLoader,
        sessionManager: runtimeSessionManager,
        customTools,
        ...(model ? { model } : {}),
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
      });
      return {
        ...created,
        services: {
          cwd,
          agentDir: runtimeAgentDir,
          modelRuntime,
          settingsManager,
          resourceLoader,
          diagnostics: [],
        },
        diagnostics: [],
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: context.cwd,
      agentDir,
      sessionManager,
    });
    const mode = new InteractiveMode(runtime, {
      verbose: false,
      productCapabilities,
      productBudget,
      showLoadedResources: false,
      ...(bootScreen.terminal ? { terminal: bootScreen.terminal } : {}),
    });
    await waitForMinimumBootDuration(bootScreen.startedAtMs);
    bootScreen.stop();
    try {
      await mode.run();
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    } finally {
      await browser.close();
    }
  }
}

function latestUserPrompt(sessionManager: SessionManager): string | undefined {
  const entries = sessionManager.buildContextEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.type === "text" ? block.text : "")
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

interface EarlyBootScreen {
  startedAtMs: number;
  terminal?: NonNullable<ConstructorParameters<typeof InteractiveMode>[1]>["terminal"];
  stop(): void;
}

function createEarlyBootScreen(): EarlyBootScreen {
  const startedAtMs = performance.now();
  const factory = (PiCodingAgentSdk as unknown as {
    createLivepeerBootScreen?: () => Omit<EarlyBootScreen, "startedAtMs">;
  }).createLivepeerBootScreen;
  const screen = factory?.() ?? { stop() {} };
  return { ...screen, startedAtMs };
}

export function remainingBootDuration(
  startedAtMs: number,
  nowMs: number,
  minimumMs = MINIMUM_BOOT_DURATION_MS,
): number {
  return Math.max(0, minimumMs - (nowMs - startedAtMs));
}

async function waitForMinimumBootDuration(startedAtMs: number): Promise<void> {
  const remaining = remainingBootDuration(startedAtMs, performance.now());
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function resolveAccess(context: LivepeerInteractiveContext): Promise<"anonymous" | "authenticated"> {
  return await context.services.livepeer.credentials.get() ? "authenticated" : "anonymous";
}

async function resolveSelectedModel(
  modelRuntime: ModelRuntime,
  selection: ModelSelection | undefined,
  credentials: ModelCredentialStore,
) {
  if (selection) return modelRuntime.getModel(selection.provider, selection.model);

  const configured = new Set((await credentials.list()).map(({ providerId }) => providerId));
  const preferredProviders = ["openai-codex", ...configured].filter(
    (provider, index, providers) => configured.has(provider) && providers.indexOf(provider) === index,
  );
  for (const provider of preferredProviders) {
    const models = modelRuntime.getModels(provider);
    const preferred = provider === "openai-codex"
      ? models.find(({ id }) => id === "gpt-5.6-terra") ?? models.find(({ id }) => id === "gpt-5.5")
      : undefined;
    if (preferred) return preferred;
    if (models[0]) return models[0];
  }
  return undefined;
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Terminal } from "@earendil-works/pi-tui";
import { isViewportTUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "./support/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createInteractiveTui,
	InteractiveMode,
	type InteractiveModeOptions,
	type InteractiveTuiOptions,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";

class HarnessTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for shell state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("interactive shell public API", () => {
	it("accepts a terminal through the root-exported InteractiveMode options", () => {
		const terminal = new HarnessTerminal();
		const options = { terminal } satisfies InteractiveModeOptions;

		expect(options.terminal).toBe(terminal);
	});

	it("constructs both renderer modes with a caller-owned terminal through root exports", () => {
		for (const tuiMode of ["regular", "fullscreen"] as const) {
			const terminal = new HarnessTerminal();
			const options = {
				tuiMode,
				showHardwareCursor: false,
				logDirectory: "/tmp/livepeer-shell-harness",
				terminal,
			} satisfies InteractiveTuiOptions;
			const tui = createInteractiveTui(options);

			expect(tui.terminal).toBe(terminal);
			expect(isViewportTUI(tui)).toBe(tuiMode === "fullscreen");
		}
	});

	it("cancels an active turn with Ctrl-C while preserving idle clear behavior", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "livepeer-shell-ctrlc-"));
		const previousOffline = process.env.LIVEPEER_OFFLINE;
		process.env.LIVEPEER_OFFLINE = "1";
		const faux = registerFauxProvider({
			tokensPerSecond: 5,
			tokenSize: { min: 1, max: 1 },
		});
		faux.setResponses([fauxAssistantMessage("a deliberately slow response")]);

		const credentials = new InMemoryCredentialStore();
		const model = faux.getModel();
		await credentials.modify(model.provider, async () => ({
			type: "api_key",
			key: "test-key",
		}));
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});

		const settingsManager = SettingsManager.inMemory({ quietStartup: true });
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
				settingsManager,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		const terminal = new HarnessTerminal();
		const mode = new InteractiveMode(runtime, { terminal, verbose: false });

		try {
			await mode.init();
			const activePrompt = runtime.session.prompt("start the slow response");
			await waitFor(() => runtime.session.isStreaming);
			await runtime.session.prompt("queued correction", {
				streamingBehavior: "steer",
			});

			terminal.sendInput("\x03");
			await activePrompt;

			expect(runtime.session.isStreaming).toBe(false);
			const restoredInput = mode.getUserInput();
			terminal.sendInput("\r");
			await expect(restoredInput).resolves.toBe("queued correction");

			const idleInput = mode.getUserInput();
			terminal.sendInput("draft");
			terminal.sendInput("\x03");
			terminal.sendInput("\r");
			await expect(
				Promise.race([idleInput.then(() => "resolved"), new Promise((resolve) => setTimeout(resolve, 30))]),
			).resolves.toBeUndefined();
			terminal.sendInput("kept");
			terminal.sendInput("\r");
			await expect(idleInput).resolves.toBe("kept");
		} finally {
			mode.stop();
			await runtime.dispose();
			faux.unregister();
			if (previousOffline === undefined) delete process.env.LIVEPEER_OFFLINE;
			else process.env.LIVEPEER_OFFLINE = previousOffline;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("erases the editor cursor cell with its background before restoring shell attributes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "livepeer-shell-cursor-cleanup-"));
		const previousOffline = process.env.LIVEPEER_OFFLINE;
		process.env.LIVEPEER_OFFLINE = "1";
		const faux = registerFauxProvider();
		const credentials = new InMemoryCredentialStore();
		const model = faux.getModel();
		await credentials.modify(model.provider, async () => ({
			type: "api_key",
			key: "test-key",
		}));
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});
		const settingsManager = SettingsManager.inMemory({ quietStartup: true });
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const session = await createAgentSessionFromServices({
			services,
			sessionManager,
			model,
		});
		const runtime = await createAgentSessionRuntime(
			async () => ({ ...session, services, diagnostics: services.diagnostics }),
			{
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager,
			},
		);
		const terminal = new HarnessTerminal();
		const mode = new InteractiveMode(runtime, { terminal, verbose: false });

		try {
			await mode.init();
			terminal.writes.length = 0;
			mode.stop();
			const cleanup = terminal.writes.join("");
			expect(cleanup).toMatch(/\x1b\[48;/u);
			expect(cleanup.endsWith("\x1b[0m\x1b[49m")).toBe(true);
		} finally {
			await runtime.dispose();
			faux.unregister();
			if (previousOffline === undefined) delete process.env.LIVEPEER_OFFLINE;
			else process.env.LIVEPEER_OFFLINE = previousOffline;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

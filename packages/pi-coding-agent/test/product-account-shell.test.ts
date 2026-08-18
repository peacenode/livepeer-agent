import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { createLivepeerToolRenderers } from "../../terminal-host/src/livepeer/rendering.ts";
import { VirtualTerminal } from "./support/virtual-terminal.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	ModelRuntime,
	type ProductAccountAuth,
	type ProductBudget,
	type ProductCapabilities,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "../src/index.ts";

class HarnessTerminal extends VirtualTerminal implements Terminal {}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createRuntimeHarness(options: {
	customTools?: ToolDefinition[];
	responses?: FauxResponseStep[];
} = {}): Promise<AgentSessionRuntime> {
	const tempDir = mkdtempSync(join(tmpdir(), "livepeer-account-shell-"));
	const faux = registerFauxProvider();
	faux.setResponses(options.responses ?? []);
	const model = faux.getModel();
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
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
					customTools: options.customTools,
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
	cleanups.push(async () => {
		await runtime.dispose();
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	});
	return runtime;
}

function createProductAccountAuth(overrides: Partial<ProductAccountAuth> = {}): ProductAccountAuth {
	return {
		login: async () => ({ status: "Logged in" }),
		logout: async () => ({ status: "Logged out" }),
		account: async () => ({ status: "Account ready" }),
		activate: async () => ({ status: "Activated" }),
		...overrides,
	};
}

function submit(terminal: HarnessTerminal, text: string): void {
	terminal.sendInput(text);
	terminal.sendInput("\r");
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for product account shell state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function waitForTerminalText(terminal: HarnessTerminal, text: string): Promise<void> {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		await terminal.flush();
		if (terminal.getViewport().join("\n").includes(text)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for terminal text: ${text}`);
}

describe("product account interactive shell", () => {
	it("renders the compact capability home and runs local capability commands without a model turn", async () => {
		const runtime = await createRuntimeHarness({
			customTools: [testTool("list_capabilities", "Discover current Livepeer capabilities")],
		});
		const calls: string[] = [];
		let maxCostUsd: number | undefined;
		const productBudget: ProductBudget = {
			get: () => ({
				maxCostUsd,
				status: maxCostUsd === undefined ? "No session cap set." : `$${maxCostUsd} per operation.`,
			}),
			set: (value) => {
				maxCostUsd = value;
				return { maxCostUsd, status: value === undefined ? "Session cap removed." : `$${value} per operation.` };
			},
		};
		const productCapabilities: ProductCapabilities = {
			list: async (category) => {
				calls.push(category);
				return {
					title: category === "all" ? "All capabilities" : "Image capabilities",
					lines: ["flux-image · flux-1 · $0.02/image"],
				};
			},
		};
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, {
			terminal,
			productCapabilities,
			productBudget,
			verbose: true,
			showLoadedResources: false,
		});
		await mode.init();
		await waitForTerminalText(terminal, "/text-to-image");
		const home = terminal.getViewport().join("\n");
		expect(home).toContain("/image-to-image");
		expect(home).toContain("/text-to-video");
		expect(home).toContain("/image-to-video");
		expect(home).toContain("/text-to-3d");
		expect(home).toContain("/image-to-3d");
		expect(home).toContain("/audio");
		expect(home).toContain("/ffmpeg");
		expect(home).toContain("/capabilities");
		expect(home).toContain("/budget");
		expect(home).not.toContain("[Context]");
		expect(home).not.toContain("[Skills]");
		expect(home).not.toContain("[Skill conflicts]");

		submit(terminal, "/text-to-image");
		await waitForTerminalText(terminal, "flux-image");
		expect(calls).toEqual(["text-to-image"]);
		expect(runtime.session.messages).toEqual([]);

		submit(terminal, "/capabilities");
		await waitForTerminalText(terminal, "All capabilities");
		expect(calls).toEqual(["text-to-image", "all"]);
		expect(runtime.session.messages).toEqual([]);

		submit(terminal, "/budget 2.00");
		await waitForTerminalText(terminal, "$2 per operation.");
		expect(maxCostUsd).toBe(2);
		submit(terminal, "/budget");
		await waitForTerminalText(terminal, "Session budget");
		submit(terminal, "/budget off");
		await waitForTerminalText(terminal, "Session cap removed.");
		expect(maxCostUsd).toBeUndefined();

		submit(terminal, "/tools");
		await waitForTerminalText(terminal, "Livepeer tools");
		const toolsMenu = terminal.getViewport().join("\n");
		expect(toolsMenu).toContain("list_capabilities");
		expect(toolsMenu).toContain("Discover current Livepeer capabilities");
		expect(toolsMenu).not.toContain("Coding\n");
		expect(toolsMenu).not.toContain("bash  ");
		expect(runtime.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "list_capabilities"]),
		);
		mode.stop();
	});

	it("prints a structured tool failure reason in the headless transcript", async () => {
		const reason = "Verify your email to inspect individual capabilities.";
		const runtime = await createRuntimeHarness({
			customTools: [
				{
					...testTool("describe_capability", "Inspect one Livepeer capability"),
					...createLivepeerToolRenderers("describe_capability"),
					execute: async () => ({
						content: [{ type: "text" as const, text: `[demo_not_allowed] ${reason}` }],
						details: {
							isError: true,
							error: { code: "demo_not_allowed", message: reason },
						},
					}),
				},
			],
			responses: [
				fauxAssistantMessage(fauxToolCall("describe_capability", { name: "video-model" }), {
					stopReason: "toolUse",
				}),
			],
		});
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, verbose: true, showLoadedResources: false });
		await mode.init();
		void mode.run();

		submit(terminal, "Inspect video-model.");
		await waitForTerminalText(terminal, "Email verification required");
		const transcript = terminal.getViewport().join("\n");
		expect(transcript).toContain("Email verification required");
		expect(transcript).toContain("Verify the email attached to this Daydream key");
		expect(transcript).toContain("ask the agent: verify my email");
		expect(transcript).not.toContain("demo_not_allowed");
		expect(transcript).not.toContain(reason);
		expect(transcript).not.toContain("Livepeer operation complete");
		mode.stop();
	});

	it("intercepts standalone activation codes without history, transcript, model, or terminal disclosure", async () => {
		const runtime = await createRuntimeHarness();
		const activationCode = "LP-ABCD-1234";
		const activated: string[] = [];
		const reloadActions: string[] = [];
		const auth = createProductAccountAuth({
			activate: async (code) => {
				activated.push(code);
				return { status: `Activated ${code}` };
			},
			reload: async ({ action }) => {
				reloadActions.push(action);
				return { status: `Reloaded ${activationCode}` };
			},
		});
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, productAccountAuth: auth, verbose: false });
		await mode.init();
		const nextInput = mode.getUserInput();

		submit(terminal, activationCode);
		await waitFor(() => activated.length === 1 && reloadActions.length === 1);
		await terminal.flush();

		expect(activated).toEqual([activationCode]);
		expect(reloadActions).toEqual(["activate"]);
		expect(runtime.session.messages).toEqual([]);
		expect(terminal.getViewport().join("\n")).not.toContain(activationCode);
		expect(terminal.getViewport().join("\n")).toContain("[activation code]");

		submit(terminal, "safe next prompt");
		await expect(nextInput).resolves.toBe("safe next prompt");
		mode.stop();
	});

	it("shows an explicit login destination, verification URL/code, supports cancellation, and restores focus", async () => {
		const runtime = await createRuntimeHarness();
		let loginCalls = 0;
		let loginSignal: AbortSignal | undefined;
		const auth = createProductAccountAuth({
			login: async ({ signal, notify }) => {
				loginCalls++;
				loginSignal = signal;
				notify({
					type: "verification",
					verificationUrl: "https://auth.example.test/device",
					userCode: "VERIFY-42",
				});
				return await new Promise(() => {});
			},
		});
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, productAccountAuth: auth, verbose: false });
		await mode.init();

		submit(terminal, "/login");
		await waitForTerminalText(terminal, "ChatGPT provider");
		expect(terminal.getViewport().join("\n")).toContain("Livepeer account");
		terminal.sendInput("j");
		terminal.sendInput("\r");
		await waitForTerminalText(terminal, "https://auth.example.test/device");
		expect(terminal.getViewport().join("\n")).toContain("VERIFY-42");
		expect(loginCalls).toBe(1);

		terminal.sendInput("\x1b");
		await waitFor(() => loginSignal?.aborted === true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const nextInput = mode.getUserInput();
		submit(terminal, "focus restored");
		await expect(nextInput).resolves.toBe("focus restored");
		mode.stop();
	});

	it("runs account/logout commands and reloads only after successful mutations", async () => {
		const runtime = await createRuntimeHarness();
		const calls: string[] = [];
		const auth = createProductAccountAuth({
			account: async () => {
				calls.push("account");
				return {
					status: "Account ready",
					account: { email: "user@example.test", accessTier: "creator", enabled: true },
				};
			},
			logout: async () => {
				calls.push("logout");
				return { status: "Logged out" };
			},
			reload: async ({ action }) => {
				calls.push(`reload:${action}`);
				return { status: "Shell access reloaded" };
			},
		});
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, productAccountAuth: auth, verbose: false });
		await mode.init();

		submit(terminal, "/livepeer account");
		await waitFor(() => calls.includes("account"));
		await waitForTerminalText(terminal, "user@example.test");
		expect(terminal.getViewport().join("\n")).toContain("Access tier: creator");
		expect(calls).toEqual(["account"]);

		submit(terminal, "/livepeer logout");
		await waitFor(() => calls.includes("reload:logout"));
		await waitForTerminalText(terminal, "Shell access reloaded");
		expect(calls).toEqual(["account", "logout", "reload:logout"]);
		mode.stop();
	});

	it("restores focus after a failed mutation and does not reload", async () => {
		const runtime = await createRuntimeHarness();
		const calls: string[] = [];
		const auth = createProductAccountAuth({
			logout: async () => {
				calls.push("logout");
				throw new Error("Logout failed safely");
			},
			reload: async ({ action }) => {
				calls.push(`reload:${action}`);
				return { status: "Unexpected reload" };
			},
		});
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, productAccountAuth: auth, verbose: false });
		await mode.init();

		submit(terminal, "/livepeer logout");
		await waitForTerminalText(terminal, "Logout failed safely");
		expect(calls).toEqual(["logout"]);
		const nextInput = mode.getUserInput();
		submit(terminal, "focus after failure");
		await expect(nextInput).resolves.toBe("focus after failure");
		mode.stop();
	});

	it("keeps provider login behavior when no product auth host is supplied", async () => {
		const runtime = await createRuntimeHarness();
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, verbose: false });
		await mode.init();

		submit(terminal, "/login");
		await waitForTerminalText(terminal, "Select authentication method:");
		expect(terminal.getViewport().join("\n")).not.toContain("Livepeer account");
		terminal.sendInput("\x1b");
		submit(terminal, "/provider");
		await waitForTerminalText(terminal, "Usage: /provider login <provider>");
		mode.stop();
	});
});

function testTool(name: string, description: string): ToolDefinition {
	return {
		name,
		label: name,
		description,
		promptSnippet: description,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
	};
}

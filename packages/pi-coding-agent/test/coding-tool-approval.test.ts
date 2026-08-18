import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "./support/virtual-terminal.ts";
import { getCodingToolPolicyDecision, type ToolApprovalHandler } from "../src/core/coding-tool-policy.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolApprovalRequest,
	type ToolDefinition,
} from "../src/index.ts";

class HarnessTerminal extends VirtualTerminal implements Terminal {}

const toolSchema = Type.Object({
	command: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
});

function fakeTool(
	name: string,
	execute: () => Promise<unknown> | unknown,
	approval?: ToolDefinition<typeof toolSchema>["approval"],
): ToolDefinition<typeof toolSchema> {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: toolSchema,
		approval,
		async execute() {
			await execute();
			return { content: [{ type: "text", text: `${name} complete` }], details: undefined };
		},
	};
}

type RuntimeHarness = {
	runtime: AgentSessionRuntime;
	cleanup: () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createRuntimeHarness(
	tools: ToolDefinition[],
	responses: ReturnType<typeof fauxAssistantMessage>[],
): Promise<RuntimeHarness> {
	const tempDir = mkdtempSync(join(tmpdir(), "livepeer-coding-policy-"));
	const faux = registerFauxProvider();
	faux.setResponses(responses);
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
				customTools: tools,
				noTools: "builtin",
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
	const cleanup = async () => {
		await runtime.dispose();
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	};
	cleanups.push(cleanup);
	return { runtime, cleanup };
}

async function bindApproval(runtime: AgentSessionRuntime, handler: ToolApprovalHandler): Promise<void> {
	await runtime.session.bindExtensions({ toolApprovalHandler: handler });
}

function assistantCount(runtime: AgentSessionRuntime): number {
	return runtime.session.messages.filter((message) => message.role === "assistant").length;
}

async function waitForTerminalText(terminal: HarnessTerminal, text: string): Promise<void> {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		await terminal.flush();
		if (terminal.getScrollBuffer().join("\n").includes(text)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for terminal text: ${text}`);
}

describe("Livepeer coding tool policy", () => {
	it("runs read automatically without requesting approval", async () => {
		let executions = 0;
		const { runtime } = await createRuntimeHarness(
			[fakeTool("read", () => executions++)],
			[
				fauxAssistantMessage(fauxToolCall("read", { path: "safe.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		);
		const approvals: ToolApprovalRequest[] = [];
		await bindApproval(runtime, async (request) => {
			approvals.push(request);
			return true;
		});

		await runtime.session.prompt("read safely");

		expect(executions).toBe(1);
		expect(approvals).toEqual([]);
		expect(assistantCount(runtime)).toBe(2);
	});

	it("requires scoped approval before bash execution", async () => {
		let executions = 0;
		const { runtime } = await createRuntimeHarness(
			[fakeTool("bash", () => executions++)],
			[
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf safe" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		);
		const approvals: ToolApprovalRequest[] = [];
		await bindApproval(runtime, async (request) => {
			approvals.push(request);
			return true;
		});

		await runtime.session.prompt("run safe command");

		expect(executions).toBe(1);
		expect(approvals).toMatchObject([{ toolName: "bash", risk: "standard", title: "Approve bash" }]);
	});

	it("denial prevents execution and blocks later sibling tools", async () => {
		const executions: string[] = [];
		const { runtime } = await createRuntimeHarness(
			[fakeTool("write", () => executions.push("write")), fakeTool("read", () => executions.push("read"))],
			[
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "denied.txt" }), fauxToolCall("read", { path: "escape.txt" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("must not continue"),
			],
		);
		await bindApproval(runtime, async () => false);

		await runtime.session.prompt("attempt denied write");

		expect(executions).toEqual([]);
		expect(assistantCount(runtime)).toBe(1);
	});

	it("fails closed when the approval handler throws", async () => {
		let executions = 0;
		const { runtime } = await createRuntimeHarness(
			[fakeTool("edit", () => executions++)],
			[fauxAssistantMessage(fauxToolCall("edit", { path: "blocked.txt" }), { stopReason: "toolUse" })],
		);
		await bindApproval(runtime, async () => {
			throw new Error("approval UI unavailable");
		});

		await runtime.session.prompt("attempt edit");

		expect(executions).toBe(0);
		expect(assistantCount(runtime)).toBe(1);
	});

	it("terminates after an unrecoverable tool failure without a sibling escape", async () => {
		const executions: string[] = [];
		const { runtime } = await createRuntimeHarness(
			[
				fakeTool("read", () => {
					executions.push("read");
					throw new Error("unrecoverable read failure");
				}),
				fakeTool("write", () => executions.push("write")),
			],
			[
				fauxAssistantMessage(
					[fauxToolCall("read", { path: "missing" }), fauxToolCall("write", { path: "escape.txt" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("must not continue"),
			],
		);
		await bindApproval(runtime, async () => true);

		await runtime.session.prompt("run failing action");

		expect(executions).toEqual(["read"]);
		expect(assistantCount(runtime)).toBe(1);
	});

	it("uses host-supplied custom-tool disclosure and fails closed when preflight throws", async () => {
		const approvals: ToolApprovalRequest[] = [];
		let approvedExecutions = 0;
		const approved = await createRuntimeHarness(
			[
				fakeTool(
					"hosted_job",
					() => approvedExecutions++,
					async () => ({ title: "Approve hosted job", message: "Estimated price: 1 credit" }),
				),
			],
			[
				fauxAssistantMessage(fauxToolCall("hosted_job", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		);
		await bindApproval(approved.runtime, async (request) => {
			approvals.push(request);
			return true;
		});
		await approved.runtime.session.prompt("run hosted job");

		expect(approvedExecutions).toBe(1);
		expect(approvals[0]).toMatchObject({
			toolName: "hosted_job",
			title: "Approve hosted job",
			message: "Estimated price: 1 credit",
		});

		let failedExecutions = 0;
		const failed = await createRuntimeHarness(
			[
				fakeTool(
					"hosted_job",
					() => failedExecutions++,
					async () => {
						throw new Error("preflight unavailable");
					},
				),
			],
			[fauxAssistantMessage(fauxToolCall("hosted_job", {}), { stopReason: "toolUse" })],
		);
		await bindApproval(failed.runtime, async () => true);
		await failed.runtime.session.prompt("run unavailable job");

		expect(failedExecutions).toBe(0);
		expect(assistantCount(failed.runtime)).toBe(1);
	});

	it("lets a host approval preflight return undefined for automatic execution", async () => {
		let executions = 0;
		const { runtime } = await createRuntimeHarness(
			[
				fakeTool(
					"hosted_read",
					() => executions++,
					async () => undefined,
				),
			],
			[
				fauxAssistantMessage(fauxToolCall("hosted_read", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		);

		await runtime.session.prompt("run automatic hosted read");

		expect(executions).toBe(1);
		expect(assistantCount(runtime)).toBe(2);
	});

	it("labels destructive commands and lets Ctrl-C cancel the approval", async () => {
		let executions = 0;
		const { runtime } = await createRuntimeHarness(
			[fakeTool("bash", () => executions++)],
			[
				fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /tmp/not-executed" }), {
					stopReason: "toolUse",
				}),
			],
		);
		const terminal = new HarnessTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, verbose: false });
		await mode.init();

		const prompt = runtime.session.prompt("request destructive command");
		await waitForTerminalText(terminal, "Destructive command approval");
		terminal.sendInput("\x03");
		await prompt;

		expect(executions).toBe(0);
		expect(assistantCount(runtime)).toBe(1);
		mode.stop();
	});

	it("supports explicit approval and denial through the public terminal", async () => {
		let approvedExecutions = 0;
		const approved = await createRuntimeHarness(
			[fakeTool("bash", () => approvedExecutions++)],
			[
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf safe" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		);
		const approvalTerminal = new HarnessTerminal(100, 30);
		const approvalMode = new InteractiveMode(approved.runtime, { terminal: approvalTerminal, verbose: false });
		await approvalMode.init();
		const approvedPrompt = approved.runtime.session.prompt("approve command");
		await waitForTerminalText(approvalTerminal, "Approve bash");
		approvalTerminal.sendInput("\r");
		await approvedPrompt;
		expect(approvedExecutions).toBe(1);
		approvalMode.stop();

		let deniedExecutions = 0;
		const denied = await createRuntimeHarness(
			[fakeTool("write", () => deniedExecutions++)],
			[fauxAssistantMessage(fauxToolCall("write", { path: "denied.txt" }), { stopReason: "toolUse" })],
		);
		const denialTerminal = new HarnessTerminal(100, 30);
		const denialMode = new InteractiveMode(denied.runtime, { terminal: denialTerminal, verbose: false });
		await denialMode.init();
		const deniedPrompt = denied.runtime.session.prompt("deny write");
		await waitForTerminalText(denialTerminal, "Approve write");
		denialTerminal.sendInput("j");
		denialTerminal.sendInput("\r");
		await deniedPrompt;
		expect(deniedExecutions).toBe(0);
		denialMode.stop();
	});

	it("classifies the complete coding-tool policy", () => {
		for (const toolName of ["read", "grep", "find", "ls"]) {
			expect(getCodingToolPolicyDecision("call", toolName, {})).toEqual({ action: "automatic" });
		}
		for (const toolName of ["bash", "write", "edit"]) {
			expect(getCodingToolPolicyDecision("call", toolName, {})).toMatchObject({ action: "approval" });
		}
		expect(getCodingToolPolicyDecision("call", "bash", { command: "rm -rf /tmp/example" })).toMatchObject({
			action: "approval",
			request: { risk: "destructive", title: "Destructive command approval" },
		});
	});
});

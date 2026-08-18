import { PRODUCT_POLICY } from "../product-policy.ts";

export type ToolApprovalRisk = "standard" | "destructive";

export interface ToolApprovalDisclosure {
	title: string;
	message: string;
	risk?: ToolApprovalRisk;
}

export interface ToolApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	risk: ToolApprovalRisk;
	title: string;
	message: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<boolean>;

export type CodingToolPolicyDecision = { action: "automatic" } | { action: "approval"; request: ToolApprovalRequest };

const automaticTools = new Set<string>(PRODUCT_POLICY.codingTools.automatic);
const approvalTools = new Set<string>(PRODUCT_POLICY.codingTools.requireApproval);

export function usesCodingToolPolicy(toolName: string): boolean {
	return automaticTools.has(toolName) || approvalTools.has(toolName);
}

const destructiveShellPatterns = [
	/(?:^|[;&|]\s*)(?:sudo\s+)?rm\b/i,
	/(?:^|[;&|]\s*)(?:sudo\s+)?(?:dd|mkfs(?:\.[a-z0-9_-]+)?|shutdown|reboot|halt|poweroff)\b/i,
	/(?:^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i,
	/(?:^|[;&|]\s*)(?:sudo\s+)?(?:truncate\s+-s\s*0|chmod\s+-R\s+777)\b/i,
];

export function isClearlyDestructiveShellCommand(command: string): boolean {
	return destructiveShellPatterns.some((pattern) => pattern.test(command));
}

function summarizeApproval(toolName: "bash" | "write" | "edit", args: Record<string, unknown>): string {
	if (toolName === "bash") {
		return typeof args.command === "string" ? args.command : "Run the requested shell command";
	}
	const path = typeof args.path === "string" ? args.path : "the requested file";
	return toolName === "write" ? `Write ${path}` : `Edit ${path}`;
}

export function getCodingToolPolicyDecision(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): CodingToolPolicyDecision {
	if (automaticTools.has(toolName) || !approvalTools.has(toolName)) {
		return { action: "automatic" };
	}

	const approvedToolName = toolName as "bash" | "write" | "edit";
	const command = approvedToolName === "bash" && typeof args.command === "string" ? args.command : "";
	const risk: ToolApprovalRisk = command && isClearlyDestructiveShellCommand(command) ? "destructive" : "standard";
	return {
		action: "approval",
		request: {
			toolCallId,
			toolName: approvedToolName,
			args,
			risk,
			title: risk === "destructive" ? "Destructive command approval" : `Approve ${approvedToolName}`,
			message: summarizeApproval(approvedToolName, args),
		},
	};
}

export function createHostToolApprovalRequest(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	disclosure: ToolApprovalDisclosure,
): ToolApprovalRequest {
	return {
		toolCallId,
		toolName,
		args,
		risk: disclosure.risk ?? "standard",
		title: disclosure.title,
		message: disclosure.message,
	};
}

import type { ToolApprovalDisclosure, ToolDefinition } from "@livepeer/pi-coding-agent";
import type { BrowserAction, BrowserAutomation } from "./automation.js";

const openSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http or https URL to open." },
    headed: { type: "boolean", description: "Show the browser window for manual login or visual interaction." },
  },
  required: ["url"],
  additionalProperties: false,
};

const actionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["click", "hover", "fill", "select", "check", "uncheck", "press", "go_back", "go_forward", "reload"],
    },
    ref: { type: "string", description: "Element ref from the most recent browser snapshot." },
    value: { type: "string", description: "Text, selection value, or key required by the action." },
  },
  required: ["action"],
  additionalProperties: false,
};

type BrowserToolDefinition = ToolDefinition & {
  approval?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => ToolApprovalDisclosure | undefined | Promise<ToolApprovalDisclosure | undefined>;
};

export interface BrowserToolOptions {
  onScreenshot?: (path: string) => void;
}

export function createBrowserToolDefinitions(
  browser: BrowserAutomation,
  options: BrowserToolOptions = {},
): BrowserToolDefinition[] {
  const browserGuidelines = [
    "Use browser tools for webpages and JavaScript applications; do not scrape websites with bash, curl, or requests unless the user explicitly asks for raw HTTP.",
    "After navigation or an action, use element refs from the newest accessibility snapshot because refs expire when the page changes.",
  ];
  return [
    {
      name: "browser_open",
      label: "Open webpage",
      description: "Open a webpage in the managed, stateful browser and return its accessibility snapshot. Set headed:true when the user needs to complete login, SSO, or 2FA manually.",
      promptSnippet: "Open a webpage in the stateful browser.",
      promptGuidelines: browserGuidelines,
      parameters: openSchema,
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const input = record(params);
        const result = await browser.open(ctx.sessionManager.getSessionId(), requiredString(input.url, "url"), { headed: input.headed === true }, signal);
        return modelSnapshot(result.text, result.session);
      },
    },
    {
      name: "browser_snapshot",
      label: "Read webpage",
      description: "Return a fresh accessibility snapshot for the current browser page, including stable refs for interactive elements.",
      promptSnippet: "Read the current webpage and refresh element refs.",
      promptGuidelines: browserGuidelines,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      executionMode: "sequential",
      execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
        const result = await browser.snapshot(ctx.sessionManager.getSessionId(), signal);
        return modelSnapshot(result.text, result.session);
      },
    },
    {
      name: "browser_action",
      label: "Use webpage",
      description: "Interact with the current webpage using a ref from the newest snapshot, then return the updated accessibility snapshot.",
      promptSnippet: "Click, fill, select, or navigate the current webpage.",
      promptGuidelines: browserGuidelines,
      parameters: actionSchema,
      executionMode: "sequential",
      approval: (_toolCallId, params) => actionApproval(record(params)),
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const action = parseAction(record(params));
        const result = await browser.act(ctx.sessionManager.getSessionId(), action, signal);
        return modelSnapshot(result.text, result.session);
      },
    },
    {
      name: "browser_screenshot",
      label: "Capture webpage",
      description: "Capture the current browser page as a PNG when visual inspection materially helps. Prefer browser_snapshot for ordinary reading and interaction.",
      promptSnippet: "Capture the current webpage as an image.",
      promptGuidelines: browserGuidelines,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      executionMode: "sequential",
      execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
        const result = await browser.screenshot(ctx.sessionManager.getSessionId(), signal);
        options.onScreenshot?.(result.path);
        return {
          content: [
            { type: "text", text: `Browser screenshot saved to ${result.path}` },
            { type: "image", data: result.data, mimeType: result.mimeType },
          ],
          details: { path: result.path, session: result.session },
        };
      },
    },
    {
      name: "browser_close",
      label: "Close browser",
      description: "Close the managed browser for the current agent session when browser work is complete.",
      promptSnippet: "Close the current managed browser session.",
      promptGuidelines: browserGuidelines,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      executionMode: "sequential",
      execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
        await browser.closeSession(ctx.sessionManager.getSessionId(), signal);
        return { content: [{ type: "text", text: "Browser session closed." }], details: {} };
      },
    },
  ];
}

function actionApproval(params: Record<string, unknown>): ToolApprovalDisclosure | undefined {
  const action = typeof params.action === "string" ? params.action : "unknown";
  if (["hover", "go_back", "go_forward", "reload"].includes(action)) return undefined;
  const target = typeof params.ref === "string" ? params.ref : "current page";
  const scope = action === "fill" || action === "select"
    ? `${action} ${target} with ${typeof params.value === "string" ? params.value.length : 0} characters`
    : `${action} ${target}`;
  return {
    title: "Approve browser interaction",
    message: `Action: ${scope}\nThe webpage may submit data or change external state.`,
  };
}

function parseAction(params: Record<string, unknown>): BrowserAction {
  const action = requiredString(params.action, "action");
  if (["click", "hover", "check", "uncheck"].includes(action)) {
    return { action: action as "click" | "hover" | "check" | "uncheck", ref: requiredString(params.ref, "ref") };
  }
  if (action === "fill" || action === "select") {
    return { action, ref: requiredString(params.ref, "ref"), value: requiredString(params.value, "value", true) };
  }
  if (action === "press") return { action, value: requiredString(params.value, "value") };
  if (action === "go_back" || action === "go_forward" || action === "reload") return { action };
  throw new Error(`Unsupported browser action: ${action}`);
}

function modelSnapshot(text: string, session: string) {
  return { content: [{ type: "text" as const, text: text || "The browser returned an empty snapshot." }], details: { session } };
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`browser tool requires ${name}.`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

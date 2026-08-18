import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	hiddenFromMenu?: boolean;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "help", description: "Show available commands" },
	{ name: "text-to-image", description: "List text-to-image models" },
	{ name: "image-to-image", description: "List image editing and transformation models" },
	{ name: "text-to-video", description: "List text-to-video models" },
	{ name: "image-to-video", description: "List image and reference-to-video models" },
	{ name: "text-to-3d", description: "List text-to-3D models" },
	{ name: "image-to-3d", description: "List image-to-3D models" },
	{ name: "audio", description: "List speech, music, and audio models" },
	{ name: "ffmpeg", description: "Show available FFmpeg capabilities" },
	{ name: "capabilities", description: "Show the complete Livepeer capability catalog" },
	{ name: "budget", description: "Set the session cap for each paid Livepeer operation", argumentHint: "[usd|off]" },
	{ name: "tools", description: "Show tools available to the agent" },
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message", hiddenFromMenu: true },
	{ name: "clone", description: "Duplicate the current session at the current position", hiddenFromMenu: true },
	{ name: "tree", description: "Navigate session tree (switch branches)", hiddenFromMenu: true },
	{ name: "trust", description: "Save project trust decision for future sessions", hiddenFromMenu: true },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "provider", description: "Configure model-provider authentication", argumentHint: "login <provider>" },
	{ name: "livepeer", description: "Manage Livepeer account", argumentHint: "login|logout|account|activate <code>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

export const MENU_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMANDS.filter(
	(command) => command.hiddenFromMenu !== true,
);

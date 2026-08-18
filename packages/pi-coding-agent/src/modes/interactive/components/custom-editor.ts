import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private attachmentPasteBuffer = "";
	private attachmentPastePrefix = "";
	private bufferingAttachmentPaste = false;
	private readonly attachments = new Map<string, string>();
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		const paste = this.captureAttachmentPaste(data);
		if (paste.handled) return;
		data = paste.data;
		if ((data === "\x7f" || data === "\b") && this.removeAttachmentBeforeCursor()) return;

		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}

	/** Insert a file as a compact composer attachment instead of a raw path. */
	insertAttachment(filePath: string): boolean {
		if (!isFile(filePath)) return false;
		const duplicateIndex = [...this.attachments.values()].filter((path) => basename(path) === basename(filePath)).length + 1;
		const suffix = duplicateIndex > 1 ? ` · ${duplicateIndex}` : "";
		const token = `[${basename(filePath)}${suffix}]`;
		this.attachments.set(token, filePath);
		const separator = this.getText().length > 0 && !/\s$/u.test(this.getText()) ? " " : "";
		super.insertTextAtCursor(`${separator}${token} `);
		return true;
	}

	/** Resolve visual attachment tokens to their exact paths before submission. */
	expandAttachmentTokens(text: string): string {
		let expanded = text;
		for (const [token, filePath] of this.attachments) {
			expanded = expanded.replaceAll(token, filePath);
		}
		return expanded;
	}

	/** Expand attachment tokens for a submitted prompt and release their editor state. */
	consumeAttachmentTokens(text: string): string {
		return this.consumeAttachments(text).text;
	}

	/** Return the submitted text plus exact local attachment paths. */
	consumeAttachments(text: string): { text: string; paths: string[] } {
		const paths = [...this.attachments]
			.filter(([token]) => text.includes(token))
			.map(([, filePath]) => filePath);
		const expanded = this.expandAttachmentTokens(text);
		this.attachments.clear();
		return { text: expanded, paths };
	}

	private captureAttachmentPaste(data: string): { handled: boolean; data: string } {
		const start = data.indexOf("\x1b[200~");
		if (!this.bufferingAttachmentPaste && start === -1) return { handled: false, data };

		if (!this.bufferingAttachmentPaste) {
			this.bufferingAttachmentPaste = true;
			this.attachmentPastePrefix = data.slice(0, start);
			this.attachmentPasteBuffer = data.slice(start + 6);
		} else {
			this.attachmentPasteBuffer += data;
		}

		const end = this.attachmentPasteBuffer.indexOf("\x1b[201~");
		if (end === -1) return { handled: true, data: "" };

		const content = this.attachmentPasteBuffer.slice(0, end);
		const remaining = this.attachmentPasteBuffer.slice(end + 6);
		const prefix = this.attachmentPastePrefix;
		this.attachmentPasteBuffer = "";
		this.attachmentPastePrefix = "";
		this.bufferingAttachmentPaste = false;
		const paths = parseDroppedFilePaths(content);
		if (paths.length > 0) {
			if (prefix) super.handleInput(prefix);
			for (const filePath of paths) this.insertAttachment(filePath);
			if (remaining) this.handleInput(remaining);
			return { handled: true, data: "" };
		}

		return { handled: false, data: `${prefix}\x1b[200~${content}\x1b[201~${remaining}` };
	}

	private removeAttachmentBeforeCursor(): boolean {
		const cursor = this.getCursor();
		const lines = this.getLines();
		const line = lines[cursor.line] ?? "";
		for (const token of this.attachments.keys()) {
			const trailingSpace = line.slice(0, cursor.col).endsWith(`${token} `);
			const tokenEnd = trailingSpace ? cursor.col - 1 : cursor.col;
			const tokenStart = tokenEnd - token.length;
			if (tokenStart < 0 || line.slice(tokenStart, tokenEnd) !== token) continue;
			const removeStart = tokenStart > 0 && line[tokenStart - 1] === " " ? tokenStart - 1 : tokenStart;
			const removeEnd = trailingSpace ? cursor.col : tokenEnd;
			lines[cursor.line] = line.slice(0, removeStart) + line.slice(removeEnd);
			this.attachments.delete(token);
			super.setText(lines.join("\n"));
			return true;
		}
		return false;
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const contentWidth = Math.max(1, width - 2);
		const rendered = super
			.render(contentWidth)
			.map(stabilizeEmptyCursor)
			.filter((line) => !isEditorBorder(stripAnsi(line)));
		const contentLines = rendered.map((line, index) => {
			line = this.styleAttachmentTokens(line);
			const prompt = index === 0 ? `${theme.fg("accent", "›")} ` : "  ";
			const content = truncateToWidth(`${prompt}${line}`, width, "");
			const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
			const background = theme.getBgAnsi("userMessageBg");
			const persistentContent = content
				.replaceAll("\x1b[0m", `\x1b[0m${background}`)
				.replaceAll("\x1b[49m", `\x1b[49m${background}`);
			return `${background}${persistentContent}${padding}\x1b[49m`;
		});
		const background = theme.getBgAnsi("userMessageBg");
		const paddingRow = `${background}${" ".repeat(width)}\x1b[49m`;
		return [paddingRow, ...contentLines, paddingRow];
	}

	private styleAttachmentTokens(line: string): string {
		for (const token of this.attachments.keys()) {
			if (!line.includes(token)) continue;
			line = line.replaceAll(token, theme.fg("accent", theme.bold(token)));
		}
		return line;
	}
}

function isFile(filePath: string): boolean {
	try {
		return existsSync(filePath) && statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/** Parse shell-escaped or raw absolute file paths emitted by terminal drag-and-drop. */
export function parseDroppedFilePaths(input: string): string[] {
	const trimmed = input.trim();
	if (!trimmed) return [];

	const shellWords = parseShellWords(trimmed);
	if (shellWords.length > 0 && shellWords.every(isFile)) return shellWords;

	const memo = new Map<number, string[] | undefined>();
	const splitRawPaths = (start: number): string[] | undefined => {
		while (/\s/u.test(trimmed[start] ?? "")) start++;
		if (start >= trimmed.length) return [];
		if (memo.has(start)) return memo.get(start);
		const boundaries = [trimmed.length];
		for (let index = start + 1; index < trimmed.length; index++) {
			if (/\s/u.test(trimmed[index - 1] ?? "") && trimmed[index] === "/") boundaries.push(index - 1);
		}
		for (const end of boundaries.sort((a, b) => a - b)) {
			const candidate = trimmed.slice(start, end).trim();
			if (!isFile(candidate)) continue;
			const rest = splitRawPaths(end);
			if (rest) {
				const result = [candidate, ...rest];
				memo.set(start, result);
				return result;
			}
		}
		memo.set(start, undefined);
		return undefined;
	};
	return splitRawPaths(0) ?? [];
}

function parseShellWords(input: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			word += char;
			escaping = false;
		} else if (char === "\\" && quote !== "'") {
			escaping = true;
		} else if (quote) {
			if (char === quote) quote = undefined;
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/\s/u.test(char)) {
			if (word) words.push(word);
			word = "";
		} else {
			word += char;
		}
	}
	if (escaping) word += "\\";
	if (word) words.push(word);
	return quote ? [] : words;
}

function stabilizeEmptyCursor(line: string): string {
	return line.replaceAll("\x1b[7m \x1b[0m", theme.fg("accent", "█"));
}

function isEditorBorder(line: string): boolean {
	return /^─+$/.test(line) || /^─*(?:↑|↓) \d+ lines?─*$/.test(line);
}

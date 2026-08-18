import { setKeybindings, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "./support/test-themes.ts";
import { VirtualTerminal } from "./support/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("renders a Codex-style composer with matching background padding rows", () => {
		initTheme("dark");
		const keybindings = new KeybindingsManager();
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal(56, 20)), defaultEditorTheme, keybindings);
		const lines = editor.render(56);

		expect(lines).toHaveLength(3);
		expect(stripAnsi(lines[0] ?? "")).toBe(" ".repeat(56));
		expect(stripAnsi(lines[1] ?? "")).toMatch(/^› /);
		expect(stripAnsi(lines[2] ?? "")).toBe(" ".repeat(56));
		expect(lines.every((line) => line.includes("\u001b[48"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 56)).toBe(true);
		const background = theme.getBgAnsi("userMessageBg");
		expect(lines[1]?.startsWith(background)).toBe(true);
		expect(lines[1]).toContain(theme.fg("accent", "█"));
		expect(lines.every((line) => line.endsWith("\u001b[49m"))).toBe(true);
	});

	it("repaints the empty cursor explicitly after Ctrl-C clears the composer", () => {
		initTheme("dark");
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal(56, 20)), defaultEditorTheme, keybindings);
		editor.focused = true;
		editor.setText("draft prompt");
		editor.onAction("app.clear", () => editor.setText(""));

		editor.handleInput("\x03");

		expect(editor.getText()).toBe("");
		const promptLine = editor.render(56)[1] ?? "";
		expect(promptLine).toContain(theme.fg("accent", "█"));
		expect(promptLine).not.toContain("\x1b[7m \x1b[0m");
		expect(visibleWidth(promptLine)).toBe(56);
	});

	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("previous prompt");
		expect(modelCycles).toBe(0);

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
	});
});

describe("CustomEditor file attachments", () => {
	it("renders dropped images and files as compact tokens and expands exact paths on submit", () => {
		initTheme("dark");
		const directory = mkdtempSync(join(tmpdir(), "livepeer-editor-files-"));
		try {
			const imagePath = join(directory, "character reference.png");
			const notesPath = join(directory, "prompt notes.md");
			writeFileSync(imagePath, "png");
			writeFileSync(notesPath, "notes");
			const editor = new CustomEditor(
				new TuiMainScreen(new VirtualTerminal(80, 20)),
				defaultEditorTheme,
				new KeybindingsManager(),
			);

			editor.handleInput(`\x1b[200~${imagePath} ${notesPath}\x1b[201~`);

			expect(editor.getText()).toContain("[character reference.png]");
			expect(editor.getText()).toContain("[prompt notes.md]");
			expect(editor.getText()).not.toContain(directory);
			expect(editor.expandAttachmentTokens(editor.getText())).toContain(imagePath);
			expect(editor.expandAttachmentTokens(editor.getText())).toContain(notesPath);
			const rendered = editor.render(80).join("\n");
			expect(stripAnsi(rendered)).toContain("[character reference.png]");
			expect(rendered).toContain(theme.fg("accent", theme.bold("[character reference.png]")));

			editor.handleInput("\x7f");
			expect(editor.getText()).not.toContain("[prompt notes.md]");
			expect(editor.getText()).toContain("[character reference.png]");
			const consumed = editor.consumeAttachments(editor.getText());
			expect(consumed.text).toContain(imagePath);
			expect(consumed.text).not.toContain(notesPath);
			expect(consumed.paths).toEqual([imagePath]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves ordinary bracketed paste behavior", () => {
		const editor = new CustomEditor(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager(),
		);

		editor.handleInput("\x1b[200~ordinary pasted text\x1b[201~");

		expect(editor.getExpandedText()).toBe("ordinary pasted text");
	});
});

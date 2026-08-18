import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: {
		onSubmit?: (text: string) => void;
		consumeAttachments?: (text: string) => { text: string; paths: string[] };
		consumeAttachmentTokens?: (text: string) => string;
	};
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	parseProductCapabilityCommand: (text: string) => undefined;
	loadAttachedPromptImages: (paths: readonly string[]) => Promise<unknown[]>;
	onInputCallback?: (text: string, images?: unknown[]) => void;
	pendingUserInputs: string[];
	pendingUserInputImages: Array<unknown[] | undefined>;
};

type InputContext = {
	onInputCallback?: (text: string, images?: unknown[]) => void;
	pendingUserInputs: string[];
	pendingUserInputImages: Array<unknown[] | undefined>;
	nextUserInputImages?: unknown[];
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		parseProductCapabilityCommand: vi.fn(() => undefined),
		loadAttachedPromptImages: vi.fn(async () => []),
		pendingUserInputs: [],
		pendingUserInputImages: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
			pendingUserInputImages: [undefined],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("prepares dropped images once and carries them with the first queued prompt", async () => {
		const image = { type: "image", data: "encoded-image", mimeType: "image/png" };
		const context = createSubmitContext();
		context.defaultEditor.consumeAttachments = () => ({
			text: "Animate /Users/person/Pictures/source.png",
			paths: ["/Users/person/Pictures/source.png"],
		});
		context.loadAttachedPromptImages = vi.fn(async () => [image]);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("Animate [source.png]");

		expect(context.loadAttachedPromptImages).toHaveBeenCalledWith(["/Users/person/Pictures/source.png"]);
		expect(context.pendingUserInputs).toEqual(["Animate /Users/person/Pictures/source.png"]);
		expect(context.pendingUserInputImages).toEqual([[image]]);
	});
});

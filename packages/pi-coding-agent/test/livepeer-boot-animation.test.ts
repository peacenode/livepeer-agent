import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LivepeerBootAnimation,
	renderLivepeerLogoFrame,
} from "../src/modes/interactive/components/livepeer-boot-animation.ts";
import { createLivepeerBootScreen } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

describe("LivepeerBootAnimation", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("matches the six-square geometry of the supplied Livepeer symbol", () => {
		const frame = renderLivepeerLogoFrame(0, 56).map(stripAnsi);
		const logoStart = 23;

		expect(frame).toHaveLength(11);
		expect(frame[0]?.trim()).toBe("livepeer");
		expect(frame.slice(1, 3)).toEqual(["", ""]);
		expect(frame[3]?.slice(logoStart, logoStart + 2)).not.toBe("  ");
		expect(frame[4]?.slice(logoStart + 4, logoStart + 6)).not.toBe("  ");
		expect(frame[5]?.slice(logoStart, logoStart + 2)).not.toBe("  ");
		expect(frame[5]?.slice(logoStart + 8, logoStart + 10)).not.toBe("  ");
		expect(frame[6]?.slice(logoStart + 4, logoStart + 6)).not.toBe("  ");
		expect(frame[7]?.slice(logoStart, logoStart + 2)).not.toBe("  ");
		expect(frame.slice(8, 10)).toEqual(["", ""]);
		expect(frame[10]?.trim()).toBe("reticulating splines...");
	});

	it("centers the complete boot stack in the terminal viewport", () => {
		const frame = renderLivepeerLogoFrame(0, 80, 24).map(stripAnsi);
		const content = frame.map((line, index) => ({ index, line })).filter(({ line }) => line.length > 0);

		expect(frame).toHaveLength(24);
		expect(content[0]).toEqual({ index: 6, line: `${" ".repeat(36)}livepeer` });
		expect(content.at(-1)).toEqual({ index: 16, line: `${" ".repeat(28)}reticulating splines...` });
	});

	it("fits narrow terminals without changing its height", () => {
		for (const width of [4, 8, 12, 56, 80, 120]) {
			const frame = renderLivepeerLogoFrame(3, width).map(stripAnsi);
			expect(frame).toHaveLength(11);
			expect(frame.every((line) => line.length <= width)).toBe(true);
		}
	});

	it("renders on a timer and stops cleanly", () => {
		vi.useFakeTimers();
		const ui = { requestRender: vi.fn(), terminal: { rows: 24 } };
		const animation = new LivepeerBootAnimation(ui as never, 120);

		vi.advanceTimersByTime(360);
		expect(ui.requestRender).toHaveBeenCalledTimes(3);

		animation.dispose();
		vi.advanceTimersByTime(360);
		expect(ui.requestRender).toHaveBeenCalledTimes(3);
	});

	it("clears the visible primary screen without deleting scrollback before the session renders", () => {
		const terminal = new FakeTerminal();
		const screen = createLivepeerBootScreen(terminal);

		screen.stop();

		expect(terminal.writes.at(-1)).toBe("\x1b[2J\x1b[H");
		expect(terminal.writes.at(-1)).not.toContain("\x1b[3J");
	});
});

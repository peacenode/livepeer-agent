import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const FRAME_INTERVAL_MS = 120;
const POINTS = [
	{ row: 0, column: 0 },
	{ row: 1, column: 1 },
	{ row: 2, column: 2 },
	{ row: 3, column: 1 },
	{ row: 4, column: 0 },
	{ row: 2, column: 0 },
] as const;

const SHADES = ["██", "▓▓", "▒▒", "░░"] as const;

export function renderLivepeerLogoMark(phase: number, solid = false): string[] {
	const normalizedPhase = ((phase % POINTS.length) + POINTS.length) % POINTS.length;
	const rows = Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => "  "));

	for (const [index, point] of POINTS.entries()) {
		const age = (normalizedPhase - index + POINTS.length) % POINTS.length;
		const shade = solid ? SHADES[0] : SHADES[Math.min(age, SHADES.length - 1)];
		rows[point.row][point.column] =
			solid || age === 0 ? theme.bold(theme.fg("accent", shade)) : theme.fg("dim", shade);
	}

	return rows.map((cells) => cells.map((cell, index) => (index < cells.length - 1 ? `${cell}  ` : cell)).join(""));
}

export function renderLivepeerLogoFrame(phase: number, width: number, height = 11): string[] {
	const logoRows = renderLivepeerLogoMark(phase);
	const stack = [
		theme.bold(theme.fg("accent", "livepeer")),
		"",
		"",
		...logoRows,
		"",
		"",
		theme.fg("muted", "reticulating splines..."),
	];

	const safeWidth = Math.max(0, Math.floor(width));
	const safeHeight = Math.max(0, Math.floor(height));
	const centered = stack.map((line) => {
		const visibleLine = truncateToWidth(line, safeWidth, "");
		const lineWidth = visibleWidth(visibleLine);
		if (lineWidth === 0) return "";
		const leftPadding = Math.floor(Math.max(0, safeWidth - lineWidth) / 2);
		return `${" ".repeat(leftPadding)}${visibleLine}`;
	});
	const visibleStack = centered.slice(0, safeHeight);
	const topPadding = Math.floor(Math.max(0, safeHeight - visibleStack.length) / 2);
	const bottomPadding = Math.max(0, safeHeight - topPadding - visibleStack.length);

	return [
		...Array.from({ length: topPadding }, () => ""),
		...visibleStack,
		...Array.from({ length: bottomPadding }, () => ""),
	];
}

export class LivepeerBootAnimation implements Component {
	private phase = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private readonly ui: TUI;

	constructor(ui: TUI, intervalMs = FRAME_INTERVAL_MS) {
		this.ui = ui;
		this.interval = setInterval(() => {
			this.phase = (this.phase + 1) % POINTS.length;
			this.ui.requestRender();
		}, intervalMs);
		this.interval.unref?.();
	}

	invalidate(): void {
		// Rendering is derived directly from the current animation phase.
	}

	render(width: number): string[] {
		return renderLivepeerLogoFrame(this.phase, width, this.ui.terminal.rows);
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}
}

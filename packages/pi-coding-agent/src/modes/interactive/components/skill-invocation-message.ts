import { Box, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * Uses the Livepeer operation surface so skills and routed tools share one visual language.
 * Only renders the skill block itself - user message is rendered separately.
 */
export class SkillInvocationMessageComponent extends Box {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 0);
		this.skillBlock = skillBlock;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	override render(width: number): string[] {
		const content = super.render(width);
		if (content.length === 0) return [];
		const defaultBackground = (line: string) => `\x1b[49m${line}\x1b[49m`;
		const rule = defaultBackground(theme.fg("customMessageLabel", "─".repeat(Math.max(0, width))));
		return [rule, ...content.map(defaultBackground), rule];
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		if (this.expanded) {
			// Expanded: label + skill name header + full content
			const header =
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageLabel", this.skillBlock.name);
			this.addChild(new Text(header, 0, 0));
			this.addChild(
				new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// Collapsed: single line - [skill] name (hint to expand)
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageLabel", this.skillBlock.name) +
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}

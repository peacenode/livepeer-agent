import { describe, expect, it } from "vitest";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SkillInvocationMessageComponent", () => {
	it("uses the Livepeer operation surface with a neutral skill label", () => {
		initTheme("dark");
		const component = new SkillInvocationMessageComponent({
			name: "short-form-video",
			location: "/skills/short-form-video/SKILL.md",
			content: "# Short-form video\nPlan a concise production.",
			userMessage: undefined,
		});

		const collapsedLines = component.render(80);
		const collapsed = collapsedLines.join("\n");
		expect(collapsed).not.toContain(theme.getBgAnsi("livepeerToolBg"));
		expect(collapsed).toContain("\x1b[49m");
		expect(stripAnsi(collapsedLines[0] ?? "")).toBe("─".repeat(80));
		expect(stripAnsi(collapsedLines.at(-1) ?? "")).toBe("─".repeat(80));
		expect(collapsedLines[0]).toContain(theme.getFgAnsi("customMessageLabel"));
		expect(collapsedLines.at(-1)).toContain(theme.getFgAnsi("customMessageLabel"));
		expect(collapsed).toContain(theme.getFgAnsi("customMessageLabel"));
		expect(stripAnsi(collapsed)).toContain("[skill] short-form-video");

		component.setExpanded(true);
		const expanded = component.render(80).join("\n");
		expect(expanded).not.toContain(theme.getBgAnsi("livepeerToolBg"));
		expect(expanded).toContain(theme.getFgAnsi("customMessageLabel"));
		expect(stripAnsi(expanded)).toContain("[skill] short-form-video");
		expect(stripAnsi(expanded)).toContain("Short-form video");
	});
});

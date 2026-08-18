import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS, MENU_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("Livepeer slash command menu", () => {
	it("keeps advanced session commands callable but out of the visible menu", () => {
		const callable = new Set(BUILTIN_SLASH_COMMANDS.map(({ name }) => name));
		const visible = new Set(MENU_SLASH_COMMANDS.map(({ name }) => name));

		for (const command of ["fork", "clone", "tree", "trust"]) {
			expect(callable.has(command)).toBe(true);
			expect(visible.has(command)).toBe(false);
		}
	});
});

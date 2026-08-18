import { describe, expect, it } from "vitest";
import { isOfflineMode, PRODUCT_POLICY, resolveProductHome } from "../src/product-policy.ts";

describe("Livepeer product policy", () => {
	it("keeps fork-owned network services disabled", () => {
		expect(Object.values(PRODUCT_POLICY.services)).toEqual([false, false, false, false, false, false]);
	});

	it("prefers LIVEPEER_HOME over XDG_CONFIG_HOME", () => {
		expect(resolveProductHome({ LIVEPEER_HOME: "/livepeer", XDG_CONFIG_HOME: "/xdg" })).toBe("/livepeer");
		expect(resolveProductHome({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/livepeer");
	});

	it("recognizes supported offline values", () => {
		expect(isOfflineMode({ LIVEPEER_OFFLINE: "yes" })).toBe(true);
		expect(isOfflineMode({ LIVEPEER_OFFLINE: "0" })).toBe(false);
	});

	it("pins the project and session layout", () => {
		expect(PRODUCT_POLICY.projectConfigDir).toBe(".livepeer");
		expect(`${PRODUCT_POLICY.paths.sessionsDirectory}/${PRODUCT_POLICY.paths.sessionSchema}`).toBe("sessions/v2");
	});
});

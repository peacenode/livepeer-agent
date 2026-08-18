import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.LIVEPEER_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.LIVEPEER_EXPERIMENTAL;
		} else {
			process.env.LIVEPEER_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when LIVEPEER_EXPERIMENTAL is unset", () => {
		delete process.env.LIVEPEER_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when LIVEPEER_EXPERIMENTAL is empty", () => {
		process.env.LIVEPEER_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when LIVEPEER_EXPERIMENTAL is set to 1", () => {
		process.env.LIVEPEER_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when LIVEPEER_EXPERIMENTAL is set to 0", () => {
		process.env.LIVEPEER_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when LIVEPEER_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.LIVEPEER_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});

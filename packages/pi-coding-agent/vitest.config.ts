import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		env: { PI_OFFLINE: "1", LIVEPEER_OFFLINE: "1" },
		unstubEnvs: true,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		include: ["test/**/*.test.ts"],
		exclude: [
			"test/agent-session-branching.test.ts",
			"test/agent-session-compaction.test.ts",
			"test/agent-session-tree-navigation.test.ts",
			"test/compaction-extensions.test.ts",
			"test/rpc.test.ts",
		],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
});

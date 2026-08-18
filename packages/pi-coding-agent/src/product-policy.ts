import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_POLICY = {
	name: "livepeer",
	title: "Livepeer",
	packageName: "@livepeer/pi-coding-agent",
	projectConfigDir: ".livepeer",
	environment: {
		home: "LIVEPEER_HOME",
		sessionDir: "LIVEPEER_SESSION_DIR",
		offline: "LIVEPEER_OFFLINE",
	},
	paths: {
		xdgDirectory: "livepeer",
		sessionsDirectory: "sessions",
		sessionSchema: "v2",
	},
	services: {
		selfUpdate: false,
		versionCheck: false,
		share: false,
		changelog: false,
		installReporting: false,
		remoteModelCatalog: false,
	},
	codingTools: {
		automatic: ["read", "grep", "find", "ls"],
		requireApproval: ["bash", "write", "edit"],
	},
} as const;

export function resolveProductHome(environment: NodeJS.ProcessEnv = process.env): string {
	const explicitHome = environment[PRODUCT_POLICY.environment.home];
	if (explicitHome) return explicitHome;

	const xdgConfigHome = environment.XDG_CONFIG_HOME;
	if (xdgConfigHome) return join(xdgConfigHome, PRODUCT_POLICY.paths.xdgDirectory);

	return join(homedir(), ".config", PRODUCT_POLICY.paths.xdgDirectory);
}

export function isOfflineMode(environment: NodeJS.ProcessEnv = process.env): boolean {
	const value = environment[PRODUCT_POLICY.environment.offline];
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.LIVEPEER_EXPERIMENTAL === "1";
}

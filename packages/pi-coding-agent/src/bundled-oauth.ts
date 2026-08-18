import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

/** Register OAuth loaders in the exact pi-ai module instance used by this shell. */
export function registerBundledShellOAuthFlows(): void {
	registerBunOAuthFlows();
}

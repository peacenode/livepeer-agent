export type ProductCapabilityCategory =
	| "text-to-image"
	| "image-to-image"
	| "text-to-video"
	| "image-to-video"
	| "text-to-3d"
	| "image-to-3d"
	| "audio"
	| "ffmpeg"
	| "all";

export interface ProductCapabilityListOptions {
	signal: AbortSignal;
}

export interface ProductCapabilityListResult {
	title: string;
	lines: readonly string[];
	summary?: string;
}

/** Product-neutral capability menu supplied by the terminal host. */
export interface ProductCapabilities {
	list(
		category: ProductCapabilityCategory,
		options: ProductCapabilityListOptions,
	): Promise<ProductCapabilityListResult>;
}

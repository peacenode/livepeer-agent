import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { complete, registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { resolveCloudflareModel } from "@earendil-works/pi-ai/providers/cloudflare-stream";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

let capturedModel: Model<"openai-completions"> | undefined;
let capturedOptions: StreamOptions | SimpleStreamOptions | undefined;

function doneStream(model: Model<"openai-completions">) {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.end(message);
	return stream;
}

function registerCaptureProvider(): void {
	registerApiProvider({
		api: "openai-completions",
		stream: (model, _context, options) => {
			capturedModel = model;
			capturedOptions = options;
			return doneStream(model);
		},
		streamSimple: (model, _context, options) => {
			capturedModel = model;
			capturedOptions = options;
			return doneStream(model);
		},
	});
}

function registerRuntimeCaptureProvider(modelRuntime: ModelRuntime): void {
	const provider = modelRuntime.getProvider("cloudflare-ai-gateway");
	if (!provider) throw new Error("Cloudflare provider is unavailable");
	modelRuntime.registerNativeProvider({
		...provider,
		stream: (model, _context, options) => {
			capturedModel = model;
			capturedOptions = options;
			return doneStream(model as Model<"openai-completions">);
		},
		streamSimple: (model, _context, options) => {
			capturedModel = model as Model<"openai-completions">;
			capturedOptions = options;
			return doneStream(model as Model<"openai-completions">);
		},
	} satisfies Provider);
}

afterEach(() => {
	resetApiProviders();
	capturedModel = undefined;
	capturedOptions = undefined;
});

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		expect(model).toBeDefined();

		registerRuntimeCaptureProvider(modelRuntime);
		await modelRuntime.completeSimple(model!, { messages: [] });

		if (!capturedModel) throw new Error("Cloudflare request was not captured");
		expect(resolveCloudflareModel(capturedModel, capturedOptions?.env).baseUrl).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat",
		);
		expect(capturedOptions?.headers?.["cf-aig-authorization"]).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		expect(model).toBeDefined();

		resetApiProviders();
		registerCaptureProvider();
		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);
		expect(auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer test-token",
			Authorization: null,
			"x-api-key": null,
		});

		const materializedModel = auth.baseUrl ? { ...model!, baseUrl: auth.baseUrl } : model!;
		await complete(materializedModel, { messages: [] }, auth);

		if (!capturedModel) throw new Error("Cloudflare request was not captured");
		expect(resolveCloudflareModel(capturedModel, capturedOptions?.env).baseUrl).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat",
		);
		expect(capturedOptions?.headers?.["cf-aig-authorization"]).toBe("Bearer test-token");
		expect(capturedOptions?.headers?.Authorization).toBeNull();
		expect(capturedOptions?.headers?.["x-api-key"]).toBeNull();
	});
});

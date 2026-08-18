import { createModels, type Api, type CredentialStore, type Model, type Models } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export type ModelProvider = "openai" | "openai-codex" | "anthropic";

const DEFAULT_MODELS: Record<ModelProvider, string> = {
  openai: "gpt-5.6-terra",
  "openai-codex": "gpt-5.6-terra",
  anthropic: "claude-sonnet-5",
};

export function createProviderModels(credentials?: CredentialStore): Models {
  const models = createModels(credentials ? { credentials } : undefined);
  models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider());
  models.setProvider(anthropicProvider());
  return models;
}

export function resolveModel(models: Models, provider: ModelProvider, requested?: string): Model<Api> {
  const model = models.getModel(provider, requested ?? DEFAULT_MODELS[provider]) ?? models.getModels(provider)[0];
  if (!model) throw new Error(`No models are available for ${provider}.`);
  return model;
}

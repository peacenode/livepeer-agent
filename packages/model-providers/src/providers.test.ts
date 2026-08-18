import { describe, expect, it } from "vitest";
import { createProviderModels, resolveModel } from "./providers.js";

describe("model providers", () => {
  it("registers Pi's subscription-backed OpenAI Codex provider", () => {
    const models = createProviderModels();
    const provider = models.getProvider("openai-codex");

    expect(provider?.name).toBe("OpenAI Codex");
    expect(provider?.auth.oauth).toMatchObject({ isSubscription: true });
    expect(resolveModel(models, "openai-codex").provider).toBe("openai-codex");
  });
});

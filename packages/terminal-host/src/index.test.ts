import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runLivepeerInteractive,
  type InteractiveShellUnavailableError,
  type LivepeerInteractiveServices,
} from "./index.js";
import {
  createFakeExecutionClient,
  createFakeLivepeerAccess,
  createFakeModelCredentialStore,
  createFakeModelPort,
  createFakeOAuthPort,
  createFakeShellAdapter,
} from "./testing/index.js";

function services(): LivepeerInteractiveServices {
  return {
    models: createFakeModelPort(),
    oauth: createFakeOAuthPort(),
    modelCredentials: createFakeModelCredentialStore(),
    livepeer: createFakeLivepeerAccess(),
    execution: createFakeExecutionClient(),
  };
}

describe("runLivepeerInteractive", () => {
  it("fails explicitly until the forked shell adapter is injected", async () => {
    await expect(runLivepeerInteractive({
      cwd: ".",
      configRoot: ".config/livepeer",
      resume: false,
      services: services(),
    })).rejects.toMatchObject({
      name: "InteractiveShellUnavailableError",
      code: "LIVEPEER_INTERACTIVE_SHELL_UNAVAILABLE",
    } satisfies Partial<InteractiveShellUnavailableError>);
  });

  it("normalizes host paths and delegates exactly once", async () => {
    const shell = createFakeShellAdapter();
    const ports = services();
    await runLivepeerInteractive({
      cwd: ".",
      configRoot: ".config/livepeer",
      resume: true,
      services: ports,
      shell,
    });
    expect(shell.contexts).toHaveLength(1);
    const context = shell.contexts[0];
    expect(context?.cwd).toBe(resolve("."));
    expect(context?.configRoot).toBe(resolve(".config/livepeer"));
    expect(context?.resume).toBe(true);
    expect(context?.services).toBe(ports);
  });

  it("propagates adapter failures without translating lifecycle errors", async () => {
    const failure = new DOMException("Cancelled", "AbortError");
    const shell = createFakeShellAdapter(() => Promise.reject(failure));
    await expect(runLivepeerInteractive({
      cwd: ".",
      configRoot: ".config/livepeer",
      resume: false,
      services: services(),
      shell,
    })).rejects.toBe(failure);
  });
});

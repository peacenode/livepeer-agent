/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import { FakeCredentialStore } from "@livepeer-agent/contracts/testing";
import type { CliIO } from "./io/index.js";
import { createDefaultDependencies, runCli } from "./index.js";

describe("default CLI configuration", () => {
  it("starts with local credentials and reports Daydream-key status", async () => {
    const stdout: string[] = [];
    const io: CliIO = {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
      readStdin: async () => "",
      confirm: async () => false,
      prompt: async () => "",
      promptSecret: async () => "",
    };
    const dependencies = createDefaultDependencies({}, new FakeCredentialStore());
    const exit = await runCli(["node", "livepeer", "key", "status", "--json"], dependencies, { io });
    expect(exit).toBe(0);
    const result = JSON.parse(stdout[0]!) as unknown;
    expect(result).toMatchObject({
      ok: true,
      command: "key.status",
      data: { configured: false, source: null },
    });
  });
});

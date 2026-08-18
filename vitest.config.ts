import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@livepeer-agent/contracts/testing", replacement: source("./packages/contracts/src/testing/index.ts") },
      { find: "@livepeer-agent/contracts", replacement: source("./packages/contracts/src/index.ts") },
      { find: "@livepeer-agent/livepeer-client", replacement: source("./packages/livepeer-client/src/index.ts") },
      { find: "@livepeer-agent/model-providers", replacement: source("./packages/model-providers/src/index.ts") },
      { find: "@livepeer/pi-coding-agent", replacement: source("./packages/pi-coding-agent/src/index.ts") },
      { find: "@livepeer-agent/terminal-host/testing", replacement: source("./packages/terminal-host/src/testing/index.ts") },
      { find: "@livepeer-agent/terminal-host", replacement: source("./packages/terminal-host/src/index.ts") },
    ],
  },
  test: {
    testTimeout: 30000,
    include: ["**/*.test.ts"],
    exclude: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/pi-coding-agent/**",
    ],
    coverage: { reporter: ["text", "json"] },
  },
});

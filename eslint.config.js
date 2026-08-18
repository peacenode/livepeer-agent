import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.build/**",
      "**/coverage/**",
      "**/node_modules/**",
      // The filtered upstream subtree retains its own source conventions and is
      // gated by package-local TypeScript plus the complete offline test suite.
      "packages/pi-coding-agent/**",
      "packages/terminal-host/test/acceptance/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { "no-undef": "off" },
  },
);

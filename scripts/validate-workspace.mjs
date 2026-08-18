import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const fail = (message) => {
  throw new Error(message);
};

const rootManifest = readJson("package.json");
const shellManifest = readJson("packages/pi-coding-agent/package.json");
const terminalManifest = readJson("packages/terminal-host/package.json");
const cliManifest = readJson("apps/cli/package.json");
const cliTypeScript = readJson("apps/cli/tsconfig.json");
const provenance = readJson("packages/pi-coding-agent/UPSTREAM.json");
const cohort = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-client",
  "@earendil-works/pi-protocol",
  "@earendil-works/pi-tui",
];

if (shellManifest.name !== "@livepeer/pi-coding-agent") fail("Owned shell package name is incorrect");
if (shellManifest.version !== "0.84.1-livepeer.1") fail("Owned shell version is incorrect");
if (shellManifest.private !== true) fail("Owned shell must remain non-publishable as a standalone npm package");
if (shellManifest.piConfig?.name !== "livepeer" || shellManifest.piConfig?.configDir !== ".livepeer") {
  fail("Owned shell identity/config directory is incorrect");
}
for (const dependency of cohort) {
  if (shellManifest.dependencies?.[dependency] !== "0.84.1") fail(`${dependency} must be pinned to 0.84.1`);
  if (rootManifest.pnpm?.overrides?.[dependency] !== "0.84.1") fail(`${dependency} override must be 0.84.1`);
}
for (const subpath of ["./themes/dark.json", "./themes/light.json", "./themes/theme-schema.json"]) {
  if (!shellManifest.exports?.[subpath]) fail(`Missing stable shell export: ${subpath}`);
}
if (terminalManifest.dependencies?.[shellManifest.name] !== "workspace:*") {
  fail("terminal-host must consume the workspace shell");
}
if (terminalManifest.peerDependencies?.[shellManifest.name] || terminalManifest.devDependencies?.[shellManifest.name]) {
  fail("terminal-host must not split the shell across peer/dev dependencies");
}
if (cliManifest.devDependencies?.[shellManifest.name] !== "workspace:*") {
  fail("CLI bundling must consume the workspace shell");
}
if (cliTypeScript.compilerOptions?.outDir === "dist") {
  fail("CLI typecheck output must not overwrite the standalone dist bundle");
}
if (
  provenance.upstream?.repository !== "https://github.com/earendil-works/pi.git" ||
  provenance.upstream?.sourcePath !== "packages/coding-agent" ||
  provenance.upstream?.commit !== "936aff00918de1187f085f123c2812d8f2d67745" ||
  provenance.upstream?.version !== "0.84.1" ||
  provenance.upstream?.subtreeSplitCommit !== "8dc7c9717c6a3ee2682e4a86823522a909298f56" ||
  provenance.downstream?.package !== shellManifest.name ||
  provenance.downstream?.version !== shellManifest.version
) {
  fail("Owned shell provenance does not match the imported subtree");
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const archivedPathPrefixes = [
  "apps/auth-web/",
  "packages/livepeer-gateway/",
  "migrations/",
  "apps/cli/src/auth/",
  "apps/cli/src/commands/auth/",
];
for (const path of tracked) {
  const archivedPrefix = archivedPathPrefixes.find((prefix) => path.startsWith(prefix));
  if (archivedPrefix) fail(`Archived identity path returned to the active tree: ${path}`);
}

const forbiddenContent = [
  ["", "Users", "peace"].join("/"),
  `accepted${"Head"}`,
  `npm:${["@earendil-works", "pi-coding-agent"].join("/")}`,
  ["with", "livepeer", "pi", "link"].join("-"),
];
const activeArchitectureFile = (path) =>
  path !== "scripts/validate-workspace.mjs"
  && !path.startsWith("packages/pi-coding-agent/")
  && (
    /^(?:apps|packages|scripts)\//u.test(path)
    || /^(?:eslint\.config\.js|vitest\.config\.ts|tsconfig[^/]*\.json|package\.json|pnpm-(?:lock|workspace)\.yaml)$/u.test(path)
  );
const forbiddenArchitectureContent = [
  ["archived auth dependency", /better[-_ ]?auth/iu],
  ["invitation architecture", /(?:\binvitations?\b|invitation[A-Z_]|invitation-)/u],
  ["gateway-session architecture", /gateway[-_]?session/iu],
];
for (const path of tracked) {
  let content;
  try {
    content = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  const marker = forbiddenContent.find((candidate) => content.includes(candidate));
  if (marker) fail(`Tracked file ${path} contains forbidden migration marker: ${marker}`);
  if (activeArchitectureFile(path)) {
    const architectureMarker = forbiddenArchitectureContent.find(([, pattern]) => pattern.test(content));
    if (architectureMarker) {
      fail(`Tracked file ${path} contains forbidden ${architectureMarker[0]} marker`);
    }
  }
}

console.log("workspace validation passed");

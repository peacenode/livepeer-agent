import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findPnpmPackageRoot, generateThirdPartyNotices } from "./generate-third-party-notices.mjs";

const root = new URL("../", import.meta.url);
const resolveFromCli = createRequire(new URL("../apps/cli/package.json", import.meta.url)).resolve;
const resolveFromPiCodingAgent = createRequire(new URL("../packages/pi-coding-agent/package.json", import.meta.url)).resolve;
const output = new URL("apps/cli/dist/", root);
const rootPath = fileURLToPath(root);
const aliases = {
  "@livepeer-agent/contracts": new URL("packages/contracts/src/index.ts", root).pathname,
  "@livepeer-agent/livepeer-client": new URL("packages/livepeer-client/src/index.ts", root).pathname,
  "@livepeer-agent/model-providers": new URL("packages/model-providers/src/index.ts", root).pathname,
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const mainBundle = await build({
  entryPoints: [new URL("apps/cli/src/index.ts", root).pathname],
  outfile: new URL("index.js", output).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  metafile: true,
  alias: aliases,
  banner: {
    js: [
      "import { createRequire as __bundleCreateRequire } from 'node:module';",
      "import { dirname as __bundleDirname } from 'node:path';",
      "import { fileURLToPath as __bundleFileURLToPath } from 'node:url';",
      "const require = __bundleCreateRequire(import.meta.url);",
      "const __dirname = __bundleDirname(__bundleFileURLToPath(import.meta.url));",
    ].join(" "),
  },
});

// pi-ai intentionally loads OAuth implementations through a relative dynamic
// import. The main CLI is a single-file bundle, so ship the exact relative
// module as its own self-contained chunk for both login and token derivation.
const oauthBundle = await build({
  entryPoints: [new URL("node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js", root).pathname],
  outfile: new URL("openai-codex.js", output).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  metafile: true,
});

const themes = new URL("modes/interactive/theme/", output);
const assets = new URL("modes/interactive/assets/", output);
const exportHtml = new URL("core/export-html/", output);
const exportHtmlVendor = new URL("vendor/", exportHtml);
const legal = new URL("legal/", output);
await Promise.all([
  mkdir(themes, { recursive: true }),
  mkdir(assets, { recursive: true }),
  mkdir(exportHtmlVendor, { recursive: true }),
  mkdir(legal, { recursive: true }),
]);
await Promise.all([
	copyFile(resolveFromPiCodingAgent("@silvia-odwyer/photon-node/photon_rs_bg.wasm"), new URL("photon_rs_bg.wasm", output)),
  ...["dark.json", "light.json", "theme-schema.json"].map((name) =>
    copyFile(resolveFromCli(`@livepeer/pi-coding-agent/themes/${name}`), new URL(name, themes)),
  ),
  copyFile(resolveFromCli("@livepeer/pi-coding-agent/assets/clankolas.png"), new URL("clankolas.png", assets)),
  ...["template.html", "template.css", "template.js"].map((name) =>
    copyFile(resolveFromCli(`@livepeer/pi-coding-agent/export-html/${name}`), new URL(name, exportHtml)),
  ),
  ...["highlight.min.js", "marked.min.js"].map((name) =>
    copyFile(resolveFromCli(`@livepeer/pi-coding-agent/export-html/vendor/${name}`), new URL(name, exportHtmlVendor)),
  ),
  copyFile(new URL("packages/pi-coding-agent/LICENSE", root), new URL("PI_LICENSE.txt", legal)),
  copyFile(new URL("install.sh", root), new URL("install.sh", output)),
]);

const photonRoot = dirname(resolveFromPiCodingAgent("@silvia-odwyer/photon-node/photon_rs_bg.wasm"));
const highlightRoot = dirname(resolveFromPiCodingAgent("highlight.js/package.json"));
const markedRoot = await findPnpmPackageRoot(rootPath, "marked", "18.0.5");
const piLicenseFallback = {
  name: "LICENSE (from the pinned Pi source fork)",
  path: fileURLToPath(new URL("packages/pi-coding-agent/LICENSE", root)),
};
const rootNotices = fileURLToPath(new URL("THIRD_PARTY_NOTICES.md", root));
await generateThirdPartyNotices({
  root: rootPath,
  outputDirectory: fileURLToPath(legal),
  noticesPath: rootNotices,
  bundles: [
    { name: "cli", metafile: mainBundle.metafile },
    { name: "openai-codex-oauth", metafile: oauthBundle.metafile },
  ],
  additionalPackages: [
    { bundle: "copied-wasm", packageRoot: photonRoot },
  ],
  fallbackLicenses: Object.fromEntries([
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-client",
    "@earendil-works/pi-protocol",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-telemetry",
  ].map((name) => [name, piLicenseFallback])),
  virtualArtifacts: [
    {
      name: "highlight.js",
      version: "11.9.0",
      license: "BSD-3-Clause",
      repository: "https://github.com/highlightjs/highlight.js",
      bundle: "copied-export-html-vendor",
      licenseSourceRoot: highlightRoot,
    },
    {
      name: "marked",
      version: "18.0.5",
      license: "MIT",
      repository: "https://github.com/markedjs/marked",
      bundle: "copied-export-html-vendor",
      licenseSourceRoot: markedRoot,
    },
  ],
});
await copyFile(rootNotices, new URL("THIRD_PARTY_NOTICES.md", legal));

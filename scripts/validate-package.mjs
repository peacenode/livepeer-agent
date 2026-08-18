import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = join(root, "apps", "cli");
const shell = join(root, "packages", "pi-coding-agent");
const temporary = await mkdtemp(join(tmpdir(), "livepeer-package-"));
const cache = join(temporary, "npm-cache");
const install = join(temporary, "install");
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toLowerCase().startsWith("npm_config_")
    && key !== "DAYDREAM_API_KEY"
    && key !== "LIVEPEER_MCP_URL")),
  npm_config_cache: cache,
  XDG_CONFIG_HOME: join(temporary, "config"),
};
const outputFlagIndex = process.argv.indexOf("--output");
const validatedOutput = outputFlagIndex === -1 ? undefined : process.argv[outputFlagIndex + 1];
if (outputFlagIndex !== -1 && (!validatedOutput || validatedOutput.startsWith("--"))) {
  throw new Error("--output requires a destination path");
}

async function verifyBundledOAuth(binary) {
  const child = spawn(binary, ["provider", "login", "openai-codex"], {
    env: { ...environment, TERM_PROGRAM: "Termius" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    const capture = (chunk) => {
      output += chunk.toString();
      if (output.includes("Cannot find module")) rejectCompletion(new Error(`Bundled OAuth module failed to load:\n${output}`));
      if (/Open to continue:|https:\/\/auth\.openai\.com/u.test(output)) resolveCompletion();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", rejectCompletion);
    child.once("exit", (code) => {
      if (!settled) rejectCompletion(new Error(`OAuth smoke exited before presenting authorization (exit ${String(code)}):\n${output}`));
    });
  });
  const timeout = setTimeout(() => {
    if (!settled) child.kill("SIGKILL");
  }, 8_000);
  try {
    child.stdin.write("browser\n");
    await completion;
    settled = true;
  } finally {
    clearTimeout(timeout);
    child.kill("SIGINT");
    await Promise.race([
      new Promise((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) resolveExit();
        else child.once("exit", resolveExit);
      }),
      new Promise((resolveExit) => setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 500)),
    ]);
  }
}

async function verifyBundledImageRead(packageRoot) {
  const dist = join(packageRoot, "dist");
  const entry = join(dist, "index.js");
  const probe = join(dist, "image-read-probe.mjs");
  const source = await readFile(entry, "utf8");
  await writeFile(probe, `${source}\nexport { createReadToolDefinition as __createReadToolDefinition };\n`);
  const { __createReadToolDefinition: createReadToolDefinition } = await import(pathToFileURL(probe).href);
  const tool = createReadToolDefinition(packageRoot);
  const result = await tool.execute(
    "package-image-smoke",
    { path: join(dist, "modes", "interactive", "assets", "clankolas.png") },
    undefined,
    undefined,
    { model: { input: ["text", "image"] } },
  );
  const image = result.content.find((block) => block.type === "image");
  if (!image?.data || image.mimeType !== "image/png") {
    const text = result.content.find((block) => block.type === "text")?.text ?? "no diagnostic";
    throw new Error(`Standalone CLI could not read a PNG for a vision model: ${text}`);
  }
}

try {
  const shellPackDestination = join(temporary, "shell-pack");
  const shellExtract = join(temporary, "shell-extract");
  await mkdir(shellPackDestination);
  await mkdir(shellExtract);
  const shellPacked = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", shellPackDestination], {
    cwd: shell,
    encoding: "utf8",
    env: environment,
  }))[0];
  if (!shellPacked?.filename || !Array.isArray(shellPacked.files)) throw new Error("Shell npm pack did not return a file manifest");
  const shellPaths = shellPacked.files.map((file) => String(file.path));
  const forbiddenShellFiles = shellPaths.filter((path) => /(?:^|\/)(?:test|src|node_modules|\.cache)(?:\/|$)|(?:\.test\.|\.map$|\.tsbuildinfo$|(?:^|\/)\.env(?:\.|$)|credentials\.json$)/u.test(path));
  if (forbiddenShellFiles.length) throw new Error(`Forbidden shell package files: ${forbiddenShellFiles.join(", ")}`);
  for (const required of [
    "package.json",
    "LICENSE",
    "UPSTREAM.md",
    "UPSTREAM.json",
    "dist/index.js",
    "dist/modes/interactive/theme/dark.json",
    "dist/modes/interactive/theme/light.json",
    "dist/modes/interactive/theme/theme-schema.json",
    "dist/modes/interactive/assets/clankolas.png",
  ]) {
    if (!shellPaths.includes(required)) throw new Error(`Missing packaged shell asset: ${required}`);
  }
  const shellTarball = join(shellPackDestination, shellPacked.filename);
  execFileSync("tar", ["-xzf", shellTarball, "-C", shellExtract]);
  const shellManifest = JSON.parse(await readFile(join(shellExtract, "package", "package.json"), "utf8"));
  if (JSON.stringify(shellManifest).includes("workspace:")) {
    throw new Error("Packed shell manifest contains an unresolved workspace dependency");
  }

  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], {
    cwd: cli,
    encoding: "utf8",
    env: environment,
  }))[0];
  if (!packed?.filename || !Array.isArray(packed.files)) throw new Error("npm pack did not return a file manifest");
  const paths = packed.files.map((file) => String(file.path));
  const forbidden = paths.filter((path) => /(?:^|\/)(?:src|test|tests|fixtures|sessions?|node_modules|\.cache)(?:\/|$)|(?:\.test\.|\.map$|\.tsbuildinfo$|(?:^|\/)\.env(?:\.|$)|credentials\.json$|providers\.json$|(?:^|\/)evals?(?:\/|$))/u.test(path));
  if (forbidden.length) throw new Error(`Forbidden package files: ${forbidden.join(", ")}`);
  for (const required of ["dist/index.js", "dist/install.sh", "dist/openai-codex.js", "dist/photon_rs_bg.wasm", "dist/modes/interactive/theme/dark.json", "dist/modes/interactive/theme/light.json", "dist/modes/interactive/assets/clankolas.png", "dist/core/export-html/template.html", "dist/core/export-html/template.css", "dist/core/export-html/template.js", "dist/core/export-html/vendor/highlight.min.js", "dist/core/export-html/vendor/marked.min.js", "dist/legal/PI_LICENSE.txt", "dist/legal/THIRD_PARTY_NOTICES.md", "dist/legal/BUNDLED_DEPENDENCIES.json"]) {
    if (!paths.includes(required)) throw new Error(`Missing packaged runtime asset: ${required}`);
  }

  const tarball = join(temporary, packed.filename);
  execFileSync("tar", ["-xzf", tarball, "-C", temporary]);
  const manifest = JSON.parse(await readFile(join(temporary, "package", "package.json"), "utf8"));
  const runtimeManifest = {
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  };
  if (JSON.stringify(runtimeManifest).includes("workspace:")) {
    throw new Error("Packed manifest contains an unresolved runtime workspace dependency");
  }
  if (Object.keys(manifest.dependencies ?? {}).length) throw new Error("Standalone CLI package unexpectedly has runtime dependencies");
  const bundledInstaller = await readFile(join(temporary, "package", "dist", "install.sh"), "utf8");
  if (bundledInstaller !== await readFile(join(root, "install.sh"), "utf8")) {
    throw new Error("Packaged self-update installer differs from the root installer");
  }
  const legalRoot = join(temporary, "package", "dist", "legal");
  const inventory = JSON.parse(await readFile(join(legalRoot, "BUNDLED_DEPENDENCIES.json"), "utf8"));
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.packages) || !inventory.packages.length) {
    throw new Error("Bundled dependency inventory is empty or invalid");
  }
  if (!inventory.generatedFrom?.includes("cli") || !inventory.generatedFrom?.includes("openai-codex-oauth")) {
    throw new Error("Bundled dependency inventory does not cover both esbuild bundles");
  }
  for (const dependency of inventory.packages) {
    if (!dependency.name || !dependency.version || !dependency.license || !dependency.bundles?.length) {
      throw new Error(`Incomplete bundled dependency inventory entry: ${JSON.stringify(dependency)}`);
    }
  }
  const piLicense = await readFile(join(legalRoot, "PI_LICENSE.txt"), "utf8");
  if (!piLicense.includes("MIT License") || !piLicense.includes("Copyright (c) 2025 Mario Zechner")) {
    throw new Error("Packaged Pi license is missing or incorrect");
  }
  if (piLicense !== await readFile(join(shell, "LICENSE"), "utf8")) {
    throw new Error("Packaged Pi license differs from the preserved fork license");
  }
  const notices = await readFile(join(legalRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  if (notices !== await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")) {
    throw new Error("Packaged third-party notices differ from the generated root notices");
  }
  for (const dependency of inventory.packages) {
    if (!notices.includes(`${dependency.name}@${dependency.version}`)) {
      throw new Error(`Third-party notices omit bundled dependency: ${dependency.name}@${dependency.version}`);
    }
  }
  for (const path of paths.filter((path) => path !== "package.json")) {
    const content = await readFile(join(temporary, "package", path), "utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{24,}\b|\blpt_(?:at|rt)_[A-Za-z0-9._-]{16,}\b/u.test(content)) {
      throw new Error(`Possible credential material in package file: ${path}`);
    }
  }
  await verifyBundledImageRead(join(temporary, "package"));

  execFileSync("npm", ["install", "--global", "--prefix", install, tarball, "--ignore-scripts", "--no-audit", "--no-fund"], {
    encoding: "utf8",
    env: environment,
  });
  for (const binary of ["livepeer", "livepeer-agent"]) {
    const help = execFileSync(join(install, "bin", binary), ["--help"], { encoding: "utf8", env: environment });
    if (!help.includes("Livepeer media tools and terminal agent")) throw new Error(`${binary} did not execute after installation`);
  }
  const livepeer = join(install, "bin", "livepeer");
  const keyStatus = spawnSync(livepeer, ["key", "status", "--json"], { encoding: "utf8", env: environment });
  if (keyStatus.status !== 0 || !keyStatus.stdout.includes('"configured":false')) throw new Error("Fresh install did not report an unconfigured Daydream key");
  const browserStatus = spawnSync(livepeer, ["browser", "status", "--json"], { encoding: "utf8", env: environment });
  if (browserStatus.status !== 0 || !browserStatus.stdout.includes('"installed":false') || !browserStatus.stdout.includes("livepeer browser install")) {
    throw new Error("Fresh install did not report actionable managed-browser status");
  }
  await verifyBundledOAuth(livepeer);
  if (validatedOutput) {
    const destination = resolve(validatedOutput);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(tarball, destination);
    console.log(`validated CLI artifact: ${destination}`);
  }
  console.log(`package validation passed (${shellPacked.filename}, ${shellPaths.length} files; ${packed.filename}, ${paths.length} files; both binaries installed and invoked)`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

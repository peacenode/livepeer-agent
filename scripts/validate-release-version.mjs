import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliManifestPath = resolve(root, "apps/cli/package.json");
const releaseVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function assertReleaseVersion({ tag, manifestVersion, artifactVersion, binaryVersion }) {
  if (!releaseVersionPattern.test(manifestVersion)) {
    throw new Error(`CLI package version is not a releasable semantic version: ${manifestVersion}`);
  }
  const expectedTag = `v${manifestVersion}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag} does not match CLI package version ${manifestVersion}; expected ${expectedTag}`);
  }
  if (artifactVersion !== undefined && artifactVersion !== manifestVersion) {
    throw new Error(`Release artifact version ${artifactVersion} does not match CLI package version ${manifestVersion}`);
  }
  if (binaryVersion !== undefined && binaryVersion !== manifestVersion) {
    throw new Error(`CLI binary version ${binaryVersion} does not match CLI package version ${manifestVersion}`);
  }
  return manifestVersion;
}

export function parseArguments(argv) {
  const [tag, ...options] = argv;
  if (!tag || tag.startsWith("--")) {
    throw new Error("Usage: validate-release-version.mjs <vX.Y.Z> [--artifact <tarball>] [--binary <path>]");
  }
  const parsed = { tag };
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option ?? "option"} requires a value`);
    if (option === "--artifact") parsed.artifact = value;
    else if (option === "--binary") parsed.binary = value;
    else throw new Error(`Unknown option: ${option}`);
  }
  return parsed;
}

function readArtifactVersion(artifact) {
  const manifest = execFileSync("tar", ["-xOf", resolve(root, artifact), "package/package.json"], { encoding: "utf8" });
  return JSON.parse(manifest).version;
}

function readBinaryVersion(binary) {
  return execFileSync(process.execPath, [resolve(root, binary), "--version"], { encoding: "utf8" }).trim();
}

export function validateReleaseArtifacts({ tag, artifact, binary }) {
  const manifestVersion = JSON.parse(readFileSync(cliManifestPath, "utf8")).version;
  return assertReleaseVersion({
    tag,
    manifestVersion,
    ...(artifact ? { artifactVersion: readArtifactVersion(artifact) } : {}),
    ...(binary ? { binaryVersion: readBinaryVersion(binary) } : {}),
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const version = validateReleaseArtifacts(parseArguments(process.argv.slice(2)));
    console.log(`release version validated: v${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

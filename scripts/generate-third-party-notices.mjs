import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:\..*)?$/iu;
const NOTICE_FILE_PATTERN = /^notice(?:\..*)?$/iu;

function normalizeLegalText(text) {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

function packageNameFromInput(inputPath) {
  const normalized = inputPath.split(sep).join("/");
  const matches = [...normalized.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/gu)];
  return matches.at(-1)?.[1];
}

async function findPackageRoot(inputPath, packageName) {
  let current = dirname(inputPath);
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name === packageName) return { root: current, manifest };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  throw new Error(`Could not locate package.json for bundled input: ${inputPath}`);
}

function normalizeLicense(license) {
  if (typeof license === "string" && license.trim()) return license.trim();
  if (license && typeof license.type === "string" && license.type.trim()) return license.type.trim();
  return undefined;
}

async function collectLegalFiles(packageRoot, fallbackLicense) {
  const names = (await readdir(packageRoot)).sort((left, right) => left.localeCompare(right, "en"));
  const licenseNames = names.filter((name) => LICENSE_FILE_PATTERN.test(name));
  const noticeNames = names.filter((name) => NOTICE_FILE_PATTERN.test(name));
  return {
    licenses: licenseNames.length
      ? await Promise.all(licenseNames.map(async (name) => ({ name, text: normalizeLegalText(await readFile(join(packageRoot, name), "utf8")) })))
      : fallbackLicense
        ? [{ name: fallbackLicense.name, text: normalizeLegalText(await readFile(fallbackLicense.path, "utf8")) }]
        : [],
    notices: await Promise.all(noticeNames.map(async (name) => ({ name, text: normalizeLegalText(await readFile(join(packageRoot, name), "utf8")) }))),
  };
}

async function describePackage(packageRoot, bundle, fallbackLicenses) {
  const canonicalRoot = await realpath(packageRoot);
  const manifest = JSON.parse(await readFile(join(canonicalRoot, "package.json"), "utf8"));
  const license = normalizeLicense(manifest.license);
  if (!manifest.name || !manifest.version) throw new Error(`Missing package identity: ${canonicalRoot}`);
  if (!license) throw new Error(`Missing license metadata: ${manifest.name}@${manifest.version}`);
  return {
    key: `${manifest.name}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    license,
    repository: typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url,
    bundles: [bundle],
    legal: await collectLegalFiles(canonicalRoot, fallbackLicenses?.[manifest.name]),
  };
}

async function packageRootsFromMetafile(root, metafile) {
  const roots = new Map();
  for (const input of Object.keys(metafile.inputs).sort((left, right) => left.localeCompare(right, "en"))) {
    const absolute = resolve(root, input);
    const packageName = packageNameFromInput(absolute);
    if (!packageName) continue;
    const found = await findPackageRoot(absolute, packageName);
    roots.set(await realpath(found.root), found.root);
  }
  return [...roots.values()];
}

function mergePackage(packages, next) {
  const existing = packages.get(next.key);
  if (!existing) {
    packages.set(next.key, next);
    return;
  }
  existing.bundles = [...new Set([...existing.bundles, ...next.bundles])].sort();
}

function renderNotices(packages) {
  const lines = [
    "LIVEPEER AGENT THIRD-PARTY NOTICES",
    "",
    "This file is generated from the dependency inputs in both esbuild bundle metafiles.",
    "Copied runtime assets are included explicitly. Package order is deterministic.",
    "The owned Pi coding-agent source fork is distributed under the separate PI_LICENSE.txt file.",
    "",
    "BUNDLED DEPENDENCY INVENTORY",
    "",
  ];
  for (const entry of packages) {
    lines.push(`- ${entry.name}@${entry.version} | ${entry.license} | ${entry.bundles.join(", ")}`);
  }
  for (const entry of packages) {
    lines.push("", "=".repeat(78), `${entry.name}@${entry.version}`, `License: ${entry.license}`);
    if (entry.repository) lines.push(`Repository: ${entry.repository}`);
    if (!entry.legal.licenses.length) {
      lines.push("", "The published package declares the license above but does not include a separate root-level license file.");
    }
    for (const file of [...entry.legal.licenses, ...entry.legal.notices]) {
      lines.push("", `--- ${file.name} ---`, "", file.text.trimEnd());
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function generateThirdPartyNotices({ root, bundles, additionalPackages, virtualArtifacts, fallbackLicenses, outputDirectory, noticesPath = join(outputDirectory, "THIRD_PARTY_NOTICES.md") }) {
  const packages = new Map();
  for (const bundle of bundles) {
    for (const packageRoot of await packageRootsFromMetafile(root, bundle.metafile)) {
      mergePackage(packages, await describePackage(packageRoot, bundle.name, fallbackLicenses));
    }
  }
  for (const additional of additionalPackages) {
    mergePackage(packages, await describePackage(additional.packageRoot, additional.bundle, fallbackLicenses));
  }
  for (const artifact of virtualArtifacts) {
    const license = normalizeLicense(artifact.license);
    if (!artifact.name || !artifact.version || !license) throw new Error(`Incomplete vendored artifact metadata: ${artifact.name ?? "unknown"}`);
    const legal = await collectLegalFiles(artifact.licenseSourceRoot);
    mergePackage(packages, {
      key: `${artifact.name}@${artifact.version}`,
      name: artifact.name,
      version: artifact.version,
      license,
      repository: artifact.repository,
      bundles: [artifact.bundle],
      legal,
    });
  }

  const sorted = [...packages.values()].sort((left, right) => left.key.localeCompare(right.key, "en"));
  const inventory = {
    schemaVersion: 1,
    generatedFrom: bundles.map(({ name }) => name).sort(),
    packages: sorted.map(({ name, version, license, repository, bundles }) => ({
      name,
      version,
      license,
      ...(repository ? { repository } : {}),
      bundles,
    })),
  };
  await writeFile(join(outputDirectory, "BUNDLED_DEPENDENCIES.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(noticesPath, renderNotices(sorted));
  return inventory;
}

export async function findPnpmPackageRoot(root, name, version) {
  const virtualStore = join(root, "node_modules", ".pnpm");
  const encodedName = name.replace("/", "+");
  const candidates = (await readdir(virtualStore))
    .filter((entry) => entry === `${encodedName}@${version}` || entry.startsWith(`${encodedName}@${version}_`))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(`Expected one pnpm package for ${name}@${version}; found ${candidates.length}`);
  }
  const packageRoot = join(virtualStore, candidates[0], "node_modules", ...name.split("/"));
  if (!(await stat(packageRoot)).isDirectory()) throw new Error(`Missing pnpm package directory: ${relative(root, packageRoot)}`);
  return packageRoot;
}

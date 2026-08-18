import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  type SettingsManager,
} from "@livepeer/pi-coding-agent";

export interface InstructionFile {
  path: string;
  content: string;
}

export interface LivepeerResourcePlan {
  cwd: string;
  repositoryRoot: string;
  configRoot: string;
  agentsFiles: readonly InstructionFile[];
  skillPaths: readonly string[];
  extensionPaths: readonly string[];
}

export interface LivepeerResourcePlanOptions {
  cwd: string;
  configRoot: string;
}

/** Resolve only Livepeer-owned resources; no ~/.pi or project .pi paths participate. */
export function createLivepeerResourcePlan(options: LivepeerResourcePlanOptions): LivepeerResourcePlan {
  const cwd = resolve(options.cwd);
  const configRoot = resolve(options.configRoot);
  const repositoryRoot = findRepositoryRoot(cwd);

  return {
    cwd,
    repositoryRoot,
    configRoot,
    agentsFiles: loadRepositoryInstructions(repositoryRoot, cwd),
    // The owned shell's skill loader is first-wins, so precedence is explicit here.
    skillPaths: existingPaths([
      join(repositoryRoot, ".livepeer", "skills"),
      join(configRoot, "skills"),
    ]),
    // Project extensions load before global extensions for the same reason.
    extensionPaths: existingPaths([
      join(repositoryRoot, ".livepeer", "extensions"),
      join(configRoot, "extensions"),
    ]),
  };
}

export function createLivepeerResourceLoader(
  plan: LivepeerResourcePlan,
  settingsManager?: SettingsManager,
): DefaultResourceLoader {
  const options: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd: plan.cwd,
    agentDir: plan.configRoot,
    ...(settingsManager ? { settingsManager } : {}),
    additionalExtensionPaths: [...plan.extensionPaths],
    additionalSkillPaths: [...plan.skillPaths],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: plan.agentsFiles.map((file) => ({ ...file })) }),
    // Preserve the owned shell's coding-agent base rather than discovering a
    // user-level SYSTEM.md as a replacement prompt.
    systemPromptOverride: () => undefined,
  };
  return new DefaultResourceLoader(options);
}

export function findRepositoryRoot(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  let current = resolvedCwd;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolvedCwd;
    current = parent;
  }
}

export function loadRepositoryInstructions(repositoryRoot: string, cwd: string): InstructionFile[] {
  const root = resolve(repositoryRoot);
  const target = resolve(cwd);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(`Working directory is outside the repository root: ${target}`);
  }
  const directories: string[] = [];
  let current = target;
  while (true) {
    directories.unshift(current);
    if (current === root) break;
    current = dirname(current);
  }
  return directories.flatMap((directory) => {
    const path = join(directory, "AGENTS.md");
    return isFile(path) ? [{ path, content: readFileSync(path, "utf8") }] : [];
  });
}

function existingPaths(paths: readonly string[]): string[] {
  return paths.filter(existsSync);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@livepeer/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeModelCredentialStore } from "../testing/index.js";
import {
  createLivepeerResourceLoader,
  createLivepeerResourcePlan,
  loadRepositoryInstructions,
} from "./index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Livepeer shell resources", () => {
  it("loads AGENTS.md from repository root to cwd so nearer instructions are later", () => {
    const fixture = createFixture();
    const files = loadRepositoryInstructions(fixture.repositoryRoot, fixture.cwd);
    expect(files.map(({ path }) => path)).toEqual([
      join(fixture.repositoryRoot, "AGENTS.md"),
      join(fixture.cwd, "AGENTS.md"),
    ]);
    expect(files.map(({ content }) => content)).toEqual(["root guidance", "near guidance"]);
  });

  it("discovers only project and global Livepeer skill locations", () => {
    const fixture = createFixture();
    const plan = createLivepeerResourcePlan(fixture);
    expect(plan.skillPaths).toEqual([
      join(fixture.repositoryRoot, ".livepeer", "skills"),
      join(fixture.configRoot, "skills"),
    ]);
    expect(plan.extensionPaths).toEqual([
      join(fixture.repositoryRoot, ".livepeer", "extensions"),
      join(fixture.configRoot, "extensions"),
    ]);
    expect([...plan.skillPaths, ...plan.extensionPaths].some((path) => /(^|\/)\.pi(\/|$)/u.test(path))).toBe(false);
    expect(plan.skillPaths.some((path) => /(^|\/)(evals?|test)(\/|$)/u.test(path))).toBe(false);
  });

  it("indexes a project skill over a global collision without appending a bundled profile", async () => {
    const fixture = createFixture();
    const plan = createLivepeerResourcePlan(fixture);
    const loader = createLivepeerResourceLoader(plan);
    await loader.reload();
    const skills = loader.getSkills().skills;
    expect(skills.find(({ name }) => name === "image-generation")?.filePath).toBe(
      join(fixture.repositoryRoot, ".livepeer", "skills", "image-generation", "SKILL.md"),
    );
    expect(skills.some(({ name }) => name === "short-form-video")).toBe(false);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getSystemPrompt()).toBeUndefined();
    expect(loader.getAgentsFiles().agentsFiles.map(({ content }) => content)).toEqual(["root guidance", "near guidance"]);
  });

  it("leaves the owned shell's general coding tools enabled", async () => {
    const fixture = createFixture();
    const plan = createLivepeerResourcePlan(fixture);
    const settingsManager = SettingsManager.create(fixture.cwd, fixture.configRoot);
    const resourceLoader = createLivepeerResourceLoader(plan, settingsManager);
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory();
    const modelRuntime = await ModelRuntime.create({
      credentials: createFakeModelCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
    if (!model) throw new Error("Expected the bundled Anthropic model fixture.");
    const { session } = await createAgentSession({
      cwd: fixture.cwd,
      agentDir: fixture.configRoot,
      model,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
    });
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
    expect(session.systemPrompt).not.toContain("director guidance");
    expect(session.systemPrompt).toContain("expert coding assistant operating inside pi");
    session.dispose();
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "livepeer-resources-"));
  roots.push(root);
  const repositoryRoot = join(root, "repo");
  const cwd = join(repositoryRoot, "packages", "app");
  const configRoot = join(root, "config", "livepeer");
  mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(repositoryRoot, ".livepeer", "extensions"), { recursive: true });
  mkdirSync(join(configRoot, "extensions"), { recursive: true });
  write(join(repositoryRoot, "AGENTS.md"), "root guidance");
  write(join(cwd, "AGENTS.md"), "near guidance");
  writeSkill(join(repositoryRoot, ".livepeer", "skills", "image-generation", "SKILL.md"), "image-generation", "project image");
  writeSkill(join(configRoot, "skills", "image-generation", "SKILL.md"), "image-generation", "global image");
  return { cwd, repositoryRoot, configRoot };
}

function writeSkill(path: string, name: string, description: string): void {
  write(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

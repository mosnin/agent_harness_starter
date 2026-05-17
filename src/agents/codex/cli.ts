import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { AgentsMdConfig, SkillMarkdown, CodexTomlConfig, MigrationResult } from "./types";
import {
  generateAgentsMd,
  generateSkillMarkdown,
  generateToml,
} from "./generators";
import { migrateClaude } from "./migrator";

export interface CodexCliOptions {
  /** Directory to write generated files. Default: process.cwd() */
  outputDir?: string;
  /** Whether to overwrite existing files. Default: false */
  overwrite?: boolean;
}

export interface CodexCli {
  /** Generate AGENTS.md from config */
  generate(
    config: AgentsMdConfig,
    options?: CodexCliOptions
  ): Promise<{ path: string; content: string }>;

  /** Generate skill markdown file */
  generateSkill(
    skill: SkillMarkdown,
    options?: CodexCliOptions
  ): Promise<{ path: string; content: string }>;

  /** Generate TOML config */
  generateToml(
    config: CodexTomlConfig,
    options?: CodexCliOptions
  ): Promise<{ path: string; content: string }>;

  /** Migrate an existing CLAUDE.md file */
  migrate(
    sourcePath: string,
    options?: CodexCliOptions
  ): Promise<MigrationResult & { outputPath: string }>;
}

/**
 * Resolve the effective output directory and overwrite flag from merged options.
 */
function resolveOptions(
  instanceOptions: CodexCliOptions | undefined,
  callOptions: CodexCliOptions | undefined
): Required<CodexCliOptions> {
  return {
    outputDir: callOptions?.outputDir ?? instanceOptions?.outputDir ?? process.cwd(),
    overwrite: callOptions?.overwrite ?? instanceOptions?.overwrite ?? false,
  };
}

/**
 * Ensure the parent directory exists and, unless overwrite is set, that the
 * target path does not already exist.
 */
async function prepareWrite(
  filePath: string,
  overwrite: boolean
): Promise<void> {
  // Ensure parent directory exists
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir) {
    await mkdir(dir, { recursive: true });
  }

  if (!overwrite) {
    try {
      await readFile(filePath);
      // File exists — throw a descriptive error
      throw new Error(
        `File already exists: ${filePath}. Pass overwrite: true to replace it.`
      );
    } catch (err) {
      // ENOENT means the file does not exist — that's fine
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

/**
 * Create a programmatic Codex CLI instance.
 *
 * @example
 * ```ts
 * const cli = createCodexCli({ outputDir: "./out", overwrite: true });
 * await cli.generate({ name: "MyAgent", description: "..." });
 * ```
 */
export function createCodexCli(options?: CodexCliOptions): CodexCli {
  return {
    async generate(
      config: AgentsMdConfig,
      callOptions?: CodexCliOptions
    ): Promise<{ path: string; content: string }> {
      const { outputDir, overwrite } = resolveOptions(options, callOptions);
      const filePath = join(outputDir, "AGENTS.md");
      const content = generateAgentsMd(config);
      await prepareWrite(filePath, overwrite);
      await writeFile(filePath, content, "utf8");
      return { path: filePath, content };
    },

    async generateSkill(
      skill: SkillMarkdown,
      callOptions?: CodexCliOptions
    ): Promise<{ path: string; content: string }> {
      const { outputDir, overwrite } = resolveOptions(options, callOptions);
      const filePath = join(outputDir, "skills", `${skill.name}.md`);
      const content = generateSkillMarkdown(skill);
      await prepareWrite(filePath, overwrite);
      await writeFile(filePath, content, "utf8");
      return { path: filePath, content };
    },

    async generateToml(
      config: CodexTomlConfig,
      callOptions?: CodexCliOptions
    ): Promise<{ path: string; content: string }> {
      const { outputDir, overwrite } = resolveOptions(options, callOptions);
      const filePath = join(outputDir, "codex.toml");
      const content = generateToml(config);
      await prepareWrite(filePath, overwrite);
      await writeFile(filePath, content, "utf8");
      return { path: filePath, content };
    },

    async migrate(
      sourcePath: string,
      callOptions?: CodexCliOptions
    ): Promise<MigrationResult & { outputPath: string }> {
      const { outputDir, overwrite } = resolveOptions(options, callOptions);
      const claudeMdContent = await readFile(sourcePath, "utf8");
      const result = migrateClaude(claudeMdContent);
      const outputPath = join(outputDir, "AGENTS.md");
      await prepareWrite(outputPath, overwrite);
      await writeFile(outputPath, result.agentsMd, "utf8");
      return { ...result, outputPath };
    },
  };
}

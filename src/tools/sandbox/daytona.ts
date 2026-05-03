/**
 * Daytona sandbox tool.
 * Daytona provides ephemeral dev environments with full filesystem access.
 * Docs: https://www.daytona.io/docs
 */

import { z } from "zod";
import { registerTool } from "../registry";
import { config } from "@/lib/config";

type DaytonaSandbox = {
  id: string;
  stop: () => Promise<void>;
  process: {
    executeCommand: (cmd: { command: string; timeout?: number }) => Promise<{
      exitCode: number;
      result: string;
    }>;
  };
  fs: {
    uploadFile: (path: string, content: string) => Promise<void>;
    downloadFile: (path: string) => Promise<string>;
  };
};

let _daytona: unknown = null;

async function getDaytona() {
  if (!_daytona) {
    const { Daytona } = await import("@daytonaio/sdk");
    _daytona = new Daytona({
      apiKey: config.daytona.apiKey,
      serverUrl: config.daytona.serverUrl,
    });
  }
  return _daytona as {
    create: (opts?: object) => Promise<DaytonaSandbox>;
  };
}

export const daytonaRunCodeTool = registerTool({
  name: "sandbox_run_code",
  description:
    "Execute code in an isolated Daytona sandbox environment. Supports Python, Node.js, and shell scripts. The sandbox has network access and a full Linux environment.",
  parameters: z.object({
    code: z.string().describe("The code to execute"),
    language: z
      .enum(["python", "node", "bash"])
      .default("python")
      .describe("Programming language"),
    files: z
      .array(
        z.object({
          path: z.string().describe("File path relative to workspace root"),
          content: z.string().describe("File content"),
        })
      )
      .optional()
      .describe("Additional files to create before running the code"),
    timeoutSeconds: z.number().int().min(5).max(300).default(60),
  }),
  async execute({ code, language, files, timeoutSeconds }) {
    const daytona = await getDaytona();
    const sandbox = await daytona.create();

    try {
      if (files?.length) {
        for (const file of files) {
          await sandbox.fs.uploadFile(file.path, file.content);
        }
      }

      const entryMap: Record<string, string> = {
        python: `python3 -c ${JSON.stringify(code)}`,
        node: `node -e ${JSON.stringify(code)}`,
        bash: `bash -c ${JSON.stringify(code)}`,
      };

      const result = await sandbox.process.executeCommand({
        command: entryMap[language],
        timeout: timeoutSeconds * 1000,
      });

      return {
        exitCode: result.exitCode,
        output: result.result,
        success: result.exitCode === 0,
      };
    } finally {
      await sandbox.stop().catch(() => {});
    }
  },
});

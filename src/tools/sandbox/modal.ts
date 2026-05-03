/**
 * Modal sandbox tool.
 * Modal runs serverless GPU/CPU workloads in isolated containers.
 * This adapter calls Modal's REST API to trigger deployed functions.
 * Docs: https://modal.com/docs
 *
 * Usage: deploy your Modal function first, then call it via this tool.
 */

import { z } from "zod";
import { registerTool } from "../registry";
import { config } from "@/lib/config";

async function callModalFunction(
  appName: string,
  functionName: string,
  payload: unknown
): Promise<{ result: unknown; logs: string[] }> {
  const tokenId = config.modal.tokenId;
  const tokenSecret = config.modal.tokenSecret;

  if (!tokenId || !tokenSecret) {
    throw new Error("Modal credentials not configured (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET)");
  }

  const credentials = Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64");

  const response = await fetch(
    `https://api.modal.com/v1/apps/${encodeURIComponent(appName)}/functions/${encodeURIComponent(functionName)}/call`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ args: [payload] }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Modal API error ${response.status}: ${text}`);
  }

  return response.json();
}

export const modalRunFunctionTool = registerTool({
  name: "modal_run_function",
  description:
    "Call a deployed Modal serverless function. Use this for compute-intensive tasks like ML inference, data processing, or heavy code execution that benefit from GPU/CPU scaling.",
  parameters: z.object({
    appName: z.string().describe("The Modal app name (as deployed)"),
    functionName: z.string().describe("The function name within the app"),
    payload: z
      .record(z.unknown())
      .optional()
      .describe("JSON payload passed as the first argument to the function"),
  }),
  async execute({ appName, functionName, payload }) {
    return callModalFunction(appName, functionName, payload ?? {});
  },
});

/** Select the active sandbox tool based on SANDBOX_PROVIDER env var. */
export function getSandboxTool() {
  const provider = config.sandbox.provider;
  if (provider === "daytona") {
    return import("./daytona").then((m) => m.daytonaRunCodeTool);
  }
  if (provider === "modal") {
    return Promise.resolve(modalRunFunctionTool);
  }
  return Promise.resolve(null);
}

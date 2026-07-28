/* ------------------------------------------------------------------ *
 * Inherited MCP tools, in the shape the SWARM speaks.
 *
 * The catalog side of a mount (`./mcp-catalog.ts`) produces `Tool`s —
 * `run(input: string) -> { ok, output }` — which is what `hades exec`,
 * the ReAct loop and the tool-RPC bridge consume. Swarm workers use a
 * different, argument-typed shape: `SwarmTool.execute(args) -> unknown`,
 * dispatched through `ToolRunner`, which records EVERY call as evidence
 * so a worker cannot claim work it never did.
 *
 * Rather than make one shape pretend to be the other, this module maps a
 * mount to `SwarmTool`s directly. Two consequences are deliberate:
 *
 *  - Arguments pass through as an object, with no string round trip. The
 *    swarm already has structured args; re-serializing them to a string
 *    just so the catalog wrapper could parse them back would be a lossy
 *    detour.
 *  - A failed call THROWS. `ToolRunner` records a throw as `ok:false`
 *    with the reason and propagates it, which is exactly what should
 *    happen: an unreachable server or a tool that reported `isError`
 *    must not leave a successful-looking record behind for a claim to
 *    cite. Returning a "failed" object would do precisely that.
 *
 * Nothing here connects until `execute` is called, matching the catalog
 * entries' inert-until-called rule.
 * ------------------------------------------------------------------ */

import type { SwarmTool } from "../../swarm-runtime/worker/toolbox";
import { callMcpServerTool, type McpMountDeps } from "../mcp/mount";
import {
  describeInputSchema,
  mcpSource,
  mcpToolId,
  type McpMountRecord,
} from "./mcp-catalog";

/**
 * `SwarmTool`s for every tool of every mounted server, named with the SAME
 * `mcp.<server>.<tool>` ids the catalog uses — so a capability allowlist, a
 * tool-call record and a `hades tools list` row all refer to one identity.
 *
 * Tools whose names cannot be represented as catalog ids are skipped here for
 * the same reason they are skipped there (see `planMcpEntries`): a foreign name
 * is never silently rewritten into something the operator did not authorize.
 */
export function mcpSwarmTools(records: McpMountRecord[], deps: McpMountDeps = {}): SwarmTool[] {
  const out: SwarmTool[] = [];
  const claimed = new Set<string>();

  for (const record of records) {
    for (const mounted of record.tools) {
      const id = mcpToolId(record.spec.name, mounted.name);
      if (id === undefined || claimed.has(id)) continue;
      claimed.add(id);

      out.push({
        name: id,
        description:
          `[${mcpSource(record.spec.name)}] ${
            mounted.description ?? "(no description provided by the server)"
          } Arguments: ${describeInputSchema(mounted.inputSchema)}.`,
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          const outcome = await callMcpServerTool(record.spec, mounted.name, args ?? {}, deps);
          if (!outcome.ok) throw new Error(outcome.error);
          if (outcome.isError) {
            throw new Error(
              `MCP tool "${mounted.name}" on server "${record.spec.name}" reported an error: ${outcome.text}`
            );
          }
          return { source: mcpSource(record.spec.name), tool: mounted.name, text: outcome.text };
        },
      });
    }
  }

  return out;
}

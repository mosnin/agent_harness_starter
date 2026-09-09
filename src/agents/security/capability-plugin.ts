/**
 * withCapabilities — enforces per-run capability tokens on every tool call.
 *
 * `security/capabilities.ts` has always been able to mint and verify tokens, but nothing
 * called it: no route minted a token and `core.ts` never verified one. This plugin is the
 * missing wiring, structured like `withSecurity` in `security/plugin.ts`.
 *
 * Usage:
 *   const token = await mintRunnerCapabilityToken({
 *     sub: user.id,
 *     runId: run.id,
 *     scopes: runner.grantedScopes,
 *     agentName: "director",
 *   });
 *
 *   createCustomHarness({ ...config, plugins: [withCapabilities({ expectedAud: "director" })] })
 *     .stream({ messages, context: { userId: user.id, capabilityToken: token, capabilityRunId: run.id } });
 *
 * Fail-closed invariants:
 *   - No resolvable token ⇒ every tool call throws. There is no "unauthenticated" fallthrough.
 *   - The token is verified before EACH call, not cached per run, so a token that expires
 *     mid-run stops the run at the next tool call.
 *   - A wildcard ("*") token is rejected at mint time; scoping to nothing is not scoping.
 *
 * NOTE: `orchestrator.ts` calls `resolveAgentTools` + `toOpenAITool` directly and never runs
 * `wrapTools`, so orchestrated runs bypass this plugin entirely. Anything reachable from an
 * orchestrated run must be authorized at its own boundary (the runner re-checks scopes against
 * the capability token on every command, which is what actually holds that line).
 */

import type { HarnessPlugin, PluginRunContext } from "../types";
import type { ToolContext, ToolDefinition } from "../tools/types";
import { type RunnerToolName, runnerToolsForScopes } from "../runner/scopes";
import type { Scope } from "../runner/protocol";
// assertToolAllowed is not re-exported from security/index.ts — import from the module directly.
import {
	CapabilityError,
	assertToolAllowed,
	issueCapabilityToken,
	resolveToolsFromToken,
} from "./capabilities";
import { audit as globalAudit, type AuditLogger } from "./audit";

export interface CapabilityPluginOptions {
	/** Static token. Prefer `resolveToken` or `context.capabilityToken` for per-run tokens. */
	token?: string;
	/** Per-run token resolver. Wins over `token`. */
	resolveToken?: (ctx: PluginRunContext) => Promise<string | undefined> | string | undefined;
	/** Enforced by jose; a token minted for another agent is rejected. */
	expectedAud?: string;
	expectedIss?: string;
	expectedOrgId?: string;
	/**
	 * Run id the token must be scoped to. Defaults to `context.capabilityRunId`.
	 * `context.runId` is overwritten by the harness with a fresh per-stream UUID, so a token
	 * minted against a database run id must travel in `capabilityRunId` to be checked.
	 */
	expectedRunId?: string | ((ctx: PluginRunContext) => string | undefined);
	auditLogger?: AuditLogger;
}

function resolveExpectedRunId(
	opts: CapabilityPluginOptions,
	ctx: PluginRunContext,
): string | undefined {
	if (typeof opts.expectedRunId === "function") return opts.expectedRunId(ctx);
	if (typeof opts.expectedRunId === "string") return opts.expectedRunId;
	const fromContext = ctx.context.capabilityRunId;
	return typeof fromContext === "string" ? fromContext : undefined;
}

async function resolveToken(
	opts: CapabilityPluginOptions,
	ctx: PluginRunContext,
): Promise<string> {
	const resolved =
		(await opts.resolveToken?.(ctx)) ??
		opts.token ??
		(typeof ctx.context.capabilityToken === "string" ? ctx.context.capabilityToken : undefined);

	if (!resolved) {
		throw new CapabilityError(
			"No capability token was supplied for this run.",
			"CAPABILITY_TOKEN_MISSING",
		);
	}
	return resolved;
}

export function withCapabilities(opts: CapabilityPluginOptions = {}): HarnessPlugin {
	const auditLogger = opts.auditLogger ?? globalAudit;

	return {
		name: "capabilities",

		wrapTools(tools: ToolDefinition[], ctx: PluginRunContext): ToolDefinition[] {
			return tools.map((tool) => ({
				...tool,
				execute: async (input: unknown, toolCtx: ToolContext) => {
					const start = Date.now();

					try {
						const token = await resolveToken(opts, ctx);
						const { tools: allowed } = await resolveToolsFromToken(
							token,
							resolveExpectedRunId(opts, ctx),
							{
								...(opts.expectedAud !== undefined ? { expectedAud: opts.expectedAud } : {}),
								...(opts.expectedIss !== undefined ? { expectedIss: opts.expectedIss } : {}),
								...(opts.expectedOrgId !== undefined ? { expectedOrgId: opts.expectedOrgId } : {}),
							},
						);
						assertToolAllowed(allowed, tool.name);
					} catch (err) {
						auditLogger.log({
							runId: ctx.runId,
							userId: ctx.userId,
							agentName: ctx.agentName,
							toolName: tool.name,
							input,
							outcome: "blocked",
							policyName: "capability-token",
							reason: err instanceof Error ? err.message : String(err),
						});
						throw err;
					}

					try {
						const output = await tool.execute(input, toolCtx);
						auditLogger.log({
							runId: ctx.runId,
							userId: ctx.userId,
							agentName: ctx.agentName,
							toolName: tool.name,
							input,
							outcome: "allowed",
							policyName: "capability-token",
							durationMs: Date.now() - start,
						});
						return output;
					} catch (err) {
						auditLogger.log({
							runId: ctx.runId,
							userId: ctx.userId,
							agentName: ctx.agentName,
							toolName: tool.name,
							input,
							outcome: "error",
							policyName: "capability-token",
							durationMs: Date.now() - start,
							error: err instanceof Error ? err.message : String(err),
						});
						throw err;
					}
				},
			}));
		},
	};
}

// ── Minting ───────────────────────────────────────────────────────────────────

export interface MintRunnerTokenOptions {
	sub: string;
	runId: string;
	/** Scopes the run needs. Must already be a subset of what the user granted at pairing. */
	scopes: Scope[];
	agentName?: string;
	orgId?: string;
	/** Default "15m" via AGENT_CAPABILITY_DEFAULT_TTL. A recording session outlives a short TTL. */
	ttl?: string;
	aud?: string;
	iss?: string;
	/** Non-runner tools the same run also needs. "*" is rejected. */
	extraTools?: string[];
}

export interface MintedRunnerToken {
	token: string;
	scopes: Scope[];
	tools: string[];
}

/**
 * Mint a token scoped to exactly the runner tools the given scopes reach.
 * Throws rather than issuing an empty or wildcard token — a token that grants everything is
 * indistinguishable from no token at all.
 */
export async function mintRunnerCapabilityToken(
	opts: MintRunnerTokenOptions,
): Promise<MintedRunnerToken> {
	if (opts.extraTools?.includes("*")) {
		throw new CapabilityError(
			'Refusing to mint a wildcard ("*") capability token for a runner session.',
			"CAPABILITY_WILDCARD_REFUSED",
		);
	}

	const scopes = [...new Set(opts.scopes)].sort();
	const runnerTools: RunnerToolName[] = runnerToolsForScopes(scopes);
	const tools = [...new Set<string>([...runnerTools, ...(opts.extraTools ?? [])])].sort();

	if (tools.length === 0) {
		throw new CapabilityError(
			"Refusing to mint a capability token that grants no tools.",
			"CAPABILITY_NO_TOOLS",
		);
	}

	const token = await issueCapabilityToken({
		sub: opts.sub,
		runId: opts.runId,
		tools,
		...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
		...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
		...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
		...(opts.aud !== undefined ? { aud: opts.aud } : {}),
		...(opts.iss !== undefined ? { iss: opts.iss } : {}),
	});

	return { token, scopes, tools };
}

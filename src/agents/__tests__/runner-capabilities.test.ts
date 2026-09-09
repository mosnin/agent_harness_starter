import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogger, InMemoryAuditAdapter, NoopAuditAdapter } from "@/agents/security/audit";
import { CapabilityError, issueCapabilityToken } from "@/agents/security/capabilities";
import { mintRunnerCapabilityToken, withCapabilities } from "@/agents/security/capability-plugin";
import { RUNNER_TOOL_NAMES, runnerToolsForScopes, scopesForRunnerTools } from "@/agents/runner/scopes";
import type { PluginRunContext } from "@/agents/types";
import type { ToolDefinition } from "@/agents/tools/types";
import { z } from "zod";

const SECRET = "test-capability-secret-that-is-long-enough";
const quietAudit = new AuditLogger(new NoopAuditAdapter());

function pluginCtx(overrides: Partial<PluginRunContext> = {}): PluginRunContext {
	return {
		runId: "harness-run-uuid",
		agentName: "director",
		model: "gpt-4o",
		userId: "user-1",
		startedAt: Date.now(),
		context: { userId: "user-1" },
		...overrides,
	};
}

function fakeTool(name: string): ToolDefinition {
	return {
		name,
		description: name,
		parameters: z.object({}),
		execute: async () => ({ ran: name }),
	};
}

async function runTool(
	plugin: ReturnType<typeof withCapabilities>,
	ctx: PluginRunContext,
	toolName: string,
): Promise<unknown> {
	const wrapped = await plugin.wrapTools?.([fakeTool(toolName)], ctx, new Map());
	if (!wrapped) throw new Error("plugin did not wrap tools");
	return wrapped[0].execute({}, {});
}

describe("mintRunnerCapabilityToken", () => {
	beforeEach(() => {
		process.env.AGENT_CAPABILITY_SECRET = SECRET;
	});
	afterEach(() => {
		process.env.AGENT_CAPABILITY_SECRET = undefined;
	});

	it("scopes the token to exactly the runner tools the scopes reach", async () => {
		const minted = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen", "record"],
		});

		expect(minted.tools).toEqual(runnerToolsForScopes(["observe_screen", "record"]).sort());
		expect(minted.tools).toContain("runner_observe");
		expect(minted.tools).toContain("runner_start_recording");
		expect(minted.tools).not.toContain("runner_click");
		expect(minted.tools).not.toContain("runner_export");
	});

	it("refuses a wildcard token", async () => {
		await expect(
			mintRunnerCapabilityToken({ sub: "u", runId: "r", scopes: ["record"], extraTools: ["*"] }),
		).rejects.toBeInstanceOf(CapabilityError);
	});

	it("refuses a token granting nothing", async () => {
		await expect(mintRunnerCapabilityToken({ sub: "u", runId: "r", scopes: [] })).rejects.toThrow(
			/grants no tools/,
		);
	});

	it("maps every runner tool back to a scope", () => {
		expect(scopesForRunnerTools(RUNNER_TOOL_NAMES)).toEqual([
			"control_applications",
			"control_keyboard",
			"control_pointer",
			"edit",
			"export",
			"observe_screen",
			"record",
			"upload",
		]);
		expect(scopesForRunnerTools(["not_a_runner_tool"])).toEqual([]);
	});
});

describe("withCapabilities enforcement", () => {
	beforeEach(() => {
		process.env.AGENT_CAPABILITY_SECRET = SECRET;
	});
	afterEach(() => {
		process.env.AGENT_CAPABILITY_SECRET = undefined;
		vi.useRealTimers();
	});

	it("allows a tool that is in the token", async () => {
		const { token } = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen"],
			aud: "cap-runner",
		});

		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({
			context: { userId: "user-1", capabilityToken: token, capabilityRunId: "run-1" },
		});

		await expect(runTool(plugin, ctx, "runner_observe")).resolves.toEqual({ ran: "runner_observe" });
	});

	it("denies a tool that is not in the token", async () => {
		const { token } = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen"],
			aud: "cap-runner",
		});

		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({ context: { capabilityToken: token, capabilityRunId: "run-1" } });

		await expect(runTool(plugin, ctx, "runner_click")).rejects.toThrow(
			/Tool "runner_click" is not in the capability token scope/,
		);
	});

	it("denies when the token was minted for a different audience", async () => {
		const { token } = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen"],
			aud: "some-other-agent",
		});

		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({ context: { capabilityToken: token, capabilityRunId: "run-1" } });

		await expect(runTool(plugin, ctx, "runner_observe")).rejects.toThrow(/audience mismatch/i);
	});

	it("denies an expired token", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		const { token } = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen"],
			aud: "cap-runner",
			ttl: "5m",
		});

		vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));

		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({ context: { capabilityToken: token, capabilityRunId: "run-1" } });

		await expect(runTool(plugin, ctx, "runner_observe")).rejects.toThrow(/expired/i);
	});

	it("denies a token scoped to a different run", async () => {
		const { token } = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen"],
			aud: "cap-runner",
		});

		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({ context: { capabilityToken: token, capabilityRunId: "run-2" } });

		await expect(runTool(plugin, ctx, "runner_observe")).rejects.toThrow(/scoped to run "run-1"/);
	});

	it("fails closed when no token is supplied at all", async () => {
		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		await expect(runTool(plugin, pluginCtx(), "runner_observe")).rejects.toThrow(
			/No capability token was supplied/,
		);
	});

	it("fails closed on a forged token", async () => {
		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({ context: { capabilityToken: "not.a.jwt", capabilityRunId: "run-1" } });
		await expect(runTool(plugin, ctx, "runner_observe")).rejects.toBeInstanceOf(CapabilityError);
	});

	it("rejects a token that grants no tools", async () => {
		const token = await issueCapabilityToken({ sub: "user-1", runId: "run-1", tools: [], aud: "cap-runner" });
		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({ context: { capabilityToken: token, capabilityRunId: "run-1" } });
		await expect(runTool(plugin, ctx, "runner_observe")).rejects.toThrow(/grants no tools/);
	});

	it("re-verifies before every call, so a mid-run expiry stops the next one", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		const { token } = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen"],
			aud: "cap-runner",
			ttl: "5m",
		});

		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger: quietAudit });
		const ctx = pluginCtx({ context: { capabilityToken: token, capabilityRunId: "run-1" } });
		const wrapped = await plugin.wrapTools?.([fakeTool("runner_observe")], ctx, new Map());
		if (!wrapped) throw new Error("no tools");

		await expect(wrapped[0].execute({}, {})).resolves.toBeTruthy();

		vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
		await expect(wrapped[0].execute({}, {})).rejects.toThrow(/expired/i);
	});

	it("writes a blocked audit record on denial", async () => {
		const adapter = new InMemoryAuditAdapter();
		const auditLogger = new AuditLogger(adapter);

		const { token } = await mintRunnerCapabilityToken({
			sub: "user-1",
			runId: "run-1",
			scopes: ["observe_screen"],
			aud: "cap-runner",
		});

		const plugin = withCapabilities({ expectedAud: "cap-runner", auditLogger });
		const ctx = pluginCtx({ context: { capabilityToken: token, capabilityRunId: "run-1" } });

		await expect(runTool(plugin, ctx, "runner_click")).rejects.toThrow();


		const records = adapter.records ?? [];
		expect(records.some((r) => r.outcome === "blocked" && r.toolName === "runner_click")).toBe(true);
	});
});

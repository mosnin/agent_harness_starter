export type HelmAgentId = 'codex' | 'claude' | 'gemini' | 'opencode' | 'grok' | 'hades';
export interface HelmAgent { id: HelmAgentId; name: string; installed: boolean; version?: string; auth: 'unknown'; error?: string }
export type HelmStatus = 'starting' | 'running' | 'needs_review' | 'verified' | 'failed' | 'cancelled' | 'interrupted';
export interface HelmCheck { command: string; args: string[] }
export interface HelmCheckResult extends HelmCheck { exitCode: number | null; output: string; passed: boolean; startedAt: number; finishedAt: number; outputTruncated?: boolean; revision: string }
export interface HelmStart { root: string; agent: HelmAgentId; prompt: string; title?: string; maxMinutes?: number; checks?: HelmCheck[]; context?: string; parentSession?: string; owner?: string; model?: string }
export interface HelmRun { id: string; root: string; workspace: string; branch: string; baseSha: string; agent: HelmAgentId; title: string; prompt: string; status: HelmStatus; createdAt: number; updatedAt: number; output: string; error?: string; exitCode?: number | null; checks?: HelmCheckResult[]; requestedChecks?: HelmCheck[]; contextSnapshot?: string; parentSession?: string; owner?: string; sessionId?: string; maxMinutes: number; workspaceIdentity?: {dev: number; ino: number; gitFileDigest: string}; sourceDirty: boolean; exclusions: string[]; verificationRevision?: string; outputTruncated?: boolean; model?: string }
export interface HelmDiff { text: string; files: string[]; revision: string; truncated: boolean; stale: boolean }
export interface HelmBuiltinInput { root: string; prompt: string; context?: string; model?: string; maxMinutes: number; parentSession?: string; owner?: string }
export interface HelmOptions { env?: NodeJS.ProcessEnv; runBuiltin?: (input: HelmBuiltinInput, signal: AbortSignal, onUpdate: (update: {sessionId?: string; output?: string}) => void) => Promise<{output: string; error?: string; sessionId?: string}> }

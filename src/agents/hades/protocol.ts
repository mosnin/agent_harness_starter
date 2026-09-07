/**
 * The Hades wire contract, as this harness needs it.
 *
 * This mirrors `@hades/protocol` v1.1.0 from the hades-browser repository.
 * The two ship as separate packages today, so the slice the harness actually
 * uses is restated here rather than pulled in as a dependency; once
 * `@hades/protocol` is published, both sides should import it and this file
 * should be deleted. The shapes below are wire-identical — changing one
 * without the other breaks the connection, which is why `PROTOCOL_VERSION`
 * is negotiated on every handshake.
 */

export const PROTOCOL_VERSION = "1.1.0" as const;

export interface Envelope<P = unknown> {
  id: string;
  protocol: string;
  kind: "request" | "response" | "event";
  type: string;
  at: number;
  payload: P;
  replyTo?: string;
  sessionId?: string;
}

export interface HandshakeRequest {
  protocol: string;
  client: "hades-browser" | "hades-desktop" | "hermes-harness";
  clientVersion: string;
  capabilities: string[];
  token?: string;
}

export interface HandshakeResponse {
  ok: boolean;
  sessionId: string;
  protocol: string;
  serverCapabilities: string[];
  error?: string;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  description?: string;
  allowedTools: string[];
  wallet?: { evmAddress?: string; solanaAddress?: string };
}

// ── Browser tools ───────────────────────────────────────────────────────────

export type BrowserToolName =
  | "browser.listWorkspaces"
  | "browser.listTabs"
  | "browser.openTab"
  | "browser.closeTab"
  | "browser.focusTab"
  | "browser.navigate"
  | "browser.readPage"
  | "browser.capture"
  | "browser.findInPage"
  | "collections.list"
  | "collections.read"
  | "collections.search"
  | "collections.addPage"
  | "collections.create"
  | "activity.digest"
  // ── Agent mode: seeing and acting in a page ──
  | "page.snapshot"
  | "page.extract"
  | "page.waitFor"
  | "page.click"
  | "page.hover"
  | "page.type"
  | "page.press"
  | "page.select"
  | "page.scroll"
  | "page.screenshot"
  // ── Shared memory ──
  | "context.write"
  | "context.search"
  | "context.list";

export interface ToolCall {
  callId: string;
  agentId: string;
  name: BrowserToolName;
  args: Record<string, unknown>;
  /** The run this call is part of, so the browser badges the tab and logs the step. */
  runId?: string;
}

export interface ToolResult<T = unknown> {
  callId: string;
  ok: boolean;
  value?: T;
  error?: {
    code:
      | "consent-denied"
      | "not-found"
      | "invalid-args"
      | "blocked-by-policy"
      | "timeout"
      | "internal"
      | "stale-ref"
      | "paused"
      | "user-declined";
    message: string;
  };
}

export interface BrowserTab {
  id: string;
  workspaceId: string;
  url: string;
  title: string;
  pinned: boolean;
  lastActiveAt: number;
}

export interface BrowserWorkspace {
  id: string;
  name: string;
  profileId: string;
  agentAccess: "full" | "metadata-only" | "none";
}

export interface PageContent {
  tabId: string;
  url: string;
  title: string;
  format: "text" | "markdown" | "html";
  content: string;
  truncated: boolean;
}

export interface CollectionSummary {
  id: string;
  name: string;
  description?: string;
  itemCount: number;
  agentReadable: boolean;
  updatedAt: number;
}

export interface CollectionSearchHit {
  collectionId: string;
  collectionName: string;
  item: {
    id: string;
    url: string;
    title: string;
    note?: string;
    tags: string[];
  };
  score: number;
  excerpt?: string;
}

export interface ActivityDigest {
  from: number;
  to: number;
  eventCount: number;
  topDomains: Array<{ domain: string; dwellMs: number; visits: number }>;
  searches: string[];
  narrative?: string;
}

export interface CaptureResult {
  id: string;
  kind: string;
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
  source?: { tabId?: string; url?: string; title?: string };
}

export interface CaptureSubmission {
  capture: CaptureResult;
  prompt?: string;
  agentId?: string;
}

/** browser -> agent: the person typed in the agent panel. */
export interface ChatSend {
  text: string;
  agentId?: string;
  /** The conversation to answer into; echo it on `agent.message`. */
  threadId?: string;
  context?: {
    tabs?: Array<{ id: string; url: string; title: string }>;
    collectionIds?: string[];
    docIds?: string[];
    selection?: string;
    contextIds?: string[];
  };
}

// ── Agent mode: the page as the agent sees it ───────────────────────────────

export interface PageNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  inputType?: string;
  options?: string[];
  state?: {
    disabled?: boolean;
    checked?: boolean;
    expanded?: boolean;
    focused?: boolean;
    required?: boolean;
    offscreen?: boolean;
  };
  rect?: { x: number; y: number; width: number; height: number };
  depth: number;
  autocomplete?: string;
}

export interface PageTree {
  snapshotId: number;
  tabId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; maxX: number; maxY: number };
  nodes: PageNode[];
  truncated: boolean;
  screenshot?: string;
}

export interface PageActionResult {
  ok: true;
  target?: Pick<PageNode, "ref" | "role" | "name">;
  url: string;
  navigated?: boolean;
}

export type PageKey =
  | "Enter"
  | "Tab"
  | "Escape"
  | "Backspace"
  | "Delete"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Space";

// ── Shared memory ───────────────────────────────────────────────────────────

export type ContextKind = "run" | "page" | "note" | "fact" | "preference";

export interface ContextRecord {
  id: string;
  kind: ContextKind;
  title: string;
  body: string;
  sourceUrl?: string;
  workspaceId?: string;
  createdBy: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ContextSearchHit {
  record: ContextRecord;
  score: number;
  excerpt?: string;
}

// ── Runs: a task, as the browser shows it ───────────────────────────────────

export type RunStepStatus = "running" | "done" | "failed" | "skipped";

export interface RunArtifact {
  kind:
    | "tab"
    | "collection"
    | "collection-item"
    | "note"
    | "easel"
    | "file"
    | "url"
    | "context";
  id?: string;
  label: string;
  url?: string;
}

/** agent -> browser */
export interface TaskStarted {
  runId: string;
  agentId: string;
  title: string;
  tabIds?: string[];
  workspaceId?: string;
  threadId?: string;
}

/** agent -> browser */
export interface TaskStep {
  runId: string;
  stepId: string;
  text: string;
  status: RunStepStatus;
  tool?: { name: string; callId?: string; ok?: boolean; summary?: string };
  artifacts?: RunArtifact[];
  error?: string;
  tabIds?: string[];
}

/** agent -> browser */
export interface TaskNeedsInput {
  runId: string;
  question: { prompt: string; options?: string[] };
}

/** agent -> browser */
export interface TaskFinished {
  runId: string;
  status: "done" | "failed" | "cancelled";
  summary?: string;
  artifacts?: RunArtifact[];
}

/** browser -> agent: the person paused, resumed, stopped or answered. */
export interface TaskControl {
  runId: string;
  action: "pause" | "resume" | "cancel" | "answer";
  answer?: string;
  reason?: "user-input" | "user-request" | "approval";
}

// ── Browser-side language work ──────────────────────────────────────────────

/**
 * A short, bounded piece of language work the browser asks the agent for.
 *
 * The browser cannot summarise a page or name a tab for itself, and running
 * that on a service of ours would mean page text leaving the machine to reach
 * somebody the user never chose. So it comes here instead, to the agent they
 * already connected — and with no agent connected the browser simply does not
 * offer the features.
 */
export type AiTask = "preview" | "ask" | "tidy-title" | "tidy-filename";

export interface AiCompleteRequest {
  task: AiTask;
  url?: string;
  title?: string;
  /** Page text, already truncated by the browser. */
  text?: string;
  question?: string;
  agentId?: string;
  maxWords?: number;
}

export interface AiCompleteResponse {
  ok: boolean;
  text: string;
  error?: string;
}

// ── Wallet ──────────────────────────────────────────────────────────────────

export type ChainFamily = "evm" | "solana";

export type AccountOwner =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string };

export interface SpendPolicy {
  ownerId: string;
  maxPerTransactionUsd: number;
  maxPerDayUsd: number;
  allowedTargets: string[];
  allowedChains: string[];
  autoApproveBelowUsd: number;
  requireApprovalAlways: boolean;
}

export const DEFAULT_AGENT_SPEND_POLICY: Omit<SpendPolicy, "ownerId"> = {
  maxPerTransactionUsd: 25,
  maxPerDayUsd: 100,
  allowedTargets: [],
  allowedChains: [],
  autoApproveBelowUsd: 0,
  requireApprovalAlways: true,
};

export interface SpendRecord {
  ownerId: string;
  at: number;
  usdValue: number;
  caip2: string;
  txHash?: string;
}

export const WALLET_ERROR = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  policyDenied: 4300,
  notSignable: 4301,
} as const;

export type PolicyVerdict =
  | { allowed: true; requiresApproval: boolean }
  | { allowed: false; reason: string; code: number };

/**
 * The same pure evaluation the browser runs, so an agent's budget means the
 * same thing on both sides of the connection.
 */
export function evaluateSpendPolicy(
  policy: SpendPolicy,
  request: { usdValue: number; caip2: string; target?: string },
  recentSpend: SpendRecord[],
  now: number = Date.now(),
): PolicyVerdict {
  if (
    policy.allowedChains.length > 0 &&
    !policy.allowedChains.includes(request.caip2)
  ) {
    return {
      allowed: false,
      reason: `Chain ${request.caip2} is not in this wallet's allowed chains.`,
      code: WALLET_ERROR.policyDenied,
    };
  }
  if (
    policy.allowedTargets.length > 0 &&
    request.target !== undefined &&
    !policy.allowedTargets.some(
      (target) => target.toLowerCase() === request.target!.toLowerCase(),
    )
  ) {
    return {
      allowed: false,
      reason: `Target ${request.target} is not in this wallet's allowlist.`,
      code: WALLET_ERROR.policyDenied,
    };
  }
  if (request.usdValue > policy.maxPerTransactionUsd) {
    return {
      allowed: false,
      reason: `$${request.usdValue.toFixed(2)} exceeds the per-transaction limit of $${policy.maxPerTransactionUsd.toFixed(2)}.`,
      code: WALLET_ERROR.policyDenied,
    };
  }
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const spentToday = recentSpend
    .filter(
      (record) => record.ownerId === policy.ownerId && record.at >= dayAgo,
    )
    .reduce((total, record) => total + record.usdValue, 0);
  if (spentToday + request.usdValue > policy.maxPerDayUsd) {
    return {
      allowed: false,
      reason: `This would put today's spend at $${(spentToday + request.usdValue).toFixed(2)}, over the $${policy.maxPerDayUsd.toFixed(2)} daily limit.`,
      code: WALLET_ERROR.policyDenied,
    };
  }
  return {
    allowed: true,
    requiresApproval:
      policy.requireApprovalAlways ||
      request.usdValue > policy.autoApproveBelowUsd,
  };
}

let counter = 0;

export function nextMessageId(prefix = "msg"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function isCompatible(
  remote: string,
  local: string = PROTOCOL_VERSION,
): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  const r = parse(remote);
  const l = parse(local);
  if (!r || !l) return false;
  if (r[1] !== l[1]) return false;
  return Number(r[2]) <= Number(l[2]);
}

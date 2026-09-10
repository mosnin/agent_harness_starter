export const ECOSYSTEM_IDS = [
  "stored",
  "operate",
  "scalar",
  "company-os",
  "cadre",
  "glove",
  "govern",
] as const;
export type EcosystemId = (typeof ECOSYSTEM_IDS)[number];
/** id is the human OAuth subject, never a workspace ID shared by different people. */
export interface PluginAccount {
  id: string;
  name: string;
  tenantId: string;
}
export interface PluginRecord {
  id: string;
  collection: string;
  title: string;
  updatedAt?: number;
  revision?: string;
  data: unknown;
}
export interface PluginWriteCapability {
  collection: string;
  operation: string;
  fields: string[];
  requiredFields?: string[];
  /** Consent required for this operation; defaults to the adapter's write scopes. */
  requiredScopes?: string[];
  /** Additional consent for specific fields, beyond the operation permission. */
  fieldScopes?: Record<string, string[]>;
  description: string;
  keyFormat: "uuid" | "url-safe";
}
export interface PluginCapabilities {
  /** The actual exposed data surface, not a claim of every product feature. */
  reads: string[];
  readScopes?: Record<string, string[]>;
  detail: "service" | "snapshot";
  writes: PluginWriteCapability[];
}
export interface PluginView {
  id: EcosystemId;
  name: string;
  origin: string;
  description: string;
  status:
    | "disconnected"
    | "connecting"
    | "connected"
    | "syncing"
    | "stale"
    | "error"
    | "unavailable";
  reason?: string;
  account?: PluginAccount;
  collections: string[];
  lastSyncedAt?: number;
  agentRead: boolean;
  agentWrite: boolean;
  scopes: string[];
  syncMode: "live" | "changes" | "polling" | "manual" | "unavailable";
  capabilities?: PluginCapabilities;
}
export interface PluginTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  clientId: string;
  refreshUncertain?: boolean;
}
export interface PluginConnection {
  profile: string;
  pluginId: EcosystemId;
  generation: string;
  status: PluginView["status"];
  reason?: string;
  account?: PluginAccount;
  agentRead: boolean;
  agentWrite: boolean;
  scopes: string[];
  lastSyncedAt?: number;
  cursor?: string;
}
export interface OAuthConfiguration {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  clientId?: string;
  scopes: string[];
  readScopes: string[];
  writeScopes: string[];
  resource?: string;
  /** Exact source-reviewed endpoint origins. Never derive trust from a discovery document. */
  allowedOrigins: string[];
}
export interface PluginPage {
  records: PluginRecord[];
  nextPage?: string;
  cursor?: string;
}
export interface PluginChanges {
  changes: Array<
    { record: PluginRecord } | { deleted: { collection: string; id: string } }
  >;
  cursor: string;
  hasMore?: boolean;
  resetSnapshot?: boolean;
}
export type PluginRequest = (
  url: string,
  init?: RequestInit,
) => Promise<unknown>;
export interface PluginAdapter {
  account(value: unknown): PluginAccount;
  initialize?(
    request: PluginRequest,
    account: PluginAccount,
    installationId: string,
  ): Promise<void>;
  snapshot(
    request: PluginRequest,
    account: PluginAccount,
    page?: string,
  ): Promise<PluginPage>;
  record?(
    request: PluginRequest,
    account: PluginAccount,
    collection: string,
    id: string,
  ): Promise<PluginRecord>;
  changes?(
    request: PluginRequest,
    account: PluginAccount,
    cursor: string,
    signal: AbortSignal,
  ): Promise<PluginChanges>;
  /** Only advertise product-owned, scoped, idempotent writes with an explicit optimistic revision. */
  write?(
    request: PluginRequest,
    account: PluginAccount,
    input: PluginWrite,
  ): Promise<unknown>;
  /** Product-owned SSE invalidations; account data is always re-read through scoped requests. */
  eventsEndpoint?: string;
}
export interface PluginDefinition {
  id: EcosystemId;
  name: string;
  origin: string;
  description: string;
  unavailableReason?: string;
  oauth?: OAuthConfiguration;
  adapter?: PluginAdapter;
  capabilities?: PluginCapabilities;
}
export interface PluginWrite {
  key: string;
  collection: string;
  id: string;
  operation: string;
  expectedRevision: string;
  data: Record<string, unknown>;
}
export interface PluginWriteReceipt {
  key: string;
  status: "pending" | "applied" | "rejected" | "unknown";
  fingerprint: string;
  result?: unknown;
  at: number;
  accountId?: string;
  tenantId?: string;
}
export interface PluginData {
  records: PluginRecord[];
  collections: string[];
  total: number;
  nextOffset?: number;
  status: PluginView["status"];
  lastSyncedAt?: number;
  account?: PluginAccount;
}

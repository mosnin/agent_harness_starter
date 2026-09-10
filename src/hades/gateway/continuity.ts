import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget } from "./connector";

/** A user's handle on one platform. */
export interface ChannelRef {
  platform: string;
  user: string;
  channel?: string;
}

/**
 * One person across every channel they reach us on. `links` are the per-platform
 * handles proven to be the same human; `sessionId` is the single conversation
 * that follows them from channel to channel; `lastSeen` is where to reach them
 * proactively.
 */
export interface Identity {
  id: string;
  links: ChannelRef[];
  sessionId?: string;
  lastSeen?: ChannelRef;
  updatedAt: number;
}

function refKey(ref: ChannelRef): string {
  return `${ref.platform}:${ref.user}`;
}

function sameRef(a: ChannelRef, b: ChannelRef): boolean {
  return a.platform === b.platform && a.user === b.user;
}

/**
 * Durable map of per-platform handles → canonical {@link Identity}. In-memory
 * base with a file-backed subclass; both share the same atomic-write persistence
 * seam the rest of Hades uses.
 */
export class InMemoryIdentityStore {
  protected identities = new Map<string, Identity>();
  /** platform:user → identity id */
  protected index = new Map<string, string>();

  /** Look up the identity a channel handle belongs to, if any. */
  resolve(ref: ChannelRef): Identity | undefined {
    const id = this.index.get(refKey(ref));
    return id ? this.identities.get(id) : undefined;
  }

  /** Resolve, or create a fresh identity seeded with this handle. */
  resolveOrCreate(ref: ChannelRef): Identity {
    const existing = this.resolve(ref);
    if (existing) return existing;
    const identity: Identity = {
      id: randomUUID(),
      links: [{ platform: ref.platform, user: ref.user, channel: ref.channel }],
      updatedAt: this.now(),
    };
    this.identities.set(identity.id, identity);
    this.index.set(refKey(ref), identity.id);
    this.persist();
    return identity;
  }

  get(id: string): Identity | undefined {
    return this.identities.get(id);
  }
  all(): Identity[] {
    return [...this.identities.values()];
  }
  size(): number {
    return this.identities.size;
  }

  /**
   * Attach a channel handle to an existing identity. If the handle already
   * belongs to a *different* identity, the two are merged into `identityId`
   * (links unioned, the emptier one's session preserved only if the target lacks
   * one). Returns the surviving identity.
   */
  link(identityId: string, ref: ChannelRef): Identity | undefined {
    const target = this.identities.get(identityId);
    if (!target) return undefined;
    const owner = this.resolve(ref);
    if (owner && owner.id !== target.id) {
      // Merge owner into target.
      for (const l of owner.links) {
        if (!target.links.some((t) => sameRef(t, l))) target.links.push(l);
        this.index.set(refKey(l), target.id);
      }
      if (!target.sessionId && owner.sessionId) target.sessionId = owner.sessionId;
      this.identities.delete(owner.id);
    } else if (!target.links.some((l) => sameRef(l, ref))) {
      target.links.push({ platform: ref.platform, user: ref.user, channel: ref.channel });
    }
    this.index.set(refKey(ref), target.id);
    target.updatedAt = this.now();
    this.persist();
    return target;
  }

  /** Persist the conversation id that follows this identity across channels. */
  setSession(identityId: string, sessionId: string): void {
    const i = this.identities.get(identityId);
    if (!i) return;
    i.sessionId = sessionId;
    i.updatedAt = this.now();
    this.persist();
  }

  /** Record where we last heard from this identity, for proactive follow-up. */
  touch(identityId: string, ref: ChannelRef): void {
    const i = this.identities.get(identityId);
    if (!i) return;
    i.lastSeen = { platform: ref.platform, user: ref.user, channel: ref.channel };
    i.updatedAt = this.now();
    this.persist();
  }

  protected now(): number {
    return Date.now();
  }
  protected persist(): void {}
}

export class FileIdentityStore extends InMemoryIdentityStore {
  constructor(private readonly path: string) {
    super();
    try {
      const arr = JSON.parse(readFileSync(path, "utf8")) as Identity[];
      for (const i of arr) {
        this.identities.set(i.id, i);
        for (const l of i.links) this.index.set(refKey(l), i.id);
      }
    } catch {
      /* fresh */
    }
  }
  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all()));
    renameSync(tmp, this.path);
  }
}

export interface LinkCodeOptions {
  /** Generate a short human-typable code. Injectable for deterministic tests. */
  generateCode?: () => string;
  /** Time source (ms). Injectable for deterministic tests. */
  now?: () => number;
  /** How long an issued code stays valid. Default 10 minutes. */
  ttlMs?: number;
}

/**
 * The "prove it's you on another channel" flow. From an already-known channel a
 * user requests a link code; typing that code from a new channel binds the new
 * handle to the same identity — so the conversation continues rather than
 * restarting. Codes are single-use and expire.
 */
export class IdentityLinker {
  private pending = new Map<string, { identityId: string; expiresAt: number }>();
  private readonly generateCode: () => string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly store: InMemoryIdentityStore,
    opts: LinkCodeOptions = {}
  ) {
    this.generateCode = opts.generateCode ?? (() => randomUUID().slice(0, 6).toUpperCase());
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  }

  /** Issue a one-time code that binds another channel to `identityId`. */
  issueLinkCode(identityId: string): string {
    const code = this.generateCode();
    this.pending.set(code, { identityId, expiresAt: this.now() + this.ttlMs });
    return code;
  }

  /**
   * Redeem a code from a new channel handle. Returns the surviving identity, or
   * null if the code is unknown/expired. The code is consumed on success.
   */
  redeemLinkCode(code: string, ref: ChannelRef): Identity | null {
    const entry = this.pending.get(code);
    if (!entry) return null;
    if (entry.expiresAt < this.now()) {
      this.pending.delete(code);
      return null;
    }
    this.pending.delete(code);
    return this.store.link(entry.identityId, ref) ?? null;
  }
}

/** Context the continuity router hands to the underlying handler. */
export interface ContinuityContext {
  identity: Identity;
  /** The single session id that follows this identity across channels. */
  sessionId: string;
  /** True when this identity's previous turn came from a different platform. */
  switchedChannel: boolean;
}

export type ContinuityHandler = (msg: InboundMessage, ctx: ContinuityContext) => Promise<OutboundReply>;

export interface ContinuityRouterOptions {
  /** Mint a session id when an identity has none yet. Default randomUUID. */
  newSessionId?: () => string;
}

/**
 * Wraps a message handler so one identity keeps one conversation no matter which
 * channel it arrives on. It resolves (or creates) the canonical identity for the
 * inbound handle, ensures a durable `sessionId`, flags a cross-channel switch,
 * and records `lastSeen` for proactive replies — then delegates. The wrapped
 * handler is a normal `(msg) => reply`, so it drops straight into
 * {@link ConnectorHub}.
 */
export class ContinuityRouter {
  private readonly newSessionId: () => string;

  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly handler: ContinuityHandler,
    opts: ContinuityRouterOptions = {}
  ) {
    this.newSessionId = opts.newSessionId ?? (() => randomUUID());
  }

  /** The `(msg) => reply` a ConnectorHub can call directly. */
  handle = async (msg: InboundMessage): Promise<OutboundReply> => {
    const ref: ChannelRef = { platform: msg.platform, user: msg.user, channel: msg.channel };
    const identity = this.store.resolveOrCreate(ref);

    const switchedChannel = !!identity.lastSeen && identity.lastSeen.platform !== ref.platform;

    let sessionId = identity.sessionId;
    if (!sessionId) {
      sessionId = this.newSessionId();
      this.store.setSession(identity.id, sessionId);
    }

    const reply = await this.handler(msg, { identity, sessionId, switchedChannel });
    this.store.touch(identity.id, ref);
    return reply;
  };

  /** Where to reach an identity now (its most recent channel), as a target. */
  deliveryTargetFor(identityId: string): { platform: string; target: DeliveryTarget } | undefined {
    const i = this.store.get(identityId);
    const ref = i?.lastSeen ?? i?.links[0];
    if (!ref) return undefined;
    return { platform: ref.platform, target: { user: ref.user, channel: ref.channel } };
  }
}

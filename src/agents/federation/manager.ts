import { generateKeyPair, sign, verify, canonicalize, toHex, fromHex } from "./crypto";
import { PeerRegistry } from "./peer-registry";
import type { FederationConfig, FederationMessage, FederationPeer, SignedPayload } from "./types";
import { randomUUID } from "crypto";

export class FederationManager {
  private config: FederationConfig;
  private registry: PeerRegistry;
  private privateKey?: Uint8Array;
  private publicKey?: Uint8Array;

  constructor(config: FederationConfig) {
    this.config = config;
    this.registry = new PeerRegistry();
  }

  // Initialize key pair (call before using sign/verify)
  async initialize(): Promise<{ publicKey: string; peerId: string }> {
    const kp = await generateKeyPair();
    this.privateKey = kp.privateKey;
    this.publicKey = kp.publicKey;
    return {
      publicKey: toHex(this.publicKey),
      peerId: this.config.peerId,
    };
  }

  // Add and trust a peer by their public key
  addPeer(id: string, name: string, publicKeyHex: string): FederationPeer {
    const publicKey = fromHex(publicKeyHex);
    const peer = this.registry.addPeer({ id, name, publicKey });
    this.config.onPeerJoin?.(peer);
    return peer;
  }

  trustPeer(peerId: string): void {
    this.registry.trustPeer(peerId);
  }

  revokePeer(peerId: string): void {
    this.registry.revokePeer(peerId);
    this.config.onPeerRevoke?.(peerId);
  }

  // Sign a payload for sending to a peer
  async createSignedMessage(
    type: FederationMessage["type"],
    toPeerId: string,
    payload: unknown
  ): Promise<FederationMessage> {
    if (!this.privateKey) {
      throw new Error("FederationManager not initialized. Call initialize() first.");
    }

    const id = randomUUID();
    const nonce = randomUUID();
    const timestamp = Date.now();
    const fromPeerId = this.config.peerId;

    const canonical = canonicalize({ id, type, fromPeerId, toPeerId, payload, timestamp, nonce });
    const signature = await sign(canonical, this.privateKey);

    return { id, type, fromPeerId, toPeerId, payload, timestamp, signature, nonce };
  }

  // Verify a received message — throws if signature invalid or peer untrusted
  async verifyMessage(msg: FederationMessage): Promise<FederationPeer> {
    const peer = this.registry.getPeer(msg.fromPeerId);

    if (!peer) {
      throw new Error(`Unknown peer: ${msg.fromPeerId}`);
    }
    if (peer.status === "revoked") {
      throw new Error(`Peer is revoked: ${msg.fromPeerId}`);
    }
    if (peer.status === "untrusted") {
      throw new Error(`Peer is untrusted: ${msg.fromPeerId}`);
    }

    const { id, type, fromPeerId, toPeerId, payload, timestamp, nonce } = msg;
    const canonical = canonicalize({ id, type, fromPeerId, toPeerId, payload, timestamp, nonce });

    const valid = await verify(msg.signature, canonical, peer.publicKey);
    if (!valid) {
      throw new Error(`Invalid signature from peer ${msg.fromPeerId}`);
    }

    this.registry.updateLastSeen(msg.fromPeerId);
    return peer;
  }

  // Higher-level: sign arbitrary payload for external delivery
  async signPayload(payload: unknown): Promise<SignedPayload> {
    if (!this.privateKey || !this.publicKey) {
      throw new Error("FederationManager not initialized. Call initialize() first.");
    }

    const timestamp = Date.now();
    const nonce = randomUUID();
    const canonical = canonicalize({ payload, timestamp, nonce });
    const signature = await sign(canonical, this.privateKey);

    return {
      payload,
      signature: toHex(signature),
      publicKey: toHex(this.publicKey),
      timestamp,
      nonce,
    };
  }

  // Verify an externally received signed payload given a public key
  async verifyPayload(signed: SignedPayload, expectedPublicKeyHex: string): Promise<boolean> {
    if (signed.publicKey !== expectedPublicKeyHex) {
      return false;
    }

    const { payload, timestamp, nonce } = signed;
    const canonical = canonicalize({ payload, timestamp, nonce });
    const signature = fromHex(signed.signature);
    const publicKey = fromHex(signed.publicKey);

    return verify(signature, canonical, publicKey);
  }

  // List trusted peers
  getTrustedPeers(): FederationPeer[] {
    return this.registry.getTrustedPeers();
  }

  // Public key as hex (for sharing with peers)
  getPublicKeyHex(): string {
    if (!this.publicKey) {
      throw new Error("FederationManager not initialized. Call initialize() first.");
    }
    return toHex(this.publicKey);
  }
}

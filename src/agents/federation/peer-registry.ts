import type { FederationPeer } from "./types";

export class PeerRegistry {
  private peers: Map<string, FederationPeer> = new Map();

  addPeer(peer: Omit<FederationPeer, "status" | "addedAt">): FederationPeer {
    const fullPeer: FederationPeer = {
      ...peer,
      status: "unknown",
      addedAt: Date.now(),
    };
    this.peers.set(peer.id, fullPeer);
    return fullPeer;
  }

  trustPeer(peerId: string): FederationPeer {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer not found: ${peerId}`);
    }
    peer.status = "trusted";
    return peer;
  }

  revokePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer not found: ${peerId}`);
    }
    peer.status = "revoked";
  }

  getPeer(peerId: string): FederationPeer | undefined {
    return this.peers.get(peerId);
  }

  getTrustedPeers(): FederationPeer[] {
    return Array.from(this.peers.values()).filter((p) => p.status === "trusted");
  }

  isTrusted(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    return peer?.status === "trusted";
  }

  updateLastSeen(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastSeenAt = Date.now();
    }
  }

  getAll(): FederationPeer[] {
    return Array.from(this.peers.values());
  }
}

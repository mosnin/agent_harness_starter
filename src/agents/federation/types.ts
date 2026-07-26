export type PeerStatus = "unknown" | "trusted" | "untrusted" | "revoked";
export type FederationMessageType = "handshake" | "task" | "result" | "heartbeat" | "revoke";

export interface FederationPeer {
  id: string;                    // unique peer identifier
  name: string;
  publicKey: Uint8Array;         // Ed25519 public key (32 bytes)
  status: PeerStatus;
  addedAt: number;
  lastSeenAt?: number;
  metadata?: Record<string, unknown>;
}

export interface FederationMessage {
  id: string;
  type: FederationMessageType;
  fromPeerId: string;
  toPeerId: string | "broadcast";
  payload: unknown;
  timestamp: number;
  signature: Uint8Array;         // Ed25519 signature of canonical form
  nonce: string;                 // prevent replay attacks (randomUUID)
}

export interface SignedPayload {
  payload: unknown;
  signature: string;             // hex-encoded
  publicKey: string;             // hex-encoded
  timestamp: number;
  nonce: string;
}

export interface FederationConfig {
  peerId: string;
  peerName: string;
  onMessage?: (msg: FederationMessage, peer: FederationPeer) => void;
  onPeerJoin?: (peer: FederationPeer) => void;
  onPeerRevoke?: (peerId: string) => void;
}

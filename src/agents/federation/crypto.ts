import * as ed from "@noble/ed25519";

// Generate a new Ed25519 key pair
export async function generateKeyPair(): Promise<{
  privateKey: Uint8Array;  // 32 bytes
  publicKey: Uint8Array;   // 32 bytes
}> {
  const privateKey = ed.utils.randomSecretKey();  // 32 random bytes
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

// Sign a message with a private key
export async function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey);
}

// Verify a signature
export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  return ed.verifyAsync(signature, message, publicKey);
}

// Canonical serialization for signing (stable JSON)
export function canonicalize(obj: unknown): Uint8Array {
  const sorted = sortKeys(obj);
  const json = JSON.stringify(sorted);
  return new TextEncoder().encode(json);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// Hex encoding/decoding utilities
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

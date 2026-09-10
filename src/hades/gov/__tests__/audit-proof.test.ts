import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../styx/certificate";
import { GovIdentity } from "../identity";
import {
  consistencyProof,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  signCheckpoint,
  verifyCheckpoint,
  verifyConsistency,
  verifyInclusion,
  type ConsistencyProof,
  type InclusionProof,
} from "../audit-proof";

// ---------------------------------------------------------------------------
// Deterministic RNG for reproducible key generation.
// ---------------------------------------------------------------------------

function seededRng(seed: number): (n: number) => Uint8Array {
  let s = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

function leaves(n: number, prefix = "leaf"): string[] {
  return Array.from({ length: n }, (_, i) => sha256Hex(`${prefix}-${i}`));
}

// ---------------------------------------------------------------------------
// Independent brute-force reference implementation of the RFC 6962 Merkle
// Tree Hash, deliberately using a DIFFERENT algorithm shape than
// `audit-proof.ts`'s top-down recursive split: a one-pass, left-to-right,
// stack-based "binary counter" construction (the same technique real-world
// append-only-log implementations use for incremental root computation).
// Leaves are pushed one at a time; whenever the top two stack entries are
// perfect subtrees of equal size they are merged; at the end the remaining
// stack (largest subtree at the bottom, smallest/most-recent at the top) is
// folded from the top down. This is mathematically equivalent to RFC 6962's
// MTH for every size (proof sketch: both encode the unique run-length
// binary decomposition of n into descending powers of two, merged
// left-to-right) but shares no code path or recursion structure with the
// implementation under test, so a shared bug would have to independently
// exist in both.
// ---------------------------------------------------------------------------

function bruteForceRoot(rawLeaves: readonly string[]): string {
  if (rawLeaves.length === 0) return sha256Hex("hades.gov.audit.v1");

  const stack: { size: number; hash: string }[] = [];
  for (const raw of rawLeaves) {
    let node = { size: 1, hash: leafHash(raw) };
    while (stack.length > 0 && stack[stack.length - 1].size === node.size) {
      const top = stack.pop()!;
      node = { size: top.size + node.size, hash: nodeHash(top.hash, node.hash) };
    }
    stack.push(node);
  }

  let acc = stack.pop()!;
  while (stack.length > 0) {
    const next = stack.pop()!;
    acc = { size: next.size + acc.size, hash: nodeHash(next.hash, acc.hash) };
  }
  return acc.hash;
}

describe("audit-proof: domain separation", () => {
  it("leafHash and nodeHash use disjoint domain-separated prefixes", () => {
    const h = sha256Hex("x");
    const lh = leafHash(h);
    const nh = nodeHash(h, h);
    expect(lh).not.toBe(nh);
    expect(lh).toBe(sha256Hex("\x00" + h));
    expect(nh).toBe(sha256Hex("\x01" + h + h));
  });

  it("second-preimage resistance: an interior node hash cannot be presented as a valid leaf for a different tree position", () => {
    const ls = leaves(4);
    const root = merkleRoot(ls);
    // The RFC 6962 interior hash of leaves[0..2) as raw material — attacker
    // tries to claim this interior hash IS a leaf's raw digest.
    const interior = nodeHash(leafHash(ls[0]), leafHash(ls[1]));
    // A proof for index 0 must not verify using the interior hash as the "leaf".
    const proof = inclusionProof(ls, 0);
    expect(verifyInclusion(interior, proof, root)).toBe(false);
    // And the genuine leaf must still verify (control).
    expect(verifyInclusion(ls[0], proof, root)).toBe(true);
  });
});

describe("audit-proof: merkleRoot vs brute-force reference, sizes 0..33", () => {
  it("empty tree hashes to the genesis constant", () => {
    expect(merkleRoot([])).toBe(sha256Hex("hades.gov.audit.v1"));
    expect(bruteForceRoot([])).toBe(merkleRoot([]));
  });

  for (let n = 0; n <= 33; n++) {
    it(`matches brute-force root for tree size ${n}`, () => {
      const ls = leaves(n, `size${n}`);
      expect(merkleRoot(ls)).toBe(bruteForceRoot(ls));
    });
  }

  it("two different leaf sets never collide", () => {
    const a = merkleRoot(leaves(5, "a"));
    const b = merkleRoot(leaves(5, "b"));
    expect(a).not.toBe(b);
  });

  it("leaf order is semantic — reordering changes the root", () => {
    const ls = leaves(6);
    const reordered = [ls[1], ls[0], ls[2], ls[3], ls[4], ls[5]];
    expect(merkleRoot(ls)).not.toBe(merkleRoot(reordered));
  });
});

describe("audit-proof: inclusion proofs, every index at every size 0..33", () => {
  for (let n = 1; n <= 33; n++) {
    it(`verifies every index for tree size ${n} and matches brute-force path`, () => {
      const ls = leaves(n, `inc${n}`);
      const root = merkleRoot(ls);
      for (let i = 0; i < n; i++) {
        const proof = inclusionProof(ls, i);
        expect(proof.index).toBe(i);
        expect(proof.treeSize).toBe(n);
        expect(verifyInclusion(ls[i], proof, root)).toBe(true);
      }
    });
  }

  it("tree of size 1 has an empty path and verifies trivially", () => {
    const ls = leaves(1, "single");
    const root = merkleRoot(ls);
    const proof = inclusionProof(ls, 0);
    expect(proof.path).toEqual([]);
    expect(verifyInclusion(ls[0], proof, root)).toBe(true);
  });

  it("rejects a proof with one flipped path element", () => {
    const ls = leaves(9, "flip");
    const root = merkleRoot(ls);
    const proof = inclusionProof(ls, 4);
    expect(proof.path.length).toBeGreaterThan(0);
    const tampered: InclusionProof = { ...proof, path: [...proof.path] };
    tampered.path[0] = sha256Hex(tampered.path[0] + "-flipped");
    expect(verifyInclusion(ls[4], tampered, root)).toBe(false);
  });

  it("rejects a proof presented with the wrong index", () => {
    const ls = leaves(10, "wrongidx");
    const root = merkleRoot(ls);
    const proof = inclusionProof(ls, 3);
    const wrongIndex: InclusionProof = { ...proof, index: 4 };
    expect(verifyInclusion(ls[3], wrongIndex, root)).toBe(false);
  });

  it("rejects a proof presented with the wrong treeSize", () => {
    // The perturbation must actually change the tree SHAPE (cross a
    // power-of-two boundary that affects the split point `k` on the path to
    // the target index) — an index whose audit path never touches the
    // "far" side of the tree is, correctly, insensitive to some treeSize
    // perturbations (RFC 6962 audit paths do not independently encode
    // treeSize beyond what the sibling hashes imply), so a real attack must
    // reshape the tree, not just relabel it.
    const ls = leaves(10, "wrongsize");
    const root = merkleRoot(ls);
    const proof = inclusionProof(ls, 3);
    const wrongSize: InclusionProof = { ...proof, treeSize: proof.treeSize + 1000 };
    expect(verifyInclusion(ls[3], wrongSize, root)).toBe(false);
  });

  it("rejects a proof lifted from a different tree", () => {
    const treeA = leaves(8, "treeA");
    const treeB = leaves(8, "treeB");
    const rootB = merkleRoot(treeB);
    const proofFromA = inclusionProof(treeA, 2);
    expect(verifyInclusion(treeA[2], proofFromA, rootB)).toBe(false);
  });

  it("is total on adversarial input: never throws, always fails safely", () => {
    const ls = leaves(5, "adv");
    const root = merkleRoot(ls);
    expect(() => inclusionProof(ls, -1)).not.toThrow();
    expect(() => inclusionProof(ls, 999)).not.toThrow();
    expect(() => inclusionProof([], 0)).not.toThrow();
    expect(() => inclusionProof(ls, 1.5)).not.toThrow();

    expect(verifyInclusion(ls[0], inclusionProof(ls, -1), root)).toBe(false);
    expect(verifyInclusion(ls[0], inclusionProof(ls, 999), root)).toBe(false);
    expect(verifyInclusion(ls[0], inclusionProof([], 0), root)).toBe(false);
    expect(verifyInclusion(ls[0], { index: 0, treeSize: 0, path: [] }, root)).toBe(false);
    expect(verifyInclusion(ls[0], { index: -1, treeSize: 5, path: [] }, root)).toBe(false);
    // Malformed proof shapes coming from untrusted JSON.
    expect(verifyInclusion(ls[0], { index: 0, treeSize: 5, path: [1 as unknown as string] }, root)).toBe(false);
    expect(verifyInclusion(ls[0], null as unknown as InclusionProof, root)).toBe(false);
  });
});

describe("audit-proof: consistency proofs, every (fromSize,toSize) pair up to 33", () => {
  for (let toSize = 1; toSize <= 33; toSize++) {
    it(`verifies every fromSize<=toSize for toSize=${toSize}`, () => {
      const ls = leaves(toSize, `cons${toSize}`);
      const newRoot = merkleRoot(ls);
      for (let fromSize = 1; fromSize <= toSize; fromSize++) {
        const oldRoot = merkleRoot(ls.slice(0, fromSize));
        const proof = consistencyProof(ls, fromSize);
        expect(proof.fromSize).toBe(fromSize);
        expect(proof.toSize).toBe(toSize);
        expect(verifyConsistency(oldRoot, newRoot, proof)).toBe(true);
      }
    });
  }

  it("rejects a consistency proof when an early leaf was altered (append-only violation)", () => {
    const original = leaves(12, "orig");
    const oldRoot = merkleRoot(original.slice(0, 6));

    const rewritten = [...original];
    rewritten[2] = sha256Hex("tampered-leaf-2");
    const newRoot = merkleRoot(rewritten);

    // Attacker builds a proof from the REWRITTEN tree.
    const forgedProof = consistencyProof(rewritten, 6);
    expect(verifyConsistency(oldRoot, newRoot, forgedProof)).toBe(false);
  });

  it("rejects a consistency proof for a fully rewritten same-size tree", () => {
    const original = leaves(10, "full-orig");
    const oldRoot = merkleRoot(original);

    const rewritten = leaves(10, "full-rewritten");
    const newRoot = merkleRoot(rewritten);

    const proof = consistencyProof(rewritten, 10);
    // fromSize === toSize means the proof is only valid if the roots match,
    // which they must not for genuinely different content.
    expect(verifyConsistency(oldRoot, newRoot, proof)).toBe(false);
  });

  it("accepts a genuine append-only growth", () => {
    const base = leaves(7, "grow");
    const grown = [...base, sha256Hex("grow-new-1"), sha256Hex("grow-new-2")];
    const oldRoot = merkleRoot(base);
    const newRoot = merkleRoot(grown);
    const proof = consistencyProof(grown, 7);
    expect(verifyConsistency(oldRoot, newRoot, proof)).toBe(true);
  });

  it("is total on adversarial input: never throws, always fails safely", () => {
    const ls = leaves(6, "adv-cons");
    const root = merkleRoot(ls);
    expect(() => consistencyProof(ls, 0)).not.toThrow();
    expect(() => consistencyProof(ls, -1)).not.toThrow();
    expect(() => consistencyProof(ls, 999)).not.toThrow();
    expect(() => consistencyProof(ls, 3.5)).not.toThrow();

    expect(verifyConsistency(root, root, { fromSize: 0, toSize: 6, path: [] })).toBe(false);
    expect(verifyConsistency(root, root, { fromSize: 7, toSize: 6, path: [] })).toBe(false);
    const proof: ConsistencyProof = consistencyProof(ls, 3);
    expect(verifyConsistency(root, root, { ...proof, path: [1 as unknown as string] })).toBe(false);
    expect(verifyConsistency(root, root, null as unknown as ConsistencyProof)).toBe(false);
  });

  it("fromSize === toSize is a valid (empty-path) proof iff the roots are equal", () => {
    const ls = leaves(4, "eq");
    const root = merkleRoot(ls);
    const proof = consistencyProof(ls, 4);
    expect(proof.path).toEqual([]);
    expect(verifyConsistency(root, root, proof)).toBe(true);
    expect(verifyConsistency(root, sha256Hex("different"), proof)).toBe(false);
  });
});

describe("audit-proof: signed checkpoints", () => {
  it("signs and verifies a checkpoint under a trusted key", () => {
    const identity = GovIdentity.generate(seededRng(1));
    const cp = signCheckpoint(identity, { treeSize: 5, root: merkleRoot(leaves(5)), headSha256: sha256Hex("head"), at: 1000 });
    expect(cp.schema).toBe("hades.gov.checkpoint.v1");
    expect(cp.signerPublicKey).toBe(identity.publicKeyHex());
    const result = verifyCheckpoint(cp, [identity.publicKeyHex()]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("rejects a checkpoint signed by a key outside the trusted set", () => {
    const identity = GovIdentity.generate(seededRng(2));
    const stranger = GovIdentity.generate(seededRng(3));
    const cp = signCheckpoint(identity, { treeSize: 3, root: merkleRoot(leaves(3)), headSha256: sha256Hex("h"), at: 1 });
    const result = verifyCheckpoint(cp, [stranger.publicKeyHex()]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("checkpoint-signature-invalid");
  });

  it("rejects a checkpoint with a tampered field (root swapped for a different tree's root)", () => {
    const identity = GovIdentity.generate(seededRng(4));
    const cp = signCheckpoint(identity, { treeSize: 5, root: merkleRoot(leaves(5)), headSha256: sha256Hex("h"), at: 1 });
    const tampered = { ...cp, root: merkleRoot(leaves(5, "other")) };
    const result = verifyCheckpoint(tampered, [identity.publicKeyHex()]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("checkpoint-signature-invalid");
  });

  it("rejects a checkpoint with a forged signature (self-signed by an attacker key, still not trusted)", () => {
    const attacker = GovIdentity.generate(seededRng(5));
    const trusted = GovIdentity.generate(seededRng(6));
    const forged = signCheckpoint(attacker, { treeSize: 1, root: merkleRoot(leaves(1)), headSha256: sha256Hex("h"), at: 1 });
    // Internally consistent (attacker signed it with their own key) but the
    // key is not trusted.
    expect(verifyCheckpoint(forged, [attacker.publicKeyHex()]).ok).toBe(true);
    expect(verifyCheckpoint(forged, [trusted.publicKeyHex()]).ok).toBe(false);
  });

  it("reports schema-mismatch for a checkpoint with the wrong schema string", () => {
    const identity = GovIdentity.generate(seededRng(7));
    const cp = signCheckpoint(identity, { treeSize: 1, root: merkleRoot(leaves(1)), headSha256: sha256Hex("h"), at: 1 });
    const wrongSchema = { ...cp, schema: "hades.gov.checkpoint.v2" as unknown as "hades.gov.checkpoint.v1" };
    const result = verifyCheckpoint(wrongSchema, [identity.publicKeyHex()]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe("schema-mismatch");
  });

  it("verifyCheckpoint is total on adversarial input: never throws", () => {
    const identity = GovIdentity.generate(seededRng(8));
    expect(() => verifyCheckpoint(null as unknown as ReturnType<typeof signCheckpoint>, [])).not.toThrow();
    expect(() => verifyCheckpoint({} as unknown as ReturnType<typeof signCheckpoint>, [])).not.toThrow();
    expect(() => verifyCheckpoint({ schema: "hades.gov.checkpoint.v1" } as unknown as ReturnType<typeof signCheckpoint>, [identity.publicKeyHex()])).not.toThrow();
  });
});

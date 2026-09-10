import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { UserModel, FileUserModel, reconcile, deriveTraitsFromMemories } from "../learning/user-model";
import { InMemoryMemoryStore } from "../memory/store";
import type { UserTrait } from "../learning/user-model";

function trait(partial: Partial<UserTrait>): UserTrait {
  return { attribute: "a", value: "v", confidence: 0.5, evidence: [], updatedAt: 0, revisions: 0, ...partial };
}

describe("reconcile (dialectic)", () => {
  it("creates, reinforces, revises, or ignores", () => {
    expect(reconcile(undefined, { attribute: "name", value: "Sam" })).toBe("created");
    expect(reconcile(trait({ value: "Sam", confidence: 0.6 }), { attribute: "name", value: "Sam" })).toBe("reinforced");
    expect(reconcile(trait({ value: "Sam", confidence: 0.5 }), { attribute: "name", value: "Alex", confidence: 0.9 })).toBe("revised");
    expect(reconcile(trait({ value: "Sam", confidence: 0.9 }), { attribute: "name", value: "Alex", confidence: 0.3 })).toBe("ignored");
  });
});

describe("UserModel", () => {
  it("reinforces confidence on repeated agreement", () => {
    const m = new UserModel();
    m.assert({ attribute: "editor", value: "vscode", confidence: 0.5 });
    const before = m.get("editor")!.confidence;
    m.assert({ attribute: "editor", value: "vscode", confidence: 0.5 });
    expect(m.get("editor")!.confidence).toBeGreaterThan(before);
  });

  it("revises a belief when stronger evidence conflicts", () => {
    const m = new UserModel();
    m.assert({ attribute: "location", value: "Berlin", confidence: 0.5 });
    m.assert({ attribute: "location", value: "Munich", confidence: 0.9, evidence: "moved recently" });
    const t = m.get("location")!;
    expect(t.value).toBe("Munich");
    expect(t.revisions).toBe(1);
  });

  it("ignores weaker conflicting evidence", () => {
    const m = new UserModel();
    m.assert({ attribute: "location", value: "Berlin", confidence: 0.9 });
    m.assert({ attribute: "location", value: "Paris", confidence: 0.2 });
    expect(m.get("location")!.value).toBe("Berlin");
  });

  it("builds from memories and describes the user", () => {
    const mem = new InMemoryMemoryStore();
    mem.add({ fact: "The user's name is Sam", salience: 0.95 });
    mem.add({ fact: "The user prefers dark mode", salience: 0.8 });
    const m = new UserModel();
    m.ingest(mem.all());
    expect(m.get("name")?.value).toContain("Sam");
    expect(m.describe()).toContain("name");
  });

  it("derives traits offline from memory facts", () => {
    const derived = deriveTraitsFromMemories([
      { id: "1", fact: "The user is based in Tokyo", salience: 0.7, tags: [], createdAt: 0, accessCount: 0 },
    ]);
    expect(derived.find((d) => d.attribute === "location")?.value).toContain("Tokyo");
  });
});

describe("FileUserModel", () => {
  it("persists the model across sessions", () => {
    const path = join(tmpdir(), `hades-user-${process.pid}-${Math.floor(performance.now())}.json`);
    try {
      const a = new FileUserModel(path);
      a.assert({ attribute: "name", value: "Sam", confidence: 0.9 });
      const b = new FileUserModel(path);
      expect(b.get("name")?.value).toBe("Sam");
    } finally {
      rmSync(path, { force: true });
    }
  });
});

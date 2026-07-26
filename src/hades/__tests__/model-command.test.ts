import { describe, it, expect } from "vitest";
import { ModelRegistry } from "../models/registry";
import { InMemoryModelSelection } from "../models/selection";
import { ModelCommand } from "../models/command";

function makeRegistry(): ModelRegistry {
  return new ModelRegistry()
    .register(
      { id: "claude-opus-x", provider: "anthropic", displayName: "Opus X", aliases: ["opus"], contextWindow: 200000 },
      { default: true }
    )
    .register({ id: "claude-haiku-x", provider: "anthropic", displayName: "Haiku X", aliases: ["haiku"] })
    .register({ id: "gpt-z", provider: "openai", displayName: "GPT Z", aliases: ["z"] });
}

describe("ModelRegistry", () => {
  it("resolves by id and alias, groups by provider, marks a default", () => {
    const reg = makeRegistry();
    expect(reg.resolve("claude-opus-x")?.id).toBe("claude-opus-x");
    expect(reg.resolve("opus")?.id).toBe("claude-opus-x");
    expect(reg.resolve("OPUS")?.id).toBe("claude-opus-x"); // case-insensitive alias
    expect(reg.resolve("nope")).toBeUndefined();
    expect(reg.getDefault()?.id).toBe("claude-opus-x");
    expect([...reg.byProvider().keys()]).toEqual(["anthropic", "openai"]);
  });
});

describe("ModelCommand", () => {
  it("defaults to the registry default when nothing is selected", () => {
    const cmd = new ModelCommand(makeRegistry(), new InMemoryModelSelection());
    expect(cmd.active()?.id).toBe("claude-opus-x");
    expect(cmd.current().lines[0]).toContain("claude-opus-x");
  });

  it("switches selection by alias and persists it", () => {
    const sel = new InMemoryModelSelection(() => 5);
    const cmd = new ModelCommand(makeRegistry(), sel);
    const res = cmd.use("haiku");
    expect(res.ok).toBe(true);
    expect(res.active?.id).toBe("claude-haiku-x");
    expect(sel.get()).toBe("claude-haiku-x");
    expect(cmd.active()?.id).toBe("claude-haiku-x");
  });

  it("rejects an unknown model without changing selection", () => {
    const sel = new InMemoryModelSelection();
    const cmd = new ModelCommand(makeRegistry(), sel);
    const res = cmd.use("mystery");
    expect(res.ok).toBe(false);
    expect(res.lines[0]).toContain("Unknown model");
    expect(sel.get()).toBeUndefined();
  });

  it("marks the active model in the list", () => {
    const cmd = new ModelCommand(makeRegistry(), new InMemoryModelSelection());
    cmd.use("z");
    const list = cmd.list();
    const starred = list.lines.find((l) => l.includes("* "));
    expect(starred).toContain("gpt-z");
  });

  it("falls back to default when the persisted model is no longer registered", () => {
    const sel = new InMemoryModelSelection();
    sel.set("retired-model");
    const cmd = new ModelCommand(makeRegistry(), sel);
    expect(cmd.active()?.id).toBe("claude-opus-x"); // graceful fallback
  });

  it("dispatches subcommands via run(), incl. bare-id shorthand", () => {
    const sel = new InMemoryModelSelection();
    const cmd = new ModelCommand(makeRegistry(), sel);
    expect(cmd.run([]).ok).toBe(true); // list
    expect(cmd.run(["use", "haiku"]).active?.id).toBe("claude-haiku-x");
    expect(cmd.run(["opus"]).active?.id).toBe("claude-opus-x"); // shorthand
    expect(cmd.run(["current"]).lines[0]).toContain("claude-opus-x");
  });
});

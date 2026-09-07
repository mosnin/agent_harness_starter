import { describe, expect, it } from "vitest";
import { toolActivityCards } from "../ui/tool-activity";
const call = (status: string, input: string, extra: Record<string, unknown> = {}) => ({ kind: "desktop.tool", tool: "file_ops", input, status, ...extra });
describe("derived native tool activity cards", () => {
  it("groups three sequential repeated tools into three completed calls without changing the journal", () => {
    const events = ["a", "b", "c"].flatMap(path => [call("running", JSON.stringify({ op: "read", path })), call("done", JSON.stringify({ path, op: "read" }), { ok: true, output: "Contents " + path })]);
    const saved = JSON.stringify(events), cards = toolActivityCards(events, false);
    expect(cards).toHaveLength(3); expect(cards.map(card => card.status)).toEqual(["Completed", "Completed", "Completed"]);
    expect(cards.map(card => card.output)).toEqual(["Contents a", "Contents b", "Contents c"]);
    expect(JSON.stringify(events)).toBe(saved);
  });
  it("groups decoded JSON formatting and escaped values with their canonical start", () => {
    const cards = toolActivityCards([call("running", '{"op":"write","path":"a"}'), call("done", '{ "path": "a", "op": "wr\\u0069te" }', { ok: false, output: "Not approved" })], false);
    expect(cards).toEqual([{ tool: "file_ops", input: '{"op":"write","path":"a"}', output: "Not approved", status: "Failed" }]);
  });
  it("keeps identical repeated calls separate and only the genuinely unsettled call running", () => {
    const cards = toolActivityCards([call("running", "same"), call("done", "same", { ok: true, output: "first" }), call("running", "same")], true);
    expect(cards).toHaveLength(2); expect(cards.map(card => card.status)).toEqual(["Completed", "Running"]);
  });
  it("keeps unmatched results instead of completing a different input", () => {
    const cards = toolActivityCards([call("running", "old"), call("done", "other", { ok: false, output: "Invalid input" })], false);
    expect(cards.map(card => card.status)).toEqual(["Interrupted", "Failed"]);
    expect(cards[1].input).toBe("other");
  });
  it("does not pair across ended or restarted turns", () => {
    const cards = toolActivityCards([
      { kind: "desktop.started" }, call("running", "same"), { kind: "desktop.done" },
      { kind: "desktop.started" }, call("done", "same", { ok: true, output: "second turn" }),
      call("running", "third"), { kind: "desktop.started" }, call("running", "fourth"),
    ], true);
    expect(cards.map(card => card.status)).toEqual(["Interrupted", "Completed", "Interrupted", "Running"]);
  });
  it("retains explicit interruption and marks a restored unfinished journal interrupted", () => {
    const explicit = toolActivityCards([call("running", "a"), call("interrupted", "a")], false);
    expect(explicit).toHaveLength(1); expect(explicit[0].status).toBe("Interrupted");
    expect(toolActivityCards([call("running", "b")], false)[0].status).toBe("Interrupted");
  });
});

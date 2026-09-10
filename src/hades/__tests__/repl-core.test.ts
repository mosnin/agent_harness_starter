import { describe, it, expect } from "vitest";
import { Repl } from "../repl/core";
import { MultilineBuffer } from "../repl/multiline";
import { CommandHistory } from "../repl/history";
import type { ReplIO } from "../repl/core";

function fakeIO(): ReplIO & { chunks: string[]; lines: string[] } {
  const chunks: string[] = [];
  const lines: string[] = [];
  return { chunks, lines, write: (c) => chunks.push(c), writeLine: (l) => lines.push(l) };
}

describe("MultilineBuffer", () => {
  it("submits a single complete line immediately", () => {
    const b = new MultilineBuffer();
    expect(b.feed("hello world")).toEqual({ complete: true, text: "hello world" });
    expect(b.pending).toBe(false);
  });

  it("continues on a trailing backslash and joins lines", () => {
    const b = new MultilineBuffer();
    expect(b.feed("first \\").complete).toBe(false);
    const res = b.feed("second");
    expect(res.complete).toBe(true);
    expect(res.text).toBe("first \nsecond");
  });

  it("keeps reading while brackets or code fences are open", () => {
    const b = new MultilineBuffer();
    expect(b.feed("func(").complete).toBe(false);
    expect(b.feed("arg").complete).toBe(false);
    expect(b.feed(")").complete).toBe(true);

    const f = new MultilineBuffer();
    expect(f.feed("```js").complete).toBe(false);
    expect(f.feed("code").complete).toBe(false);
    expect(f.feed("```").complete).toBe(true);
  });

  it("force-submits a pending buffer on a blank line", () => {
    const b = new MultilineBuffer();
    b.feed("open(");
    const res = b.feed("");
    expect(res.complete).toBe(true);
    expect(res.text).toBe("open(");
  });
});

describe("CommandHistory", () => {
  it("navigates prev/next and returns to the live draft", () => {
    const h = new CommandHistory();
    h.add("one");
    h.add("two");
    expect(h.prev("draft")).toBe("two");
    expect(h.prev("draft")).toBe("one");
    expect(h.next()).toBe("two");
    expect(h.next()).toBe("draft"); // back to live draft
  });

  it("coalesces consecutive duplicates", () => {
    const h = new CommandHistory();
    h.add("x");
    h.add("x");
    h.add("y");
    expect(h.all()).toEqual(["x", "y"]);
  });
});

describe("Repl", () => {
  it("streams handler output and records history", async () => {
    const io = fakeIO();
    const repl = new Repl(io, async (input, stream) => {
      for (const word of input.split(" ")) stream(`[${word}]`);
      return "";
    });

    const res = await repl.feedLine("hello there");
    expect(res.submitted).toBe(true);
    expect(io.chunks.join("")).toBe("[hello][there]");
    expect(repl.history.all()).toEqual(["hello there"]);
  });

  it("shows a continuation prompt while a turn is incomplete", async () => {
    const io = fakeIO();
    const repl = new Repl(io, async () => "ok", { prompt: "> ", continuationPrompt: "… " });
    expect(repl.currentPrompt()).toBe("> ");
    const first = await repl.feedLine("do(");
    expect(first.submitted).toBe(false);
    expect(repl.currentPrompt()).toBe("… ");
    const second = await repl.feedLine(")");
    expect(second.submitted).toBe(true);
    expect(repl.currentPrompt()).toBe("> ");
  });

  it("emits handler-returned text that was not streamed", async () => {
    const io = fakeIO();
    const repl = new Repl(io, async () => "final answer");
    const res = await repl.feedLine("q");
    expect(res.result).toBe("final answer");
    expect(io.chunks.join("")).toBe("final answer");
  });

  it("ignores an empty submission", async () => {
    const io = fakeIO();
    let ran = false;
    const repl = new Repl(io, async () => {
      ran = true;
      return "";
    });
    const res = await repl.feedLine("   ");
    expect(res.submitted).toBe(false);
    expect(ran).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { SlashCommandRegistry, helpCommand } from "../repl/commands";
import { Repl } from "../repl/core";
import type { ReplIO } from "../repl/core";

function fakeIO(): ReplIO & { chunks: string[]; lines: string[] } {
  const chunks: string[] = [];
  const lines: string[] = [];
  return { chunks, lines, write: (c) => chunks.push(c), writeLine: (l) => lines.push(l) };
}

describe("SlashCommandRegistry", () => {
  it("parses name and args, dispatches, resolves aliases", async () => {
    const seen: string[] = [];
    const reg = new SlashCommandRegistry().register({
      name: "model",
      description: "switch model",
      aliases: ["m"],
      run: (ctx) => {
        seen.push(ctx.args.join("+"));
        return `model set to ${ctx.args[0]}`;
      },
    });

    const out: string[] = [];
    const res = await reg.dispatch("/model opus fast", (l) => out.push(l));
    expect(res).toMatchObject({ handled: true, command: "model" });
    expect(seen).toEqual(["opus+fast"]);
    expect(out).toEqual(["model set to opus"]);

    const viaAlias = await reg.dispatch("/m haiku", () => {});
    expect(viaAlias.command).toBe("model");
  });

  it("reports unknown slash commands instead of running them", async () => {
    const reg = new SlashCommandRegistry();
    const out: string[] = [];
    const res = await reg.dispatch("/nope", (l) => out.push(l));
    expect(res).toMatchObject({ handled: true, unknown: true });
    expect(out[0]).toContain("Unknown command");
  });

  it("autocompletes command names by prefix", () => {
    const reg = new SlashCommandRegistry()
      .register({ name: "model", description: "", run: () => {} })
      .register({ name: "memory", description: "", run: () => {} })
      .register({ name: "clear", description: "", run: () => {} });
    expect(reg.complete("/me")).toEqual(["/memory"]);
    expect(reg.complete("/m").sort()).toEqual(["/memory", "/model"]);
    expect(reg.complete("/x")).toEqual([]);
  });

  it("helpCommand lists every registered command", () => {
    const reg = new SlashCommandRegistry();
    reg.register(helpCommand(reg)).register({ name: "clear", description: "clear screen", run: () => {} });
    const text = reg.get("help")!.run({ argString: "", args: [], write: () => {} }) as string;
    expect(text).toContain("/help");
    expect(text).toContain("/clear — clear screen");
  });
});

describe("Repl with slash commands + interrupt", () => {
  it("routes a slash line to the command registry, not the handler", async () => {
    const io = fakeIO();
    let handlerRan = false;
    const commands = new SlashCommandRegistry().register({
      name: "clear",
      description: "clear",
      run: (ctx) => ctx.write("cleared"),
    });
    const repl = new Repl(io, async () => {
      handlerRan = true;
      return "agent";
    }, { commands });

    const res = await repl.feedLine("/clear");
    expect(res.submitted).toBe(true);
    expect(handlerRan).toBe(false);
    expect(io.lines).toContain("cleared");
  });

  it("still routes normal input to the handler", async () => {
    const io = fakeIO();
    const commands = new SlashCommandRegistry();
    const repl = new Repl(io, async (input, stream) => {
      stream(`reply:${input}`);
      return "";
    }, { commands });
    await repl.feedLine("hello");
    expect(io.chunks.join("")).toBe("reply:hello");
  });

  it("interrupts an in-flight turn via the abort signal", async () => {
    const io = fakeIO();
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    const repl = new Repl(io, async (_input, stream, signal) => {
      signal.addEventListener("abort", () => {
        stream("[aborted]");
        released();
      });
      await gate;
      return "";
    });

    const turn = repl.feedLine("long task");
    // Let the handler subscribe before interrupting.
    await Promise.resolve();
    expect(repl.interrupt()).toBe(true);
    await turn;
    expect(io.chunks.join("")).toContain("[aborted]");
    expect(io.lines).toContain("^C");
    // Nothing in flight now.
    expect(repl.interrupt()).toBe(false);
  });

  it("autocompletes slash commands and history", async () => {
    const io = fakeIO();
    const commands = new SlashCommandRegistry().register({ name: "model", description: "", run: () => {} });
    const repl = new Repl(io, async () => "", { commands });
    await repl.feedLine("deploy the app");
    expect(repl.complete("/mo")).toEqual(["/model"]);
    expect(repl.complete("deploy")).toEqual(["deploy the app"]);
  });
});

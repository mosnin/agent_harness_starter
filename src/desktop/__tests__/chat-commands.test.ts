import { expect, it } from "vitest";
import { resolveChatCommand } from "../core/chat-commands";
it("validates only explicit commands and keeps normal paths intact", () => {
  expect(resolveChatCommand("/Users/preston/project", [])).toEqual({
    context: "",
  });
  expect(() => resolveChatCommand("/goal", [])).toThrow("Add instructions");
  expect(() => resolveChatCommand("/unknown hello", [])).toThrow(
    "Unknown command",
  );
  expect(resolveChatCommand("/team Build a report", []).context).toContain(
    "concurrent",
  );
  expect(
    resolveChatCommand("/skill review Check this", [
      { name: "review", content: "Check evidence" },
    ]).context,
  ).toContain("Check evidence");
});

// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { bindChatCommands } from "../ui/chat-command-picker";
it("selects without submitting, dismisses, and loads installed skills", async () => {
  document.body.innerHTML = '<textarea></textarea><div id="options"></div>';
  const input = document.querySelector("textarea")!,
    host = document.querySelector<HTMLDivElement>("#options")!;
  let selected = "";
  let sent = 0;
  bindChatCommands(
    input,
    host,
    (v) => (selected = v),
    async () => [{ name: "ponytail" }],
  );
  input.onkeydown = () => sent++;
  input.value = "/";
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(selected).toBe("/goal ");
  expect(sent).toBe(0);
  expect(host.hidden).toBe(true);
  input.value = "/skill ";
  input.dispatchEvent(new Event("input"));
  await Promise.resolve();
  await Promise.resolve();
  expect(host.textContent).toContain("ponytail");
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(host.hidden).toBe(true);
});

// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { TeamChatView } from "../ui/team-chat";
import { SlackView } from "../ui/slack-view";
const views: { destroy(): void }[] = [];
afterEach(() => { views.forEach(v => v.destroy()); views.length = 0; document.body.replaceChildren(); });
async function settle() { for (let i=0;i<12;i++) await Promise.resolve(); }
function host() { const node = document.createElement("div"); document.body.append(node); return node; }
it("keeps team member disclosure and composer selection across incoming messages", async () => {
  let messages: any[] = [];
  const state = { connected: true, name: "Team", member: { id: "me", role: "owner" }, members: [], channels: [{ id: "general", name: "general" }] };
  const rpc = vi.fn(async (method: string) => method === "team.status" ? state : method === "team.messages" ? messages : undefined);
  const view = new TeamChatView(rpc, vi.fn(), vi.fn()); views.push(view); view.mount(host()); await settle();
  view.node.querySelector<HTMLDetailsElement>(".team-members")!.open = true;
  const input = view.node.querySelector<HTMLTextAreaElement>("textarea")!; input.value = "A careful reply"; input.dispatchEvent(new Event("input")); input.focus(); input.setSelectionRange(2, 9, "backward");
  messages = [{ id: "message", seq: 1, at: Date.now(), sender: "Teammate", content: "An update" }];
  await view.refresh();
  const after = view.node.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(after.value).toBe("A careful reply"); expect(document.activeElement).toBe(after);
  expect([after.selectionStart, after.selectionEnd, after.selectionDirection]).toEqual([2, 9, "backward"]);
  expect(view.node.querySelector<HTMLDetailsElement>(".team-members")!.open).toBe(true);
  expect(view.node.textContent).toContain("An update");
});
it("retains Slack credential drafts when an unrelated channel lookup fails", async () => {
  const rpc = vi.fn(async (method: string) => { if (method === "slack.status") return { jobs: [] }; throw new Error("Connection unavailable"); });
  const view = new SlackView(rpc, vi.fn(), () => ({ root: "/project", profile: "p", name: "Hades" }), vi.fn()); views.push(view); view.mount(host()); await settle();
  const input = view.node.querySelector<HTMLInputElement>("#slack-bot-token")!; input.value = "draft-token";
  const channels = view.node.querySelector<HTMLButtonElement>('[data-command="channels"]')!; channels.focus(); channels.click(); await settle();
  expect(view.node.querySelector<HTMLInputElement>("#slack-bot-token")!.value).toBe("draft-token");
  expect(view.node.textContent).toContain("Connection unavailable");
  expect(document.activeElement?.getAttribute("data-command")).toBe("channels");
});

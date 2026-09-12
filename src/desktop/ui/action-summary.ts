const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const agents: Record<string, string> = { codex: "Codex", claude: "Claude Code", gemini: "Gemini", opencode: "Helm", grok: "Grok", hades: "Hades" };

/** Explain the proposed effect; the original arguments remain inspectable. */
export function actionSummary(tool: string, input: unknown): string {
  const raw = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  let args: Record<string, any>;
  try {
    args = JSON.parse(raw);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid arguments");
  } catch { return `<p>${esc(tool)}</p><pre>${esc(raw)}</pre>`; }
  let title = "", body = "";
  if (tool === "helm_delegate" || tool === "helm_orca_start") {
    title = `Start coding with ${agents[String(args.agent)] ?? "the selected agent"}`;
    body = `<p>${esc(args.prompt)}</p><p class="help">Works in a separate checkout. Changes remain available for review before integration.</p>`;
  } else if (tool === "delegate_work") {
    title = "Start the proposed plan";
    body = `<p>${esc(args.objective)}</p>`;
    if (Array.isArray(args.tasks)) body += `<ol>${args.tasks.map((task: any) => `<li>${esc(task?.title ?? task?.prompt ?? "Task")}</li>`).join("")}</ol>`;
    body += '<p class="help">Hades coordinates these tasks and shows their progress in this conversation.</p>';
  } else if (tool === "delegation_message") {
    title = "Update the task instructions";
    body = `<p>${esc(args.input)}</p>`;
  } else if (["delegation_stop", "helm_orca_stop", "helm_cancel"].includes(tool)) {
    title = "Stop the task";
    body = '<p>Request a stop. Saved work remains available for review.</p>';
  }
  if (!title) return `<p>${esc(tool)}</p><pre>${esc(raw)}</pre>`;
  return `<p><strong>${esc(title)}</strong></p>${body}<details><summary>Action details</summary><pre>${esc(raw)}</pre></details>`;
}

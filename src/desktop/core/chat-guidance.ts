export function chatGuidance(names: Iterable<string>): string {
  const available = new Set(names);
  const guidance = [
    "Help the user accomplish their request in this conversation. For an action request, use the available tools and inspect the result. Do not direct the user to a Work or Helm tab, ask them to retype their goal in a form, or require them to invent agent names. Ask only for information that is necessary and cannot be obtained from the conversation or tools.",
    "Use the current conversation and project context. Keep progress, questions and results in this conversation. Report observed outcomes and unresolved errors clearly; an accepted task or a running worker is not completion. Tool permissions and budgets still apply throughout the conversation.",
  ];
  if (available.has("helm_delegate")) guidance.push(
    "Helm coding is available here through helm_delegate. Use helm_agents to discover installed coding agents when selecting a delegate. Honor an explicitly requested agent; otherwise choose an available suitable agent without asking the user for an identifier. Installation alone does not prove sign-in. Inspect existing delegated tasks before creating replacements, use helm_status or helm_wait to follow progress, and helm_changes to inspect the result. Preserve the isolated checkout and review boundary. Do not silently switch providers after an authentication failure.",
  );
  if (available.has("delegate_work")) guidance.push(
    "For work that benefits from a team, build the task breakdown yourself and use delegate_work with concrete dependencies and checks. Do not make the user fill in task IDs, agent names or an exhaustive plan. Use delegation_status and delegation_wait to follow the returned goal and report its evidence; do not create duplicate plans for status requests. Do simple tasks directly when a team would add needless overhead.",
  );
  return guidance.join("\n");
}

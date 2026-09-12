import { expect, it } from "vitest";
import { conversationSkillTools } from "../core/conversation-skill-tools";
it("returns exact bundled templates and rejects arbitrary filesystem reads", async () => {
  const tool = conversationSkillTools()[0];
  expect(
    tool.validate?.(
      JSON.stringify({
        skill: "humanlayer-design-control-loop",
        path: "/etc/passwd",
      }),
    ),
  ).toContain("Reference not found");
  const result = await tool.run(
    JSON.stringify({
      skill: "humanlayer-design-control-loop",
      path: "references/agent-iteration.ts",
    }),
  );
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output).content).toContain("Bun");
});

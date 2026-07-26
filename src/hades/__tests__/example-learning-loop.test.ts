import { describe, it, expect } from "vitest";
import { demoLearningLoop } from "../examples/learning-loop";

describe("demoLearningLoop example", () => {
  it("runs the closed loop: a remembered fact resurfaces on the next turn", async () => {
    const transcript = await demoLearningLoop();
    const joined = transcript.join("\n");

    // The /remember command persisted the fact.
    expect(joined).toContain("Remembered: I deploy on Fridays and prefer TypeScript");

    // The next turn's reply shows the fact was retrieved and injected.
    expect(joined).toContain("Given what I know");
    expect(joined).toContain("I deploy on Fridays and prefer TypeScript");
    expect(joined).toContain('here\'s my take on "help me plan a TypeScript deploy"');
  });
});

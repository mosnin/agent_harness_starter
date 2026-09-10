import { describe, it, expect } from "vitest";
import {
  EVAL_CATEGORIES,
  EVAL_TASKS,
  tasksByCategory,
  decomposableTasks,
} from "../bench/eval-suite";

/**
 * Per-task {correct, wrong} answer table. Every grader must accept `correct`,
 * reject `wrong`, and reject "". Keyed by task id so a missing entry fails loud.
 */
const ANSWERS: Record<string, { correct: string; wrong: string }> = {
  "extract-01-emails": {
    correct: "alice@example.com, bob@test.org",
    wrong: "alice@example.com",
  },
  "extract-02-emails-url-distractor": {
    correct: "The emails are carol@acme.io, sales@acme.io.",
    wrong: "carol@acme.io, www.acme.io",
  },
  "extract-03-emails-case-mailto": {
    correct: "admin@work.net, jane@work.net, john.doe@work.net",
    wrong: "jane@work.net, john.doe@work.net",
  },
  "extract-04-hashtags": { correct: "#ai, #coding", wrong: "#coding, #ml" },
  "extract-05-numbers": { correct: "3, 12", wrong: "3" },
  "extract-06-urls": {
    correct: "http://b.org, https://a.com",
    wrong: "https://a.com",
  },

  "classify-01-sentiment-pos": { correct: "positive", wrong: "negative" },
  "classify-02-sentiment-neg": { correct: "Negative.", wrong: "positive" },
  "classify-03-sentiment-neutral": {
    correct: "The sentiment is neutral.",
    wrong: "positive",
  },
  "classify-04-language-fr": { correct: "french", wrong: "spanish" },
  "classify-05-language-es": { correct: "Spanish", wrong: "french" },
  "classify-06-topic-tech": { correct: "technology", wrong: "sports" },
  "classify-07-topic-politics": { correct: "politics", wrong: "technology" },

  "transform-01-csv-strings": {
    correct: '{"name":"Alice","role":"Engineer","city":"London"}',
    wrong: '{"name":"Engineer","role":"Alice","city":"London"}',
  },
  "transform-02-csv-strings": {
    correct: 'Here: {"color":"red","shape":"circle","size":"large"}',
    wrong: '{"color":"blue","shape":"circle","size":"large"}',
  },
  "transform-03-csv-typed": {
    correct: '{"title":"Dune","year":1965}',
    wrong: '{"title":"Dune","year":1984}',
  },
  "transform-04-swap": {
    correct: '{"x":"a","y":"b"}',
    wrong: '{"a":"x","b":"y"}',
  },
  "transform-05-uppercase-values": {
    correct: '{"first":"HI","second":"BYE"}',
    wrong: '{"first":"hi","second":"bye"}',
  },
  "transform-06-csv-bool-num": {
    correct: '{"active":true,"score":42}',
    wrong: '{"active":false,"score":42}',
  },

  "reason-01-syllogism": { correct: "Yes.", wrong: "No" },
  "reason-02-some-quantifier": {
    correct: "No, not all cats are blue.",
    wrong: "Yes",
  },
  "reason-03-transitive-height": { correct: "yes", wrong: "no" },
  "reason-04-youngest": { correct: "Yes", wrong: "no" },
  "reason-05-affirming-consequent": { correct: "No", wrong: "yes" },
  "reason-06-square-rectangle": { correct: "No", wrong: "yes" },
  "reason-07-transitive-numbers": { correct: "Yes", wrong: "no" },

  "arith-01-sum-primes": {
    correct: "The sum of all primes below 20 is 77.",
    wrong: "78",
  },
  "arith-02-percent": { correct: "30", wrong: "15" },
  "arith-03-factorial": { correct: "5040", wrong: "720" },
  "arith-04-discount": { correct: "$30", wrong: "10" },
  "arith-05-sum-1-to-10": { correct: "55", wrong: "45" },
  "arith-06-speed": { correct: "40 mph", wrong: "90" },
  "arith-07-power": { correct: "1024", wrong: "100" },
  "arith-08-gcd": { correct: "12", wrong: "6" },

  "multi-01-word-length": {
    correct: "apple:5, kiwi:4, banana:6",
    wrong: "apple:5, kiwi:4, banana:7",
  },
  "multi-02-first-letter": {
    correct: "dog:d, cat:c, fish:f",
    wrong: "dog:d, cat:c, fish:g",
  },
  "multi-03-double": {
    correct: "3:6, 8:16, 10:20",
    wrong: "3:6, 8:16, 10:30",
  },
  "multi-04-parity": {
    correct: "4:even, 7:odd, 12:even",
    wrong: "4:odd, 7:odd, 12:even",
  },
  "multi-05-word-length-2": {
    correct: "hello:5, hi:2, world:5",
    wrong: "hello:5, hi:2, world:6",
  },
  "multi-06-square": {
    correct: "2:4, 5:25, 9:81",
    wrong: "2:4, 5:25, 9:18",
  },
  "multi-07-capital": {
    correct: "Paris:France, Tokyo:Japan, Cairo:Egypt",
    wrong: "Paris:Japan, Tokyo:France, Cairo:Egypt",
  },
  "multi-08-vowel-count": {
    correct: "apple:2, sky:0, ocean:3",
    wrong: "apple:2, sky:1, ocean:3",
  },
  "multi-09-plus-ten": {
    correct: "5:15, 15:25, 100:110",
    wrong: "5:15, 15:25, 100:100",
  },
  "multi-10-word-length-3": {
    correct: "sun:3, moon:4, star:4, comet:5",
    wrong: "sun:3, moon:4, star:5, comet:5",
  },
  "multi-11-is-prime": {
    correct: "7:yes, 8:no, 11:yes",
    wrong: "7:yes, 8:yes, 11:yes",
  },
  "multi-12-celsius-fahrenheit": {
    correct: "0:32, 100:212",
    wrong: "0:32, 100:200",
  },
  "multi-13-color-length": {
    correct: "red:3, green:5, blue:4",
    wrong: "red:3, green:6, blue:4",
  },
  "multi-14-half": {
    correct: "10:5, 30:15, 8:4",
    wrong: "10:5, 30:15, 8:2",
  },
};

describe("eval-suite structure", () => {
  it("has between 30 and 50 tasks", () => {
    expect(EVAL_TASKS.length).toBeGreaterThanOrEqual(30);
    expect(EVAL_TASKS.length).toBeLessThanOrEqual(50);
  });

  it("uses only declared categories and includes every one", () => {
    const used = new Set(EVAL_TASKS.map((t) => t.category));
    for (const c of EVAL_CATEGORIES) expect(used.has(c)).toBe(true);
    for (const c of used) expect(EVAL_CATEGORIES).toContain(c);
  });

  it("has at least 12 decomposable tasks", () => {
    expect(decomposableTasks().length).toBeGreaterThanOrEqual(12);
  });

  it("has unique task ids", () => {
    const ids = EVAL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("query helpers", () => {
  it("tasksByCategory partitions the suite", () => {
    let total = 0;
    for (const c of EVAL_CATEGORIES) {
      const tasks = tasksByCategory(c);
      total += tasks.length;
      expect(tasks.every((t) => t.category === c)).toBe(true);
    }
    expect(total).toBe(EVAL_TASKS.length);
    expect(tasksByCategory("does-not-exist")).toEqual([]);
  });

  it("decomposableTasks returns only decomposable tasks", () => {
    expect(decomposableTasks().every((t) => t.decomposable)).toBe(true);
  });
});

describe("graders: accept correct, reject wrong and empty", () => {
  it("has an answer-table entry for every task", () => {
    for (const t of EVAL_TASKS) expect(ANSWERS[t.id]).toBeDefined();
  });

  for (const task of EVAL_TASKS) {
    it(`grades ${task.id}`, () => {
      const a = ANSWERS[task.id];
      expect(task.grade(a.correct)).toBe(true);
      expect(task.grade(a.wrong)).toBe(false);
      expect(task.grade("")).toBe(false);
    });
  }
});

import { test, expect } from "bun:test";
import { explain, LAW_CODES } from "../src/explain";

/**
 * `--explain` is an agent-facing surface: a diagnostic cites a law, and the agent must be able to
 * ask what that law demands without leaving the tool. Every law the checker can emit therefore
 * needs an entry — a diagnostic whose law has no explanation is a dead end in the loop.
 */
test("every law code explains itself with normative text and a corpus example", () => {
  for (const law of LAW_CODES) {
    const text = explain(law);
    expect({ law, has: text !== null }).toEqual({ law, has: true });
    expect({ law, hasExample: (text ?? "").includes("example:") }).toEqual({ law, hasExample: true });
  }
});

test("an unknown law code explains nothing rather than guessing", () => {
  expect(explain("V99")).toBeNull();
  expect(explain("nonsense")).toBeNull();
});

test("the example cites the fixture written to plant the law, not a bystander", () => {
  expect(explain("V12")).toContain("sim-dead-region.meant");
  expect(explain("V14")).toContain("e48-universal-actor-condition.meant");
});

import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { lex } from "../src/lexer";
import { simulate } from "../src/sim";
import { report } from "../src/report";
import type { Verdict } from "../src/diagnostics";

/**
 * `# SIM-EXPECT:` is the conformance convention for simulation, and it works exactly like
 * `# EXPECT:`: the expectation lives on the line it is about, so adding a rule means adding a
 * fixture line rather than editing this file.
 *
 *   # SIM-EXPECT: falsified <claim-id>   this authored claim / step must be falsified
 *   # SIM-EXPECT: dead <ShapeName>       the witness search must report the region unsatisfiable
 *   # SIM-EXPECT: denied <CODE>          replay must produce exactly this denial
 *
 * A `sim-*` fixture with no plants must come back entirely clean — nothing falsified, nothing dead.
 */
function plants(file: string): Array<{ line: number; kind: string; operand: string }> {
  const out: Array<{ line: number; kind: string; operand: string }> = [];
  for (const c of lex(readFileSync(file, "utf8"), file).comments) {
    const m = /^#\s*SIM-EXPECT:\s*(\S+)\s+(.+?)\s*$/.exec(c.text);
    if (m) out.push({ line: c.line, kind: m[1] ?? "", operand: m[2] ?? "" });
  }
  return out;
}

const matches = (v: Verdict, plant: { line: number; kind: string; operand: string }): boolean => {
  if (v.range.start.line !== plant.line) return false;
  if (plant.kind === "falsified") return v.status === "falsified" && v.subject === plant.operand;
  if (plant.kind === "dead") return v.status === "dead" && v.subject === plant.operand;
  if (plant.kind === "denied") return v.status === "verified" && (v.evidence ?? []).includes(`denied ${plant.operand}`);
  return false;
};

const SIM_FIXTURES = readdirSync("fixtures").filter(f => f.startsWith("sim-") && f.endsWith(".meant")).sort();

for (const name of SIM_FIXTURES) {
  const file = `fixtures/${name}`;
  test(`sim fixture ${name} matches its # SIM-EXPECT: plants`, () => {
    const planted = plants(file);
    const verdicts = simulate([file]).verdicts ?? [];

    const missing = planted
      .filter(p => !verdicts.some(v => matches(v, p)))
      .map(p => `${p.line}: expected ${p.kind} ${p.operand}, got [${verdicts.filter(v => v.range.start.line === p.line).map(v => `${v.status} ${v.subject}`).join("; ")}]`);

    const unexpected = verdicts
      .filter(v => v.status === "falsified" || v.status === "dead")
      .filter(v => !planted.some(p => matches(v, p)))
      .map(v => `${v.range.start.line}: unplanted ${v.status} ${v.subject} — ${v.message}`);

    expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
  });
}

test("every sim fixture is check-clean: simulation of a red model reports nothing meaningful", () => {
  for (const name of SIM_FIXTURES) {
    const result = simulate([`fixtures/${name}`]);
    expect({ file: name, errors: result.summary.errors }).toEqual({ file: name, errors: 0 });
  }
});

test("known-good replays and probes clean: no falsified claim, no dead region", () => {
  const verdicts = simulate(["fixtures/known-good.meant"]).verdicts ?? [];
  expect(verdicts.filter(v => v.status === "falsified" || v.status === "dead")).toEqual([]);
});

test("every shape in known-good gets a concrete witness", () => {
  const verdicts = simulate(["fixtures/known-good.meant"]).verdicts ?? [];
  const witnessed = verdicts.filter(v => v.kind === "witness" && v.status === "verified");
  expect(witnessed.map(v => v.subject).sort()).toEqual(["AtLoanLimit", "NeverReminded", "OpenLoan", "OverdueLoan"]);
  for (const v of witnessed) expect((v.counterexample ?? []).length).toBeGreaterThan(0);
});

test("the S001 tick counterexample is the minimal one: count = 4, n = 2, one tick", () => {
  const verdicts = simulate(["fixtures/sim-s001-tick.meant"]).verdicts ?? [];
  const falsified = verdicts.find(v => v.subject === "SessionTick:S002");
  expect(falsified?.status).toBe("falsified");
  const world = (falsified?.counterexample ?? []).join("\n");
  expect(world).toContain("current_session_number = 2");
  expect(world).toContain("session_count = 4");
});

// ---------------------------------------------------------------- discovery fixtures

const DISCOVERY = ["fixtures/discovery-held-change.meant", "fixtures/discovery-noise-cap.meant"];

for (const file of DISCOVERY) {
  test(`sim ${file}`, () => {
    expect(simulate([file]).verdicts).toMatchSnapshot();
  });
  test(`report ${file}`, () => {
    const result = report([file]);
    expect({ opacity: result.opacity, patterns: result.patterns, candidates: result.candidates, questions: result.questions })
      .toMatchSnapshot();
  });
}

test("discovery derives the at-most-one theorem from guarded creations", () => {
  const candidates = report(["fixtures/discovery-held-change.meant"]).candidates ?? [];
  const theorem = candidates.find(c => c.template === "at-most-one" && c.claim.includes("HeldChange"));
  expect(theorem?.status).toBe("theorem");
  expect(theorem?.id).toStartWith("DRV-at-most-one-Membership-");
  expect(theorem?.evidence.filter(e => e.startsWith("creation site")).length).toBe(3);
  expect(theorem?.evidence.some(e => e.includes("guarding conjunct"))).toBe(true);
});

test("discovery reports the bounded counter as near-derivable and names the step it cannot take", () => {
  const candidates = report(["fixtures/discovery-noise-cap.meant"]).candidates ?? [];
  const near = candidates.find(c => c.template === "bounded-counter" && c.claim.includes("reminders_sent"));
  expect(near?.status).toBe("near");
  expect(near?.blocked).toContain("first-match branch exclusion");
  expect(near?.evidence.some(e => e.includes("CapReached"))).toBe(true);
});

test("the pattern miner surfaces the related-instance-write cluster and counts its recurrence", () => {
  const patterns = report(["fixtures/discovery-held-change.meant"]).patterns ?? [];
  const cluster = patterns.find(p => p.cluster === "related-instance-write");
  // One occurrence is the *right* count here: E49 refused this pattern at the recurrence bar with a
  // single site, and the miner agreeing is what keeps the refusal justified rather than remembered.
  expect(cluster?.count).toBe(1);
  expect(cluster?.sites.length).toBe(cluster?.count);
  expect(cluster?.sites[0]).toContain("ApplyHeldChange");
});

test("recurrence is counted, not eyeballed: an identical residue shape clusters with its count", () => {
  const patterns = report(["fixtures/discovery-held-change.meant"]).patterns ?? [];
  const recurring = patterns.filter(p => p.cluster === "identical-shape" && p.count >= 2);
  expect(recurring.length).toBeGreaterThanOrEqual(1);
  for (const p of recurring) expect(p.sites.length).toBe(p.count);
});

test("candidate ids are deterministic across runs", () => {
  const first = (report(["fixtures/discovery-held-change.meant"]).candidates ?? []).map(c => c.id);
  const second = (report(["fixtures/discovery-held-change.meant"]).candidates ?? []).map(c => c.id);
  expect(second).toEqual(first);
});

// ---------------------------------------------------------------- a domain across files (E54)

test("a split domain simulates as one model, and each verdict names its declaring file", () => {
  const result = simulate(["fixtures/e54-domain-split"]);
  expect(result.summary.errors).toBe(0);
  const verdicts = result.verdicts ?? [];
  expect(verdicts.filter(v => v.status === "falsified" || v.status === "dead")).toEqual([]);
  expect(verdicts.find(v => v.kind === "replay" && v.subject === "JobRuns#1")?.status).toBe("verified");
  expect([...new Set(verdicts.map(v => v.file))]).toEqual(["fixtures/e54-domain-split/behavior.meant"]);
});

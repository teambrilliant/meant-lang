import { test, expect } from "bun:test";
import { check } from "../src/index";
import { load } from "../src/domains";

/**
 * A domain is every file in the run whose header names it (§1, E54) — the run, and only the run:
 * nothing outside the passed paths joins, so the answer depends on what was asked alone.
 */
test("files sharing a header merge: the split domain is one clean model", () => {
  const run = load(["fixtures/e54-domain-split"]);
  expect(run.domains.map(d => ({ name: d.name, files: d.files }))).toEqual([{
    name: "e54-split",
    files: ["fixtures/e54-domain-split/behavior.meant", "fixtures/e54-domain-split/concepts.meant"],
  }]);
  const result = check(["fixtures/e54-domain-split"]);
  expect(result.summary.errors + result.summary.warnings).toBe(0);
});

test("merging is bounded by the run: one file of a split domain, alone, cannot resolve its sibling", () => {
  const result = check(["fixtures/e54-domain-split/behavior.meant"]);
  expect(result.diagnostics.some(d => d.law === "V2" && d.message.includes("`Job`"))).toBe(true);
});

test("distinct headers stay distinct domains, even side by side in one run", () => {
  const run = load(["fixtures/known-good.meant", "fixtures/known-bad.meant", "fixtures/e54-domain-split"]);
  expect(run.domains.map(d => d.name)).toEqual(["lending", "lending-bad", "e54-split"]);
  expect(check(["fixtures/known-good.meant", "fixtures/e54-domain-split"]).summary.errors).toBe(0);
});

test("the merged header carries each clause once", () => {
  const [domain] = load(["fixtures/e54-domain-conflicts"]).domains;
  const clauses = domain?.model.domain?.clauses.map(c => c.kind === "meta" ? c.key.text : c.kind) ?? [];
  expect(clauses).toEqual(["mode", "state-of-record"]);
});

test("an unresolved name another domain declares says where — and suggests the header one edit away", () => {
  const typo = check(["fixtures/e54-domain-conflicts"]).diagnostics
    .find(d => d.law === "V2" && d.file === "fixtures/e54-domain-conflicts/typo.meant");
  expect(typo?.message).toContain("declared in domain `e54-conflicts` (fixtures/e54-domain-conflicts/a.meant:7)");
  expect(typo?.fix).toBe("did you mean `domain e54-conflicts`? domains in this run: e54-conflicts, e54-conflictz");
});

test("a distant domain is named but not suggested: cross-domain references are out of the language", () => {
  const result = check(["fixtures/e54-domain-split/behavior.meant", "fixtures/e33-system-only-domain.meant"]);
  const job = result.diagnostics.find(d => d.law === "V2" && d.message.startsWith("`Job`"));
  expect(job?.message).toContain("declared in domain `e33` (fixtures/e33-system-only-domain.meant:5)");
  expect(job?.fix).toBe("a domain resolves only its own declarations (§1) — declare it here, or move this file into domain `e33`");
});

test("a name declared nowhere keeps its plain message", () => {
  const result = check(["fixtures/e54-domain-split/behavior.meant"]);
  const job = result.diagnostics.find(d => d.law === "V2" && d.message.startsWith("`Job`"));
  expect(job?.message).toBe("`Job` is not a declared concept.");
});

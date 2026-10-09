import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { lex } from "../src/lexer";
import { check, expandAll } from "../src/index";

/**
 * Fixtures are self-describing: `# EXPECT: V2` (or `# EXPECT: V14, V4`) on a line declares the
 * diagnostics that must fire there. `# EXPECT-NEXT:` declares them for the following line — the
 * form an unterminated-string plant needs, since anything after its opening quote is inside it.
 * Adding a rule means adding a fixture line, not editing this file.
 *
 * A directory under fixtures/ is one case — one run, so files sharing a `domain` header merge
 * (E54) — and its plants key on file and line, so a finding stamped with the wrong file misses.
 */
function expectations(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of lex(readFileSync(file, "utf8"), file).comments) {
    const m = /^#\s*EXPECT(-NEXT)?:\s*(.+?)\s*$/.exec(c.text);
    if (!m) continue;
    const laws = (m[2] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    out.set(`${file}:${m[1] ? c.line + 1 : c.line}`, laws);
  }
  return out;
}

const CASES = readdirSync("fixtures").sort().flatMap(name => {
  const path = `fixtures/${name}`;
  if (statSync(path).isDirectory()) return [{ path, files: expandAll([path]).files }];
  return /\.(meant|md)$/.test(name) ? [{ path, files: [path] }] : [];
});

for (const { path, files } of CASES) {
  test(`fixture ${path} matches its # EXPECT: plants`, () => {
    const planted = new Map(files.flatMap(f => [...expectations(f)]));
    const result = check([path]);
    const loud = result.diagnostics.filter(d => d.severity !== "info");
    const at = (d: { file: string; range: { start: { line: number } } }) => `${d.file}:${d.range.start.line}`;

    const missing: string[] = [];
    for (const [where, laws] of planted) {
      for (const law of laws) {
        const hit = result.diagnostics.some(d => at(d) === where && d.law === law);
        if (!hit) missing.push(`${where}: expected ${law}, got [${result.diagnostics.filter(d => at(d) === where).map(d => d.law).join(", ")}]`);
      }
    }
    const unexpected = loud
      .filter(d => !(planted.get(at(d)) ?? []).includes(d.law))
      .map(d => `${at(d)}: unplanted ${d.severity} ${d.law}/${d.code} — ${d.message}`);

    expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
  });
}

test("known-good.meant is the conformance gate: zero errors, zero warnings", () => {
  const result = check(["fixtures/known-good.meant"]);
  expect(result.files).toEqual(["fixtures/known-good.meant"]);
  expect(result.summary.errors).toBe(0);
  expect(result.summary.warnings).toBe(0);
});

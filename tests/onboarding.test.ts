import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookFeedback } from "../src/hook";
import { COMMANDS, installSkill, layer0, renderSkill, specSection, specSectionNumbers, specToc } from "../src/onboarding";

test("layer 0 fits the budget and lists every command once", () => {
  const out = layer0();
  expect(out.split("\n").length).toBeLessThanOrEqual(30);
  for (const c of COMMANDS) {
    const mentions = out.split("\n").filter(line => line.trimStart().startsWith(`${c.name} `) || line.trimStart() === c.name);
    expect(mentions.length).toBe(1);
  }
  expect(out).toMatchSnapshot();
});

test("layer 0 carries orientation, not depth: no law texts, no productions", () => {
  const out = layer0();
  expect(out).toContain("meant skill");
  expect(out).toContain("meant check <model dir> --json");
  expect(out).not.toContain("::=");
  expect(out).not.toMatch(/\bV\d+\b/);
});

// ---------------------------------------------------------------- skill

test("drift-lock: committed SKILL.md is exactly `meant skill install` output", () => {
  const committed = readFileSync(".claude/skills/meant-modeling/SKILL.md", "utf8");
  expect(committed).toBe(renderSkill("install"));
});

test("skill stdout is portable and frontmatter-free", () => {
  const out = renderSkill("stdout");
  expect(out.startsWith("---")).toBe(false);
  for (const banned of ["spec/errata.md", "sketches/", "thoughts/", "bun run meant", "D#", "AD#"]) {
    expect(out).not.toContain(banned);
  }
});

test("install is idempotent in a fresh directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "meant-skill-"));
  try {
    const first = installSkill(dir);
    expect(first).toContain("wrote");
    const written = readFileSync(join(dir, ".claude", "skills", "meant-modeling", "SKILL.md"), "utf8");
    expect(written).toBe(renderSkill("install"));
    expect(installSkill(dir)).toContain("up to date");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- spec

test("spec TOC is generated from the shipped document", () => {
  expect(specSectionNumbers()).toEqual(
    ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17"],
  );
  expect(specToc()).toContain("§15");
});

test("spec slicing returns one whole top-level section", () => {
  const s15 = specSection("15");
  expect(s15?.startsWith("## 15.")).toBe(true);
  expect(s15).not.toContain("## 16.");
  const s4 = specSection("4");
  expect(s4).toContain("### 4.8");   // subsections ride along
  expect(specSection("99")).toBeNull();
});

// ---------------------------------------------------------------- hook

test("hook: clean model file stays silent", () => {
  expect(hookFeedback({ tool_input: { file_path: "fixtures/known-good.meant" } })).toBeNull();
});

test("hook: red model file returns law-cited feedback", () => {
  const fb = hookFeedback({ tool_input: { file_path: "fixtures/known-bad.meant" } });
  expect(fb).toMatch(/^meant check .* \d+ errors, \d+ warnings\n/);
  expect(fb).toMatch(/[VPL][\d-]*\S*\/\S+ /);   // at least one law/code line
});

test("hook: md gating is by content, not path", () => {
  expect(hookFeedback({ tool_input: { file_path: "README.md" } })).toBeNull();          // no meant fence
  const host = hookFeedback({ tool_input: { file_path: "fixtures/e53-md-fence-tag.md" } });
  expect(host).toContain("V2");   // the tagged fence's plant reaches the hook; the other fences stay prose
});

test("hook: a file of a split domain is checked with its siblings, and only its domain reports", () => {
  expect(hookFeedback({ tool_input: { file_path: "fixtures/e54-domain-split/behavior.meant" } })).toBeNull();
  expect(hookFeedback({ tool_input: { file_path: "./fixtures/e54-domain-split/behavior.meant" } })).toBeNull();
  const fb = hookFeedback({ tool_input: { file_path: "fixtures/e54-domain-conflicts/b.meant" } }) ?? "";
  expect(fb).toContain("P/domain-clause-conflict");
  expect(fb).not.toContain("typo.meant");                      // e54-conflictz is a neighbour, not this domain
  expect(hookFeedback({ tool_input: { file_path: "fixtures/known-bad.meant" } })).not.toContain("e54");
});

test("hook: irrelevant and malformed inputs stay silent", () => {
  expect(hookFeedback({ tool_input: { file_path: "src/cli.ts" } })).toBeNull();
  expect(hookFeedback({ tool_input: { file_path: "missing.md" } })).toBeNull();
  expect(hookFeedback({})).toBeNull();
  expect(hookFeedback("garbage")).toBeNull();
  expect(hookFeedback(null)).toBeNull();
});

test("hook: a Markdown part checks its domain's standalone sibling declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "meant-domain-hook-"));
  try {
    const concepts = join(dir, "concepts.meant");
    const behavior = join(dir, "behavior.md");
    const source = readFileSync("fixtures/e54-domain-split/concepts.meant", "utf8");
    writeFileSync(concepts, source);
    writeFileSync(behavior, "# Model notes\n\n``` meant \t\n" + readFileSync("fixtures/e54-domain-split/behavior.meant", "utf8") + "\n```\n");
    expect(hookFeedback({ tool_input: { file_path: behavior } })).toBeNull();
    writeFileSync(concepts, source.replace("concept Job", "concept Task"));
    const feedback = hookFeedback({ tool_input: { file_path: behavior } });
    expect(feedback).toContain("meant check");
    expect(feedback).toContain(`V2/unresolved-ref ${behavior}:`);
    expect(feedback).toContain("`Job` is not a declared concept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: whitespace-padded model fences use the lexer's host positions", () => {
  const dir = mkdtempSync(join(tmpdir(), "meant-hook-"));
  try {
    const path = join(dir, "notes.md");
    const source = readFileSync("fixtures/e53-md-fence-tag.md", "utf8").replace("```meant", "``` meant \t");
    writeFileSync(path, source);
    const feedback = hookFeedback({ tool_input: { file_path: path } });
    expect(feedback).toContain(`V2/unresolved-ref ${path}:15`);
    for (const tag of ["Meant", "mint", "meant extra", ""]) {
      writeFileSync(path, source.replace("``` meant \t", `\`\`\`${tag}`));
      expect(hookFeedback({ tool_input: { file_path: path } })).toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

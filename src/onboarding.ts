import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import skillBody from "./skill.md" with { type: "text" };
import specText from "../spec/meant-grammar-v0.md" with { type: "text" };

export interface CommandSpec { name: string; args: string; blurb: string }

// Single home for the verb inventory: usage(), layer 0, and the dispatch all read this.
export const COMMANDS: CommandSpec[] = [
  { name: "check",  args: "<paths> [--json] [--explain <LAW>]", blurb: "parse/resolve/laws; exit 1 iff errors" },
  { name: "fmt",    args: "<paths> [--check]",                  blurb: "canonical form; --check exits 1 on drift" },
  { name: "sim",    args: "<paths> [--json]",                   blurb: "witness / probe / replay verdicts" },
  { name: "report", args: "<paths> [--json]",                   blurb: "opacity, patterns, candidates, questions" },
  { name: "skill",  args: "[install]",                          blurb: "agent editing discipline (stdout, or write .claude/skills/)" },
  { name: "spec",   args: "[<section> | --all]",                blurb: "the normative grammar (TOC by default)" },
  { name: "hook",   args: "",                                   blurb: "PostToolUse hook: stdin JSON -> diagnostics feedback" },
];

export function commandTable(): string {
  return COMMANDS
    .map(c => `  ${`${c.name} ${c.args}`.trimEnd().padEnd(42)} ${c.blurb}`)
    .join("\n");
}

export function layer0(): string {
  return `meant ${pkg.version} — business intent and behavior

A Meant model describes what an application should do.
People decide the behavior; agents help author the model;
engineers choose the implementation. The toolkit checks models deterministically.
Model files: .meant, or \`\`\`meant fences in .md.

Agent bootstrap:
  1. Read \`meant skill\` into context (persist it: \`meant skill install\`).
  2. Loop: edit → \`meant check <model dir> --json\` → fix errors → \`meant fmt <file>\`.
  3. Depth on demand: \`meant check --explain <LAW>\` · \`meant spec <section>\`.
  4. Modeling an existing app: read the "Starting from code" section of \`meant skill\`.

Commands
${commandTable()}
`;
}

// ---------------------------------------------------------------- skill

const SKILL_FRONTMATTER = `---
name: meant-modeling
description: Discipline for editing meant model files (.meant, or \`\`\`meant fenced blocks in .md). Use whenever creating or modifying meant declarations — concepts, dimensions, shapes, actions, invariants, scenarios — or processing prose requirements into a model.
---

`;

export function renderSkill(mode: "stdout" | "install"): string {
  return mode === "install" ? SKILL_FRONTMATTER + skillBody : skillBody;
}

const HOOK_SNIPPET = `
To close the loop, register the PostToolUse hook in .claude/settings.json
(meant never edits settings itself):

  {
    "hooks": {
      "PostToolUse": [
        { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "meant hook" }] }
      ]
    }
  }
`;

export function installSkill(cwd: string): string {
  const dir = join(cwd, ".claude", "skills", "meant-modeling");
  const file = join(dir, "SKILL.md");
  const content = renderSkill("install");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (existing === content) return `up to date  ${file}\n${HOOK_SNIPPET}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, content);
  return `wrote  ${file}\n${HOOK_SNIPPET}`;
}

// ---------------------------------------------------------------- spec

const SECTION_HEADING = /^## (\d+)\. (.*)$/;

export function specSectionNumbers(): string[] {
  return specText
    .split("\n")
    .map(line => SECTION_HEADING.exec(line))
    .filter(m => m !== null)
    .map(m => m[1] ?? "");
}

export function specToc(): string {
  const lines = specText
    .split("\n")
    .map(line => SECTION_HEADING.exec(line))
    .filter(m => m !== null)
    .map(m => `  §${(m[1] ?? "").padEnd(3)} ${m[2] ?? ""}`);
  return `meant grammar v0 — sections (print one: \`meant spec <n>\`; whole doc: \`meant spec --all\`)\n\n${lines.join("\n")}\n`;
}

export function specSection(n: string): string | null {
  const lines = specText.split("\n");
  const start = lines.findIndex(line => {
    const m = SECTION_HEADING.exec(line);
    return m !== null && m[1] === n;
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_HEADING.test(lines[i] ?? "")) { end = i; break }
  }
  return lines.slice(start, end).join("\n").trimEnd() + "\n";
}

export function specAll(): string {
  return specText;
}

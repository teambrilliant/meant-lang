#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { check, expandAll } from "./index";
import { explain, LAW_CODES } from "./explain";
import { formatDocument } from "./printer";
import { report } from "./report";
import { simulate } from "./sim";
import { commandTable, installSkill, layer0, renderSkill, specAll, specSection, specSectionNumbers, specToc } from "./onboarding";
import { hookFeedback } from "./hook";
import type { CheckResult, Diagnostic } from "./diagnostics";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => args.includes(name);
const option = (name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
};
/** Positional paths, with `--explain <law>`'s operand consumed rather than mistaken for one. */
const paths: string[] = [];
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined) continue;
  if (arg.startsWith("--")) { if (arg === "--explain") i++; continue }
  paths.push(arg);
}

const json = flag("--json");

if (command === undefined || command === "--help" || command === "-h" || command === "help") {
  console.log(layer0());
  process.exit(0);
}

const usage = () => {
  console.error("usage: meant <command> <paths...> [--json]");
  console.error(commandTable());
  console.error("  paths: .meant files, or directories to search (md-fenced models included)");
  process.exit(2);
};

const badge: Record<Diagnostic["severity"], string> = { error: "error", warning: "warn ", info: "info " };

function printDiagnostics(result: CheckResult): void {
  let currentFile = "";
  for (const d of result.diagnostics) {
    if (d.file !== currentFile) { currentFile = d.file; console.log(`\n${currentFile}`) }
    console.log(`  ${badge[d.severity]} ${d.range.start.line}:${d.range.start.col}  ${d.law}/${d.code}  ${d.message}`);
    if (d.fix) console.log(`         → ${d.fix}`);
  }
  const { errors, warnings, infos } = result.summary;
  console.log(`\n${result.files.length} file(s): ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`);
}

// ---------------------------------------------------------------- check

if (command === "check") {
  const law = option("--explain");
  if (law !== null) {
    const text = explain(law);
    if (text === null) {
      console.error(`\`${law}\` is not a law code. Known: ${LAW_CODES.join(", ")}`);
      process.exit(2);
    }
    console.log(text);
    process.exit(0);
  }
  if (paths.length === 0) usage();
  const result = check(paths);
  if (json) console.log(JSON.stringify(result, null, 2));
  else printDiagnostics(result);
  process.exit(result.summary.errors > 0 ? 1 : 0);
}

// ---------------------------------------------------------------- fmt

if (command === "fmt") {
  if (paths.length === 0) usage();
  const checkOnly = flag("--check");
  const { files, unreadable } = expandAll(paths);
  const drifted: string[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const { text, skipped: reason } = formatDocument(source, file);
    if (reason !== null) { skipped.push({ file, reason }); continue }
    if (text === source) continue;
    drifted.push(file);
    if (!checkOnly) writeFileSync(file, text);
  }
  if (json) {
    console.log(JSON.stringify({ version: 1, files, drifted, skipped, diagnostics: unreadable, mode: checkOnly ? "check" : "write" }, null, 2));
  } else {
    for (const d of unreadable) {
      console.log(`  error  ${d.law}/${d.code}  ${d.message}`);
      if (d.fix) console.log(`         → ${d.fix}`);
    }
    for (const file of drifted) console.log(`${checkOnly ? "drift" : "wrote"}  ${file}`);
    for (const s of skipped) console.log(`skip   ${s.file}  (${s.reason} — a file the parser convicts is not formatted)`);
    console.log(`\n${files.length} file(s): ${drifted.length} ${checkOnly ? "not in canonical form" : "reformatted"}, ${skipped.length} skipped`);
  }
  process.exit(unreadable.length > 0 || (checkOnly && drifted.length > 0) ? 1 : 0);
}

// ---------------------------------------------------------------- sim

if (command === "sim") {
  if (paths.length === 0) usage();
  const result = simulate(paths);
  if (json) { console.log(JSON.stringify(result, null, 2)); }
  else {
    printDiagnostics(result);
    let currentFile = "";
    for (const v of result.verdicts ?? []) {
      if (v.file !== currentFile) { currentFile = v.file; console.log(`\n${currentFile}`) }
      console.log(`  ${v.status.padEnd(11)} ${v.kind.padEnd(7)} ${v.range.start.line}:${v.range.start.col}  ${v.subject}  ${v.message}`);
      for (const line of v.evidence ?? []) console.log(`         · ${line}`);
    }
    const tally = new Map<string, number>();
    for (const v of result.verdicts ?? []) tally.set(v.status, (tally.get(v.status) ?? 0) + 1);
    console.log(`\n${result.files.length} file(s): ${[...tally].map(([k, n]) => `${n} ${k}`).join(", ") || "no verdicts"}`);
  }
  const falsified = (result.verdicts ?? []).filter(v => v.status === "falsified").length;
  process.exit(result.summary.errors > 0 || falsified > 0 ? 1 : 0);
}

// ---------------------------------------------------------------- report

if (command === "report") {
  if (paths.length === 0) usage();
  const result = report(paths);
  if (json) { console.log(JSON.stringify(result, null, 2)); }
  else {
    if (result.summary.errors > 0) printDiagnostics(result);
    console.log("── opacity queue ──");
    for (const o of result.opacity ?? []) {
      console.log(`  ${o.declaration.padEnd(28)} ${o.file}:${o.range.start.line}  sentences ${o.sentences}, unprobeable ${o.unprobeable}, skipped ${o.skipped}`);
      for (const line of o.detail) console.log(`         · ${line}`);
    }
    console.log("\n── residue patterns ──");
    for (const p of result.patterns ?? []) {
      console.log(`  ×${p.count}  ${p.cluster}  ${p.pattern}`);
      for (const site of p.sites) console.log(`         · ${site}`);
    }
    console.log("\n── discovery candidates ──");
    for (const c of result.candidates ?? []) {
      console.log(`  ${c.status.padEnd(6)} ${c.id}`);
      console.log(`         ${c.claim}`);
      for (const line of c.evidence) console.log(`         · ${line}`);
      if (c.blocked) console.log(`         blocked: ${c.blocked}`);
    }
    console.log("\n── questions inbox ──");
    for (const q of result.questions ?? []) console.log(`  ${q.handle.padEnd(10)} ${q.file}:${q.range.start.line}  ${q.text}`);
    console.log(`\n${result.files.length} file(s): ${(result.opacity ?? []).length} opaque declaration(s), ${(result.patterns ?? []).length} pattern(s), ${(result.candidates ?? []).length} candidate(s), ${(result.questions ?? []).length} question(s)`);
  }
  process.exit(result.summary.errors > 0 ? 1 : 0);
}

// ---------------------------------------------------------------- skill

if (command === "skill") {
  if (args[1] === "install") {
    console.log(installSkill(process.cwd()));
    process.exit(0);
  }
  if (args[1] !== undefined) usage();
  console.log(renderSkill("stdout"));
  process.exit(0);
}

// ---------------------------------------------------------------- spec

if (command === "spec") {
  if (flag("--all")) { console.log(specAll()); process.exit(0) }
  const section = args[1];
  if (section === undefined) { console.log(specToc()); process.exit(0) }
  const body = specSection(section);
  if (body === null) {
    console.error(`no section \`${section}\`. Sections: ${specSectionNumbers().join(", ")}`);
    process.exit(2);
  }
  console.log(body);
  process.exit(0);
}

// ---------------------------------------------------------------- hook

if (command === "hook") {
  let feedback: string | null = null;
  try {
    feedback = hookFeedback(await Bun.stdin.json());
  } catch {
    // Malformed or absent stdin: a hook must never break the editing session.
  }
  if (feedback !== null) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: feedback },
    }));
  }
  process.exit(0);
}

usage();

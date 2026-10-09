// PostToolUse hook logic: given the hook payload, return the feedback text
// for red model files, or null for anything that should stay silent.
import { readFileSync } from "node:fs";
import { dirname, normalize } from "node:path";
import { isModelFile, load } from "./domains";
import { checkDomain } from "./index";
import { sortDiagnostics, summarize } from "./diagnostics";
import { fenceRegions } from "./lexer";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function hookFeedback(input: unknown): string | null {
  if (!isRecord(input) || !isRecord(input.tool_input)) return null;
  const path = input.tool_input.file_path;
  if (typeof path !== "string" || !isModelFile(path)) return null;

  if (path.endsWith(".md")) {
    let source: string;
    try { source = readFileSync(path, "utf8") } catch { return null }
    if (fenceRegions(source).length === 0) return null;
  }

  // A domain spans files (§1): check the edited file's whole domain, found among its directory's
  // model files, and report only that domain — neighbouring domains are not this edit's business.
  const file = normalize(path);
  const run = load([dirname(file)]);
  const domain = run.domains.find(d => d.files.includes(file));
  const diagnostics = sortDiagnostics(domain ? checkDomain(domain, run.index) : run.diagnostics.filter(d => d.file === file));
  const { errors, warnings } = summarize(diagnostics);
  if (errors + warnings === 0) return null;
  return (
    `meant check ${path}: ${errors} errors, ${warnings} warnings\n` +
    diagnostics
      .filter(d => d.severity !== "info")
      .map(d => `${d.law}/${d.code} ${d.file}:${d.range.start.line} ${d.message}${d.fix ? ` → ${d.fix}` : ""}`)
      .join("\n")
  );
}

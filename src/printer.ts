import { fenceRegions, lex } from "./lexer";
import type { CommentTrivia, Token } from "./lexer";
import { lineDepths, parse } from "./parser";

/**
 * The canonical printer. It works off the token stream rather than the parsed CST: the canonical
 * form is entirely lexical (indent, separator width, comment spacing, blank-line caps), and a
 * token-stream printer cannot lose a construct the parser dropped on an error path.
 *
 * Two invariants keep it honest, both property-tested in tests/fmt.test.ts:
 *   idempotency          format(format(x)) === format(x)
 *   semantic preservation format(x) lexes to the same token texts, in order, as x
 *
 * The second is not decorative: `verified-by tests/x.test.ts#returns` lexes as glued tokens, and a
 * printer that inserted a space before `#` would turn the fragment into a comment. Hence the
 * standing rule below — normalize the whitespace that is there, never invent whitespace that is not.
 */

/**
 * Mis-indentation is the one structural conviction `fmt` repairs; every other one stays its hand.
 *
 * The difference is whether the parser recovered. An over-indented clause is understood completely —
 * §17 says the join stops at a construct, so the line is a sibling and the printer knows its depth,
 * which makes re-emitting it a fix rather than a guess. A tab, an unterminated string, or an unknown
 * statement leaves the parser guessing, and half the conformance corpus exists to *plant* exactly
 * those: a formatter that silently turns `\t` into two spaces deletes the fixture proving tabs are
 * illegal.
 */
const REPAIRABLE: ReadonlySet<string> = new Set(["indent-mismatch"]);

export function formatDocument(source: string, file: string): { text: string; skipped: string | null } {
  const lexed = lex(source, file);
  const parsed = parse(lexed);
  const blocking = [...lexed.diagnostics, ...parsed.diagnostics]
    .filter(d => d.severity === "error" && !REPAIRABLE.has(d.code));
  const first = blocking[0];
  if (first) return { text: source, skipped: `${first.law}/${first.code} at ${first.range.start.line}` };
  return { text: format(source, file), skipped: null };
}

/** Operators the canonical form spaces on both sides even when the source glued them. */
const SPACED_OPS: ReadonlySet<string> = new Set(["=", "!=", "<", "<=", ">", ">=", "+=", "-=", "|", "->"]);

const INDENT = "  ";

/**
 * Separator between two adjacent tokens on one output line.
 * Whitespace present in the source collapses to one space; whitespace absent stays absent —
 * except for the shapes §17 and the plan's canonical form legislate outright.
 */
function separator(prev: Token, next: Token): string {
  const glued = next.leading.length === 0;
  if (next.kind === "OP" && (next.text === "," || next.text === ")" || next.text === "]")) return "";
  if (prev.kind === "OP" && (prev.text === "(" || prev.text === "[")) return "";
  if (prev.kind === "OP" && prev.text === ",") return " ";
  if (next.kind === "OP" && SPACED_OPS.has(next.text)) return " ";
  if (prev.kind === "OP" && SPACED_OPS.has(prev.text)) return " ";
  return glued ? "" : " ";
}

function renderTokens(tokens: Token[]): string {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const prev = tokens[i - 1];
    if (prev) out += separator(prev, t);
    out += t.text;
  }
  return out;
}

interface Physical { text: string; terminator: string }

function splitPhysical(source: string): Physical[] {
  const out: Physical[] = [];
  for (const raw of source.split(/(?<=\n)/)) {
    if (raw === "") continue;
    const m = /(\r?\n)$/.exec(raw);
    out.push({ text: m ? raw.slice(0, raw.length - (m[1]?.length ?? 0)) : raw, terminator: m?.[1] ?? "" });
  }
  return out;
}

export function format(source: string, file: string): string {
  if (source === "") return source;
  const lexed = lex(source, file);
  const physical = splitPhysical(source);
  const depthOf = lineDepths(lexed.lines);

  // Which physical lines the formatter owns: everything, or only fenced regions in a .md host.
  const owned = new Set<number>();
  if (file.endsWith(".md")) {
    const regions = fenceRegions(source);
    let offset = 0;
    for (let i = 0; i < physical.length; i++) {
      const p = physical[i];
      if (!p) continue;
      const end = offset + p.text.length + p.terminator.length;
      if (regions.some(([a, b]) => offset >= a && end <= b)) owned.add(i + 1);
      offset = end;
    }
  } else {
    for (let i = 0; i < physical.length; i++) owned.add(i + 1);
  }

  // A logical line owns every physical line its tokens span; interior string lines pass through
  // verbatim (the canonical form touches a multi-line string's opening indentation, never its body).
  const startsLogical = new Map<number, { tokens: Token[]; endLine: number }>();
  const interior = new Set<number>();
  for (const line of lexed.lines) {
    let endLine = line.line;
    for (const t of line.tokens) if (t.endPos.line > endLine) endLine = t.endPos.line;
    startsLogical.set(line.line, { tokens: line.tokens, endLine });
    for (let l = line.line + 1; l <= endLine; l++) interior.add(l);
  }

  const commentsByLine = new Map<number, CommentTrivia[]>();
  for (const c of lexed.comments) {
    const bucket = commentsByLine.get(c.line);
    if (bucket) bucket.push(c); else commentsByLine.set(c.line, [c]);
  }

  /** A comment is trailing when tokens precede it on its physical line. */
  const trailingComment = (line: number, tokens: Token[]): string | null => {
    const onLine = commentsByLine.get(line) ?? [];
    let lastCol = 0;
    for (const t of tokens) if (t.endPos.line === line && t.endPos.col > lastCol) lastCol = t.endPos.col;
    const after = onLine.filter(c => c.col >= lastCol);
    const first = after[0];
    return first ? first.text.trimEnd() : null;
  };

  interface Emit { line: number; text: string; terminator: string; topLevel: boolean }
  const emits: Emit[] = [];
  const blanksBefore: number[] = [];

  let pendingBlanks = 0;
  for (let i = 0; i < physical.length; i++) {
    const lineNo = i + 1;
    const p = physical[i];
    if (!p) continue;

    if (!owned.has(lineNo)) {
      emits.push({ line: lineNo, text: p.text, terminator: p.terminator, topLevel: true });
      blanksBefore.push(-1);                       // prose: blank runs outside fences are untouched
      pendingBlanks = 0;
      continue;
    }
    if (interior.has(lineNo)) continue;            // consumed by the multi-line token above

    const logical = startsLogical.get(lineNo);
    if (logical) {
      const depth = depthOf.get(lineNo) ?? 0;
      let text = INDENT.repeat(depth) + renderTokens(logical.tokens);
      const comment = trailingComment(logical.endLine, logical.tokens);
      if (comment !== null) text += "  " + comment;
      emits.push({ line: lineNo, text, terminator: p.terminator, topLevel: depth === 0 });
      blanksBefore.push(pendingBlanks);
      pendingBlanks = 0;
      continue;
    }

    const comment = (commentsByLine.get(lineNo) ?? [])[0];
    if (comment) {
      // Full-line comments keep their own indentation level — the narrowest reading of the rule,
      // and the only one that preserves hand-aligned continuation blocks.
      emits.push({ line: lineNo, text: p.text.trimEnd(), terminator: p.terminator, topLevel: comment.col === 1 });
      blanksBefore.push(pendingBlanks);
      pendingBlanks = 0;
      continue;
    }

    if (p.text.trim() === "") { pendingBlanks++; continue; }

    // Debris inside a fence that produced no token (only reachable after a lexer error): verbatim.
    emits.push({ line: lineNo, text: p.text.trimEnd(), terminator: p.terminator, topLevel: true });
    blanksBefore.push(pendingBlanks);
    pendingBlanks = 0;
  }

  const newline = physical.find(p => p.terminator !== "")?.terminator ?? "\n";
  let out = "";
  for (let i = 0; i < emits.length; i++) {
    const emit = emits[i];
    if (!emit) continue;
    const before = blanksBefore[i] ?? 0;
    if (before > 0) {
      const cap = emit.topLevel ? 2 : 1;
      out += newline.repeat(Math.min(before, cap));
    } else if (before === -1) {
      // prose region: the blank lines are physical lines of their own, already emitted verbatim
    }
    // An unterminated string runs to EOF, so its token text already carries the line's newline.
    out += emit.text + (emit.terminator === "" || emit.text.endsWith("\n") ? "" : newline);
  }
  return out;
}

import type { Diagnostic, Position, Range } from "./diagnostics";

export type TokenKind =
  | "KEYWORD"    // a word in the §15 inventory, in any position (keywords are contextual)
  | "NAME"       // Capitalized declared name: [A-Z][A-Za-z0-9_]*
  | "ID"         // stable id: [A-Z]+[0-9]+  (S001, A004, SC001)
  | "IDENT"      // lowercase word: [a-z_][A-Za-z0-9_]* with joined hyphens (partner-fee)
  | "HANDLE"     // @alex
  | "STRING"     // "…" — may span lines
  | "INT"
  | "DECIMAL"
  | "DURATION"   // int + unit, lexed as one token: `3 days`, `1 month`
  | "OP"
  | "PUNCT"      // anything else — prose debris; never an error on its own
  | "EOL";

export interface Token {
  kind: TokenKind;
  text: string;        // raw source slice
  value: string;       // STRING: content without quotes; else identical to text
  leading: string;     // raw trivia (whitespace, comments, non-fence prose) preceding this token
  start: number;       // byte offset of text
  end: number;         // byte offset after text
  pos: Position;       // 1-based line/col of text start
  endPos: Position;    // 1-based line/col just past text (multi-line strings end on a later line)
  file: string;        // the host file — a domain spans files, so every finding names its anchor's
}

export interface CommentTrivia { text: string; line: number; col: number }

/** One logical line: the tokens between two EOLs, plus its indentation column. */
export interface Line {
  indent: number;      // leading spaces of the physical line the first token sits on
  tokens: Token[];     // never empty; EOL excluded
  line: number;        // 1-based physical line of the first token
}

export interface LexResult {
  file: string;
  source: string;
  tokens: Token[];     // flat stream including EOL tokens
  trailing: string;    // trivia after the last token (round-trip tail)
  lines: Line[];
  comments: CommentTrivia[];
  diagnostics: Diagnostic[];
}

/** §15 keyword inventory (normative). Keywords are contextual: they may appear where a name is expected. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  // kinds (8) + the domain wrapper
  "domain", "concept", "dimension", "touchpoints", "shape", "exposure", "action", "invariant", "scenario",
  // domain
  "mode", "uses", "model-first", "code-first", "mixed",
  // concept
  "field", "values", "fallback",
  // shape
  "of", "where", "wait", "timeout",
  // exposure
  "to", "at", "must-see", "must-not-see",
  // action
  "by", "requires", "else", "in", "otherwise", "effect", "new", "with",
  // invariant
  "check", "schema", "execution", "scenario-coverage", "conformance-only", "judged", "rubric",
  // scenario
  "expect", "lane", "checks", "via", "denied",
  // cross-cutting
  "note", "verified-by", "planned", "undecided",
  // expressions
  "and", "or", "not", "no", "some", "this", "actor", "today",
]);

/**
 * Duration units. `day`/`days` is not in §3's unit list but is used by every fuse and delta in the
 * corpus (`timeout 3 days`, `today = next_billing_date - 1 day`); admitted here as the narrowest
 * reading, reported as a proposed erratum.
 */
const UNITS: ReadonlySet<string> = new Set([
  "ms", "s", "m", "h", "d", "day", "days", "week", "weeks", "month", "months", "year", "years",
  "second", "seconds", "minute", "minutes", "hour", "hours",
]);

const DATA_TYPES: ReadonlySet<string> = new Set(["int", "decimal", "string", "bool", "date", "duration"]);
export { DATA_TYPES };

const OPERATORS = ["->", "!=", "<=", ">=", "+=", "-=", "=", "<", ">", "+", "-", "*", "/", "?",
  ":", ",", ".", "(", ")", "[", "]", "|"];

function isWordStart(c: string): boolean { return /[A-Za-z_]/.test(c); }
function isWordChar(c: string): boolean { return /[A-Za-z0-9_]/.test(c); }

/**
 * Meant Lang model regions of a markdown host file: fenced blocks whose info string is `meant`.
 * Untagged and otherwise-tagged fences are prose (§17) — a host may carry shell blocks and
 * examples without becoming a model. Positions stay relative to the host.
 */
export function fenceRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let open: number | null = null;
  let tagged = false;
  let offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const fence = /^\s*```(.*)/.exec(line);
    if (fence !== null) {
      if (open === null) { open = offset + line.length; tagged = (fence[1] ?? "").trim() === "meant"; }
      else { if (tagged) regions.push([open, offset]); open = null; }
    }
    offset += line.length;
  }
  if (open !== null && tagged) regions.push([open, source.length]);
  return regions;
}

export function lex(source: string, file: string): LexResult {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);

  const posOf = (offset: number): Position => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - (lineStarts[lo] ?? 0) + 1 };
  };
  const rangeOf = (start: number, end: number): Range => ({ start: posOf(start), end: posOf(end) });

  const diagnostics: Diagnostic[] = [];
  const err = (law: string, code: string, message: string, start: number, end: number, fix?: string) =>
    diagnostics.push({ law, code, severity: "error", message, file, range: rangeOf(start, end), ...(fix ? { fix } : {}) });

  const isMarkdown = file.endsWith(".md");
  const regions = isMarkdown ? fenceRegions(source) : [[0, source.length] as [number, number]];
  const inCode = (i: number) => regions.some(([a, b]) => i >= a && i < b);
  const nextCodeStart = (i: number) => {
    let best = source.length;
    for (const [a] of regions) if (a > i && a < best) best = a;
    return best;
  };

  const tokens: Token[] = [];
  const comments: CommentTrivia[] = [];
  let pos = 0;
  let trivia = "";
  const reportedTabLines = new Set<number>();

  const push = (kind: TokenKind, start: number, end: number, value?: string) => {
    tokens.push({
      kind, text: source.slice(start, end), value: value ?? source.slice(start, end),
      leading: trivia, start, end, pos: posOf(start), endPos: posOf(end), file,
    });
    trivia = "";
  };

  while (pos < source.length) {
    if (!inCode(pos)) { const to = nextCodeStart(pos); trivia += source.slice(pos, to); pos = to; continue; }

    const c = source[pos] ?? "";

    if (c === "\n" || (c === "\r" && source[pos + 1] === "\n")) {
      const len = c === "\r" ? 2 : 1;
      push("EOL", pos, pos + len);
      pos += len;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      if (c === "\t") {
        const p = posOf(pos);
        if (!reportedTabLines.has(p.line)) {
          reportedTabLines.add(p.line);
          err("P", "tab-indent", "Tabs are illegal (§17): indentation is 2 spaces per level.", pos, pos + 1,
            "replace the tab with spaces");
        }
      }
      trivia += c; pos++; continue;
    }
    // `#` opens a comment only at a whitespace boundary — `return.test.ts#returns` keeps its fragment.
    if (c === "#" && (pos === 0 || /[\s]/.test(source[pos - 1] ?? " "))) {
      let end = pos;
      while (end < source.length && source[end] !== "\n") end++;
      const p = posOf(pos);
      comments.push({ text: source.slice(pos, end), line: p.line, col: p.col });
      trivia += source.slice(pos, end);
      pos = end;
      continue;
    }
    if (c === '"') {
      let end = pos + 1;
      while (end < source.length) {
        if (source[end] === "\\" && end + 1 < source.length) { end += 2; continue; }
        if (source[end] === '"') { end++; break; }
        end++;
      }
      if (end > source.length || source[end - 1] !== '"' || end === pos + 1) {
        err("P", "unterminated-string", "String is never closed (§17: strings are double-quoted).", pos, Math.min(end, source.length),
          "close the string with `\"`");
        push("STRING", pos, source.length, source.slice(pos + 1));
        pos = source.length;
        continue;
      }
      push("STRING", pos, end, source.slice(pos + 1, end - 1).replace(/\\(["\\])/g, "$1"));
      pos = end;
      continue;
    }
    if (c === "@" && isWordStart(source[pos + 1] ?? "")) {
      let end = pos + 1;
      while (end < source.length && isWordChar(source[end] ?? "")) end++;
      push("HANDLE", pos, end);
      pos = end;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let end = pos;
      while (end < source.length && /[0-9]/.test(source[end] ?? "")) end++;
      let kind: TokenKind = "INT";
      if (source[end] === "." && /[0-9]/.test(source[end + 1] ?? "")) {
        end++;
        while (end < source.length && /[0-9]/.test(source[end] ?? "")) end++;
        kind = "DECIMAL";
      }
      // duration: int + unit word, merged into one literal token (`3 days`)
      if (kind === "INT") {
        let probe = end;
        while (source[probe] === " ") probe++;
        let wordEnd = probe;
        while (wordEnd < source.length && isWordChar(source[wordEnd] ?? "")) wordEnd++;
        const word = source.slice(probe, wordEnd);
        if (word.length > 0 && UNITS.has(word) && !isWordChar(source[wordEnd] ?? "")) {
          push("DURATION", pos, wordEnd);
          pos = wordEnd;
          continue;
        }
      }
      push(kind, pos, end);
      pos = end;
      continue;
    }
    if (isWordStart(c)) {
      let end = pos;
      while (end < source.length) {
        if (isWordChar(source[end] ?? "")) { end++; continue; }
        // a hyphen binds only between word characters: `partner-fee`, never `count - 1`
        if (source[end] === "-" && isWordChar(source[end - 1] ?? "") && isWordChar(source[end + 1] ?? "")) { end += 2; continue; }
        break;
      }
      const word = source.slice(pos, end);
      const kind: TokenKind =
        KEYWORDS.has(word) ? "KEYWORD"
          : /^[A-Z]+[0-9]+$/.test(word) ? "ID"
            : /^[A-Z]/.test(word) ? "NAME"
              : "IDENT";
      push(kind, pos, end);
      pos = end;
      continue;
    }
    const op = OPERATORS.find(o => source.startsWith(o, pos));
    if (op) { push("OP", pos, pos + op.length); pos += op.length; continue; }
    push("PUNCT", pos, pos + 1);
    pos++;
  }

  // group into logical lines
  const lines: Line[] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "EOL") {
      if (current.length > 0) {
        const first = current[0];
        if (first) {
          const lineStart = lineStarts[first.pos.line - 1] ?? 0;
          const lead = source.slice(lineStart, first.start);
          lines.push({ indent: /^[ \t]*$/.test(lead) ? lead.length : first.pos.col - 1, tokens: current, line: first.pos.line });
        }
      }
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) {
    const first = current[0];
    if (first) {
      const lineStart = lineStarts[first.pos.line - 1] ?? 0;
      const lead = source.slice(lineStart, first.start);
      lines.push({ indent: /^[ \t]*$/.test(lead) ? lead.length : first.pos.col - 1, tokens: current, line: first.pos.line });
    }
  }

  return { file, source, tokens, trailing: trivia, lines, comments, diagnostics };
}

/** Byte-exact reconstruction — the round-trip property the CST's trivia promise rests on. */
export function unlex(result: LexResult): string {
  let out = "";
  for (const t of result.tokens) out += t.leading + t.text;
  return out + result.trailing;
}

/** Tokens rendered back to readable prose: source spacing collapsed to one space, never invented. */
export function joinTokens(tokens: Token[]): string {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (i > 0 && t.leading.length > 0) out += " ";
    out += t.text;
  }
  return out;
}

export function tokenRange(first: Token, last: Token): Range {
  return { start: first.pos, end: last.endPos };
}

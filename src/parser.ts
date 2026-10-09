import type { Diagnostic, Range } from "./diagnostics";
import type { Line, LexResult, Token } from "./lexer";
import { tokenRange } from "./lexer";
import type {
  ActionDecl, ActorBlock, Branch, Common, Condition, ConceptDecl, DimensionDecl, DomainClause,
  DomainDecl, EffectBlock, EffectLine, ExposureDecl, Expectation, Expr, ExpectBlock, Fact, FieldDecl,
  Fuse, InvariantDecl, LaneLine, Marker, Model, ScenarioDecl, Sentence, ShapeDecl, Statement, Step,
  ToBlock, TouchpointsDecl, TypeRef, ValuesEntry,
} from "./cst";
import { emptyCommon } from "./cst";

interface Group { head: Line; body: Line[] }

/** Split a run of lines into head lines (at the shallowest indent) plus each head's deeper body. */
function splitBlock(lines: Line[]): Group[] {
  const groups: Group[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i];
    if (!head) break;
    i++;
    const body: Line[] = [];
    while (i < lines.length) {
      const next = lines[i];
      if (!next || next.indent <= head.indent) break;
      body.push(next);
      i++;
    }
    groups.push({ head, body });
  }
  return groups;
}

/** Continuation join (§17): deeper lines under a non-block clause continue its logical line. */
function join(group: Group): Token[] {
  const out = [...group.head.tokens];
  for (const l of group.body) out.push(...l.tokens);
  return out;
}

/**
 * Words that open a clause and can never continue one (§17: the join stops at a construct).
 *
 * Deliberately excludes every §15 word that *can* begin a wrapped line — `and`/`or`/`not` continue
 * a predicate, `with` continues a creation, `at` continues an exposure block head, `timeout`
 * continues a fuse — because absorbing those is the continuation rule working, not failing.
 */
const CLAUSE_OPENERS: ReadonlySet<string> = new Set([
  "domain", "concept", "dimension", "touchpoints", "shape", "exposure", "action", "invariant", "scenario",
  "field", "values", "fallback",
  "wait",
  "must-see", "must-not-see",
  "by", "requires", "effect", "otherwise", "new",
  "check", "rubric",
  "expect", "lane", "checks",
  "note", "verified-by",
]);

const opensClause = (line: Line): boolean => {
  const first = line.tokens[0];
  return first !== undefined && first.kind === "KEYWORD" && CLAUSE_OPENERS.has(first.text);
};

/**
 * §17 names a delta head and `->` as constructs too, alongside the keywords. They are only checked
 * inside effect blocks: a shape's `where` may legitimately wrap onto a line that reads like `path =
 * value`, and convicting that would trade a silent bug for a noisy one.
 */
const opensEffectLine = (line: Line): boolean => {
  if (opensClause(line)) return true;
  const first = line.tokens[0];
  if (!first) return false;
  if (isOp(first, "->")) return true;
  if (!isWordLike(first)) return false;
  let i = 1;
  while (isOp(line.tokens[i], ".") && isWordLike(line.tokens[i + 1])) i += 2;
  const op = line.tokens[i];
  return op !== undefined && op.kind === "OP" && ["=", "+=", "-="].includes(op.text);
};

/** A statement header opens the block of clauses beneath it, exactly as `effect` or `values` does. */
const opensStatement = (group: Group): boolean => {
  const first = group.head.tokens[0];
  return first !== undefined && first.kind === "KEYWORD"
    && ["domain", "concept", "dimension", "touchpoints", "shape", "exposure", "action", "invariant", "scenario"].includes(first.text)
    && group.head.indent === 0;
};

/** Does this clause keep its deeper lines as a block, rather than absorbing them? */
function opensBlock(group: Group): boolean {
  const head = group.head.tokens;
  const first = head[0];
  const last = head[head.length - 1];
  if (!first) return false;
  if (isKw(first, "values") || isKw(first, "expect") || isKw(first, "to")) return true;
  if (isKw(first, "effect")) return head.length === 1;
  if (isKw(first, "lane") || isKw(first, "in") || isKw(first, "otherwise") || isKw(first, "by")) return isOp(last, ":");
  return false;
}

/**
 * Re-emit mis-indented siblings the continuation join would otherwise swallow.
 *
 * `field y: int` sitting one level too deep under `field x: int` used to be absorbed into it and
 * then dropped on the floor by the field production, which reads a fixed prefix — a declaration
 * deleted by two spaces, with no diagnostic anywhere. Cutting the body at the first line that opens
 * a clause turns it back into a sibling, where the block's own indentation check convicts it.
 */
function unfoldSiblings(groups: Group[], inEffect = false): Group[] {
  const opens = inEffect ? opensEffectLine : opensClause;
  const out: Group[] = [];
  for (const group of groups) {
    if (opensBlock(group) || opensStatement(group)) { out.push(group); continue }
    const at = group.body.findIndex(opens);
    if (at < 0) { out.push(group); continue }
    out.push({ head: group.head, body: group.body.slice(0, at) });
    out.push(...unfoldSiblings(splitBlock(group.body.slice(at)), inEffect));
  }
  return out;
}

/**
 * A clause head's own tokens. Block-opening clauses (§17) keep their deeper lines as a block;
 * every other clause absorbs them as continuation of one logical line.
 */
function clauseTokens(group: Group): Token[] {
  return opensBlock(group) ? group.head.tokens : join(group);
}

/**
 * Structural depth per logical line — the printer's single source of indentation truth.
 *
 * It lives here rather than in the printer because the two must not disagree: a printer computing
 * depth from raw columns re-emits a mis-indented clause one level deeper, cementing the mistake the
 * parser just recovered from. Sharing the walk means `fmt` repairs that line instead.
 */
export function lineDepths(lines: Line[]): Map<number, number> {
  const out = new Map<number, number>();
  const walk = (block: Line[], depth: number, inEffect: boolean): void => {
    for (const group of unfoldSiblings(splitBlock(block), inEffect)) {
      out.set(group.head.line, depth);
      if (opensBlock(group) || opensStatement(group)) {
        const first = group.head.tokens[0];
        walk(group.body, depth + 1, first !== undefined && isKw(first, "effect"));
        continue;
      }
      // A continuation of one logical line: indented one level, never further.
      for (const line of group.body) out.set(line.line, depth + 1);
    }
  };
  walk(lines, 0, false);
  return out;
}

const isKw = (t: Token | undefined, word: string): boolean => t !== undefined && t.text === word;
const isOp = (t: Token | undefined, op: string): boolean => t !== undefined && t.kind === "OP" && t.text === op;
const isNameLike = (t: Token | undefined | null): boolean =>
  t !== undefined && t !== null && (t.kind === "NAME" || t.kind === "ID");
/** Keywords are contextual — a §15 word may name an app field, dimension, or value. */
const isWordLike = (t: Token | undefined): boolean =>
  t !== undefined && (t.kind === "NAME" || t.kind === "ID" || t.kind === "IDENT" || t.kind === "KEYWORD");

function rangeOf(tokens: Token[], fallback: Token): Range {
  const first = tokens[0] ?? fallback;
  const last = tokens[tokens.length - 1] ?? fallback;
  return tokenRange(first, last);
}

export function parse(lex: LexResult): { model: Model; diagnostics: Diagnostic[] } {
  const file = lex.file;
  const diagnostics: Diagnostic[] = [];

  const report = (
    law: string, code: string, severity: Diagnostic["severity"], message: string,
    range: Range, fix?: string,
  ) => { diagnostics.push({ law, code, severity, message, file, range, ...(fix ? { fix } : {}) }); };

  const error = (code: string, message: string, range: Range, fix?: string) =>
    report("P", code, "error", message, range, fix);

  // ---------------------------------------------------------------- markers & cross-cutting

  function takeMarker(tokens: Token[]): { rest: Token[]; marker: Marker | null } {
    const at = tokens.findIndex(t => t.text === "undecided" && t.kind === "KEYWORD");
    if (at < 0) return { rest: tokens, marker: null };
    const tail = tokens.slice(at);
    const handle = tail.find(t => t.kind === "HANDLE") ?? null;
    const text = tail.find(t => t.kind === "STRING") ?? null;
    const first = tail[0];
    if (!first) return { rest: tokens, marker: null };
    return { rest: tokens.slice(0, at), marker: { handle, text, range: rangeOf(tail, first) } };
  }

  /** Consume a cross-cutting clause line if that is what it is. */
  function takeCommonClause(group: Group, common: Common): boolean {
    const tokens = join(group);
    const first = tokens[0];
    if (!first) return true;
    if (tokens.length === 1 && first.kind === "STRING") {
      if (common.doc === null) common.doc = first; else common.notes.push(first);
      return true;
    }
    if (isKw(first, "note")) {
      const s = tokens[1];
      if (s && s.kind === "STRING") common.notes.push(s);
      else error("note-operand", "`note` takes one quoted string.", rangeOf(tokens, first));
      return true;
    }
    if (isKw(first, "verified-by")) {
      const operands = tokens.slice(1);
      const start = operands[0];
      if (!start) { error("verified-by-operand", "`verified-by` takes a test path.", rangeOf(tokens, first)); return true; }
      const last = operands[operands.length - 1] ?? start;
      common.verifiedBy.push({ path: lex.source.slice(start.start, last.end), range: rangeOf(operands, start) });
      return true;
    }
    if (isKw(first, "undecided")) {
      const { marker } = takeMarker(tokens);
      if (marker) common.markers.push(marker);
      return true;
    }
    return false;
  }

  function takeHeaderExtras(tokens: Token[], common: Common): Token[] {
    let rest = tokens;
    const marker = takeMarker(rest);
    rest = marker.rest;
    if (marker.marker) common.markers.push(marker.marker);
    const doc = rest.findIndex(t => t.kind === "STRING");
    if (doc >= 0) { common.doc = rest[doc] ?? null; rest = [...rest.slice(0, doc), ...rest.slice(doc + 1)]; }
    for (let i = 0; i < rest.length - 2; i++) {
      if (isOp(rest[i], "(") && isKw(rest[i + 1], "planned") && isOp(rest[i + 2], ")")) {
        common.planned = true;
        rest = [...rest.slice(0, i), ...rest.slice(i + 3)];
        break;
      }
    }
    return rest;
  }

  function collectBody(body: Line[], common: Common, handler: (group: Group, tokens: Token[]) => void): void {
    const groups = unfoldSiblings(splitBlock(body));
    const expected = groups[0]?.head.indent;
    for (const group of groups) {
      if (expected !== undefined && group.head.indent !== expected) {
        const first = group.head.tokens[0];
        if (first) error("indent-mismatch",
          `Indentation ${group.head.indent} does not line up with this block's ${expected} (§17: 2 spaces per level).`,
          rangeOf(group.head.tokens, first), "align the line with its siblings");
      }
      if (takeCommonClause(group, common)) continue;
      handler(group, clauseTokens(group));
    }
  }

  // ---------------------------------------------------------------- expressions

  class ExprParser {
    private i = 0;
    constructor(private readonly t: Token[]) {}
    atEnd(): boolean { return this.i >= this.t.length }
    peek(): Token | undefined { return this.t[this.i] }
    rest(): Token[] { return this.t.slice(this.i) }
    private take(): Token | undefined { return this.t[this.i++] }

    parse(): Expr { return this.or() }

    private or(): Expr {
      let left = this.and();
      while (isKw(this.peek(), "or")) {
        const op = this.take();
        if (!op) break;
        const right = this.and();
        left = { kind: "binary", op, left, right, range: { start: left.range.start, end: right.range.end } };
      }
      return left;
    }
    private and(): Expr {
      let left = this.unary();
      while (isKw(this.peek(), "and")) {
        const op = this.take();
        if (!op) break;
        const right = this.unary();
        left = { kind: "binary", op, left, right, range: { start: left.range.start, end: right.range.end } };
      }
      return left;
    }
    private unary(): Expr {
      if (isKw(this.peek(), "not")) {
        const op = this.take();
        if (op) {
          const operand = this.unary();
          return { kind: "unary", op, operand, range: { start: op.pos, end: operand.range.end } };
        }
      }
      return this.cmp();
    }
    private cmp(): Expr {
      const left = this.sum();
      const t = this.peek();
      const isCmpOp = t && ((t.kind === "OP" && ["=", "!=", "<", "<=", ">", ">="].includes(t.text)) || isKw(t, "in"));
      if (!isCmpOp || !t) return left;
      const op = this.take();
      if (!op) return left;
      const right = this.sum();
      return { kind: "binary", op, left, right, range: { start: left.range.start, end: right.range.end } };
    }
    private sum(): Expr {
      let left = this.prod();
      while (isOp(this.peek(), "+") || isOp(this.peek(), "-")) {
        const op = this.take();
        if (!op) break;
        const right = this.prod();
        left = { kind: "binary", op, left, right, range: { start: left.range.start, end: right.range.end } };
      }
      return left;
    }
    private prod(): Expr {
      let left = this.atom();
      while (isOp(this.peek(), "*") || isOp(this.peek(), "/")) {
        const op = this.take();
        if (!op) break;
        const right = this.atom();
        left = { kind: "binary", op, left, right, range: { start: left.range.start, end: right.range.end } };
      }
      return left;
    }
    private atom(): Expr {
      const t = this.peek();
      if (!t) {
        const last = this.t[this.t.length - 1];
        return { kind: "error", range: last ? tokenRange(last, last) : { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } };
      }
      if (isOp(t, "(")) {
        this.take();
        const inner = this.parse();
        const close = this.peek();
        if (isOp(close, ")")) this.take();
        else error("unclosed-paren", "Expected `)`.", tokenRange(t, t));
        return { kind: "paren", inner, range: { start: t.pos, end: inner.range.end } };
      }
      if (isKw(t, "no") || isKw(t, "some")) {
        const q = this.take();
        const conceptTok = this.peek();
        if (!q) return { kind: "error", range: tokenRange(t, t) };
        if (!isNameLike(conceptTok) || !conceptTok) {
          error("quantifier-operand", "A quantifier takes a ConceptRef: `no <Concept> [where …]`.", tokenRange(t, t),
            "name the concept being quantified");
          return { kind: "error", range: tokenRange(q, q) };
        }
        this.take();
        let where: Expr | null = null;
        if (isKw(this.peek(), "where")) { this.take(); where = this.parse(); }
        return { kind: "quantified", quantifier: q, concept: conceptTok, where, range: { start: q.pos, end: (where ?? { range: tokenRange(conceptTok, conceptTok) }).range.end } };
      }
      if (t.kind === "STRING" || t.kind === "INT" || t.kind === "DECIMAL" || t.kind === "DURATION") {
        this.take();
        const type = t.kind === "STRING" ? "string" : t.kind === "INT" ? "int" : t.kind === "DECIMAL" ? "decimal" : "duration";
        return { kind: "literal", token: t, type, range: tokenRange(t, t) };
      }
      if (isKw(t, "actor") || isKw(t, "today") || isKw(t, "this")) {
        this.take();
        let segment: Token | null = null;
        let end = t;
        if (isOp(this.peek(), ".")) {
          this.take();
          const seg = this.peek();
          if (isWordLike(seg) && seg) { this.take(); segment = seg; end = seg; }
        }
        return { kind: "context", root: t, segment, range: tokenRange(t, end) };
      }
      if (isWordLike(t)) {
        const segments: Token[] = [];
        const first = this.take();
        if (!first) return { kind: "error", range: tokenRange(t, t) };
        segments.push(first);
        while (isOp(this.peek(), ".")) {
          const dot = this.t[this.i + 1];
          if (!isWordLike(dot)) break;
          this.take();
          const seg = this.take();
          if (seg) segments.push(seg);
        }
        const last = segments[segments.length - 1] ?? first;
        return { kind: "path", segments, range: tokenRange(first, last) };
      }
      this.take();
      error("unexpected-token", `Unexpected \`${t.text}\` in an expression.`, tokenRange(t, t));
      return { kind: "error", range: tokenRange(t, t) };
    }
  }

  function parseExpr(tokens: Token[], context: string): Expr | null {
    const first = tokens[0];
    if (!first) return null;
    const p = new ExprParser(tokens);
    const expr = p.parse();
    if (!p.atEnd()) {
      const leftover = p.rest();
      const lt = leftover[0];
      if (lt) error("trailing-tokens", `\`${lt.text}\` is left over after the ${context} expression.`,
        rangeOf(leftover, lt), "check the operator or split the clause");
    }
    return expr;
  }

  // ---------------------------------------------------------------- sentences

  function buildSentence(tokens: Token[]): Sentence {
    const { rest, marker } = takeMarker(tokens);
    const first = rest[0] ?? tokens[0];
    const viaAt = rest.findIndex(t => isKw(t, "via"));
    const via = viaAt >= 0 ? (rest[viaAt + 1] ?? null) : null;
    const refs: Token[] = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (!t || !isNameLike(t)) continue;
      if (viaAt >= 0 && i === viaAt + 1) continue;       // `via X` is a structural ActionRef, not residue
      refs.push(t);
    }
    const strings = rest.filter(t => t.kind === "STRING");
    return {
      tokens: rest, refs, strings, via, marker,
      range: first ? rangeOf(rest, first) : { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    };
  }

  // ---------------------------------------------------------------- shared clause pieces

  function parsePathTokens(tokens: Token[]): { path: Token[]; rest: Token[] } {
    const path: Token[] = [];
    let i = 0;
    if (!isWordLike(tokens[i])) return { path, rest: tokens };
    const head = tokens[i];
    if (head) path.push(head);
    i++;
    while (isOp(tokens[i], ".") && isWordLike(tokens[i + 1])) {
      const seg = tokens[i + 1];
      if (seg) path.push(seg);
      i += 2;
    }
    return { path, rest: tokens.slice(i) };
  }

  function splitTopLevel(tokens: Token[], word: string): [Token[], Token[]] | null {
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;
      if (t.kind === "OP" && (t.text === "(" || t.text === "[")) depth++;
      if (t.kind === "OP" && (t.text === ")" || t.text === "]")) depth--;
      if (depth === 0 && (t.text === word)) return [tokens.slice(0, i), tokens.slice(i + 1)];
    }
    return null;
  }

  function parseCommaList(tokens: Token[]): Token[][] {
    const out: Token[][] = [];
    let current: Token[] = [];
    for (const t of tokens) {
      if (isOp(t, ",")) { if (current.length) out.push(current); current = []; continue; }
      current.push(t);
    }
    if (current.length) out.push(current);
    return out;
  }

  // ---------------------------------------------------------------- statements

  function parseDomain(group: Group): DomainDecl | null {
    const common = emptyCommon();
    const tokens = takeHeaderExtras([...group.head.tokens], common);
    const name = tokens[1];
    const kw = tokens[0];
    if (!kw) return null;
    if (!name) { error("domain-name", "`domain` needs a name.", rangeOf(tokens, kw)); return null; }
    const clauses: DomainClause[] = [];
    collectBody(group.body, common, (g, t) => {
      const first = t[0];
      if (!first) return;
      if (isKw(first, "mode")) {
        const value = t[1];
        if (value) clauses.push({ kind: "mode", value, range: rangeOf(t, first) });
        else error("mode-operand", "`mode` takes model-first, code-first, or mixed.", rangeOf(t, first));
        return;
      }
      if (isKw(first, "uses")) { clauses.push({ kind: "uses", libs: t.slice(1), range: rangeOf(t, first) }); return; }
      clauses.push({ kind: "meta", key: first, value: t.slice(1), range: rangeOf(t, first) });
    });
    return { file, name, clauses, range: rangeOf(join(group), kw), common };
  }

  function parseDimension(group: Group, common = emptyCommon()): DimensionDecl | null {
    const tokens = takeHeaderExtras(join(group), common);
    const kw = tokens[0];
    const name = tokens[1];
    if (!kw) return null;
    if (!isWordLike(name) || !name) {
      error("dimension-name", "`dimension` needs a name.", rangeOf(tokens, kw), "write `dimension <name> = a | b`");
      return null;
    }
    if (!isOp(tokens[2], "=")) {
      error("dimension-values", "`dimension` needs `= value | value`.", rangeOf(tokens, kw), "list the closed vocabulary");
      return { kind: "dimension", file, name, values: [], range: rangeOf(tokens, kw), common };
    }
    const values: Token[] = [];
    for (let i = 3; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;
      if (isOp(t, "|")) continue;
      if (isWordLike(t)) values.push(t);
      else error("dimension-value", `\`${t.text}\` is not a dimension value.`, tokenRange(t, t));
    }
    return { kind: "dimension", file, name, values, range: rangeOf(tokens, kw), common };
  }

  function parseType(tokens: Token[], at: Token): TypeRef | null {
    const name = tokens[0];
    if (!isWordLike(name) || !name) { error("field-type", "A field needs a type.", tokenRange(at, at), "e.g. `field due_date: date`"); return null; }
    const optional = isOp(tokens[1], "?");
    return { name, optional, range: tokenRange(name, optional ? (tokens[1] ?? name) : name) };
  }

  function parseConcept(group: Group): ConceptDecl | null {
    const common = emptyCommon();
    const tokens = takeHeaderExtras([...group.head.tokens], common);
    const kw = tokens[0];
    const name = tokens[1];
    if (!kw) return null;
    if (!isNameLike(name) || !name) { error("concept-name", "`concept` needs a Capitalized name.", rangeOf(tokens, kw)); return null; }
    const decl: ConceptDecl = {
      kind: "concept", file, name, dimensions: [], fields: [], values: [], fallback: null,
      range: rangeOf(tokens, kw), common,
    };
    collectBody(group.body, common, (g, t) => {
      const first = t[0];
      if (!first) return;
      if (isKw(first, "dimension")) {
        const dim = parseDimension(g);
        if (dim) decl.dimensions.push(dim);
        return;
      }
      if (isKw(first, "field")) {
        const fname = t[1];
        if (!isWordLike(fname) || !fname) { error("field-name", "`field` needs a name.", rangeOf(t, first)); return; }
        if (!isOp(t[2], ":")) { error("field-colon", "`field <name>: <type>` — the colon is required.", rangeOf(t, first)); return; }
        const type = parseType(t.slice(3), first);
        if (type) decl.fields.push({ name: fname, type, range: rangeOf(t, first) } satisfies FieldDecl);
        return;
      }
      if (isKw(first, "fallback")) {
        const s = t[1];
        if (s && s.kind === "STRING") decl.fallback = s;
        else error("fallback-operand", "`fallback` takes one quoted string.", rangeOf(t, first));
        return;
      }
      if (isKw(first, "values")) {
        if (t.length > 1) error("values-inline", "`values` opens a block of line entries (§17, E52).", rangeOf(t, first),
          "put each entry on its own indented line");
        for (const entryGroup of splitBlock(g.body)) {
          const et = join(entryGroup);
          const { rest, marker } = takeMarker(et);
          const ename = rest[0];
          if (!ename) continue;
          const pipe = rest.find(x => isOp(x, "|"));
          if (pipe) {
            error("values-pipe", "`values` entries are one per line; `|` is dimension syntax only (E52).",
              rangeOf(et, ename), "split the list into line entries");
            continue;
          }
          const copy = rest.find(x => x.kind === "STRING") ?? null;
          decl.values.push({ name: ename, copy, marker, range: rangeOf(et, ename) } satisfies ValuesEntry);
        }
        return;
      }
      error("concept-clause", `\`${first.text}\` is not a concept clause (field, dimension, values, fallback).`,
        rangeOf(t, first));
    });
    return decl;
  }

  function parseTouchpoints(group: Group): TouchpointsDecl | null {
    const common = emptyCommon();
    const tokens = join(group);
    const kw = tokens[0];
    if (!kw) return null;
    const lanes: Token[] = [];
    for (const g of splitBlock(group.body)) {
      const t = join(g);
      const s = t[0];
      if (s && s.kind === "STRING") lanes.push(s);
      else if (s) error("lane-name", "A touchpoint lane is a quoted string (E11).", rangeOf(t, s));
    }
    return { kind: "touchpoints", file, lanes, range: rangeOf(tokens, kw), common };
  }

  function parseHeaderName(tokens: Token[], kindWord: string): { id: Token | null; name: Token | null; rest: Token[] } {
    let i = 1;
    let id: Token | null = null;
    const maybeId = tokens[i];
    if (maybeId && maybeId.kind === "ID" && isNameLike(tokens[i + 1])) { id = maybeId; i++; }
    const name = tokens[i] ?? null;
    if (!isNameLike(name) || !name) {
      const anchor = tokens[0];
      if (anchor) error(`${kindWord}-name`, `\`${kindWord}\` needs a Capitalized name.`, rangeOf(tokens, anchor));
      return { id, name: null, rest: tokens.slice(i) };
    }
    return { id, name, rest: tokens.slice(i + 1) };
  }

  function parseShape(group: Group): ShapeDecl | null {
    const common = emptyCommon();
    const tokens = takeHeaderExtras([...group.head.tokens], common);
    const kw = tokens[0];
    if (!kw) return null;
    const { id, name, rest } = parseHeaderName(tokens, "shape");
    if (!name) return null;
    let of: Token | null = null;
    if (isKw(rest[0], "of")) of = rest[1] ?? null;
    const decl: ShapeDecl = { kind: "shape", file, id, name, of, where: null, fuse: null, range: rangeOf(tokens, kw), common };
    collectBody(group.body, common, (g, t) => {
      const first = t[0];
      if (!first) return;
      if (isKw(first, "where")) {
        const { rest: body, marker } = takeMarker(t.slice(1));
        if (marker) common.markers.push(marker);
        decl.where = parseExpr(body, "`where`");
        return;
      }
      if (isKw(first, "wait")) { decl.fuse = parseFuse(t, first); return; }
      error("shape-clause", `\`${first.text}\` is not a shape clause (where, wait).`, rangeOf(t, first));
    });
    return decl;
  }

  function parseFuse(t: Token[], first: Token): Fuse | null {
    if (!isOp(t[1], "[")) {
      error("fuse-triggers", "The fuse needs a bracketed trigger list: `wait [A, B] timeout <expr> -> Action` (E50).",
        rangeOf(t, first));
      return null;
    }
    let i = 2;
    const triggers: Token[] = [];
    while (i < t.length && !isOp(t[i], "]")) {
      const tok = t[i];
      if (tok && isNameLike(tok)) triggers.push(tok);
      else if (tok && !isOp(tok, ",")) error("fuse-trigger", `\`${tok.text}\` is not an ActionRef.`, tokenRange(tok, tok));
      i++;
    }
    i++; // ]
    if (!isKw(t[i], "timeout")) { error("fuse-timeout", "The fuse needs `timeout <expr>`.", rangeOf(t, first)); return null; }
    i++;
    const arrowAt = t.findIndex((x, idx) => idx >= i && isOp(x, "->"));
    if (arrowAt < 0) { error("fuse-target", "The fuse needs `-> <Action>` (E50: the fuse fires an action).", rangeOf(t, first)); return null; }
    const timeout = parseExpr(t.slice(i, arrowAt), "`timeout`");
    const target = t[arrowAt + 1] ?? null;
    if (!timeout || !isNameLike(target) || !target) { error("fuse-target", "The fuse's timeout target must be a declared action.", rangeOf(t, first)); return null; }
    return { triggers, timeout, target, range: rangeOf(t, first) };
  }

  function parseExposure(group: Group): ExposureDecl | null {
    const common = emptyCommon();
    const tokens = takeHeaderExtras([...group.head.tokens], common);
    const kw = tokens[0];
    if (!kw) return null;
    const concept = tokens[1];
    if (!isNameLike(concept) || !concept) { error("exposure-subject", "`exposure` needs a ConceptRef.", rangeOf(tokens, kw)); return null; }
    const blocks: ToBlock[] = [];
    collectBody(group.body, common, (g, t) => {
      const first = t[0];
      if (!first) return;
      if (!isKw(first, "to")) { error("exposure-clause", "An exposure block starts `to <actor> at \"<lane>\"`.", rangeOf(t, first)); return; }
      const actor = t[1];
      if (!actor) { error("exposure-actor", "`to` needs an actor value.", rangeOf(t, first)); return; }
      if (!isKw(t[2], "at")) { error("exposure-at", "`to <actor> at \"<lane>\"` — `at` is required.", rangeOf(t, first)); return; }
      const lane = t[3];
      if (!lane || lane.kind !== "STRING") { error("exposure-lane", "`at` takes a declared lane, quoted.", rangeOf(t, first)); return; }
      const block: ToBlock = { actor, lane, mustSee: [], mustNotSee: [], range: rangeOf(t, first) };
      for (const fg of splitBlock(g.body)) {
        const ft = join(fg);
        const fk = ft[0];
        if (!fk) continue;
        const target = isKw(fk, "must-see") ? block.mustSee : isKw(fk, "must-not-see") ? block.mustNotSee : null;
        if (!target) { error("exposure-fact-clause", "Exposure facts are listed under `must-see` / `must-not-see`.", rangeOf(ft, fk)); continue; }
        for (const item of parseCommaList(ft.slice(1))) {
          const { path } = parsePathTokens(item);
          const anchor = item[0];
          if (path.length === 0 || !anchor) { if (anchor) error("exposure-fact", `\`${anchor.text}\` is not a fact (path or ConceptRef).`, rangeOf(item, anchor)); continue; }
          target.push({ path, range: rangeOf(item, anchor) } satisfies Fact);
        }
      }
      blocks.push(block);
    });
    return { kind: "exposure", file, concept, blocks, range: rangeOf(tokens, kw), common };
  }

  function parseCondition(t: Token[], first: Token): Condition {
    const { rest: withoutMarker, marker } = takeMarker(t.slice(1));
    const split = splitTopLevel(withoutMarker, "else");
    const operand = split ? split[0] : withoutMarker;
    const elseCode = split ? (split[1][0] ?? null) : null;
    const negated = isKw(operand[0], "not");
    const bare = negated ? operand.slice(1) : operand;
    if (bare.length === 1 && isNameLike(bare[0]) && bare[0]) {
      return { negated, shape: bare[0], expr: null, elseCode, marker, range: rangeOf(t, first) };
    }
    return { negated: false, shape: null, expr: parseExpr(operand, "`requires`"), elseCode, marker, range: rangeOf(t, first) };
  }

  function parseEffectLine(g: Group): EffectLine {
    const t = join(g);
    const first = t[0];
    const { rest, marker } = takeMarker(t);
    if (!first) {
      const anchor = g.head.tokens[0];
      const empty: Range = anchor ? tokenRange(anchor, anchor) : { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };
      return { kind: "sentence", sentence: buildSentence([]), nearMiss: false, range: empty };
    }
    const head = rest[0];
    const range = rangeOf(t, first);

    if (isKw(head, "new") && head) {
      const concept = rest[1];
      if (!isNameLike(concept) || !concept) {
        error("creation-concept", "`new` needs a ConceptRef (E49).", range, "e.g. `new Loan with status = open`");
        return { kind: "sentence", sentence: buildSentence(t), nearMiss: false, range };
      }
      const assignments: Array<{ name: Token; expr: Expr }> = [];
      if (isKw(rest[2], "with")) {
        for (const item of parseCommaList(rest.slice(3))) {
          const key = item[0];
          if (!key || !isOp(item[1], "=")) {
            if (key) error("creation-assignment", "`with` takes `name = value` pairs (E49).", rangeOf(item, key));
            continue;
          }
          const expr = parseExpr(item.slice(2), "`with`");
          if (expr) assignments.push({ name: key, expr });
        }
      } else if (rest.length > 2) {
        const extra = rest[2];
        if (extra) error("creation-tail", `\`${extra.text}\` follows \`new ${concept.text}\`; expected \`with …\`.`, rangeOf(rest.slice(2), extra));
      }
      return { kind: "creation", concept, assignments, marker, range };
    }

    if (isOp(head, "->") && head) {
      const shape = rest[1];
      if (!isNameLike(shape) || !shape) {
        error("outcome-target", "`->` claims a landing in a declared shape.", range);
        return { kind: "sentence", sentence: buildSentence(t), nearMiss: false, range };
      }
      return { kind: "outcome", shape, marker, range };
    }

    // trial-parse: a line is a delta iff it parses WHOLLY as `path op expr` (§4.6)
    const { path, rest: afterPath } = parsePathTokens(rest);
    const op = afterPath[0];
    const isDeltaOp = op !== undefined && op.kind === "OP" && ["=", "+=", "-="].includes(op.text);
    if (path.length > 0 && isDeltaOp && op) {
      const exprTokens = afterPath.slice(1);
      const probe = new ExprParser(exprTokens);
      const expr = probe.parse();
      if (probe.atEnd() && expr.kind !== "error" && exprTokens.length > 0) {
        return { kind: "delta", path, op, expr, marker, range };
      }
      return { kind: "sentence", sentence: buildSentence(t), nearMiss: true, range };
    }
    return { kind: "sentence", sentence: buildSentence(t), nearMiss: false, range };
  }

  function parseEffectBlock(g: Group, first: Token, t: Token[]): EffectBlock {
    const inline = t.slice(1);
    if (inline.length > 0) {
      const line = parseEffectLine({ head: { ...g.head, tokens: inline }, body: [] });
      return { lines: [line], range: rangeOf(t, first) };
    }
    const lines: EffectLine[] = [];
    const groups = unfoldSiblings(splitBlock(g.body), true);
    const expected = groups[0]?.head.indent;
    for (const eg of groups) {
      if (expected !== undefined && eg.head.indent !== expected) {
        const anchor = eg.head.tokens[0];
        if (anchor) error("indent-mismatch",
          `Indentation ${eg.head.indent} does not line up with this effect block's ${expected} (§17: 2 spaces per level).`,
          rangeOf(eg.head.tokens, anchor), "align the line with its siblings");
      }
      lines.push(parseEffectLine(eg));
    }
    if (lines.length === 0) error("empty-effect", "`effect` needs at least one effect line.", rangeOf(t, first));
    return { lines, range: rangeOf(t, first) };
  }

  function parseAction(group: Group): ActionDecl | null {
    const common = emptyCommon();
    const tokens = takeHeaderExtras([...group.head.tokens], common);
    const kw = tokens[0];
    if (!kw) return null;
    const { id, name, rest } = parseHeaderName(tokens, "action");
    if (!name) return null;
    let of: Token | null = null;
    if (isKw(rest[0], "of")) of = rest[1] ?? null;
    const decl: ActionDecl = {
      kind: "action", file, id, name, of, by: [], conditions: [], actorBlocks: [], branches: [],
      effect: null, range: rangeOf(tokens, kw), common,
    };
    collectBody(group.body, common, (g, t) => {
      const first = t[0];
      if (!first) return;
      if (isKw(first, "by")) {
        const last = t[t.length - 1];
        if (isOp(last, ":")) {
          const actor = t[1];
          if (!actor || t.length !== 3) { error("actor-block-head", "An actor block heads `by <actor>:` (E48).", rangeOf(t, first)); return; }
          const conditions: Condition[] = [];
          for (const cg of splitBlock(g.body)) {
            const ct = join(cg);
            const cf = ct[0];
            if (!cf) continue;
            if (!isKw(cf, "requires")) { error("actor-block-body", "An actor block holds `requires` lines only (E48).", rangeOf(ct, cf)); continue; }
            conditions.push(parseCondition(ct, cf));
          }
          decl.actorBlocks.push({ actor, conditions, range: rangeOf(t, first) } satisfies ActorBlock);
          return;
        }
        for (const item of parseCommaList(t.slice(1))) { const a = item[0]; if (a) decl.by.push(a); }
        return;
      }
      if (isKw(first, "requires")) { decl.conditions.push(parseCondition(t, first)); return; }
      if (isKw(first, "in") || isKw(first, "otherwise")) {
        const shape = isKw(first, "in") ? (t[1] ?? null) : null;
        const colonAt = t.findIndex(x => isOp(x, ":"));
        if (colonAt < 0) { error("branch-colon", "A branch head ends with `:` (E47).", rangeOf(t, first)); return; }
        if (colonAt !== t.length - 1) {
          const extra = t.slice(colonAt + 1);
          const e0 = extra[0];
          if (e0) error("branch-inline", "Branch bodies are block-only — there is no inline branch form (§17).",
            rangeOf(extra, e0), "indent the effect block under the branch head");
        }
        let effect: EffectBlock | null = null;
        for (const bg of splitBlock(g.body)) {
          const bt = clauseTokens(bg);
          const bf = bt[0];
          if (!bf) continue;
          if (isKw(bf, "effect")) effect = parseEffectBlock(bg, bf, bt);
          else error("branch-body", "A branch body is effect content only (E47).", rangeOf(bt, bf));
        }
        if (!effect) error("branch-empty", "A branch needs an `effect` block.", rangeOf(t, first));
        decl.branches.push({ head: first, shape, effect, range: rangeOf(t, first) } satisfies Branch);
        return;
      }
      if (isKw(first, "effect")) { decl.effect = parseEffectBlock(g, first, t); return; }
      error("action-clause", `\`${first.text}\` is not an action clause (by, requires, in, otherwise, effect).`, rangeOf(t, first));
    });
    return decl;
  }

  function parseInvariant(group: Group): InvariantDecl | null {
    const common = emptyCommon();
    const tokens = takeHeaderExtras([...group.head.tokens], common);
    const kw = tokens[0];
    if (!kw) return null;
    const { id, name } = parseHeaderName(tokens, "invariant");
    if (!name) return null;
    const decl: InvariantDecl = { kind: "invariant", file, id, name, checkBy: null, rubric: null, range: rangeOf(tokens, kw), common };
    collectBody(group.body, common, (g, t) => {
      const first = t[0];
      if (!first) return;
      if (isKw(first, "check")) {
        if (!isKw(t[1], "by")) { error("check-by", "`check by <kind>` — `by` is required.", rangeOf(t, first)); return; }
        decl.checkBy = t[2] ?? null;
        if (!decl.checkBy) error("check-kind", "`check by` needs a kind.", rangeOf(t, first));
        return;
      }
      if (isKw(first, "rubric")) {
        const s = t[1];
        if (s && s.kind === "STRING") decl.rubric = s;
        else error("rubric-operand", "`rubric` takes one quoted string.", rangeOf(t, first));
        return;
      }
      error("invariant-clause", `\`${first.text}\` is not an invariant clause (check by, rubric).`, rangeOf(t, first));
    });
    return decl;
  }

  function parseLaneLine(g: Group, t: Token[], first: Token): LaneLine | null {
    const lane = t[1];
    if (!lane || lane.kind !== "STRING") { error("lane-operand", "`lane \"<name>\":` needs a declared lane.", rangeOf(t, first)); return null; }
    if (!isOp(t[2], ":")) { error("lane-colon", "`lane \"<name>\": <sentence>` — the colon is required.", rangeOf(t, first)); return null; }
    const inline = t.slice(3);
    const sentences: Sentence[] = [];
    if (inline.length > 0) sentences.push(buildSentence(inline));
    else for (const sg of splitBlock(g.body)) sentences.push(buildSentence(join(sg)));
    return { lane, sentences, range: rangeOf(t, first) };
  }

  function parseScenario(group: Group): ScenarioDecl | null {
    const common = emptyCommon();
    const tokens = takeHeaderExtras([...group.head.tokens], common);
    const kw = tokens[0];
    if (!kw) return null;
    const { id, name } = parseHeaderName(tokens, "scenario");
    if (!name) return null;
    const decl: ScenarioDecl = {
      kind: "scenario", file, id, name, worlds: [], steps: [], expects: [], lanes: [], checks: [],
      range: rangeOf(tokens, kw), common,
    };
    collectBody(group.body, common, (g, t) => {
      const first = t[0];
      if (!first) return;
      if (isKw(first, "with")) { decl.worlds.push(buildSentence(t.slice(1))); return; }
      if (isKw(first, "checks")) {
        for (const item of parseCommaList(t.slice(1))) { const c = item[0]; if (c) decl.checks.push(c); }
        return;
      }
      if (isKw(first, "lane")) { const l = parseLaneLine(g, t, first); if (l) decl.lanes.push(l); return; }
      if (isKw(first, "expect")) {
        const block: ExpectBlock = { sentences: [], lanes: [], range: rangeOf(t, first) };
        for (const eg of splitBlock(g.body)) {
          const et = join(eg);
          const ef = et[0];
          if (!ef) continue;
          if (isKw(ef, "lane")) { const l = parseLaneLine(eg, et, ef); if (l) block.lanes.push(l); }
          else block.sentences.push(buildSentence(et));
        }
        decl.expects.push(block);
        return;
      }
      const arrow = splitTopLevel(t, "->");
      if (arrow) {
        const [before, after] = arrow;
        const sentence = buildSentence(before);
        const head = after[0];
        let expectation: Expectation | null = null;
        if (isKw(head, "denied") && head) {
          const code = after[1];
          if (code) expectation = { kind: "denied", code, range: rangeOf(after, head) };
          else error("denied-code", "`-> denied <CODE>` needs a deny code.", rangeOf(t, first));
        } else if (after.length === 1 && isNameLike(after[0]) && after[0]) {
          expectation = { kind: "shape", shape: after[0], range: rangeOf(after, after[0]) };
        } else if (head) {
          expectation = { kind: "sentence", sentence: buildSentence(after), range: rangeOf(after, head) };
        }
        decl.steps.push({ sentence, expectation, range: rangeOf(t, first) } satisfies Step);
        return;
      }
      decl.steps.push({ sentence: buildSentence(t), expectation: null, range: rangeOf(t, first) } satisfies Step);
    });
    return decl;
  }

  // ---------------------------------------------------------------- driver

  const statements: Statement[] = [];
  let domain: DomainDecl | null = null;

  for (const group of splitBlock(lex.lines)) {
    const first = group.head.tokens[0];
    if (!first) continue;
    if (group.head.indent !== 0) {
      error("statement-indent", "Statements start at column 1.", rangeOf(group.head.tokens, first),
        "outdent the declaration or indent it under its parent");
      continue;
    }
    switch (first.text) {
      case "domain": {
        const d = parseDomain(group);
        if (d) { if (domain) error("duplicate-domain", "A file declares at most one `domain` header.", d.range); else domain = d; }
        break;
      }
      case "concept": { const s = parseConcept(group); if (s) statements.push(s); break }
      case "dimension": { const s = parseDimension(group); if (s) statements.push(s); break }
      case "touchpoints": { const s = parseTouchpoints(group); if (s) statements.push(s); break }
      case "shape": { const s = parseShape(group); if (s) statements.push(s); break }
      case "exposure": { const s = parseExposure(group); if (s) statements.push(s); break }
      case "action": { const s = parseAction(group); if (s) statements.push(s); break }
      case "invariant": { const s = parseInvariant(group); if (s) statements.push(s); break }
      case "scenario": { const s = parseScenario(group); if (s) statements.push(s); break }
      default:
        error("unknown-statement", `\`${first.text}\` does not open a kernel statement (§4: the kernel eight).`,
          rangeOf(group.head.tokens, first), "start the line with concept, dimension, touchpoints, shape, exposure, action, invariant, or scenario");
    }
  }

  return { model: { file, domain, statements }, diagnostics };
}

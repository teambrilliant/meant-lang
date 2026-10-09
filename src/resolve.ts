import type { Diagnostic, Range } from "./diagnostics";
import type { Token } from "./lexer";
import { tokenRange, DATA_TYPES } from "./lexer";
import type { RunIndex } from "./domains";
import { EMPTY_INDEX } from "./domains";
import type {
  ActionDecl, ConceptDecl, DimensionDecl, DomainModel, Expr, InvariantDecl, ScenarioDecl, ShapeDecl, ValuesEntry,
} from "./cst";

export type VType =
  | { k: "int" } | { k: "decimal" } | { k: "string" } | { k: "bool" }
  | { k: "date" } | { k: "duration" } | { k: "identity" }
  | { k: "concept"; name: string }
  | { k: "dim"; owner: string | null; name: string; values: string[] }
  | { k: "opt"; inner: VType }
  /** A bare word that resolved to nothing yet — a dimension value or a `values` entry, decided by its peer. */
  | { k: "word"; token: Token }
  | { k: "error" };

export interface ConceptInfo {
  decl: ConceptDecl;
  fields: Map<string, { name: Token; type: VType; typeToken: Token }>;
  dimensions: Map<string, DimensionDecl>;
  values: Map<string, ValuesEntry>;
}

export interface Duplicate { token: Token; what: string; first: Token }

/**
 * Where a check's findings land. A domain spans files, so the sink carries the file of the
 * declaration being checked — every expression inside it lives in that file too.
 */
export interface Sink { file: string; out: Diagnostic[] }

export interface ResolvedModel {
  model: DomainModel;
  concepts: Map<string, ConceptInfo>;
  domainDimensions: Map<string, DimensionDecl>;
  shapes: Map<string, ShapeDecl>;
  shapeList: ShapeDecl[];
  actions: Map<string, ActionDecl>;
  actionList: ActionDecl[];
  invariants: Map<string, InvariantDecl>;
  invariantList: InvariantDecl[];
  scenarios: ScenarioDecl[];
  lanes: Map<string, Token>;
  actorDimension: DimensionDecl | null;
  denyCodes: ConceptInfo | null;
  duplicates: Duplicate[];
  subjects: Map<ActionDecl, string | null>;
  subjectDiagnostics: Diagnostic[];
  /** Every `path op expr` delta, by concept — feeds the no-writer smell. */
  writes: Set<string>;
  typeOf(expr: Expr, subject: string | null, sink: Sink): VType;
  resolvePath(segments: Token[], subject: string | null, sink: Sink): VType;
  relationRoute(from: string, to: string): "direct" | "child" | "none" | "ambiguous";
  describe(type: VType): string;
  checkDelta(path: Token[], op: Token, value: Expr, subject: string | null, sink: Sink): void;
  checkMemberAssignment(concept: Token, member: Token, value: Expr, subject: string | null, sink: Sink): void;
  /** For a name this domain never declares: where else in the run it is declared, if anywhere. */
  elsewhere(name: string): Elsewhere | null;
}

/** An unresolved name another domain in the run declares: a sentence for the message, and the fix. */
export interface Elsewhere { note: string; fix: string }

/** Levenshtein distance — "did you mean" fires only for a header one or two edits away. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

const isNameTok = (t: Token): boolean => t.kind === "NAME" || t.kind === "ID";

export function resolve(model: DomainModel, run: RunIndex = EMPTY_INDEX): ResolvedModel {
  const concepts = new Map<string, ConceptInfo>();
  const domainDimensions = new Map<string, DimensionDecl>();
  const shapes = new Map<string, ShapeDecl>();
  const shapeList: ShapeDecl[] = [];
  const actions = new Map<string, ActionDecl>();
  const actionList: ActionDecl[] = [];
  const invariants = new Map<string, InvariantDecl>();
  const invariantList: InvariantDecl[] = [];
  const scenarios: ScenarioDecl[] = [];
  const lanes = new Map<string, Token>();
  const duplicates: Duplicate[] = [];
  const declared = new Map<string, Token>();

  const claim = (token: Token, what: string) => {
    const first = declared.get(token.text);
    if (first) duplicates.push({ token, what, first });
    else declared.set(token.text, token);
  };

  // ---- pass 1: declarations
  for (const st of model.statements) {
    switch (st.kind) {
      case "concept": {
        claim(st.name, "concept");
        if (!concepts.has(st.name.text)) {
          concepts.set(st.name.text, {
            decl: st, fields: new Map(), dimensions: new Map(), values: new Map(),
          });
        }
        break;
      }
      case "dimension": domainDimensions.set(st.name.text, st); break;
      case "touchpoints": for (const l of st.lanes) lanes.set(l.value, l); break;
      case "shape":
        claim(st.name, "shape");
        shapeList.push(st);
        shapes.set(st.name.text, st);
        if (st.id) { claim(st.id, "shape id"); shapes.set(st.id.text, st); }
        break;
      case "action":
        claim(st.name, "action");
        actionList.push(st);
        actions.set(st.name.text, st);
        if (st.id) { claim(st.id, "action id"); actions.set(st.id.text, st); }
        break;
      case "invariant":
        claim(st.name, "invariant");
        invariantList.push(st);
        invariants.set(st.name.text, st);
        if (st.id) { claim(st.id, "invariant id"); invariants.set(st.id.text, st); }
        break;
      case "scenario":
        claim(st.name, "scenario");
        scenarios.push(st);
        if (st.id) claim(st.id, "scenario id");
        break;
      default: break;
    }
  }

  const typeOfToken = (t: Token): VType => {
    const text = t.text;
    if (DATA_TYPES.has(text)) {
      if (text === "int") return { k: "int" };
      if (text === "decimal") return { k: "decimal" };
      if (text === "string") return { k: "string" };
      if (text === "bool") return { k: "bool" };
      if (text === "date") return { k: "date" };
      return { k: "duration" };
    }
    if (concepts.has(text)) return { k: "concept", name: text };
    const dim = domainDimensions.get(text);
    if (dim) return { k: "dim", owner: null, name: text, values: dim.values.map(v => v.text) };
    return { k: "error" };
  };

  // ---- pass 2: concept members
  for (const info of concepts.values()) {
    for (const d of info.decl.dimensions) info.dimensions.set(d.name.text, d);
    for (const f of info.decl.fields) {
      const base = typeOfToken(f.type.name);
      info.fields.set(f.name.text, {
        name: f.name,
        type: f.type.optional ? { k: "opt", inner: base } : base,
        typeToken: f.type.name,
      });
    }
    for (const v of info.decl.values) info.values.set(v.name.text, v);
  }

  const actorDimension = domainDimensions.get("actor") ?? null;
  const denyCodes = concepts.get("DenyCode") ?? null;

  // ---- relations
  const relationRoute = (from: string, to: string): "direct" | "child" | "none" | "ambiguous" => {
    const fromInfo = concepts.get(from);
    const toInfo = concepts.get(to);
    if (!fromInfo || !toInfo) return "none";
    let direct = 0, child = 0;
    for (const f of fromInfo.fields.values()) if (f.type.k === "concept" && f.type.name === to) direct++;
    for (const f of toInfo.fields.values()) if (f.type.k === "concept" && f.type.name === from) child++;
    if (direct > 1 || child > 1 || (direct === 1 && child === 1)) return "ambiguous";
    if (direct === 1) return "direct";
    if (child === 1) return "child";
    return "none";
  };

  const describe = (t: VType): string => {
    switch (t.k) {
      case "concept": return t.name;
      case "dim": return `${t.name} (${t.values.join(" | ")})`;
      case "opt": return `${describe(t.inner)}?`;
      case "word": return `\`${t.token.text}\``;
      case "identity": return "identity";
      default: return t.k;
    }
  };

  const own = model.domain?.name.text ?? null;
  const elsewhere = (name: string): Elsewhere | null => {
    const hits = (run.declared.get(name) ?? []).filter(h => h.domain !== own);
    const first = hits[0];
    if (!first) return null;
    const near = own === null ? undefined : hits.find(h => editDistance(own, h.domain) <= 2);
    return {
      note: ` It is declared in ${hits.map(h => `domain \`${h.domain}\` (${h.token.file}:${h.token.pos.line})`).join(", ")}.`,
      fix: near
        ? `did you mean \`domain ${near.domain}\`? domains in this run: ${run.domains.join(", ")}`
        : `a domain resolves only its own declarations (§1) — declare it here, or move this file into domain \`${first.domain}\``,
    };
  };

  const push = (sink: Sink, law: string, code: string, severity: Diagnostic["severity"],
    message: string, range: Range, fix?: string) => {
    sink.out.push({ law, code, severity, message, file: sink.file, range, ...(fix ? { fix } : {}) });
  };

  const unresolved = (sink: Sink, code: string, token: Token, message: string, fix: string) => {
    const hint = elsewhere(token.text);
    push(sink, "V2", code, "error", `${message}${hint?.note ?? ""}`, tokenRange(token, token), hint?.fix ?? fix);
  };

  const memberType = (conceptName: string, member: Token, sink: Sink): VType => {
    const info = concepts.get(conceptName);
    if (!info) return { k: "error" };
    if (member.text === "id") return { k: "identity" };
    const field = info.fields.get(member.text);
    if (field) {
      if (field.type.k === "error") {
        unresolved(sink, "unresolved-type", field.typeToken, `\`${field.typeToken.text}\` is not a data type or a declared concept.`,
          "declare the concept or use a §4.1 data type");
      }
      return field.type;
    }
    const dim = info.dimensions.get(member.text);
    if (dim) return { k: "dim", owner: conceptName, name: dim.name.text, values: dim.values.map(v => v.text) };
    push(sink, "V4", "unresolved-path", "error", `\`${member.text}\` is not a field or dimension of ${conceptName}.`,
      tokenRange(member, member), `declare it on \`concept ${conceptName}\` or fix the path`);
    return { k: "error" };
  };

  const resolvePath = (segments: Token[], subject: string | null, sink: Sink): VType => {
    const head = segments[0];
    if (!head) return { k: "error" };
    let current: VType;
    let start = 1;

    if (isNameTok(head)) {
      if (!concepts.has(head.text)) {
        if (segments.length === 1) return { k: "word", token: head };
        unresolved(sink, "unresolved-ref", head, `\`${head.text}\` is not a declared concept.`,
          `declare \`concept ${head.text}\` or fix the reference`);
        return { k: "error" };
      }
      if (subject && head.text !== subject) {
        const route = relationRoute(subject, head.text);
        if (route === "none") {
          push(sink, "V4", "no-relation", "error", `${subject} has no relation to ${head.text}; a concept-rooted path resolves through the unique relation (E31).`,
            tokenRange(head, head), `declare the relation field, or root the path at ${subject}`);
          return { k: "error" };
        }
        if (route === "ambiguous") {
          push(sink, "V4", "ambiguous-relation", "error", `Two candidate relations connect ${subject} and ${head.text} — the path is ambiguous (E31).`,
            tokenRange(head, head), "name the field explicitly");
          return { k: "error" };
        }
      }
      current = { k: "concept", name: head.text };
    } else if (subject === null) {
      push(sink, "V9", "no-subject", "error", `\`${head.text}\` has no subject to resolve against.`,
        tokenRange(head, head), "pin the subject with `of <Concept>`");
      return { k: "error" };
    } else {
      const info = concepts.get(subject);
      if (!info) return { k: "error" };
      if (!info.fields.has(head.text) && !info.dimensions.has(head.text)) {
        if (segments.length === 1) return { k: "word", token: head };
        push(sink, "V4", "unresolved-path", "error", `\`${head.text}\` is not a field or dimension of ${subject}.`,
          tokenRange(head, head), `declare it on \`concept ${subject}\``);
        return { k: "error" };
      }
      current = memberType(subject, head, sink);
      start = 1;
    }

    for (let i = start; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) break;
      const base = current.k === "opt" ? current.inner : current;
      if (base.k !== "concept") {
        push(sink, "V4", "not-a-concept", "error", `\`${seg.text}\` cannot be read off ${describe(base)}.`,
          tokenRange(seg, seg), "shorten the path");
        return { k: "error" };
      }
      current = memberType(base.name, seg, sink);
      if (current.k === "error") return current;
    }
    return current;
  };

  const numeric = (t: VType): boolean => t.k === "int" || t.k === "decimal";

  const settleWord = (word: Extract<VType, { k: "word" }>, peer: VType, sink: Sink): boolean => {
    const base = peer.k === "opt" ? peer.inner : peer;
    if (base.k === "dim") {
      if (!base.values.includes(word.token.text)) {
        push(sink, "V3", "unknown-dimension-value", "error",
          `\`${word.token.text}\` is not a value of \`${base.name}\` (${base.values.join(" | ")}).`,
          tokenRange(word.token, word.token), `add it to the dimension, or use a declared value`);
      }
      return true;
    }
    if (base.k === "concept") {
      const info = concepts.get(base.name);
      if (info && info.values.has(word.token.text)) return true;
      if (info && info.values.size > 0) {
        push(sink, "V3", "unknown-values-entry", "error",
          `\`${word.token.text}\` is not a declared value of ${base.name}.`,
          tokenRange(word.token, word.token), `add it under \`concept ${base.name}\`'s \`values\``);
        return true;
      }
    }
    return false;
  };

  const reportLooseWord = (t: VType, sink: Sink) => {
    if (t.k !== "word") return;
    const tok = t.token;
    if (isNameTok(tok)) {
      unresolved(sink, "unresolved-ref", tok, `\`${tok.text}\` is not a declared concept.`, "declare it, or fix the reference");
    } else {
      push(sink, "V4", "unresolved-path", "error", `\`${tok.text}\` resolves to no field, dimension, or value.`,
        tokenRange(tok, tok), "declare it, or fix the path");
    }
  };

  const typeOf = (expr: Expr, subject: string | null, sink: Sink, outer?: string | null): VType => {
    switch (expr.kind) {
      case "error": return { k: "error" };
      case "paren": return typeOf(expr.inner, subject, sink, outer);
      case "literal":
        return expr.type === "int" ? { k: "int" }
          : expr.type === "decimal" ? { k: "decimal" }
            : expr.type === "string" ? { k: "string" }
              : { k: "duration" };
      case "context": {
        if (expr.root.text === "today") return { k: "date" };
        if (expr.root.text === "this") return subject ? { k: "concept", name: subject } : { k: "error" };
        const seg = expr.segment;
        if (!seg) {
          push(sink, "V4", "bare-actor", "error", "`actor` is read through `.id` or `.role` (E25).",
            expr.range, "write `actor.id` or `actor.role`");
          return { k: "error" };
        }
        if (seg.text === "id") return { k: "identity" };
        if (seg.text === "role") {
          return actorDimension
            ? { k: "dim", owner: null, name: "actor", values: actorDimension.values.map(v => v.text) }
            : { k: "error" };
        }
        push(sink, "V4", "unknown-context", "error", `\`actor.${seg.text}\` is not a context fact — the kernel provides \`actor.id\` and \`actor.role\` (E25).`,
          tokenRange(seg, seg), "use actor.id or actor.role");
        return { k: "error" };
      }
      case "path": return resolvePath(expr.segments, subject, sink);
      case "quantified": {
        const target = expr.concept.text;
        if (!concepts.has(target)) {
          unresolved(sink, "unresolved-ref", expr.concept, `\`${target}\` is not a declared concept.`, `declare \`concept ${target}\``);
          return { k: "bool" };
        }
        if (subject && subject !== target) {
          const route = relationRoute(target, subject);
          if (route === "none") {
            push(sink, "V4", "quantifier-scope", "error",
        `A quantifier auto-scopes through ${target}'s unique ${subject}-typed field; ${target} declares none (E31).`,
              tokenRange(expr.concept, expr.concept), `declare \`field ${subject.toLowerCase()}: ${subject}\` on ${target}`);
          } else if (route === "ambiguous") {
            push(sink, "V4", "quantifier-ambiguous", "error",
        `Two candidate relations tie ${target} to ${subject} — write \`where <field> = this\` (E31).`,
              tokenRange(expr.concept, expr.concept), "pin the relation with `= this`");
          }
        }
        if (expr.where) typeOf(expr.where, target, sink, subject);
        return { k: "bool" };
      }
      case "unary": {
        const inner = typeOf(expr.operand, subject, sink, outer);
        reportLooseWord(inner, sink);
        return { k: "bool" };
      }
      case "binary": {
        const op = expr.op.text;
        const left = typeOf(expr.left, subject, sink, outer);
        const right = typeOf(expr.right, subject, sink, outer);
        if (left.k === "error" || right.k === "error") return { k: "error" };

        if (op === "and" || op === "or") return { k: "bool" };

        if (["=", "!=", "<", "<=", ">", ">=", "in"].includes(op)) {
          if (left.k === "word" && right.k === "word") { reportLooseWord(left, sink); reportLooseWord(right, sink); return { k: "bool" } }
          if (left.k === "word") { if (!settleWord(left, right, sink)) reportLooseWord(left, sink); return { k: "bool" } }
          if (right.k === "word") { if (!settleWord(right, left, sink)) reportLooseWord(right, sink); return { k: "bool" } }
          const l = left.k === "opt" ? left.inner : left;
          const r = right.k === "opt" ? right.inner : right;
          const compatible =
            l.k === r.k && (l.k !== "concept" || (r.k === "concept" && l.name === r.name))
            && (l.k !== "dim" || (r.k === "dim" && l.name === r.name))
            || (numeric(l) && numeric(r));
          if (!compatible) {
            push(sink, "V4", "type-mismatch", "error",
        `Cannot compare ${describe(l)} with ${describe(r)}.`,
              expr.range, "compare like with like");
          }
          return { k: "bool" };
        }

        if (["+", "-", "*", "/"].includes(op)) {
          if (left.k === "word") { reportLooseWord(left, sink); return { k: "error" } }
          if (right.k === "word") { reportLooseWord(right, sink); return { k: "error" } }
          const l = left.k === "opt" ? left.inner : left;
          const r = right.k === "opt" ? right.inner : right;
          if (l.k === "date" && r.k === "duration") return { k: "date" };
          if (l.k === "date" && r.k === "date" && op === "-") return { k: "duration" };
          if (l.k === "duration" && r.k === "duration") return { k: "duration" };
          if (numeric(l) && numeric(r)) return l.k === "decimal" || r.k === "decimal" ? { k: "decimal" } : { k: "int" };
          push(sink, "V4", "bad-arithmetic", "error",
        `\`${op}\` does not apply to ${describe(l)} and ${describe(r)}.`,
            expr.range, "check the operand types");
          return { k: "error" };
        }
        return { k: "error" };
      }
    }
  };

  // ---- subject determination (V9 / E36)
  const subjects = new Map<ActionDecl, string | null>();
  const subjectDiagnostics: Diagnostic[] = [];

  const shapeSubject = (ref: Token): string | null => {
    const shape = shapes.get(ref.text);
    return shape?.of?.text ?? null;
  };

  for (const action of actionList) {
    const sink: Sink = { file: action.name.file, out: subjectDiagnostics };
    const refs: Token[] = [];
    for (const c of action.conditions) if (c.shape) refs.push(c.shape);
    for (const b of action.actorBlocks) for (const c of b.conditions) if (c.shape) refs.push(c.shape);
    for (const b of action.branches) if (b.shape) refs.push(b.shape);

    if (action.of) {
      const pinned = action.of.text;
      if (!concepts.has(pinned)) {
        unresolved(sink, "unresolved-ref", action.of, `\`${pinned}\` is not a declared concept.`, `declare \`concept ${pinned}\``);
        subjects.set(action, null);
        continue;
      }
      for (const ref of refs) {
        const s = shapeSubject(ref);
        if (s && s !== pinned) {
          push(sink, "V9", "subject-mismatch", "error",
            `\`${ref.text}\` is a shape of ${s}, but this action's subject is ${pinned} (E36).`,
            tokenRange(ref, ref), `use a ${pinned} shape, or change the action's \`of\``);
        }
      }
      subjects.set(action, pinned);
      continue;
    }

    const found = new Map<string, Token>();
    for (const ref of refs) {
      const s = shapeSubject(ref);
      if (s && !found.has(s)) found.set(s, ref);
    }
    if (found.size === 1) {
      const only = [...found.keys()][0];
      subjects.set(action, only ?? null);
    } else if (found.size === 0) {
      push(sink, "V9", "subject-undeterminable", "error",
        `\`${action.name.text}\` has no \`of\` and no shape ref to infer a subject from (E36).`,
        tokenRange(action.name, action.name), `pin it with \`of <Concept>\``);
      subjects.set(action, null);
    } else {
      const names = [...found.keys()].join(", ");
      for (const ref of found.values()) {
        push(sink, "V9", "subject-mixed", "error",
          `Shape refs on \`${action.name.text}\` mix subjects (${names}) — an action has exactly one (E36).`,
          tokenRange(ref, ref), `pin the subject with \`of <Concept>\``);
      }
      subjects.set(action, null);
    }
  }

  // ---- writes (feeds the no-writer smell)
  const writes = new Set<string>();
  for (const action of actionList) {
    const subject = subjects.get(action) ?? null;
    for (const block of [action.effect, ...action.branches.map(b => b.effect)]) {
      if (!block) continue;
      for (const line of block.lines) {
        if (line.kind === "delta") {
          const last = line.path[line.path.length - 1];
          if (!last) continue;
          const owner = line.path.length >= 2 ? line.path[line.path.length - 2]?.text : subject;
          if (owner) writes.add(`${owner}.${last.text}`);
        }
        if (line.kind === "creation") {
          for (const a of line.assignments) writes.add(`${line.concept.text}.${a.name.text}`);
          // a creation auto-binds the created concept's unique subject-typed relation (E49)
          const created = concepts.get(line.concept.text);
          if (created && subject) {
            for (const [name, f] of created.fields) {
              if (f.type.k === "concept" && f.type.name === subject) writes.add(`${line.concept.text}.${name}`);
            }
          }
        }
      }
    }
  }
  // a `values` entry's copy string writes the concept's one string field (the DenyCode pattern)
  for (const info of concepts.values()) {
    if (info.values.size === 0) continue;
    const stringFields = [...info.fields.entries()].filter(([, f]) => f.type.k === "string");
    const only = stringFields.length === 1 ? stringFields[0] : undefined;
    if (only) writes.add(`${info.decl.name.text}.${only[0]}`);
  }

  const assignable = (target: VType, value: VType, range: Range, sink: Sink): void => {
    if (target.k === "error" || value.k === "error") return;
    if (value.k === "word") { if (!settleWord(value, target, sink)) reportLooseWord(value, sink); return; }
    const t = target.k === "opt" ? target.inner : target;
    const v = value.k === "opt" ? value.inner : value;
    const ok =
      (t.k === v.k && (t.k !== "concept" || (v.k === "concept" && t.name === v.name))
        && (t.k !== "dim" || (v.k === "dim" && t.name === v.name)))
      || (numeric(t) && numeric(v));
    if (!ok) push(sink, "V4", "type-mismatch", "error", `Cannot assign ${describe(v)} to ${describe(t)}.`, range,
      "match the declared type");
  };

  const checkDelta = (path: Token[], op: Token, value: Expr, subject: string | null, sink: Sink): void => {
    const target = resolvePath(path, subject, sink);
    if (target.k === "word") { reportLooseWord(target, sink); return; }
    const valueType = typeOf(value, subject, sink, subject);
    if (op.text === "=") { assignable(target, valueType, value.range, sink); return; }
    const t = target.k === "opt" ? target.inner : target;
    const v = valueType.k === "opt" ? valueType.inner : valueType;
    if (t.k === "error" || v.k === "error" || v.k === "word") { if (v.k === "word") reportLooseWord(v, sink); return; }
    const ok = (numeric(t) && numeric(v)) || (t.k === "date" && v.k === "duration") || (t.k === "duration" && v.k === "duration");
    if (!ok) push(sink, "V4", "bad-arithmetic", "error", `\`${op.text}\` does not apply to ${describe(t)} and ${describe(v)}.`,
      value.range, "check the operand types");
  };

  const checkMemberAssignment = (concept: Token, member: Token, value: Expr, subject: string | null, sink: Sink): void => {
    const info = concepts.get(concept.text);
    if (!info) return;
    if (!info.fields.has(member.text) && !info.dimensions.has(member.text)) {
      push(sink, "V4", "unresolved-path", "error", `\`${member.text}\` is not a field or dimension of ${concept.text}.`,
        tokenRange(member, member), `declare it on \`concept ${concept.text}\``);
      return;
    }
    const target = memberType(concept.text, member, sink);
    const valueType = typeOf(value, subject, sink, subject);
    assignable(target, valueType, value.range, sink);
  };

  return {
    model, concepts, domainDimensions, shapes, shapeList, actions, actionList,
    invariants, invariantList, scenarios, lanes, actorDimension, denyCodes, duplicates,
    subjects, subjectDiagnostics, writes,
    typeOf: (expr, subject, sink) => typeOf(expr, subject, sink, subject),
    resolvePath, relationRoute, describe, checkDelta, checkMemberAssignment, elsewhere,
  };
}

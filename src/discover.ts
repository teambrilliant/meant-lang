import type { Candidate, Range } from "./diagnostics";
import type { ActionDecl, Branch, Expr, EffectLine } from "./cst";
import { exprText } from "./cst";
import { joinTokens } from "./lexer";
import type { ResolvedModel } from "./resolve";
import { regionsOf } from "./probe";

/**
 * Report-only discovery over a **closed** catalog of claim templates (§8). Two rules govern it:
 * false negatives are fine, false positives are forbidden — a candidate a human adopts becomes a
 * law, so a wrong one poisons the model rather than merely wasting a review.
 *
 * That asymmetry is why every template asks the same question before it concludes: could an opaque
 * effect sentence do the thing I am about to say nothing does? If yes, the candidate is downgraded
 * to `near` and the blocking sentence is named. Naming what blocks the proof is itself the output —
 * it is the list of prose that would become mechanical if it were declared.
 */

/** Words that make an effect sentence a possible creation of the concept it mentions. */
export const CREATION_WORDS = ["created", "creates", "written", "writes", "staged", "stages", "spawned", "added", "adds", "recorded", "records", "issued", "emitted"];

/** Words that make an effect sentence a possible state change. */
export const CHANGE_WORDS = ["becomes", "become", "mirrors", "applied", "reset", "resets", "decreases", "increases", "moves", "flips", "set", "carries", "carry"];

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const candidateId = (template: string, subject: string, operands: string): string =>
  `DRV-${template}-${subject}-${hash(`${template}|${subject}|${operands}`)}`;

/** `a and b and c` flattened — every template reasons over conjuncts, never over the tree. */
function conjuncts(expr: Expr | null, into: Expr[] = []): Expr[] {
  if (!expr) return into;
  if (expr.kind === "paren") return conjuncts(expr.inner, into);
  if (expr.kind === "binary" && expr.op.text === "and") {
    conjuncts(expr.left, into);
    conjuncts(expr.right, into);
    return into;
  }
  into.push(expr);
  return into;
}

interface Site {
  action: ActionDecl;
  branch: Branch | null;
  line: EffectLine;
  subject: string | null;
  range: Range;
  where: string;
}

function* effectSites(model: ResolvedModel): Generator<Site> {
  for (const action of model.actionList) {
    const subject = model.subjects.get(action) ?? null;
    for (const branch of [null, ...action.branches]) {
      const block = branch === null ? action.effect : branch.effect;
      if (!block) continue;
      const where = `${action.id?.text ?? action.name.text}${branch ? `@${branch.shape?.text ?? "otherwise"}` : ""}`;
      for (const line of block.lines) yield { action, branch, line, subject, range: line.range, where };
    }
  }
}

interface OpaqueSentence { text: string; words: string[]; refs: string[]; subject: string | null; where: string; range: Range }

function opaqueSentences(model: ResolvedModel): OpaqueSentence[] {
  const out: OpaqueSentence[] = [];
  for (const site of effectSites(model)) {
    if (site.line.kind !== "sentence") continue;
    const tokens = site.line.sentence.tokens;
    out.push({
      text: joinTokens(tokens),
      words: tokens.map(t => t.text.toLowerCase()),
      refs: site.line.sentence.refs.map(r => r.text),
      subject: site.subject,
      where: site.where,
      range: site.range,
    });
  }
  return out;
}

/** The region a creation or delta sits in, as the conjuncts its gates and branch guarantee. */
function regionConjuncts(model: ResolvedModel, action: ActionDecl, branch: Branch | null): Expr[] {
  const region = regionsOf(action, model).find(r => r.branch === branch)
    ?? regionsOf(action, model).find(r => r.branch === null);
  if (!region) return [];
  const out: Expr[] = [];
  for (const expr of region.require) conjuncts(expr ?? null, out);
  return out;
}

// ---------------------------------------------------------------- templates

/**
 * at-most-one: every creation site of C sits under a region requiring `no C where R`, and the
 * created instance satisfies R. Then a second instance cannot be created while the first matches R.
 */
function atMostOne(model: ResolvedModel, opaque: OpaqueSentence[]): Candidate[] {
  const created = new Map<string, Site[]>();
  for (const site of effectSites(model)) {
    if (site.line.kind !== "creation") continue;
    const bucket = created.get(site.line.concept.text);
    if (bucket) bucket.push(site); else created.set(site.line.concept.text, [site]);
  }

  const out: Candidate[] = [];
  for (const [concept, sites] of created) {
    const evidence: string[] = [];
    let guardText: string | null = null;
    let subject: string | null = null;
    let holds = true;

    for (const site of sites) {
      if (site.line.kind !== "creation") continue;
      const guards = regionConjuncts(model, site.action, site.branch)
        .filter(e => e.kind === "quantified" && e.quantifier.text === "no" && e.concept.text === concept);
      const guard = guards[0];
      if (!guard || guard.kind !== "quantified") { holds = false; break }

      const restriction = conjuncts(guard.where);
      const satisfied = restriction.every(r => {
        if (r.kind !== "binary" || r.op.text !== "=") return false;
        if (r.left.kind !== "path" || r.left.segments.length !== 1) return false;
        const member = r.left.segments[0]?.text;
        const wanted = r.right.kind === "path" && r.right.segments.length === 1 ? r.right.segments[0]?.text : null;
        if (!member || wanted === null) return false;
        return site.line.kind === "creation" && site.line.assignments.some(a =>
          a.name.text === member && a.expr.kind === "path" && a.expr.segments.length === 1
          && a.expr.segments[0]?.text === wanted);
      });
      if (!satisfied) { holds = false; break }

      guardText = exprText(guard);
      subject = subject ?? site.subject;
      evidence.push(`creation site \`${site.where}\`: \`new ${concept} with ${site.line.kind === "creation" ? site.line.assignments.map(a => `${a.name.text} = ${exprText(a.expr)}`).join(", ") : ""}\``);
    }
    if (!holds || guardText === null || subject === null) continue;

    evidence.push(`guarding conjunct on every one of them: \`${guardText}\``);
    const blocker = opaque.find(s => s.refs.includes(concept) && s.words.some(w => CREATION_WORDS.includes(w)));
    if (blocker) evidence.push(`opaque sentence that may create one too: "${blocker.text}" (${blocker.where})`);

    out.push({
      id: candidateId("at-most-one", subject, `${concept}|${guardText}`),
      template: "at-most-one",
      status: blocker ? "near" : "theorem",
      claim: `At most one ${concept} per ${subject} satisfies \`${guardText.replace(/^no \S+\s*/, "")}\` at a time.`,
      file: sites[0]?.action.file ?? "",
      range: sites[0]?.range ?? { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
      evidence,
      ...(blocker ? { blocked: `the sentence at ${blocker.where} may create a ${concept} the gates never see` } : {}),
    });
  }
  return out;
}

/**
 * Could this sentence move `Concept.member`? Only if it is about that concept at all — by being an
 * effect of an action whose subject it is, or by naming it — and only if it names the member or one
 * of the member's closed values. Both halves matter: without the first, one action's prose blocks
 * every other concept's claim; without the second, every sentence blocks everything.
 */
function mayMove(opaque: OpaqueSentence[], concept: string, member: string, values: string[]): OpaqueSentence | undefined {
  return opaque.find(s =>
    (s.subject === concept || s.refs.includes(concept))
    && (s.words.includes(member.toLowerCase()) || s.words.some(w => values.includes(w))));
}

/** write-once: a member assigned by creations and by no delta anywhere. */
function writeOnce(model: ResolvedModel, opaque: OpaqueSentence[]): Candidate[] {
  const assigned = new Map<string, Site[]>();
  const mutated = new Set<string>();
  for (const site of effectSites(model)) {
    if (site.line.kind === "creation") {
      for (const a of site.line.assignments) {
        const key = `${site.line.concept.text}.${a.name.text}`;
        const bucket = assigned.get(key);
        if (bucket) bucket.push(site); else assigned.set(key, [site]);
      }
    }
    if (site.line.kind === "delta") {
      const last = site.line.path[site.line.path.length - 1];
      const owner = site.line.path.length >= 2 ? site.line.path[site.line.path.length - 2]?.text : site.subject;
      if (last && owner) mutated.add(`${owner}.${last.text}`);
    }
  }

  const out: Candidate[] = [];
  for (const [key, sites] of assigned) {
    if (mutated.has(key)) continue;
    const [concept, member] = key.split(".");
    if (!concept || !member) continue;
    const blocker = mayMove(opaque, concept, member, valuesOf(model, concept, member));
    out.push({
      id: candidateId("write-once", concept, member),
      template: "write-once",
      status: blocker ? "near" : "theorem",
      claim: `\`${key}\` is written once, at creation, and never moved.`,
      file: sites[0]?.action.file ?? "",
      range: sites[0]?.range ?? { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
      evidence: [
        `assigned at ${sites.length} creation site(s): ${sites.map(s => s.where).join(", ")}`,
        "no delta anywhere targets it",
        ...(blocker ? [`opaque sentence that may move it: "${blocker.text}" (${blocker.where})`] : []),
      ],
      ...(blocker ? { blocked: `the sentence at ${blocker.where} names this member or one of its values` } : {}),
    });
  }
  return out;
}

const valuesOf = (model: ResolvedModel, concept: string, member: string): string[] => {
  const dim = model.concepts.get(concept)?.dimensions.get(member);
  return dim ? dim.values.map(v => v.text.toLowerCase()) : [];
};

/** absorbing: every delta on an axis assigns the same value, so that value is never left. */
function absorbing(model: ResolvedModel, opaque: OpaqueSentence[]): Candidate[] {
  const writes = new Map<string, { values: Set<string>; sites: Site[] }>();
  for (const site of effectSites(model)) {
    if (site.line.kind !== "delta" || site.line.op.text !== "=") continue;
    const last = site.line.path[site.line.path.length - 1];
    const owner = site.line.path.length >= 2 ? site.line.path[site.line.path.length - 2]?.text : site.subject;
    if (!last || !owner) continue;
    if (valuesOf(model, owner, last.text).length === 0) continue;          // an axis, not a datum
    const key = `${owner}.${last.text}`;
    const entry = writes.get(key) ?? { values: new Set<string>(), sites: [] };
    entry.values.add(exprText(site.line.expr));
    entry.sites.push(site);
    writes.set(key, entry);
  }

  const out: Candidate[] = [];
  for (const [key, entry] of writes) {
    if (entry.values.size !== 1) continue;
    const value = [...entry.values][0] ?? "";
    const [concept, member] = key.split(".");
    if (!concept || !member) continue;
    const values = valuesOf(model, concept, member);
    if (!values.includes(value.toLowerCase())) continue;
    const blocker = mayMove(opaque, concept, member, values);
    out.push({
      id: candidateId("absorbing", concept, `${member}=${value}`),
      template: "absorbing",
      status: blocker ? "near" : "theorem",
      claim: `\`${key} = ${value}\` is absorbing: no effect assigns the axis any other value.`,
      file: entry.sites[0]?.action.file ?? "",
      range: entry.sites[0]?.range ?? { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
      evidence: [
        `the only delta(s) on this axis: ${entry.sites.map(s => s.where).join(", ")}, all assigning \`${value}\``,
        ...(blocker ? [`opaque sentence naming the axis or a value: "${blocker.text}" (${blocker.where})`] : []),
      ],
      ...(blocker ? { blocked: `the sentence at ${blocker.where} may move the axis where no delta does` } : {}),
    });
  }
  return out;
}

/**
 * bounded-counter: the counter is only ever incremented in branches an earlier first-match branch
 * excludes when the bound is reached. Reporting this as *near* is not a shortfall — chaining
 * first-match exclusion is the reasoning step the conservative catalog does not take, and naming it
 * is what tells a human which proof obligation adoption would be assuming.
 */
function boundedCounter(model: ResolvedModel): Candidate[] {
  const out: Candidate[] = [];
  const increments = new Map<string, Site[]>();
  for (const site of effectSites(model)) {
    if (site.line.kind !== "delta" || site.line.op.text !== "+=") continue;
    const last = site.line.path[site.line.path.length - 1];
    const owner = site.line.path.length >= 2 ? site.line.path[site.line.path.length - 2]?.text : site.subject;
    if (!last || !owner) continue;
    const key = `${owner}.${last.text}`;
    const bucket = increments.get(key);
    if (bucket) bucket.push(site); else increments.set(key, [site]);
  }

  for (const [key, sites] of increments) {
    const [concept, member] = key.split(".");
    if (!concept || !member) continue;
    const guards: string[] = [];
    let bound: string | null = null;
    let guardedEverywhere = true;

    for (const site of sites) {
      const branches = site.action.branches;
      const at = site.branch === null ? branches.length : branches.indexOf(site.branch);
      let found = false;
      for (let j = 0; j < at; j++) {
        const earlier = branches[j]?.shape;
        if (!earlier) continue;
        const where = model.shapes.get(earlier.text)?.where ?? null;
        for (const conjunct of conjuncts(where)) {
          if (conjunct.kind !== "binary" || ![">=", ">"].includes(conjunct.op.text)) continue;
          if (conjunct.left.kind !== "path") continue;
          if (conjunct.left.segments[conjunct.left.segments.length - 1]?.text !== member) continue;
          bound = bound ?? exprText(conjunct);
          guards.push(`\`${site.action.name.text}\`: \`in ${earlier.text}\` (${exprText(conjunct)}) is matched before this branch`);
          found = true;
        }
      }
      if (!found) { guardedEverywhere = false; break }
    }
    if (!guardedEverywhere || bound === null) continue;

    out.push({
      id: candidateId("bounded-counter", concept, `${member}|${bound}`),
      template: "bounded-counter",
      status: "near",
      claim: `\`${key}\` is bounded: every increment sits behind a first-match branch that already claimed the state where \`${bound}\`.`,
      file: sites[0]?.action.file ?? "",
      range: sites[0]?.range ?? { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
      evidence: [
        `increment site(s): ${sites.map(s => s.where).join(", ")}`,
        ...guards,
      ],
      blocked: "first-match branch exclusion — the bound follows from an earlier branch NOT matching, and the catalog does not chain negated branch reachability",
    });
  }
  return out;
}

/**
 * suspicious absence: a member the gates read that no effect writes. This is the template that
 * earns its keep by being an *absence*: a shape can only light up if something moves the state it
 * predicates over, so a gate reading unwritten state either names a missing action or names
 * provisioning the model does not own — and the model does not say which.
 */
function suspiciousAbsence(model: ResolvedModel): Candidate[] {
  const readers = new Map<string, Set<string>>();
  const note = (concept: string, member: string, by: string) => {
    const key = `${concept}.${member}`;
    const bucket = readers.get(key) ?? new Set<string>();
    bucket.add(by);
    readers.set(key, bucket);
  };

  /** The concept a path's last segment belongs to, walked through the relation chain (§3). */
  const ownerConcept = (segments: string[], subject: string | null): string | null => {
    let current = subject;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (seg === undefined) return null;
      if (i === 0 && model.concepts.has(seg)) { current = seg; continue }
      if (current === null) return null;
      const field = model.concepts.get(current)?.fields.get(seg);
      const base = field?.type.k === "opt" ? field.type.inner : field?.type;
      if (base?.k !== "concept") return null;
      current = base.name;
    }
    return current;
  };

  const readPaths = (expr: Expr | null, subject: string | null, by: string): void => {
    if (!expr) return;
    switch (expr.kind) {
      case "path": {
        const last = expr.segments[expr.segments.length - 1];
        const owner = ownerConcept(expr.segments.map(seg => seg.text), subject);
        if (!last || !owner) return;
        // `status = active` parses as two paths; `active` is a value, not state anything writes.
        const info = model.concepts.get(owner);
        if (info && (info.fields.has(last.text) || info.dimensions.has(last.text))) note(owner, last.text, by);
        return;
      }
      case "binary": readPaths(expr.left, subject, by); readPaths(expr.right, subject, by); return;
      case "unary": readPaths(expr.operand, subject, by); return;
      case "paren": readPaths(expr.inner, subject, by); return;
      case "quantified": readPaths(expr.where, expr.concept.text, by); return;
      default: return;
    }
  };

  for (const shape of model.shapeList) {
    readPaths(shape.where, shape.of?.text ?? null, `shape ${shape.name.text}`);
    if (shape.fuse) readPaths(shape.fuse.timeout, shape.of?.text ?? null, `fuse on ${shape.name.text}`);
  }
  for (const action of model.actionList) {
    const subject = model.subjects.get(action) ?? null;
    for (const c of action.conditions) readPaths(c.expr, subject, `gate on ${action.name.text}`);
    for (const b of action.actorBlocks) for (const c of b.conditions) readPaths(c.expr, subject, `\`by ${b.actor.text}\` gate on ${action.name.text}`);
  }

  const out: Candidate[] = [];
  for (const [key, by] of [...readers].sort(([a], [b]) => a.localeCompare(b))) {
    if (model.writes.has(key)) continue;
    const [concept, member] = key.split(".");
    if (!concept || !member) continue;
    if (member === "id") continue;
    const info = model.concepts.get(concept);
    const declared = info?.decl.fields.find(f => f.name.text === member)
      ?? info?.decl.dimensions.find(d => d.name.text === member);
    out.push({
      id: candidateId("suspicious-absence", concept, member),
      template: "suspicious-absence",
      status: "absence",
      claim: `\`${key}\` is read by ${by.size} gate(s) and written by nothing.`,
      file: info?.decl.file ?? "",
      range: declared?.range ?? info?.decl.range ?? { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
      evidence: [
        ...[...by].sort().map(b => `read by ${b}`),
        "no delta and no creation assigns it: either the action that sets it is missing from the model, or the gate reads provisioning state the model does not own — the model does not say which",
      ],
    });
  }
  return out;
}

export function discover(model: ResolvedModel): Candidate[] {
  const opaque = opaqueSentences(model);
  return [
    ...atMostOne(model, opaque),
    ...writeOnce(model, opaque),
    ...absorbing(model, opaque),
    ...boundedCounter(model),
    ...suspiciousAbsence(model),
  ];
}

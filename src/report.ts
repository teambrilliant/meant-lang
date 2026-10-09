import type { CheckResult, Diagnostic, OpacityEntry, PatternCluster, Question, Verdict } from "./diagnostics";
import { sortDiagnostics, summarize } from "./diagnostics";
import type { Marker, Sentence } from "./cst";
import { load } from "./domains";
import { resolve } from "./resolve";
import type { ResolvedModel } from "./resolve";
import { runLaws } from "./laws";
import { CHANGE_WORDS, CREATION_WORDS, discover } from "./discover";
import { simulate } from "./sim";

/**
 * `meant report` — the partiality account, made addressable.
 *
 * The opacity queue answers "what did this model declare that nothing verified"; the pattern miner
 * answers "which of that prose recurs", which is the recurrence bar's evidence gathered mechanically
 * instead of remembered; the candidates answer "what is already true and could be pinned"; the
 * questions inbox answers "who owes a decision". None of it is a verdict — coverage is never
 * overstated, and nothing here is adopted without a human saying so (§8).
 */

// ---------------------------------------------------------------- residue patterns

/**
 * A sentence normalized to its shape. Resolved references, quoted instance data, numbers, and
 * closed-vocabulary values all become placeholders — what remains is the *pattern*, which is the
 * thing that either recurs (and earns a form) or does not (and stays prose, by rule).
 */
function normalize(sentence: Sentence, model: ResolvedModel): string {
  const values = new Set<string>();
  for (const info of model.concepts.values()) {
    for (const dim of info.dimensions.values()) for (const v of dim.values) values.add(v.text);
    for (const name of info.values.keys()) values.add(name);
  }
  for (const dim of model.domainDimensions.values()) for (const v of dim.values) values.add(v.text);

  const declared = (text: string): boolean =>
    model.concepts.has(text) || model.shapes.has(text) || model.actions.has(text) || model.invariants.has(text);

  const out: string[] = [];
  for (const token of sentence.tokens) {
    if (token.kind === "STRING") { out.push("<STR>"); continue }
    if (token.kind === "INT" || token.kind === "DECIMAL" || token.kind === "DURATION") { out.push("<N>"); continue }
    if (declared(token.text)) { out.push("<REF>"); continue }
    if (values.has(token.text)) { out.push("<VAL>"); continue }
    out.push(token.text.toLowerCase());
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

interface Residue { sentence: Sentence; where: string; subject: string | null; file: string; line: number }

function* residueSentences(model: ResolvedModel): Generator<Residue> {
  for (const action of model.actionList) {
    const file = action.file;
    const subject = model.subjects.get(action) ?? null;
    for (const branch of [null, ...action.branches]) {
      const block = branch === null ? action.effect : branch.effect;
      if (!block) continue;
      const where = `${action.id?.text ?? action.name.text}${branch ? `@${branch.shape?.text ?? "otherwise"}` : ""}`;
      for (const line of block.lines) {
        if (line.kind === "sentence" && line.sentence.tokens.length > 0) {
          yield { sentence: line.sentence, where, subject, file, line: line.range.start.line };
        }
      }
    }
  }
  for (const scenario of model.scenarios) {
    const file = scenario.file;
    const where = scenario.id?.text ?? scenario.name.text;
    for (const step of scenario.steps) {
      if (step.sentence.tokens.length > 0) yield { sentence: step.sentence, where, subject: null, file, line: step.range.start.line };
    }
    for (const block of scenario.expects) {
      for (const s of block.sentences) yield { sentence: s, where: `${where}#expect`, subject: null, file, line: s.range.start.line };
      for (const lane of block.lanes) for (const s of lane.sentences) yield { sentence: s, where: `${where}#lane`, subject: null, file, line: s.range.start.line };
    }
  }
}

/**
 * Does this sentence write to an instance other than its subject? That is the pattern E49 refused
 * at the recurrence bar with one occurrence, so counting it is the whole point of mining.
 */
function isRelatedInstanceWrite(residue: Residue, model: ResolvedModel): boolean {
  if (residue.subject === null) return false;                 // scenario prose has no subject to be related to
  const others = residue.sentence.refs.filter(r => model.concepts.has(r.text) && r.text !== residue.subject);
  if (others.length === 0) return false;
  return residue.sentence.tokens.some(t =>
    CHANGE_WORDS.includes(t.text.toLowerCase()) || CREATION_WORDS.includes(t.text.toLowerCase()));
}

function minePatterns(model: ResolvedModel): PatternCluster[] {
  const exact = new Map<string, Residue[]>();
  const related: Residue[] = [];
  for (const residue of residueSentences(model)) {
    const key = normalize(residue.sentence, model);
    if (key === "") continue;
    const bucket = exact.get(key);
    if (bucket) bucket.push(residue); else exact.set(key, [residue]);
    if (isRelatedInstanceWrite(residue, model)) related.push(residue);
  }

  const site = (r: Residue) => `${r.where} — ${r.file}:${r.line}`;
  const out: PatternCluster[] = [];
  if (related.length > 0) {
    out.push({
      cluster: "related-instance-write",
      pattern: "an effect writes an instance other than the action's subject",
      count: related.length,
      sites: related.map(site),
    });
  }
  for (const [pattern, members] of exact) {
    if (members.length < 2) continue;
    out.push({ cluster: "identical-shape", pattern, count: members.length, sites: members.map(site) });
  }
  return out.sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

// ---------------------------------------------------------------- opacity queue

/** Which declaration a verdict belongs to, read off the claim id the engines already carry. */
function owner(subject: string): string {
  return subject.split(/[@:#]/)[0] ?? subject;
}

/** `verdicts` are this domain's own — the caller scopes them. */
function opacityQueue(model: ResolvedModel, verdicts: Verdict[]): OpacityEntry[] {
  const entries = new Map<string, OpacityEntry>();
  const entry = (name: string, file: string, range: OpacityEntry["range"]): OpacityEntry => {
    const existing = entries.get(name);
    if (existing) return existing;
    const created: OpacityEntry = { declaration: name, file, range, sentences: 0, unprobeable: 0, skipped: 0, detail: [] };
    entries.set(name, created);
    return created;
  };

  for (const action of model.actionList) {
    const name = action.id?.text ?? action.name.text;
    for (const branch of [null, ...action.branches]) {
      const block = branch === null ? action.effect : branch.effect;
      if (!block) continue;
      for (const line of block.lines) {
        if (line.kind !== "sentence" || line.sentence.tokens.length === 0) continue;
        const row = entry(`action ${name}`, action.file, action.range);
        row.sentences++;
        row.detail.push(`effect sentence (${action.file}:${line.range.start.line}) — declared, unverified`);
      }
    }
  }
  for (const scenario of model.scenarios) {
    const name = scenario.id?.text ?? scenario.name.text;
    const prose = scenario.expects.reduce((n, b) => n + b.sentences.length + b.lanes.length, 0) + scenario.lanes.length;
    if (prose > 0) {
      const row = entry(`scenario ${name}`, scenario.file, scenario.range);
      row.detail.push(`${prose} lane/prose expectation(s) belong to the suite, not to replay`);
    }
  }

  for (const verdict of verdicts) {
    if (verdict.status !== "unprobeable" && verdict.status !== "skipped") continue;
    const name = owner(verdict.subject);
    const action = model.actions.get(name);
    const scenario = model.scenarios.find(s => (s.id?.text ?? s.name.text) === name);
    const label = action ? `action ${name}` : scenario ? `scenario ${name}` : model.shapes.has(name) ? `shape ${name}` : name;
    const decl = action ?? scenario ?? model.shapes.get(name);
    const row = entry(label, decl?.file ?? verdict.file, decl?.range ?? verdict.range);
    if (verdict.status === "unprobeable") row.unprobeable++; else row.skipped++;
  }

  return [...entries.values()]
    .filter(e => e.sentences + e.unprobeable + e.skipped > 0 || e.detail.length > 0)
    .sort((a, b) => a.file.localeCompare(b.file) || a.range.start.line - b.range.start.line);
}

// ---------------------------------------------------------------- questions inbox

function questions(model: ResolvedModel): Question[] {
  const out: Question[] = [];
  const push = (marker: Marker | null, file: string) => {
    if (!marker) return;
    const text = marker.text?.value ?? null;
    out.push({ handle: marker.handle?.text ?? "(unowned)", text: (text ?? "(no text)").replace(/\s+/g, " ").trim(), file, range: marker.range });
  };

  for (const statement of model.model.statements) {
    for (const marker of statement.common.markers) push(marker, statement.file);
  }
  if (model.model.domain) {
    for (const marker of model.model.domain.common.markers) push(marker, model.model.domain.file);
  }
  for (const info of model.concepts.values()) {
    for (const value of info.decl.values) push(value.marker, info.decl.file);
  }
  for (const action of model.actionList) {
    for (const condition of action.conditions) push(condition.marker, action.file);
    for (const b of action.actorBlocks) for (const c of b.conditions) push(c.marker, action.file);
    for (const branch of [null, ...action.branches]) {
      const block = branch === null ? action.effect : branch.effect;
      if (!block) continue;
      for (const line of block.lines) push(line.kind === "sentence" ? line.sentence.marker : line.marker, action.file);
    }
  }
  for (const scenario of model.scenarios) {
    for (const world of scenario.worlds) push(world.marker, scenario.file);
    for (const step of scenario.steps) push(step.sentence.marker, scenario.file);
  }
  return out.sort((a, b) =>
    a.handle.localeCompare(b.handle) || a.file.localeCompare(b.file) || a.range.start.line - b.range.start.line);
}

// ---------------------------------------------------------------- driver

export function report(paths: string[]): CheckResult {
  const run = load(paths);
  const simulated = simulate(paths);

  const diagnostics: Diagnostic[] = [...run.diagnostics];
  const opacity: OpacityEntry[] = [];
  const patterns: PatternCluster[] = [];
  const candidates: CheckResult["candidates"] = [];
  const inbox: Question[] = [];

  for (const domain of run.domains) {
    const model = resolve(domain.model, run.index);
    const laws = [...domain.diagnostics, ...runLaws(model)];
    diagnostics.push(...laws);
    if (laws.some(d => d.severity === "error")) continue;

    const own = new Set(domain.files);
    opacity.push(...opacityQueue(model, (simulated.verdicts ?? []).filter(v => own.has(v.file))));
    patterns.push(...minePatterns(model));
    candidates.push(...discover(model));
    inbox.push(...questions(model));
  }

  const sorted = sortDiagnostics(diagnostics);
  return {
    version: 1, files: run.files, diagnostics: sorted, summary: summarize(sorted),
    opacity, patterns, candidates, questions: inbox,
  };
}

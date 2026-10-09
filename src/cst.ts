import type { Range } from "./diagnostics";
import type { Token } from "./lexer";

export interface Marker { handle: Token | null; text: Token | null; range: Range }

/** Cross-cutting clauses usable on any statement (§4). */
export interface Common {
  doc: Token | null;
  notes: Token[];
  verifiedBy: Array<{ path: string; range: Range }>;
  planned: boolean;
  markers: Marker[];
}

export const emptyCommon = (): Common => ({ doc: null, notes: [], verifiedBy: [], planned: false, markers: [] });

export type Expr =
  | { kind: "binary"; op: Token; left: Expr; right: Expr; range: Range }
  | { kind: "unary"; op: Token; operand: Expr; range: Range }
  | { kind: "path"; segments: Token[]; range: Range }
  | { kind: "context"; root: Token; segment: Token | null; range: Range }
  | { kind: "literal"; token: Token; type: "int" | "decimal" | "string" | "duration"; range: Range }
  | { kind: "quantified"; quantifier: Token; concept: Token; where: Expr | null; range: Range }
  | { kind: "paren"; inner: Expr; range: Range }
  | { kind: "error"; range: Range };

export interface TypeRef { name: Token; optional: boolean; range: Range }
export interface FieldDecl { name: Token; type: TypeRef; range: Range }
export interface DimensionDecl { kind: "dimension"; file: string; name: Token; values: Token[]; range: Range; common: Common }
export interface ValuesEntry { name: Token; copy: Token | null; marker: Marker | null; range: Range }

export interface ConceptDecl {
  kind: "concept"; file: string; name: Token; dimensions: DimensionDecl[]; fields: FieldDecl[];
  values: ValuesEntry[]; fallback: Token | null; range: Range; common: Common;
}

export interface TouchpointsDecl { kind: "touchpoints"; file: string; lanes: Token[]; range: Range; common: Common }

export interface Fuse { triggers: Token[]; timeout: Expr; target: Token; range: Range }
export interface ShapeDecl {
  kind: "shape"; file: string; id: Token | null; name: Token; of: Token | null;
  where: Expr | null; fuse: Fuse | null; range: Range; common: Common;
}

export interface Fact { path: Token[]; range: Range }
export interface ToBlock { actor: Token; lane: Token; mustSee: Fact[]; mustNotSee: Fact[]; range: Range }
export interface ExposureDecl { kind: "exposure"; file: string; concept: Token; blocks: ToBlock[]; range: Range; common: Common }

export interface Sentence {
  tokens: Token[]; refs: Token[]; strings: Token[];
  via: Token | null; marker: Marker | null; range: Range;
}

export type EffectLine =
  | { kind: "delta"; path: Token[]; op: Token; expr: Expr; marker: Marker | null; range: Range }
  | { kind: "creation"; concept: Token; assignments: Array<{ name: Token; expr: Expr }>; marker: Marker | null; range: Range }
  | { kind: "outcome"; shape: Token; marker: Marker | null; range: Range }
  | { kind: "sentence"; sentence: Sentence; nearMiss: boolean; range: Range };

export interface EffectBlock { lines: EffectLine[]; range: Range }
export interface Condition {
  negated: boolean; shape: Token | null; expr: Expr | null;
  elseCode: Token | null; marker: Marker | null; range: Range;
}
export interface ActorBlock { actor: Token; conditions: Condition[]; range: Range }
export interface Branch { head: Token; shape: Token | null; effect: EffectBlock | null; range: Range }

export interface ActionDecl {
  kind: "action"; file: string; id: Token | null; name: Token; of: Token | null; by: Token[];
  conditions: Condition[]; actorBlocks: ActorBlock[]; branches: Branch[];
  effect: EffectBlock | null; range: Range; common: Common;
}

export interface InvariantDecl {
  kind: "invariant"; file: string; id: Token | null; name: Token;
  checkBy: Token | null; rubric: Token | null; range: Range; common: Common;
}

export interface LaneLine { lane: Token; sentences: Sentence[]; range: Range }
export type Expectation =
  | { kind: "denied"; code: Token; range: Range }
  | { kind: "shape"; shape: Token; range: Range }
  | { kind: "sentence"; sentence: Sentence; range: Range };
export interface Step { sentence: Sentence; expectation: Expectation | null; range: Range }
export interface ExpectBlock { sentences: Sentence[]; lanes: LaneLine[]; range: Range }

export interface ScenarioDecl {
  kind: "scenario"; file: string; id: Token | null; name: Token; worlds: Sentence[]; steps: Step[];
  expects: ExpectBlock[]; lanes: LaneLine[]; checks: Token[]; range: Range; common: Common;
}

export type Statement =
  | ConceptDecl | DimensionDecl | TouchpointsDecl | ShapeDecl
  | ExposureDecl | ActionDecl | InvariantDecl | ScenarioDecl;

export type DomainClause =
  | { kind: "mode"; value: Token; range: Range }
  | { kind: "uses"; libs: Token[]; range: Range }
  | { kind: "meta"; key: Token; value: Token[]; range: Range };

export interface DomainDecl { file: string; name: Token; clauses: DomainClause[]; range: Range; common: Common }

export interface Model { file: string; domain: DomainDecl | null; statements: Statement[] }

/** A domain's files as one model (§1): the merged header and every file's statements. */
export interface DomainModel { domain: DomainDecl | null; statements: Statement[] }

/** An expression rendered back to source-shaped text — evidence lines and verdicts quote predicates. */
export function exprText(expr: Expr | null): string {
  if (!expr) return "";
  switch (expr.kind) {
    case "binary": return `${exprText(expr.left)} ${expr.op.text} ${exprText(expr.right)}`;
    case "unary": return `${expr.op.text} ${exprText(expr.operand)}`;
    case "paren": return `(${exprText(expr.inner)})`;
    case "path": return expr.segments.map(s => s.text).join(".");
    case "context": return expr.segment ? `${expr.root.text}.${expr.segment.text}` : expr.root.text;
    case "literal": return expr.token.text;
    case "quantified": return `${expr.quantifier.text} ${expr.concept.text}${expr.where ? ` where ${exprText(expr.where)}` : ""}`;
    case "error": return "<unparsed>";
  }
}

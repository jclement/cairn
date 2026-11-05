// Picoschema note schemas, as Basic Memory defines them (docs/specs/SPEC-SCHEMA.md upstream and
// its check_schema manual page; written from those documents, not from Basic Memory's AGPL code).
//
// A schema is a note with `type: schema` whose `entity` names the note type it describes and whose
// frontmatter `schema` is a Picoschema dict:
//   name: string, full name            required field, with a description after the comma
//   role?: string                      optional
//   works_at?: Organization            capitalised type = a relation `works_at [[...]]`
//   expertise?(array): string          several `[expertise]` observations
//   status?(enum, current state): [a, b]
//   meta?(object): { ... }             nested (checked for presence only)
// `settings.validation` is warn (default) or strict ("error" is accepted as strict); anything
// else is refused. `settings.frontmatter` declares frontmatter keys the same way.
//
// Fields are grounded in the existing note format: a scalar field is an observation `[field] value`,
// an entity field is a relation `field [[Target]]`. Cairn extension: a field may also be satisfied
// by a frontmatter key of the same name (so task status can live in frontmatter alone).

export const SCALAR_TYPES = ["string", "integer", "number", "boolean", "any"] as const;

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  isArray: boolean;
  isEnum: boolean;
  enumValues: string[];
  isObject: boolean;
  description: string | null;
  isEntityRef: boolean;
  children: SchemaField[];
}

export interface SchemaDefinition {
  entity: string;
  version: number;
  fields: SchemaField[];
  validationMode: "warn" | "strict";
  frontmatterFields: SchemaField[];
  /** Where it came from: a schema note's permalink, or "inline". */
  source: string;
}

export class SchemaError extends Error {}

/** Structural bounds, checked before and while parsing, so a schema's own shape can't decide the work. */
export const SCHEMA_LIMITS = {
  /** Serialized size of a schema (schema plus settings) we'll read at all. */
  bytes: 16 * 1024,
  /** Fields in one schema, nested ones and settings.frontmatter included. */
  fields: 200,
  /** Nesting of (object) fields. */
  depth: 4,
  keyChars: 200,
  descriptionChars: 500,
  typeChars: 100,
  enumValues: 50,
  enumValueChars: 100,
};

const KINDS = new Set(["array", "enum", "object"]);
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.-]/;

/**
 * One field key, parsed by an explicit left-to-right scan (no regular expression with overlapping
 * repetitions, so no backtracking): name, optional "?", optional "(kind[, description])" at the end.
 */
export function parseFieldKey(rawKey: string): { name: string; optional: boolean; kind: string | null; description: string | null } | null {
  if (rawKey.length > SCHEMA_LIMITS.keyChars) return null;
  const key = rawKey.trim();
  let i = 0;
  if (!NAME_START.test(key[0] ?? "")) return null;
  while (i < key.length && NAME_CHAR.test(key[i] as string)) i++;
  const name = key.slice(0, i);
  let optional = false;
  if (key[i] === "?") {
    optional = true;
    i++;
  }
  if (i === key.length) return { name, optional, kind: null, description: null };
  if (key[i] !== "(" || key[key.length - 1] !== ")") return null;
  const inner = key.slice(i + 1, -1);
  if (inner.includes("(") || inner.includes(")")) return null;
  const comma = inner.indexOf(",");
  const kind = (comma >= 0 ? inner.slice(0, comma) : inner).trim();
  if (!KINDS.has(kind)) return null;
  const description = comma >= 0 ? inner.slice(comma + 1).trim() : "";
  return { name, optional, kind, description: description || null };
}

interface Budget {
  fields: number;
}

/** Parse a Picoschema dict into fields. Throws SchemaError on syntax it doesn't understand or that exceeds SCHEMA_LIMITS. */
export function parsePicoschema(dict: unknown, path = "schema", budget: Budget = { fields: 0 }, depth = 0): SchemaField[] {
  if (dict === null || dict === undefined) return [];
  if (typeof dict !== "object" || Array.isArray(dict)) throw new SchemaError(`${path} must be a mapping of field: type`);
  if (depth >= SCHEMA_LIMITS.depth) throw new SchemaError(`${path}: objects nest at most ${SCHEMA_LIMITS.depth} levels`);
  const out: SchemaField[] = [];
  const names = new Set<string>();
  for (const [rawKey, value] of Object.entries(dict as Record<string, unknown>)) {
    if (++budget.fields > SCHEMA_LIMITS.fields) throw new SchemaError(`a schema has at most ${SCHEMA_LIMITS.fields} fields`);
    const k = parseFieldKey(rawKey);
    if (!k) {
      throw new SchemaError(
        `${path}: can't read field "${rawKey.slice(0, 60)}${rawKey.length > 60 ? "…" : ""}" (use name, name?, name(array), name?(enum), name?(object); keys up to ${SCHEMA_LIMITS.keyChars} characters)`,
      );
    }
    const { name, optional: opt, kind } = k;
    // "x", "x?" and "x(array, …)" all name field x: one declaration per field.
    if (names.has(name.toLowerCase())) throw new SchemaError(`${path}: field "${name}" is declared more than once`);
    names.add(name.toLowerCase());
    if (k.description && k.description.length > SCHEMA_LIMITS.descriptionChars)
      throw new SchemaError(`${path}.${name}: descriptions are at most ${SCHEMA_LIMITS.descriptionChars} characters`);
    const field: SchemaField = {
      name,
      type: "string",
      required: !opt,
      isArray: kind === "array",
      isEnum: kind === "enum",
      enumValues: [],
      isObject: kind === "object",
      description: k.description,
      isEntityRef: false,
      children: [],
    };
    if (field.isEnum) {
      if (!Array.isArray(value)) throw new SchemaError(`${path}.${name}: an enum needs a list of values, e.g. [active, done]`);
      if (value.length > SCHEMA_LIMITS.enumValues) throw new SchemaError(`${path}.${name}: an enum has at most ${SCHEMA_LIMITS.enumValues} values`);
      field.enumValues = value.map((v) => String(v));
      if (field.enumValues.some((v) => v.length > SCHEMA_LIMITS.enumValueChars))
        throw new SchemaError(`${path}.${name}: enum values are at most ${SCHEMA_LIMITS.enumValueChars} characters`);
      field.type = "string";
    } else if (field.isObject) {
      field.type = "object";
      field.children = parsePicoschema(value, `${path}.${name}`, budget, depth + 1);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // name: { ... } without (object): treat as an object, as Picoschema does
      field.isObject = true;
      field.type = "object";
      field.children = parsePicoschema(value, `${path}.${name}`, budget, depth + 1);
    } else {
      const text = value === null || value === undefined ? "any" : String(value);
      if (text.length > SCHEMA_LIMITS.typeChars + SCHEMA_LIMITS.descriptionChars + 1)
        throw new SchemaError(`${path}.${name}: type and description are too long`);
      const comma = text.indexOf(",");
      const t = (comma >= 0 ? text.slice(0, comma) : text).trim() || "any";
      const desc = comma >= 0 ? text.slice(comma + 1).trim() : "";
      if (t.length > SCHEMA_LIMITS.typeChars) throw new SchemaError(`${path}.${name}: types are at most ${SCHEMA_LIMITS.typeChars} characters`);
      if (desc) field.description = desc;
      // "string[]" is accepted as array-of-string (BM's error help mentions it).
      if (t.endsWith("[]")) {
        field.isArray = true;
        field.type = t.slice(0, -2);
      } else field.type = t;
      field.isEntityRef = /^[A-Z]/.test(field.type) && !(SCALAR_TYPES as readonly string[]).includes(field.type.toLowerCase());
      if (!field.isEntityRef && !(SCALAR_TYPES as readonly string[]).includes(field.type)) {
        throw new SchemaError(`${path}.${name}: unknown type "${field.type}" (string, integer, number, boolean, any, or a capitalised note type)`);
      }
    }
    out.push(field);
  }
  return out;
}

const normType = (t: string) =>
  t
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

export const sameType = (a: string, b: string) => normType(a) === normType(b);

/** Refuse a schema whose serialized form is over SCHEMA_LIMITS.bytes, before walking it. */
export function checkSchemaSize(value: unknown): void {
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    throw new SchemaError("the schema isn't plain data");
  }
  if (size > SCHEMA_LIMITS.bytes) throw new SchemaError(`a schema is at most ${SCHEMA_LIMITS.bytes / 1024} KB (this one is ${Math.ceil(size / 1024)} KB)`);
}

/** A schema note's frontmatter (type: schema) as a definition. */
export function parseSchemaNote(frontmatter: Record<string, unknown>, source: string): SchemaDefinition {
  const settings = (frontmatter.settings ?? {}) as Record<string, unknown>;
  if (typeof settings !== "object" || Array.isArray(settings)) throw new SchemaError("settings must be a mapping");
  const raw = settings.validation === undefined || settings.validation === null ? "warn" : String(settings.validation).toLowerCase();
  if (!["warn", "strict", "error"].includes(raw)) throw new SchemaError(`settings.validation must be warn or strict, not "${raw}"`);
  const entity = frontmatter.entity ?? frontmatter.title;
  if (typeof entity !== "string" || !entity.trim()) throw new SchemaError("a schema note needs entity: <note type>");
  if (entity.length > SCHEMA_LIMITS.typeChars) throw new SchemaError(`entity is at most ${SCHEMA_LIMITS.typeChars} characters`);
  checkSchemaSize({ schema: frontmatter.schema, settings });
  const budget: Budget = { fields: 0 };
  return {
    entity: entity.trim(),
    version: Number(frontmatter.version ?? 1) || 1,
    fields: parsePicoschema(frontmatter.schema, "schema", budget),
    validationMode: raw === "warn" ? "warn" : "strict",
    frontmatterFields: parsePicoschema(settings.frontmatter, "settings.frontmatter", budget),
    source,
  };
}

// ---------- notes as the schema sees them ----------

export interface SchemaNote {
  permalink: string;
  title: string;
  file_path: string;
  type: string;
  frontmatter: Record<string, unknown>;
  /** Current observations (superseded ones excluded). */
  observations: { category: string; content: string }[];
  /** Relations, with the type of the note each resolves to (null when unresolved). */
  relations: { type: string; target: string; targetType: string | null }[];
  /** Set when the reader stopped short: the note has more observations / relations than were read. */
  truncated?: { observations?: boolean; relations?: boolean };
}

export interface ValidationResult {
  note_identifier: string;
  title: string;
  file_path: string;
  schema_entity: string;
  schema_source: string;
  /** No errors among the checks that ran. */
  passed: boolean;
  /** Every check ran. When false, `incomplete` says what wasn't checked; the note is not "valid". */
  complete: boolean;
  incomplete?: string[];
  warnings: string[];
  errors: string[];
  /** Diagnostics counted but not listed (DIAGNOSTICS_PER_NOTE), by severity. */
  more_warnings: number;
  more_errors: number;
  unmatched_observations: Record<string, number>;
  unmatched_relations: string[];
}

const RELATION_ONLY = new Set(["links_to"]); // inline links aren't typed relations a schema names

const quote = (v: string) => (v.length > 100 ? `${v.slice(0, 97)}…` : v).replace(/\n/g, " ");

function checkScalar(f: SchemaField, value: string): string | null {
  const full = value.trim();
  const v = full.length > 100 ? quote(full) : full;
  if (f.isEnum) {
    if (!f.enumValues.some((e) => e.toLowerCase() === full.toLowerCase())) return `Field ${f.name}: "${v}" is not one of [${f.enumValues.join(", ")}]`;
    return null;
  }
  if (f.type === "integer" && !/^-?\d+$/.test(full)) return `Field ${f.name}: "${v}" is not an integer`;
  if (f.type === "number" && (full === "" || Number.isNaN(Number(full)))) return `Field ${f.name}: "${v}" is not a number`;
  if (f.type === "boolean" && !/^(true|false|yes|no)$/i.test(full)) return `Field ${f.name}: "${v}" is not a boolean`;
  return null;
}

/**
 * A frontmatter value as the strings a field checks, at most WORK.valuesPerField of them (and each
 * at most WORK.valueChars long): never maps an arbitrarily long stored array.
 */
export function fmValues(v: unknown): { values: string[]; overflow: boolean } {
  if (v === undefined || v === null) return { values: [], overflow: false };
  const one = (x: unknown) => {
    const t = typeof x === "object" && x !== null ? "[object]" : String(x);
    return t.length > WORK.valueChars ? t.slice(0, WORK.valueChars) : t;
  };
  if (!Array.isArray(v)) return { values: [one(v)], overflow: false };
  const n = Math.min(v.length, WORK.valuesPerField);
  const values: string[] = new Array(n);
  for (let i = 0; i < n; i++) values[i] = one(v[i]);
  return { values, overflow: v.length > n };
}

/** Bounds on the checks one call makes, whatever the schema and the notes hold. */
export const WORK = { valuesPerField: 100, valueChars: 10_000, perNote: 5_000, perCall: 100_000 };

/** A countdown of checks; once spent, the caller stops and reports the work as incomplete. */
export class Work {
  exhausted = false;
  constructor(public left: number) {}
  take(n = 1): boolean {
    if (this.exhausted || this.left < n) {
      this.exhausted = true;
      return false;
    }
    this.left -= n;
    return true;
  }
}

/** Diagnostics kept per note; the rest are counted ("…and N more"). */
export const DIAGNOSTICS_PER_NOTE = 20;
/** Type mismatches listed by diff; the rest are counted. */
export const MISMATCHES_MAX = 100;

/**
 * Validate one note. `resolveType` gives the note type a frontmatter-only entity reference points
 * at (relations arrive already resolved, with targetType). Every value check and target lookup is
 * charged to a per-note budget and to `callWork` (shared by the whole call); when either runs out
 * the note is reported incomplete, never valid.
 */
export function validateNote(
  note: SchemaNote,
  schema: SchemaDefinition,
  resolveType?: (name: string) => string | null,
  callWork: Work = new Work(WORK.perCall),
): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  let moreWarnings = 0;
  let moreErrors = 0;
  const incomplete: string[] = [];
  const noteWork = new Work(WORK.perNote);
  const charge = (n = 1) => noteWork.take(n) && callWork.take(n);
  const listed = () => warnings.length + errors.length;
  const warn = (msg: string) => {
    if (listed() < DIAGNOSTICS_PER_NOTE) warnings.push(msg);
    else moreWarnings++;
  };
  const err = (msg: string) => {
    if (listed() < DIAGNOSTICS_PER_NOTE) errors.push(msg);
    else moreErrors++;
  };
  const problem = (msg: string) => (schema.validationMode === "strict" ? err(msg) : warn(msg));
  // A link to a note that doesn't exist yet is allowed by the note format: always a warning.
  const notice = warn;
  if (note.truncated?.observations) incomplete.push("the note has more observations than are read per note; later ones weren't checked");
  if (note.truncated?.relations) incomplete.push("the note has more relations than are read per note; later ones weren't checked");

  // Grouped once (push, not copy-per-item); frontmatter values capped and computed once per key.
  const obsBy = new Map<string, string[]>();
  for (const o of note.observations) {
    const k = o.category.toLowerCase();
    const list = obsBy.get(k);
    if (list) list.push(o.content);
    else obsBy.set(k, [o.content]);
  }
  const relBy = new Map<string, { target: string; targetType: string | null }[]>();
  for (const r of note.relations) {
    const k = r.type.toLowerCase();
    const list = relBy.get(k);
    const item = { target: r.target, targetType: r.targetType };
    if (list) list.push(item);
    else relBy.set(k, [item]);
  }
  const fmCache = new Map<string, string[]>();
  const fm = (name: string): string[] => {
    const cached = fmCache.get(name);
    if (cached) return cached;
    const { values, overflow } = fmValues(note.frontmatter[name]);
    if (overflow) incomplete.push(`frontmatter ${name} has more than ${WORK.valuesPerField} values; the first ${WORK.valuesPerField} were checked`);
    fmCache.set(name, values);
    return values;
  };
  const usedObs = new Set<string>();
  const usedRel = new Set<string>();
  let ranOut = false;

  fields: for (const f of schema.fields) {
    if (!charge()) {
      ranOut = true;
      break;
    }
    const key = f.name.toLowerCase();
    const present = note.frontmatter[f.name] !== undefined;
    if (f.isEntityRef) {
      usedRel.add(key);
      // Relations first; a frontmatter value (Cairn extension) names the target note instead.
      const rels = relBy.get(key);
      const names = rels ? null : fm(f.name);
      const count = rels ? rels.length : (names?.length ?? 0);
      if (!count) {
        // Not among the relations read; with more unread, absence isn't proven.
        if (f.required && note.truncated?.relations) incomplete.push(`${f.name}: not among the relations read; the rest weren't checked`);
        else if (f.required) problem(`Missing required field: ${f.name} (expected ${f.name} [[${f.type}]] relation)`);
        continue;
      }
      for (let i = 0; i < count; i++) {
        if (!charge()) {
          ranOut = true;
          break fields;
        }
        const r = rels ? rels[i] : { target: (names as string[])[i], targetType: resolveType ? resolveType((names as string[])[i]) : null };
        if (r.targetType === null) notice(`Field ${f.name}: [[${quote(r.target)}]] doesn't resolve to a note yet (expected a ${f.type})`);
        else if (!sameType(r.targetType, f.type)) problem(`Field ${f.name}: [[${quote(r.target)}]] is a ${r.targetType}, not a ${f.type}`);
      }
      continue;
    }
    if (f.isObject) {
      if (f.required && !present && !obsBy.has(key)) problem(`Missing required field: ${f.name} (expected ${f.name} in frontmatter)`);
      usedObs.add(key);
      continue;
    }
    const obs = obsBy.get(key) ?? [];
    usedObs.add(key);
    const values = obs.length ? obs : fm(f.name);
    if (!values.length) {
      if (f.required && note.truncated?.observations) incomplete.push(`${f.name}: not among the observations read; the rest weren't checked`);
      else if (f.required) problem(`Missing required field: ${f.name} (expected [${f.name}] observation)`);
      continue;
    }
    for (const v of values) {
      if (!charge()) {
        ranOut = true;
        break fields;
      }
      const bad = checkScalar(f, v);
      if (bad) problem(bad);
    }
  }
  if (!ranOut) {
    fmKeys: for (const f of schema.frontmatterFields) {
      if (!charge()) {
        ranOut = true;
        break;
      }
      const v = note.frontmatter[f.name];
      if (v === undefined || v === null) {
        if (f.required) problem(`Missing required frontmatter key: ${f.name}`);
        continue;
      }
      if (f.isEnum || ["integer", "number", "boolean"].includes(f.type)) {
        for (const x of fm(f.name)) {
          if (!charge()) {
            ranOut = true;
            break fmKeys;
          }
          const bad = checkScalar(f, x);
          if (bad) problem(bad.replace(/^Field /, "Frontmatter key "));
        }
      }
    }
  }
  if (ranOut)
    incomplete.push(
      callWork.exhausted
        ? "this call's check budget ran out; the rest wasn't checked"
        : "the note needs more checks than one note is allowed; the rest wasn't checked",
    );
  if (moreWarnings) warnings.push(`…and ${moreWarnings} more warning(s)`);
  if (moreErrors) errors.push(`…and ${moreErrors} more error(s)`);
  const unmatched_observations: Record<string, number> = {};
  for (const o of note.observations)
    if (!usedObs.has(o.category.toLowerCase())) unmatched_observations[o.category] = (unmatched_observations[o.category] ?? 0) + 1;
  const unmatched_relations = [...new Set(note.relations.map((r) => r.type).filter((t) => !usedRel.has(t.toLowerCase()) && !RELATION_ONLY.has(t)))].slice(
    0,
    50,
  );
  return {
    note_identifier: note.permalink,
    title: note.title,
    file_path: note.file_path,
    schema_entity: schema.entity,
    schema_source: schema.source,
    passed: errors.length === 0 && moreErrors === 0,
    complete: incomplete.length === 0,
    ...(incomplete.length ? { incomplete } : {}),
    warnings,
    errors,
    more_warnings: moreWarnings,
    more_errors: moreErrors,
    unmatched_observations,
    unmatched_relations,
  };
}

// ---------- inference and drift ----------

export interface FieldFrequency {
  name: string;
  source: "observation" | "relation";
  count: number;
  total: number;
  percentage: number;
  sample_values: string[];
  is_array: boolean;
  target_type?: string;
}

const pascal = (t: string) =>
  t
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

/** How often each observation category and relation type appears across notes (by note). */
export function frequencies(notes: SchemaNote[]): FieldFrequency[] {
  const total = notes.length;
  const acc = new Map<
    string,
    { name: string; source: "observation" | "relation"; notes: number; multi: boolean; samples: string[]; targets: Map<string, number> }
  >();
  for (const n of notes) {
    const seen = new Map<string, number>();
    const add = (source: "observation" | "relation", name: string, sample: string, targetType: string | null) => {
      const key = `${source}\u0000${name.toLowerCase()}`;
      let a = acc.get(key);
      if (!a) {
        a = { name, source, notes: 0, multi: false, samples: [], targets: new Map() };
        acc.set(key, a);
      }
      const c = (seen.get(key) ?? 0) + 1;
      seen.set(key, c);
      if (c === 1) a.notes++;
      if (c === 2) a.multi = true;
      const short = sample.length > 200 ? `${sample.slice(0, 199)}…` : sample;
      if (a.samples.length < 5 && !a.samples.includes(short)) a.samples.push(short);
      if (targetType) a.targets.set(targetType, (a.targets.get(targetType) ?? 0) + 1);
    };
    for (const o of n.observations) add("observation", o.category, o.content, null);
    for (const r of n.relations) add("relation", r.type, r.target, r.targetType);
  }
  return [...acc.values()]
    .map((a) => {
      const top = [...a.targets.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
      return {
        name: a.name,
        source: a.source,
        count: a.notes,
        total,
        percentage: total ? a.notes / total : 0,
        sample_values: a.samples,
        is_array: a.multi,
        ...(top ? { target_type: top } : {}),
      };
    })
    .sort((x, y) => y.count - x.count || (x.source === y.source ? x.name.localeCompare(y.name) : x.source === "observation" ? -1 : 1));
}

export const REQUIRED_SHARE = 0.95;
/** Fields listed in an infer/diff report; the rest are counted (`fields_omitted`). */
export const FIELDS_LISTED = 300;

export interface InferenceResult {
  note_type: string;
  notes_analyzed: number;
  field_frequencies: FieldFrequency[];
  /** Field frequencies (and excluded names) not listed, beyond FIELDS_LISTED. */
  fields_omitted: number;
  suggested_schema: Record<string, string>;
  suggested_required: string[];
  suggested_optional: string[];
  excluded: string[];
}

export function inferSchema(noteType: string, notes: SchemaNote[], threshold = 0.25): InferenceResult {
  const freq = frequencies(notes);
  const suggested: Record<string, string> = {};
  const req: string[] = [];
  const opt: string[] = [];
  const excluded: string[] = [];
  for (const f of freq) {
    if (f.percentage < threshold || f.count === 0) {
      excluded.push(f.name);
      continue;
    }
    const required = f.percentage >= REQUIRED_SHARE;
    const type = f.source === "relation" ? (f.target_type ? pascal(f.target_type) : "string") : "string";
    suggested[`${f.name}${required ? "" : "?"}${f.is_array ? "(array)" : ""}`] = type;
    (required ? req : opt).push(f.name);
  }
  return {
    note_type: noteType,
    notes_analyzed: notes.length,
    field_frequencies: freq.slice(0, FIELDS_LISTED),
    fields_omitted: Math.max(0, freq.length - FIELDS_LISTED),
    suggested_schema: suggested,
    suggested_required: req,
    suggested_optional: opt,
    excluded: excluded.slice(0, FIELDS_LISTED),
  };
}

export interface SchemaDrift {
  note_type: string;
  schema_source: string;
  notes_analyzed: number;
  new_fields: FieldFrequency[];
  dropped_fields: FieldFrequency[];
  cardinality_changes: string[];
  type_mismatches: string[];
  /** False when not every field and value was compared; `incomplete` says what wasn't. */
  complete: boolean;
  incomplete?: string[];
}

export function diffSchema(
  schema: SchemaDefinition,
  noteType: string,
  notes: SchemaNote[],
  threshold = 0.25,
  work: Work = new Work(WORK.perCall),
): SchemaDrift {
  const freq = frequencies(notes);
  const declared = new Map(schema.fields.map((f) => [f.name.toLowerCase(), f]));
  const bySourceName = new Map(freq.map((x) => [`${x.source}\u0000${x.name.toLowerCase()}`, x]));
  const new_fields = freq.filter((f) => !declared.has(f.name.toLowerCase()) && f.percentage >= threshold && !RELATION_ONLY.has(f.name)).slice(0, FIELDS_LISTED);
  const dropped_fields: FieldFrequency[] = [];
  const cardinality_changes: string[] = [];
  const type_mismatches: string[] = [];
  let mismatchesDropped = 0;
  const overflowed = new Set<string>();
  // Each note's categories and relation types once (values grouped), so the work is fields × notes.
  const perNote = notes.map((n) => {
    const obs = new Map<string, string[]>();
    for (const o of n.observations) {
      const k = o.category.toLowerCase();
      const l = obs.get(k);
      if (l) l.push(o.content);
      else obs.set(k, [o.content]);
    }
    return { n, obs, rels: new Set(n.relations.map((r) => r.type.toLowerCase())) };
  });
  fields: for (const f of schema.fields) {
    const key = f.name.toLowerCase();
    const source = f.isEntityRef ? "relation" : "observation";
    const used = bySourceName.get(`${source}\u0000${key}`);
    // Cairn: a field kept in frontmatter counts as used.
    let count = 0;
    if (!work.take(perNote.length)) break;
    for (const p of perNote) {
      const has = source === "relation" ? p.rels.has(key) : p.obs.has(key);
      if (has || (p.n.frontmatter[f.name] !== undefined && p.n.frontmatter[f.name] !== null)) count++;
    }
    const share = notes.length ? count / notes.length : 0;
    if (share < threshold) {
      dropped_fields.push({
        name: f.name,
        source,
        count,
        total: notes.length,
        percentage: share,
        sample_values: used?.sample_values ?? [],
        is_array: used?.is_array ?? false,
      });
    }
    if (used) {
      if (used.is_array && !f.isArray) cardinality_changes.push(`${f.name}: one → many (${used.name} appears more than once in a note)`);
      if (!used.is_array && f.isArray && used.count > 0) cardinality_changes.push(`${f.name}: many → one (never more than one per note)`);
    }
    if (!f.isEntityRef && !f.isObject && (f.isEnum || ["integer", "number", "boolean"].includes(f.type))) {
      for (const { n, obs } of perNote) {
        const vals = obs.get(key) ?? [];
        let values = vals;
        if (!vals.length) {
          const fm = fmValues(n.frontmatter[f.name]);
          if (fm.overflow) overflowed.add(f.name);
          values = fm.values;
        }
        for (const v of values) {
          if (!work.take()) break fields;
          const bad = checkScalar(f, v);
          if (bad && type_mismatches.length < MISMATCHES_MAX) type_mismatches.push(`${n.permalink}: ${bad}`);
          else if (bad) mismatchesDropped++;
        }
      }
    }
  }
  if (mismatchesDropped) type_mismatches.push(`…and ${mismatchesDropped} more`);
  // Fitting the work budget isn't the same as comparing everything: say what was capped.
  const incomplete: string[] = [];
  if (work.exhausted) incomplete.push("this call's check budget ran out before every field and value was compared");
  for (const name of overflowed)
    incomplete.push(`frontmatter ${name} has more than ${WORK.valuesPerField} values in some notes; only the first ${WORK.valuesPerField} were compared`);
  const truncatedNotes = notes.filter((n) => n.truncated?.observations || n.truncated?.relations).length;
  if (truncatedNotes) incomplete.push(`${truncatedNotes} note(s) have more observations or relations than are read per note; the rest weren't compared`);
  return {
    note_type: noteType,
    schema_source: schema.source,
    notes_analyzed: notes.length,
    new_fields,
    dropped_fields,
    cardinality_changes,
    type_mismatches,
    complete: incomplete.length === 0,
    ...(incomplete.length ? { incomplete } : {}),
  };
}

// ---------- text output (Basic Memory's layout) ----------

const pct = (p: number) => `${Math.round(p * 100)}%`;
const sample = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s).replace(/\n/g, " ");

export function inferText(r: InferenceResult): string {
  const lines = [`# Schema Inference: ${r.note_type}`, "", `Notes analyzed: ${r.notes_analyzed}`, "", "## Suggested Schema", "", "```yaml", "---"];
  lines.push(`title: ${pascal(r.note_type)}`, "type: schema", `entity: ${r.note_type}`, "version: 1");
  const keys = Object.entries(r.suggested_schema);
  lines.push(keys.length ? "schema:" : "schema: {}");
  for (const [k, v] of keys) lines.push(`  ${k}: ${v}`);
  lines.push("settings:", "  validation: warn", "---", "```", "", "## Field Frequencies", "");
  for (const f of r.field_frequencies) {
    const tag = r.suggested_required.includes(f.name) ? "required" : "optional";
    lines.push(
      `- **${f.name}** (${f.source}) — ${pct(f.percentage)} (${f.count}/${f.total}) [${tag}]${f.sample_values.length ? ` (e.g. ${f.sample_values.slice(0, 3).map(sample).join(", ")})` : ""}`,
    );
  }
  if (r.fields_omitted) lines.push(`- …and ${r.fields_omitted} more field(s), not listed`);
  if (r.excluded.length) lines.push("", "## Excluded (below threshold)", "", ...r.excluded.map((e) => `- ${e}`));
  return lines.join("\n");
}

/** Totals for a report: valid = passed and complete; warnings and errors include the ones not listed. */
export function validationCounts(results: ValidationResult[]) {
  const listed = (xs: string[]) => xs.filter((x) => !x.startsWith("…and ")).length;
  return {
    valid: results.filter((r) => r.passed && r.complete).length,
    warnings: results.reduce((n, r) => n + listed(r.warnings) + r.more_warnings, 0),
    errors: results.reduce((n, r) => n + listed(r.errors) + r.more_errors, 0),
    incomplete: results.filter((r) => !r.complete).length,
  };
}

export function validateText(title: string, results: ValidationResult[]): string {
  const counts = validationCounts(results);
  const lines = [
    `# Schema Validation: ${title}`,
    "",
    `Notes: ${results.length} | Valid: ${counts.valid} | Warnings: ${counts.warnings} | Errors: ${counts.errors}${counts.incomplete ? ` | Incomplete: ${counts.incomplete}` : ""}`,
    "",
  ];
  for (const r of results) {
    // A note whose checks didn't all run is never called valid.
    const status = !r.passed ? "invalid" : r.complete ? "valid" : "incomplete";
    lines.push(`- **${r.note_identifier}** — ${status}${results.length > 1 && r.schema_entity !== title ? ` (${r.schema_entity})` : ""}`);
    for (const x of r.errors) lines.push(`  - error: ${x}`);
    for (const x of r.warnings) lines.push(`  - warning: ${x}`);
    for (const x of r.incomplete ?? []) lines.push(`  - incomplete: ${x}`);
    const um = Object.entries(r.unmatched_observations);
    if (um.length) lines.push(`  - info: unmatched observations: ${um.map(([k, n]) => `[${k}] ×${n}`).join(", ")}`);
    if (r.unmatched_relations.length) lines.push(`  - info: unmatched relations: ${r.unmatched_relations.join(", ")}`);
  }
  return lines.join("\n");
}

export function diffText(d: SchemaDrift): string {
  const lines = [`# Schema Drift: ${d.note_type}`, "", `Schema: ${d.schema_source} | Notes analyzed: ${d.notes_analyzed}`, ""];
  if (!d.complete) lines.push(...(d.incomplete ?? ["Incomplete: not every field and value was compared."]).map((x) => `Incomplete: ${x}.`), "");
  const none = !d.new_fields.length && !d.dropped_fields.length && !d.cardinality_changes.length && !d.type_mismatches.length;
  if (none) return [...lines, d.complete ? "No drift: the notes match the schema." : "No drift found in what was compared."].join("\n");
  if (d.new_fields.length) {
    lines.push("## New Fields (in notes but not in schema)", "");
    for (const f of d.new_fields) lines.push(`- **${f.name}** (${f.source}) — ${pct(f.percentage)} (${f.count}/${f.total})`);
    lines.push("");
  }
  if (d.dropped_fields.length) {
    lines.push("## Dropped Fields (in schema but rare in notes)", "");
    for (const f of d.dropped_fields) lines.push(`- **${f.name}** (${f.source}) — ${pct(f.percentage)} (${f.count}/${f.total})`);
    lines.push("");
  }
  if (d.cardinality_changes.length) lines.push("## Cardinality Changes", "", ...d.cardinality_changes.map((c) => `- ${c}`), "");
  if (d.type_mismatches.length) lines.push("## Type Mismatches", "", ...d.type_mismatches.slice(0, 50).map((c) => `- ${c}`), "");
  return lines.join("\n").trimEnd();
}

export function noSchemaHelp(noteType: string): string {
  return `# No Schema Found for '${noteType}'

check_schema(command='validate', note_type='${noteType}') needs a schema note for type '${noteType}'.

## How to create one

1. **Infer it from existing notes:** check_schema(command='infer', note_type='${noteType}') suggests a schema.
2. **Write a schema note** (e.g. write_note(identifier='schema/${pascal(noteType)}.md', ...)) with this frontmatter:

\`\`\`yaml
---
title: ${pascal(noteType)}
type: schema
entity: ${noteType}
version: 1
schema:
  name: string, full name
  role?: string, job title
  status?(enum): [active, done]
settings:
  validation: warn
---
\`\`\`

Fields use Picoschema: \`field: type, description\` (required), \`field?: type\` (optional),
\`field?(array): type\`, \`field?(enum): [a, b]\`; types string, integer, number, boolean, any, or a
capitalised note type for a relation. A scalar field is an observation \`[field] value\` (or, in Cairn,
a frontmatter key); a relation field is \`field [[Target]]\`.

3. **Re-run** check_schema(command='validate', note_type='${noteType}'). Cairn indexes the schema note as soon as it is saved.`;
}

/**
 * Document-type (DOTY) classification.
 *
 * Rule 1: the numeric code prefix is NOT a reliable signal — applications and
 * notices share ranges with permits (11229 "Ehitusloa taotlus…" sits right next
 * to 11201–11206 "Ehitusteatis…").
 *
 * Rule 2: classify on the type *name*, anchored to the start of the string.
 * "^Ehitusluba\b" matches "Ehitusluba ehitise laiendamiseks" but not
 * "Ehitusloa taotlus ehitise laiendamiseks" or
 * "Ehitusloa kehtetuks tunnistamise otsus" — the genitive "Ehitusloa" simply is
 * not the word "Ehitusluba".
 *
 * Rule 3: the classifier is fetched at runtime and cached for 24 h; the code
 * tables below are an offline fallback only.
 */
import { config } from "../config.js";
import { fetchJson } from "./http.js";

export type PermitCategory = "kasutusluba" | "kasutusteatis" | "ehitusluba" | "ehitusteatis";

export const PERMIT_CATEGORIES: readonly PermitCategory[] = [
  "kasutusluba",
  "kasutusteatis",
  "ehitusluba",
  "ehitusteatis",
];

export type DocCategory = PermitCategory | "taotlus" | "kehtetuks_tunnistamine" | "muu";

/** Which legal framework the document type belongs to (EhS 2015 took effect 01.07.2015). */
export type Framework = "pre-EhS2015" | "EhS2015" | "molemad";

export interface DocumentTypeRecord {
  id: number;
  name: string;
  validFrom?: string;
  validTo?: string;
}

export interface Classification {
  kategooria: DocCategory;
  /** For `taotlus` / `kehtetuks_tunnistamine`: which permit category it concerns. */
  seotud_kategooria?: PermitCategory;
  /** For `kehtetuks_tunnistamine`: a decision revokes, an application only requests. */
  kehtetuks_liik?: "otsus" | "taotlus";
  raamistik?: Framework;
}

/**
 * Offline fallback — used only when the live classifier cannot be fetched.
 * Verified 18.08.2026 to be exactly what the name-anchored regexes select.
 */
const FALLBACK_IDS: Record<PermitCategory, readonly number[]> = {
  kasutusluba: [
    1, 123, 12311, 12312, 12313, 12314, 12318, 12319, 12328, 12329, 12331, 12332, 12333, 12334,
    12338, 12339, 12341, 12348, 12349, 12351, 12359, 12371, 12381, 12391, 12399,
  ],
  ehitusluba: [
    122, 12211, 12212, 12213, 12214, 12219, 12229, 12231, 12232, 12233, 12234, 12239, 12241,
    12249, 12251, 12271, 12291, 12299,
  ],
  ehitusteatis: [11201, 11202, 11203, 11204, 11205, 11206],
  kasutusteatis: [11301, 11302, 11303, 11304, 11305, 11306],
};

const FALLBACK_BY_ID = new Map<number, PermitCategory>();
for (const cat of PERMIT_CATEGORIES) {
  for (const id of FALLBACK_IDS[cat]) FALLBACK_BY_ID.set(id, cat);
}

const PERMIT_NAME_RE: ReadonlyArray<readonly [PermitCategory, RegExp]> = [
  ["kasutusluba", /^Kasutusluba\b/i],
  ["ehitusluba", /^Ehitusluba\b/i],
  ["ehitusteatis", /^Ehitusteatis\b/i],
  ["kasutusteatis", /^Kasutusteatis\b/i],
];

/** Genitive stems, used to tell which permit an application / revocation concerns. */
const GENITIVE_RE: ReadonlyArray<readonly [PermitCategory, RegExp]> = [
  ["kasutusluba", /^Kasutusloa\b/i],
  ["ehitusluba", /^Ehitusloa\b/i],
  ["ehitusteatis", /^Ehitusteatise\b/i],
  ["kasutusteatis", /^Kasutusteatise\b/i],
];

const REVOCATION_RE = /kehtetuks\s+tunnistami(se|ne|st)/i;
const APPLICATION_RE = /\btaotlus/i;

/** EhS 2015 entered into force 01.07.2015. */
const EHS2015 = Date.UTC(2015, 6, 1);

/**
 * The classifier mixes two date formats: `validFrom` is "01.10.2002" and
 * `validTo` is "2099-12-31 00:00:00.0". Returns undefined for anything else.
 */
export function parseClassifierDate(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return undefined;
}

/**
 * Which legal framework a document type belongs to. Types that expired on or
 * before 01.07.2015 are pre-EhS2015 — still valid evidence, never filtered out.
 */
export function frameworkOf(rec: DocumentTypeRecord | undefined): Framework | undefined {
  if (!rec) return undefined;
  const to = parseClassifierDate(rec.validTo);
  if (to !== undefined && to <= EHS2015) return "pre-EhS2015";
  const from = parseClassifierDate(rec.validFrom);
  if (from !== undefined && from >= EHS2015) return "EhS2015";
  if (from === undefined && to === undefined) return undefined;
  return "molemad";
}

/** Classify a document type by name alone. Pure; the heart of Rules 1 and 2. */
export function classifyName(name: string | null | undefined): Classification {
  const n = (name ?? "").trim();
  if (n === "") return { kategooria: "muu" };

  const related = GENITIVE_RE.find(([, re]) => re.test(n))?.[0];

  // Revocations first: "Kasutusloa kehtetuks tunnistamise taotlus" also contains
  // "taotlus", and must not be filed as a plain application.
  if (REVOCATION_RE.test(n)) {
    const out: Classification = { kategooria: "kehtetuks_tunnistamine" };
    if (related) out.seotud_kategooria = related;
    out.kehtetuks_liik = APPLICATION_RE.test(n) ? "taotlus" : "otsus";
    return out;
  }

  const permit = PERMIT_NAME_RE.find(([, re]) => re.test(n))?.[0];
  if (permit) return { kategooria: permit };

  if (APPLICATION_RE.test(n)) {
    const out: Classification = { kategooria: "taotlus" };
    if (related) out.seotud_kategooria = related;
    return out;
  }

  return { kategooria: "muu" };
}

export interface ClassifierTable {
  byId: Map<number, DocumentTypeRecord>;
  /** "klassifikaator" = live table; "fallback" = hard-coded id sets. */
  allikas: "klassifikaator" | "fallback";
}

const TTL_MS = 24 * 60 * 60 * 1000;
let cache: { table: ClassifierTable; expires: number } | undefined;

/** Fetch (and cache for 24 h) the document-type classifier. Never throws. */
export async function getClassifier(forceRefresh = false): Promise<ClassifierTable> {
  const now = Date.now();
  if (!forceRefresh && cache && cache.expires > now) return cache.table;

  let table: ClassifierTable;
  try {
    const rows = await fetchJson<DocumentTypeRecord[]>(
      `${config.ehrRootUrl}/api/classifier/v1/alldocumenttypes`,
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty classifier");
    const byId = new Map<number, DocumentTypeRecord>();
    for (const r of rows) {
      if (typeof r?.id === "number") byId.set(r.id, r);
    }
    table = { byId, allikas: "klassifikaator" };
  } catch (err) {
    console.error(
      "Document-type classifier unavailable, using offline fallback:",
      err instanceof Error ? err.name : "unknown",
    );
    table = { byId: new Map(), allikas: "fallback" };
  }

  cache = { table, expires: now + TTL_MS };
  return table;
}

/** Reset the cached classifier (tests). */
export function resetClassifierCache(): void {
  cache = undefined;
}

/**
 * Classify one document. The building's document list already carries the type
 * name, so classification works even for ids missing from the classifier; the
 * classifier adds `raamistik`, and the hard-coded ids are the last resort.
 */
export function classifyDocument(
  typeId: number | undefined,
  typeName: string | null | undefined,
  table: ClassifierTable,
): Classification {
  const rec = typeId !== undefined ? table.byId.get(typeId) : undefined;
  const name = typeName ?? rec?.name;

  let result = classifyName(name);
  if (result.kategooria === "muu" && typeId !== undefined) {
    const fallback = FALLBACK_BY_ID.get(typeId);
    if (fallback) result = { kategooria: fallback };
  }

  const raamistik = frameworkOf(rec);
  return raamistik ? { ...result, raamistik } : result;
}

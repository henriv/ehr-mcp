/**
 * Pure derivation of permit status from a building's document list.
 * No I/O — everything here is a total function over already-fetched data.
 */
import {
  classifyDocument,
  PERMIT_CATEGORIES,
  type ClassifierTable,
  type Classification,
  type DocCategory,
  type Framework,
  type PermitCategory,
} from "./classifier.js";
import type { DocumentDetailResult, RawDocumentListItem } from "./documents.js";

/** The only state that means "entered into the register". */
export const REGISTERED = "DO_DOKUSEIS_REG_KANTUD";

export type PermitStatus = "olemas" | "puudub" | "kehtetu" | "menetluses";

export interface NormalisedDoc {
  id?: number;
  doty?: number;
  tyyp?: string;
  number?: string;
  /** Calendar date in Europe/Tallinn — the upstream timestamp is UTC. */
  kuupaev?: string;
  olek?: string;
  olek_tekst?: string;
  kategooria: DocCategory;
  seotud_kategooria?: PermitCategory;
  kehtetuks_liik?: "otsus" | "taotlus";
  raamistik?: Framework;
  /** Present only when document details were fetched. */
  menetleja?: string;
  ak_marge?: boolean;
  /** true when the detail view is closed (HTTP 401) — see README, "Teadaolevad piirangud". */
  juurdepaas_piiratud?: boolean;
  seotud_dokumendid?: Array<{
    id?: number;
    doty?: number;
    number?: string;
    olek?: string;
    olek_tekst?: string;
  }>;
}

export interface PermitResult {
  staatus: PermitStatus;
  /** Documents of this category itself — the actual permit / notice. */
  dokumendid: NormalisedDoc[];
  /** Applications concerning this category (the "menetluses" evidence). */
  taotlused?: NormalisedDoc[];
  /** Revocation decisions concerning this category (the "kehtetu" evidence). */
  kehtetuks_tunnistamised?: NormalisedDoc[];
}

const TALLINN_DATE = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Tallinn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The API returns UTC instants such as `2003-12-30T22:00:00.000+00:00`, which is
 * 31.12.2003 in Estonia — the date the register itself displays. Convert rather
 * than truncate.
 */
export function tallinnDate(iso: unknown): string | undefined {
  if (typeof iso !== "string" || iso.trim() === "") return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return TALLINN_DATE.format(new Date(t));
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Turn one raw list entry into the compact shape, attaching its classification. */
export function normaliseDoc(
  raw: RawDocumentListItem,
  table: ClassifierTable,
): NormalisedDoc {
  const typeId = typeof raw.documentTypeId === "number" ? raw.documentTypeId : undefined;
  const c: Classification = classifyDocument(typeId, str(raw.documentType), table);

  const doc: NormalisedDoc = { kategooria: c.kategooria };
  if (typeof raw.documentId === "number") doc.id = raw.documentId;
  if (typeId !== undefined) doc.doty = typeId;
  const tyyp = str(raw.documentType);
  if (tyyp) doc.tyyp = tyyp;
  const nr = str(raw.documentNumber);
  if (nr) doc.number = nr;
  const kp = tallinnDate(raw.date);
  if (kp) doc.kuupaev = kp;
  const olek = str(raw.documentState);
  if (olek) doc.olek = olek;
  const olekTekst = str(raw.documentStateText);
  if (olekTekst) doc.olek_tekst = olekTekst;
  if (c.seotud_kategooria) doc.seotud_kategooria = c.seotud_kategooria;
  if (c.kehtetuks_liik) doc.kehtetuks_liik = c.kehtetuks_liik;
  if (c.raamistik) doc.raamistik = c.raamistik;

  return doc;
}

/**
 * Merge detail fields into a normalised document. Only the prosecuting
 * authority, the access-restriction mark and the related-document chain are
 * taken — never the personal data in `relatedEntities`.
 */
export function applyDetail(
  doc: NormalisedDoc,
  result: DocumentDetailResult,
  opts: { seotud?: boolean } = {},
): NormalisedDoc {
  if (result.piiratud) doc.juurdepaas_piiratud = true;
  const detail = result.detail;
  if (!detail) return doc;

  const menetleja = str(detail.prosecutingAuthority?.registrationName);
  if (menetleja) doc.menetleja = menetleja;
  // Only surfaced when set — the absence of a restriction is the normal case.
  if (detail.hasAkMark === true) doc.ak_marge = true;

  if (opts.seotud === false) return doc;

  const related = Array.isArray(detail.relatedDocuments) ? detail.relatedDocuments : [];
  const seotud = related.map((r) => {
    const item: NonNullable<NormalisedDoc["seotud_dokumendid"]>[number] = {};
    if (typeof r.documentId === "number") item.id = r.documentId;
    if (typeof r.documentType === "number") item.doty = r.documentType;
    const nr = str(r.documentNumber);
    if (nr) item.number = nr;
    const olek = str(r.documentStatusCode);
    if (olek) item.olek = olek;
    const olekTekst = str(r.documentStatusText);
    if (olekTekst) item.olek_tekst = olekTekst;
    return item;
  });
  if (seotud.length > 0) doc.seotud_dokumendid = seotud;

  return doc;
}

const isRegistered = (d: NormalisedDoc): boolean => d.olek === REGISTERED;

/**
 * Derive the status of one permit category.
 *
 *   kehtetu    — a registered revocation *decision* for this category exists
 *   olemas     — at least one registered document, not revoked
 *   menetluses — only an application, or documents in a non-final state
 *   puudub     — nothing in this category at all
 *
 * A revocation *application* does not revoke anything; it surfaces as a warning.
 */
export function derivePermitStatus(
  category: PermitCategory,
  docs: readonly NormalisedDoc[],
): PermitResult {
  const own = docs.filter((d) => d.kategooria === category);
  const applications = docs.filter(
    (d) => d.kategooria === "taotlus" && d.seotud_kategooria === category,
  );
  const revocationDecisions = docs.filter(
    (d) =>
      d.kategooria === "kehtetuks_tunnistamine" &&
      d.seotud_kategooria === category &&
      d.kehtetuks_liik === "otsus" &&
      isRegistered(d),
  );

  let staatus: PermitStatus;
  if (own.length > 0) {
    if (revocationDecisions.length > 0) staatus = "kehtetu";
    else if (own.some(isRegistered)) staatus = "olemas";
    else staatus = "menetluses";
  } else if (applications.length > 0) {
    staatus = "menetluses";
  } else {
    staatus = "puudub";
  }

  const result: PermitResult = { staatus, dokumendid: own };
  if (applications.length > 0) result.taotlused = applications;
  if (revocationDecisions.length > 0) result.kehtetuks_tunnistamised = revocationDecisions;
  return result;
}

/** Pre-2003 building-register carry-overs, which are NOT permits. */
const HOONEREGISTER_RE = /^Hooneregistri\b/i;

/** Non-fabricating caveats about what the document list does and does not prove. */
export function deriveWarnings(
  docs: readonly NormalisedDoc[],
  table: ClassifierTable,
): string[] {
  const warnings: string[] = [];

  if (docs.length === 0) {
    warnings.push("Ehitisel puuduvad avalikus dokumendinimekirjas kanded.");
  }

  const hasPermitDoc = docs.some((d) =>
    (PERMIT_CATEGORIES as readonly string[]).includes(d.kategooria),
  );
  const hasHooneregister = docs.some((d) => HOONEREGISTER_RE.test(d.tyyp ?? ""));
  if (hasHooneregister && !hasPermitDoc) {
    warnings.push(
      "Ehitis sisaldab ainult pre-2003 hooneregistri kandeid — „Hooneregistri ehitise teatis“ EI ole kasutusluba ega ehitusluba.",
    );
  }

  const pendingRevocation = docs.filter(
    (d) => d.kategooria === "kehtetuks_tunnistamine" && d.kehtetuks_liik === "taotlus",
  );
  if (pendingRevocation.length > 0) {
    warnings.push(
      "Esitatud on kehtetuks tunnistamise taotlus; taotlus ise luba kehtetuks ei tunnista.",
    );
  }

  const unattributedRevocation = docs.some(
    (d) => d.kategooria === "kehtetuks_tunnistamine" && d.seotud_kategooria === undefined,
  );
  if (unattributedRevocation) {
    warnings.push(
      "Nimekirjas on kehtetuks tunnistamise dokument, mille sihtluba ei õnnestunud tuvastada.",
    );
  }

  if (table.allikas === "fallback") {
    warnings.push(
      "Dokumenditüüpide klassifikaator ei olnud kättesaadav; kasutati offline-nimekirja (raamistik võib puududa).",
    );
  }

  return warnings;
}

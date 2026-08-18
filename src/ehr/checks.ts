/**
 * Orchestration for the six checks. Fetching lives here; the derivation rules
 * live in permits.ts and classifier.ts.
 */
import { getBuildingData, EhrNotFoundError } from "./client.js";
import { getClassifier, PERMIT_CATEGORIES, type PermitCategory } from "./classifier.js";
import { getBuildingDocuments, getDocumentDetail } from "./documents.js";
import { mapWithConcurrency } from "./http.js";
import {
  applyDetail,
  derivePermitStatus,
  deriveWarnings,
  normaliseDoc,
  type NormalisedDoc,
  type PermitResult,
} from "./permits.js";
import type { RawBuildingData } from "./types.js";

/** Cap on per-document detail requests, so a 300-document building stays cheap. */
const MAX_DETAIL_FETCHES = 12;
const DETAIL_CONCURRENCY = 4;

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export interface BuildingSummary {
  aadress?: string;
  katastritunnused: string[];
}

/** Address + cadastral numbers. Throws EhrNotFoundError for an unknown EHR code. */
export function summariseBuilding(raw: RawBuildingData): BuildingSummary {
  const e = raw.ehitis ?? {};
  const addr = e.ehitiseAadressid?.aadress ?? [];
  const aadress =
    addr.map((a) => str(a?.taisaadress)).find((a) => a !== undefined) ??
    str(e.ehitiseAndmed?.taisaadress);

  const kat = (e.ehitiseKatastriyksused?.ehitiseKatastriyksus ?? [])
    .map((k) => str(k?.katastritunnus))
    .filter((k): k is string => k !== undefined);

  const summary: BuildingSummary = { katastritunnused: [...new Set(kat)] };
  if (aadress) summary.aadress = aadress;
  return summary;
}

/** Fetch the building's documents, classified and normalised. */
async function loadDocuments(ehrCode: string, forceRefresh: boolean) {
  const [table, raw] = await Promise.all([
    getClassifier(forceRefresh),
    getBuildingDocuments(ehrCode, forceRefresh),
  ]);
  return { table, docs: raw.map((d) => normaliseDoc(d, table)) };
}

/** Enrich the given documents in place with detail-only fields, bounded. */
async function enrich(docs: NormalisedDoc[], seotud = true): Promise<void> {
  const targets = docs.filter((d) => d.id !== undefined).slice(0, MAX_DETAIL_FETCHES);
  await mapWithConcurrency(targets, DETAIL_CONCURRENCY, async (doc) => {
    applyDetail(doc, await getDocumentDetail(doc.id!), { seotud });
  });
}

/* ------------------------------------------------------------------ 1. list */

export type DocumentFilter = PermitCategory | "taotlus" | "koik";

/** Default cap on returned documents — large buildings have hundreds. */
export const DEFAULT_DOCUMENT_LIMIT = 50;

export interface DocumentListOutput {
  ehr_kood: string;
  dokumente_kokku: number;
  /** Set when `limit` truncated the result, so the caller knows data was cut. */
  karbitud?: boolean;
  dokumendid: NormalisedDoc[];
  hoiatused?: string[];
}

export async function documentList(args: {
  ehrCode: string;
  liik?: DocumentFilter;
  kaasaDetailid?: boolean;
  limit?: number;
  forceRefresh?: boolean;
}): Promise<DocumentListOutput> {
  const {
    ehrCode,
    liik = "koik",
    kaasaDetailid = false,
    limit = DEFAULT_DOCUMENT_LIMIT,
    forceRefresh = false,
  } = args;
  const { table, docs } = await loadDocuments(ehrCode, forceRefresh);

  // An unknown EHR code yields `200 []` here, so confirm existence before
  // reporting "no documents" for a building that does not exist.
  if (docs.length === 0) await getBuildingData(ehrCode);

  const matching = liik === "koik" ? docs : docs.filter((d) => d.kategooria === liik);
  const selected = matching.slice(0, limit);
  if (kaasaDetailid) await enrich(selected);

  const out: DocumentListOutput = {
    ehr_kood: ehrCode,
    dokumente_kokku: docs.length,
    dokumendid: selected,
  };
  if (selected.length < matching.length) out.karbitud = true;
  const hoiatused = deriveWarnings(docs, table);
  if (hoiatused.length > 0) out.hoiatused = hoiatused;
  return out;
}

/* ---------------------------------------------------------- 2. permit check */

export interface PermitCheckOutput {
  ehr_kood: string;
  aadress: string | null;
  kontrollitud: string;
  kontrollid: Partial<Record<PermitCategory, PermitResult>>;
  hoiatused?: string[];
  koik_dokumendid?: NormalisedDoc[];
}

export async function permitCheck(args: {
  ehrCode: string;
  kontrollid?: readonly PermitCategory[];
  forceRefresh?: boolean;
  taielik?: boolean;
}): Promise<PermitCheckOutput> {
  const { ehrCode, kontrollid = PERMIT_CATEGORIES, forceRefresh = false, taielik = false } = args;

  // buildingData is the authority on existence (404/400) and on the address.
  const [building, loaded] = await Promise.all([
    getBuildingData(ehrCode),
    loadDocuments(ehrCode, forceRefresh),
  ]);
  const { table, docs } = loaded;
  const summary = summariseBuilding(building);

  const results: Partial<Record<PermitCategory, PermitResult>> = {};
  for (const cat of kontrollid) {
    const r = derivePermitStatus(cat, docs);
    // Compact mode keeps the application trail only where it *is* the evidence,
    // i.e. when nothing was granted yet. `taielik` always keeps it.
    if (!taielik && r.staatus !== "menetluses") delete r.taotlused;
    results[cat] = r;
  }

  // Detail lookups only for the documents actually cited — never for all 300.
  const cited = new Map<number, NormalisedDoc>();
  for (const r of Object.values(results)) {
    for (const d of [...r.dokumendid, ...(r.taotlused ?? []), ...(r.kehtetuks_tunnistamised ?? [])]) {
      if (d.id !== undefined) cited.set(d.id, d);
    }
  }
  await enrich([...cited.values()], taielik);

  const out: PermitCheckOutput = {
    ehr_kood: ehrCode,
    aadress: summary.aadress ?? null,
    kontrollitud: new Date().toISOString(),
    kontrollid: results,
  };
  const hoiatused = deriveWarnings(docs, table);
  if (hoiatused.length > 0) out.hoiatused = hoiatused;
  if (taielik) out.koik_dokumendid = docs;
  return out;
}

/* ------------------------------------------------------ 3. proceeding check */

export interface ProceedingOutput {
  allikas: "tuletatud_documentStatus_valjast";
  taielik_menetlusinfo_kattesaadav: false;
  pohjus: string;
  ehr_kood?: string;
  document_id?: number;
  dokumendid: NormalisedDoc[];
  hoiatused?: string[];
}

const PROCEEDING_REASON =
  "/api/proceeding/v1 nõuab X-tee/TARA autentimist; alljärgnev on tuletatud avaliku dokumendi olekuväljast (documentState / documentStatus), mitte menetlusregistri väljavõte.";

export async function proceedingCheck(args: {
  ehrCode?: string;
  documentId?: number;
  forceRefresh?: boolean;
  taielik?: boolean;
}): Promise<ProceedingOutput> {
  const { ehrCode, documentId, forceRefresh = false, taielik = false } = args;

  const base: ProceedingOutput = {
    allikas: "tuletatud_documentStatus_valjast",
    taielik_menetlusinfo_kattesaadav: false,
    pohjus: PROCEEDING_REASON,
    dokumendid: [],
  };

  if (documentId !== undefined) {
    const table = await getClassifier(forceRefresh);
    const result = await getDocumentDetail(documentId);
    const detail = result.detail;
    if (!detail) {
      return {
        ...base,
        document_id: documentId,
        hoiatused: [
          result.piiratud
            ? `Dokumendi id-ga ${documentId} detailvaade on suletud (juurdepääsupiirang).`
            : `Dokumenti id-ga ${documentId} ei leitud.`,
        ],
      };
    }
    const doc = normaliseDoc(
      {
        documentId: detail.documentId,
        documentTypeId: detail.documentType,
        documentType: detail.documentTypeName,
        documentNumber: detail.documentNrFull ?? detail.documentNumber,
        documentState: detail.documentStatus,
        date: detail.submissionDate,
      },
      table,
    );
    applyDetail(doc, result);
    return { ...base, document_id: documentId, dokumendid: [doc] };
  }

  if (ehrCode === undefined) {
    return { ...base, hoiatused: ["Anna kas ehr_kood või document_id."] };
  }

  const { table, docs } = await loadDocuments(ehrCode, forceRefresh);
  if (docs.length === 0) await getBuildingData(ehrCode);

  // Compact: only permits, notices, applications and revocations — the documents
  // that actually have a proceeding. `taielik` adds registry entries and the rest.
  const relevant = taielik ? docs : docs.filter((d) => d.kategooria !== "muu");
  await enrich(relevant.filter((d) => d.kategooria !== "muu"));

  const out: ProceedingOutput = { ...base, ehr_kood: ehrCode, dokumendid: relevant };
  const hoiatused = deriveWarnings(docs, table);
  if (hoiatused.length > 0) out.hoiatused = hoiatused;
  return out;
}

/* --------------------------------------------------- 4. registry part check */

export interface RegistryPartOutput {
  ehr_kood: string;
  registriosa_number: null;
  saadaval: false;
  pohjus: string;
  sild: {
    katastritunnus: string[];
    aadress: string | null;
    jargmine_samm: string;
  };
}

const REGISTRY_REASON =
  "Ehitisregister ei sisalda kinnistusraamatu registriosa numbrit. Kontrollitud: /api/building/v3/buildingData, dokumendi detailvaade ja arhiivikanded — väli puudub kõigist.";

/**
 * Always null: EHR has no registriosa field. Returns the cadastral bridge so the
 * caller can continue in the land register (RIK). Never invents a number.
 */
export async function registryPartCheck(ehrCode: string): Promise<RegistryPartOutput> {
  const building = await getBuildingData(ehrCode);
  const summary = summariseBuilding(building);

  return {
    ehr_kood: ehrCode,
    registriosa_number: null,
    saadaval: false,
    pohjus: REGISTRY_REASON,
    sild: {
      katastritunnus: summary.katastritunnused,
      aadress: summary.aadress ?? null,
      jargmine_samm: "Päri kinnistusraamatust (RIK) katastritunnuse alusel.",
    },
  };
}

/* ---------------------------------------------------------- 5. full check */

export interface FullCheckOutput {
  ehr_kood: string;
  aadress: string | null;
  kontrollitud: string;
  kontrollid: Partial<Record<PermitCategory, PermitResult>>;
  registriosa: RegistryPartOutput;
  menetlus: ProceedingOutput;
  hoiatused?: string[];
}

export async function fullCheck(args: {
  ehrCode: string;
  forceRefresh?: boolean;
  taielik?: boolean;
}): Promise<FullCheckOutput> {
  const { ehrCode, forceRefresh = false, taielik = false } = args;

  // Sequential on purpose: permitCheck warms the 15-min document-list cache and
  // the 24-h classifier cache that the other two checks then reuse.
  const permits = await permitCheck({ ehrCode, forceRefresh, taielik });
  const [registriosa, menetlus] = await Promise.all([
    registryPartCheck(ehrCode),
    proceedingCheck({ ehrCode, taielik }),
  ]);

  const out: FullCheckOutput = {
    ehr_kood: ehrCode,
    aadress: permits.aadress,
    kontrollitud: permits.kontrollitud,
    kontrollid: permits.kontrollid,
    registriosa,
    menetlus,
  };
  if (permits.hoiatused) out.hoiatused = permits.hoiatused;
  return out;
}

export { EhrNotFoundError };

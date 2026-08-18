/**
 * Public document API client.
 *   GET /api/document/v1/document/building/{ehrCode}  → the building's documents
 *   GET /api/document/v1/document/{documentId}        → one document's detail
 *
 * Not used (401 without X-tee/TARA): /api/proceeding/v1/**, /api/document-api/v1/**,
 * POST /api/document/v1/document/search.
 */
import { config } from "../config.js";
import { EhrAuthRequiredError, fetchJson, warnUnexpectedAuth } from "./http.js";

/** One entry of the building's document list. Every field is treated as optional. */
export interface RawDocumentListItem {
  documentId?: number;
  documentTypeId?: number;
  documentType?: string;
  documentNumber?: string;
  documentState?: string;
  documentStateText?: string;
  date?: string;
  relatedBuildings?: Array<{ ehrCode?: string; fullAddress?: string | null; name?: string }>;
  [k: string]: unknown;
}

export interface RawRelatedDocument {
  documentId?: number;
  documentType?: number;
  documentNumber?: string;
  documentStatusCode?: string;
  documentStatusText?: string;
  [k: string]: unknown;
}

/**
 * Document detail. `relatedEntities` and `documentVersionCreator` are
 * deliberately absent from this interface — they carry names, personal codes and
 * contact details of private individuals, which this server never surfaces.
 */
export interface RawDocumentDetail {
  documentId?: number;
  documentType?: number;
  documentTypeName?: string;
  documentNumber?: string;
  documentNrFull?: string;
  documentStatus?: string;
  submissionDate?: string;
  prosecutingAuthority?: { registrationName?: string; registrationCode?: string } | null;
  relatedDocuments?: RawRelatedDocument[] | null;
  hasAkMark?: boolean | null;
  fileInfos?: unknown;
  notes?: string | null;
  content?: string | null;
  applicationComments?: unknown[] | null;
  [k: string]: unknown;
}

/** Proceeding states change, so the list is cached only briefly. */
const LIST_TTL_MS = 15 * 60 * 1000;
const listCache = new Map<string, { docs: RawDocumentListItem[]; expires: number }>();

/**
 * All public documents attached to a building.
 *
 * Note: an unknown EHR code yields `200 []`, not 404 — "no documents" and
 * "no such building" are indistinguishable here. Callers that need the
 * difference must additionally consult buildingData.
 */
export async function getBuildingDocuments(
  ehrCode: string,
  forceRefresh = false,
): Promise<RawDocumentListItem[]> {
  const now = Date.now();
  if (!forceRefresh) {
    const hit = listCache.get(ehrCode);
    if (hit && hit.expires > now) return hit.docs;
  }

  const url = `${config.ehrRootUrl}/api/document/v1/document/building/${encodeURIComponent(ehrCode)}`;
  let body: RawDocumentListItem[] | null;
  try {
    body = await fetchJson<RawDocumentListItem[]>(url, { nullStatuses: [404] });
  } catch (err) {
    if (err instanceof EhrAuthRequiredError) warnUnexpectedAuth(err);
    throw err;
  }
  const docs = Array.isArray(body) ? body : [];

  listCache.set(ehrCode, { docs, expires: now + LIST_TTL_MS });
  return docs;
}

export interface DocumentDetailResult {
  detail: RawDocumentDetail | null;
  /**
   * The document exists but its detail view is closed (HTTP 401/403). EHR has
   * restricted access to public documents containing personal data, so this is
   * an expected outcome, not a broken contract.
   */
  piiratud: boolean;
}

/**
 * One document's detail. The upstream answers HTTP 500 (not 404) for an unknown
 * documentId, so 500 maps to `{ detail: null }` rather than being retried into
 * an error; 401/403 maps to `{ piiratud: true }`.
 */
export async function getDocumentDetail(documentId: number): Promise<DocumentDetailResult> {
  const url = `${config.ehrRootUrl}/api/document/v1/document/${encodeURIComponent(String(documentId))}`;
  try {
    return { detail: await fetchJson<RawDocumentDetail>(url, { nullStatuses: [404, 500] }), piiratud: false };
  } catch (err) {
    if (err instanceof EhrAuthRequiredError) return { detail: null, piiratud: true };
    throw err;
  }
}

/** Clear the per-building document cache (tests). */
export function resetDocumentCache(): void {
  listCache.clear();
}

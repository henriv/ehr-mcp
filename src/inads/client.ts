import type { GazetteerResponse, GazetteerRow, AddressCandidate } from "./types.js";
import { parseCandidates, CADASTRE_RE } from "./parse.js";

const GAZETTEER_URL = "https://inaadress.maaamet.ee/inaadress/gazetteer";
const TIMEOUT_MS = 10_000;
const MIN_QUERY_LEN = 3;
const DEFAULT_LIMIT = 8;

/** Fetch raw gazetteer rows for a free-text address. Returns [] on any failure. */
async function fetchGazetteer(query: string, limit: number): Promise<GazetteerRow[]> {
  const params = new URLSearchParams({
    results: String(limit),
    features: "EHAK,VAIKEKOHT,KATASTRIYKSUS,TANAV,EHITISHOONE",
    ihist: "1993",
    address: query,
    appartment: "1",
    unik: "0",
    tech: "1",
    iTappAsendus: "0",
    ky: "0",
    poi: "0",
    knr: "0",
    help: "1",
  });

  try {
    const res = await fetch(`${GAZETTEER_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      // Do not log the query/address at a sensitive level; status is enough.
      console.error(`In-ADS gazetteer returned HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as GazetteerResponse;
    return Array.isArray(body.addresses) ? body.addresses : [];
  } catch (err) {
    console.error("In-ADS gazetteer request failed:", err instanceof Error ? err.name : "unknown");
    return [];
  }
}

/**
 * Resolve a free-text address to candidate locations, each carrying a cadastral
 * number and/or building (EHR) code. Never throws:
 *   - query shorter than 3 chars → []
 *   - a bare cadastral number (78401:114:0950) → returned directly, no lookup
 *   - upstream error / empty result → []
 */
export async function lookupAddress(
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<AddressCandidate[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LEN) return [];

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;

  // Shortcut: the query is already a cadastral number.
  if (CADASTRE_RE.test(q)) {
    return [{ address: null, katastritunnus: q, ehrCode: null, adrId: null }];
  }

  const rows = await fetchGazetteer(q, cap);
  return parseCandidates(rows).slice(0, cap);
}

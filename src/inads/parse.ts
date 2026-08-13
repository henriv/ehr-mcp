import type { GazetteerRow, AddressCandidate } from "./types.js";

/** Cadastral unit pattern, e.g. 78401:114:0950. */
export const CADASTRE_RE = /^\d{5}:\d{3}:\d{4}$/;

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Group gazetteer rows by `adr_id` and reduce each group to one candidate:
 *   - ehrCode         = tunnus of liik="E" rows (string / array / null)
 *   - katastritunnus  = tunnus of the liik="4" row (or null)
 *   - address         = a pikkaadress from the group
 *   - lon/lat         = viitepunkt_l / viitepunkt_b
 *
 * Candidates where both ehrCode and katastritunnus are null are dropped.
 * Rows without an adr_id are grouped individually (each on its own).
 */
export function parseCandidates(rows: GazetteerRow[]): AddressCandidate[] {
  const groups = new Map<string, GazetteerRow[]>();
  let anon = 0;
  for (const row of rows) {
    const key = str(row.adr_id) ?? `__no_adr_id_${anon++}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const candidates: AddressCandidate[] = [];
  for (const [key, group] of groups) {
    const ehrCodes: string[] = [];
    let katastritunnus: string | null = null;
    let address: string | null = null;
    let lon: number | undefined;
    let lat: number | undefined;

    for (const row of group) {
      const tunnus = str(row.tunnus);
      if (row.liik === "E") {
        if (tunnus) ehrCodes.push(tunnus);
      } else if (row.liik === "4") {
        if (tunnus && !katastritunnus) katastritunnus = tunnus;
      }
      if (!address) address = str(row.pikkaadress) ?? str(row.aadresstekst) ?? null;
      if (lon === undefined) lon = num(row.viitepunkt_l);
      if (lat === undefined) lat = num(row.viitepunkt_b);
    }

    const ehrCode: string | string[] | null =
      ehrCodes.length === 0 ? null : ehrCodes.length === 1 ? ehrCodes[0]! : ehrCodes;

    // Drop candidates with neither a building code nor a cadastral number.
    if (ehrCode === null && katastritunnus === null) continue;

    const adrId = key.startsWith("__no_adr_id_") ? null : key;
    const candidate: AddressCandidate = { address, katastritunnus, ehrCode, adrId };
    if (lon !== undefined) candidate.lon = lon;
    if (lat !== undefined) candidate.lat = lat;
    candidates.push(candidate);
  }

  return candidates;
}

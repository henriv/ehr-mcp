import type { RawBuildingData, Ehitis } from "./types.js";

export interface TrimmedTehnilised {
  ehitisalune_pind?: string;
  suletud_netopind?: string;
  korruste_arv?: string;
  maht?: string;
  korgus?: string;
  koetav_pind?: string;
}

export interface TrimmedUsage {
  kood?: string;
  nimetus?: string;
}

export interface TrimmedEnergia {
  klass?: string;
  kehtib_kuni?: string;
}

export interface TrimmedBuilding {
  ehr_kood?: string;
  nimetus?: string;
  tyyp?: string;
  seisund?: string;
  esmane_kasutus?: string;
  aadressid?: string[];
  tehnilised_naitajad?: TrimmedTehnilised;
  kasutusotstarbed?: TrimmedUsage[];
  energiamargis?: TrimmedEnergia;
  katastriuksused?: string[];
}

/** Return the string only if it is a non-empty, non-whitespace string; else undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Assign only defined values; return undefined if the object ended up empty. */
function compact<T extends object>(obj: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/**
 * Reduce a raw buildingData response to a compact (<2 KB) object.
 *
 * Total function: any missing section is simply omitted; it never throws.
 * Geometry (`ehitiseKujud`), body/part trees (`ehitiseKehand`), construction
 * classifiers (`ehitiseTehnilisedNaitajad`), coordinates and document refs are
 * dropped entirely.
 */
export function trimBuildingData(raw: RawBuildingData | null | undefined): TrimmedBuilding {
  const e: Ehitis = raw?.ehitis ?? {};
  const andmed = e.ehitiseAndmed ?? {};
  const pohi = e.ehitisePohiandmed ?? {};

  const result: TrimmedBuilding = {};

  // Core identity
  const ehrKood = str(andmed.ehrKood);
  if (ehrKood) result.ehr_kood = ehrKood;
  const nimetus = str(andmed.nimetus);
  if (nimetus) result.nimetus = nimetus;
  const tyyp = str(andmed.rajatishoonetxt);
  if (tyyp) result.tyyp = tyyp;
  const seisund = str(andmed.seisundTxt) ?? str(andmed.seisund);
  if (seisund) result.seisund = seisund;
  const esmane = str(andmed.esmaneKasutus);
  if (esmane) result.esmane_kasutus = esmane;

  // Addresses: full strings only, de-duplicated. Fall back to core taisaadress.
  const addrList = e.ehitiseAadressid?.aadress ?? [];
  const addresses = addrList
    .map((a) => str(a?.taisaadress) ?? str(a?.lahiaadress))
    .filter((a): a is string => a !== undefined);
  if (addresses.length === 0) {
    const core = str(andmed.taisaadress);
    if (core) addresses.push(core);
  }
  const uniqueAddresses = [...new Set(addresses)];
  if (uniqueAddresses.length > 0) result.aadressid = uniqueAddresses;

  // Key technical indicators (sourced from põhiandmed, not the classifier array)
  const tehnilised = compact<TrimmedTehnilised>({
    ehitisalune_pind: str(pohi.ehitisalunePind),
    suletud_netopind: str(pohi.suletud_netopind),
    korruste_arv: str(pohi.maxKorrusteArv) ?? str(pohi.minKorrusteArv),
    maht: str(pohi.mahtBruto) ?? str(pohi.maht),
    korgus: str(pohi.korgus),
    koetav_pind: str(pohi.koetavPind),
  });
  if (tehnilised) result.tehnilised_naitajad = tehnilised;

  // Usage purposes: code + name pairs, de-duplicated by code
  const usageList = e.ehitiseKasutusotstarbed?.kasutusotstarve ?? [];
  const seenCodes = new Set<string>();
  const usages: TrimmedUsage[] = [];
  for (const u of usageList) {
    const kood = str(u?.kaosKood);
    const nimi = str(u?.kaosIdTxt);
    if (!kood && !nimi) continue;
    const dedupeKey = kood ?? nimi!;
    if (seenCodes.has(dedupeKey)) continue;
    seenCodes.add(dedupeKey);
    const item = compact<TrimmedUsage>({ kood, nimetus: nimi });
    if (item) usages.push(item);
  }
  if (usages.length > 0) result.kasutusotstarbed = usages;

  // Energy certificate: latest class + validity only. Choose the entry with a
  // class, preferring the most recent issue date.
  const energiaList = e.ehitiseEnergiamargised?.energiamargis ?? [];
  const withClass = energiaList.filter((m) => str(m?.energiaKlass) !== undefined);
  if (withClass.length > 0) {
    withClass.sort((a, b) => (str(b?.energiaValjastKp) ?? "").localeCompare(str(a?.energiaValjastKp) ?? ""));
    const latest = withClass[0]!;
    const energia = compact<TrimmedEnergia>({
      klass: str(latest.energiaKlass),
      kehtib_kuni: str(latest.energiaKehtibKuniKp),
    });
    if (energia) result.energiamargis = energia;
  }

  // Cadastral units: cadastral numbers only, de-duplicated
  const katList = e.ehitiseKatastriyksused?.ehitiseKatastriyksus ?? [];
  const katNumbers = katList
    .map((k) => str(k?.katastritunnus))
    .filter((k): k is string => k !== undefined);
  const uniqueKat = [...new Set(katNumbers)];
  if (uniqueKat.length > 0) result.katastriuksused = uniqueKat;

  return result;
}

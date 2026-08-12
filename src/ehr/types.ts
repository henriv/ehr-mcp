/**
 * Loose types for the upstream `GET /v3/buildingData` response. Every field is
 * optional and string-typed because the EHR API returns strings (often empty)
 * and omits sections. The trim layer treats all of this defensively.
 */

export interface EhitiseAndmed {
  ehrKood?: string;
  ehitId?: string;
  nimetus?: string;
  seisund?: string;
  seisundTxt?: string;
  rajatisHoone?: string;
  rajatishoonetxt?: string;
  esmaneKasutus?: string;
  taisaadress?: string;
  kaosKood?: string;
  kaosIdTxt?: string;
  [k: string]: unknown;
}

export interface EhitisePohiandmed {
  ehitisalunePind?: string;
  suletud_netopind?: string;
  maxKorrusteArv?: string;
  minKorrusteArv?: string;
  mahtBruto?: string;
  maht?: string;
  korgus?: string;
  koetavPind?: string;
  omandiLiikTxt?: string;
  [k: string]: unknown;
}

export interface Aadress {
  taisaadress?: string;
  lahiaadress?: string;
  aadressTekstina?: string;
  [k: string]: unknown;
}

export interface Kasutusotstarve {
  kaosKood?: string;
  kaosIdTxt?: string;
  [k: string]: unknown;
}

export interface EnergiamargisV3 {
  energiaKlass?: string;
  energiaKehtibKuniKp?: string;
  energiaValjastKp?: string;
  [k: string]: unknown;
}

export interface EhitiseKatastriyksus {
  katastritunnus?: string;
  [k: string]: unknown;
}

export interface Ehitis {
  ehitiseAndmed?: EhitiseAndmed;
  ehitisePohiandmed?: EhitisePohiandmed;
  ehitiseAadressid?: { aadress?: Aadress[] };
  ehitiseKasutusotstarbed?: { kasutusotstarve?: Kasutusotstarve[] };
  ehitiseEnergiamargised?: { energiamargis?: EnergiamargisV3[] };
  ehitiseKatastriyksused?: { ehitiseKatastriyksus?: EhitiseKatastriyksus[] };
  // Deliberately-dropped heavy sections (present in raw, never surfaced):
  ehitiseKujud?: unknown;
  ehitiseKehand?: unknown;
  ehitiseTehnilisedNaitajad?: unknown;
  [k: string]: unknown;
}

export interface RawBuildingData {
  ehitis?: Ehitis;
  [k: string]: unknown;
}

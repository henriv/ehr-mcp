/** One row of the In-ADS gazetteer `addresses` array (loose — many fields, all optional). */
export interface GazetteerRow {
  liik?: string;
  liikVal?: string;
  tunnus?: string;
  adr_id?: string;
  pikkaadress?: string;
  aadresstekst?: string;
  viitepunkt_l?: number | string;
  viitepunkt_b?: number | string;
  [k: string]: unknown;
}

export interface GazetteerResponse {
  addresses?: GazetteerRow[];
  [k: string]: unknown;
}

/** One resolved location: cadastral unit + building code(s) for a place. */
export interface AddressCandidate {
  address: string | null;
  katastritunnus: string | null;
  /** Single EHR code, or an array when a location has several buildings, or null. */
  ehrCode: string | string[] | null;
  adrId: string | null;
  lon?: number;
  lat?: number;
}

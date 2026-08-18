import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  derivePermitStatus,
  deriveWarnings,
  normaliseDoc,
  applyDetail,
  tallinnDate,
  type NormalisedDoc,
} from "../src/ehr/permits.js";
import type { ClassifierTable, DocumentTypeRecord } from "../src/ehr/classifier.js";
import type { RawDocumentDetail, RawDocumentListItem } from "../src/ehr/documents.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T;

const types = load<DocumentTypeRecord[]>("documenttypes.subset.json");
const table: ClassifierTable = {
  byId: new Map(types.map((t) => [t.id, t])),
  allikas: "klassifikaator",
};

const roseni = load<RawDocumentListItem[]>("documents.roseni.json").map((d) => normaliseDoc(d, table));
const tagamaa = load<RawDocumentListItem[]>("documents.tagamaa.json").map((d) => normaliseDoc(d, table));

describe("normaliseDoc", () => {
  it("converts the UTC instant to the Estonian calendar date the register shows", () => {
    // 2003-12-30T22:00:00Z is 31.12.2003 in Tallinn (EET, +02:00).
    expect(tallinnDate("2003-12-30T22:00:00.000+00:00")).toBe("2003-12-31");
    expect(tallinnDate("2007-09-10T21:00:00.000+00:00")).toBe("2007-09-11");
    expect(tallinnDate(null)).toBeUndefined();
    expect(tallinnDate("not a date")).toBeUndefined();
  });

  it("keeps the upstream state code and its text verbatim", () => {
    const teavitatud = roseni.find((d) => d.olek === "DO_DOKUSEIS_TEAVITATUD");
    expect(teavitatud).toBeDefined();
    expect(teavitatud?.olek_tekst).toBeDefined();
  });
});

describe("derivePermitStatus — Roseni tn 7 (120542346)", () => {
  it("finds a registered ehitusluba", () => {
    const r = derivePermitStatus("ehitusluba", roseni);
    expect(r.staatus).toBe("olemas");
    expect(r.dokumendid.map((d) => d.doty).sort()).toEqual([12229, 12291]);
  });

  it("keeps the application trail separate from the permit itself", () => {
    const r = derivePermitStatus("ehitusluba", roseni);
    expect(r.taotlused?.map((d) => d.doty).sort()).toEqual([11229, 11291]);
    // 11229 must never appear among the permits themselves.
    expect(r.dokumendid.some((d) => d.doty === 11229)).toBe(false);
  });

  it("finds a registered kasutusluba (12329, 12391)", () => {
    const r = derivePermitStatus("kasutusluba", roseni);
    expect(r.staatus).toBe("olemas");
    expect(r.dokumendid.map((d) => d.doty).sort()).toEqual([12329, 12391]);
  });

  it("reports no ehitusteatis or kasutusteatis", () => {
    expect(derivePermitStatus("ehitusteatis", roseni).staatus).toBe("puudub");
    expect(derivePermitStatus("kasutusteatis", roseni).staatus).toBe("puudub");
  });

  it("produces no pre-2003 warning for a building with real permits", () => {
    expect(deriveWarnings(roseni, table)).toEqual([]);
  });
});

describe("derivePermitStatus — Tagamaa tee 14 (101018690), pre-2003 only", () => {
  it("has 7 documents, one of them the Hooneregistri carry-over", () => {
    expect(tagamaa).toHaveLength(7);
    expect(tagamaa.some((d) => d.doty === 91511)).toBe(true);
  });

  it("reports no permit of any kind — a Hooneregistri teatis is not one", () => {
    for (const cat of ["kasutusluba", "ehitusluba", "kasutusteatis", "ehitusteatis"] as const) {
      expect(derivePermitStatus(cat, tagamaa).staatus).toBe("puudub");
    }
  });

  it("warns that only pre-2003 building-register entries exist", () => {
    const w = deriveWarnings(tagamaa, table);
    expect(w.some((m) => m.includes("pre-2003"))).toBe(true);
  });
});

/** Build a synthetic list entry — the fixtures contain no revoked permits. */
function doc(over: Partial<RawDocumentListItem>): RawDocumentListItem {
  return {
    documentId: 1,
    documentState: "DO_DOKUSEIS_REG_KANTUD",
    documentStateText: "Registrisse kantud",
    date: "2020-01-01T00:00:00.000+00:00",
    ...over,
  };
}

describe("derivePermitStatus — Rule 4, a permit found is not a permit in force", () => {
  const permit = doc({ documentId: 10, documentTypeId: 12229, documentType: "Ehitusluba ehitise laiendamiseks" });

  it("marks the permit kehtetu when a registered revocation decision exists", () => {
    const docs = [permit, doc({ documentId: 11, documentTypeId: 12922, documentType: "Ehitusloa kehtetuks tunnistamise otsus" })]
      .map((d) => normaliseDoc(d, table));
    const r = derivePermitStatus("ehitusluba", docs);
    expect(r.staatus).toBe("kehtetu");
    expect(r.kehtetuks_tunnistamised).toHaveLength(1);
  });

  it("ignores a revocation decision that is not itself registered", () => {
    const docs = [
      permit,
      doc({
        documentId: 11,
        documentTypeId: 12922,
        documentType: "Ehitusloa kehtetuks tunnistamise otsus",
        documentState: "DO_DOKUSEIS_ALLKIRJASTAMISEL",
      }),
    ].map((d) => normaliseDoc(d, table));
    expect(derivePermitStatus("ehitusluba", docs).staatus).toBe("olemas");
  });

  it("does not let a revocation *application* revoke the permit, but warns", () => {
    const docs = [permit, doc({ documentId: 11, documentTypeId: 11412, documentType: "Ehitusloa kehtetuks tunnistamise taotlus" })]
      .map((d) => normaliseDoc(d, table));
    expect(derivePermitStatus("ehitusluba", docs).staatus).toBe("olemas");
    expect(deriveWarnings(docs, table).some((m) => m.includes("kehtetuks tunnistamise taotlus"))).toBe(true);
  });

  it("does not let a revocation of one permit type affect another", () => {
    const docs = [permit, doc({ documentId: 11, documentTypeId: 12932, documentType: "Kasutusloa kehtetuks tunnistamise otsus" })]
      .map((d) => normaliseDoc(d, table));
    expect(derivePermitStatus("ehitusluba", docs).staatus).toBe("olemas");
  });

  it("reports menetluses when only an application exists", () => {
    const docs = [doc({ documentTypeId: 11229, documentType: "Ehitusloa taotlus ehitise laiendamiseks" })]
      .map((d) => normaliseDoc(d, table));
    const r = derivePermitStatus("ehitusluba", docs);
    expect(r.staatus).toBe("menetluses");
    expect(r.dokumendid).toEqual([]);
    expect(r.taotlused).toHaveLength(1);
  });

  it("reports menetluses when the permit exists but is not yet registered", () => {
    const docs = [doc({ ...permit, documentState: "DO_DOKUSEIS_ALLKIRJASTAMISEL" })].map((d) =>
      normaliseDoc(d, table),
    );
    expect(derivePermitStatus("ehitusluba", docs).staatus).toBe("menetluses");
  });

  it("reports puudub for an empty list, and warns", () => {
    expect(derivePermitStatus("ehitusluba", []).staatus).toBe("puudub");
    expect(deriveWarnings([], table).some((m) => m.includes("puuduvad"))).toBe(true);
  });

  it("warns when the offline classifier fallback was used", () => {
    const w = deriveWarnings(roseni, { byId: new Map(), allikas: "fallback" });
    expect(w.some((m) => m.includes("offline"))).toBe(true);
  });
});

describe("applyDetail", () => {
  const detail = load<RawDocumentDetail>("document.detail.8790980.json");
  const base = (): NormalisedDoc => ({ kategooria: "ehitusluba", id: 8790980 });

  it("takes the prosecuting authority and the related-document chain", () => {
    const d = applyDetail(base(), { detail, piiratud: false });
    expect(d.menetleja).toBe("Tallinna Linnaplaneerimise Amet");
    expect(d.seotud_dokumendid).toEqual([
      {
        id: 8763692,
        doty: 11229,
        number: "27016",
        olek: "DO_DOKUSEIS_REG_KANTUD",
        olek_tekst: "Registrisse kantud",
      },
    ]);
  });

  it("omits ak_marge when the document carries no restriction mark", () => {
    expect(applyDetail(base(), { detail, piiratud: false }).ak_marge).toBeUndefined();
    expect(applyDetail(base(), { detail: { ...detail, hasAkMark: true }, piiratud: false }).ak_marge).toBe(true);
  });

  it("omits the related chain when asked to", () => {
    const d = applyDetail(base(), { detail, piiratud: false }, { seotud: false });
    expect(d.menetleja).toBe("Tallinna Linnaplaneerimise Amet");
    expect(d.seotud_dokumendid).toBeUndefined();
  });

  it("never surfaces personal data from relatedEntities", () => {
    const d = applyDetail(base(), { detail, piiratud: false });
    expect(JSON.stringify(d)).not.toContain("relatedEntities");
    expect(JSON.stringify(d)).not.toContain("personalCode");
  });

  it("flags a document whose detail view is closed (HTTP 401)", () => {
    const d = applyDetail(base(), { detail: null, piiratud: true });
    expect(d.juurdepaas_piiratud).toBe(true);
    expect(d.menetleja).toBeUndefined();
  });

  it("leaves the document untouched when the detail is simply missing", () => {
    expect(applyDetail(base(), { detail: null, piiratud: false })).toEqual(base());
  });
});

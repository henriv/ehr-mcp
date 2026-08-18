import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  documentList,
  permitCheck,
  proceedingCheck,
  registryPartCheck,
  fullCheck,
} from "../src/ehr/checks.js";
import { EhrNotFoundError } from "../src/ehr/client.js";
import { resetClassifierCache } from "../src/ehr/classifier.js";
import { resetDocumentCache } from "../src/ehr/documents.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

const DOCS_ROSENI = read("documents.roseni.json");
const DOCS_TAGAMAA = read("documents.tagamaa.json");
const TYPES = read("documenttypes.subset.json");
const DETAIL = read("document.detail.8790980.json");
const BUILDING = read("buildingData.raw.json");

/** Route a mocked fetch by URL shape, and count requests per endpoint family. */
function route(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const handler = vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [needle, make] of Object.entries(overrides)) {
      if (url.includes(needle)) return make();
    }
    if (url.includes("/classifier/v1/alldocumenttypes")) return new Response(TYPES, { status: 200 });
    if (url.includes("/document/v1/document/building/101018690"))
      return new Response(DOCS_TAGAMAA, { status: 200 });
    if (url.includes("/document/v1/document/building/")) return new Response(DOCS_ROSENI, { status: 200 });
    if (url.includes("/document/v1/document/")) return new Response(DETAIL, { status: 200 });
    if (url.includes("/buildingData")) return new Response(BUILDING, { status: 200 });
    throw new Error(`unrouted ${url}`);
  });
  vi.stubGlobal("fetch", handler);
  return calls;
}

beforeEach(() => {
  resetClassifierCache();
  resetDocumentCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("permitCheck", () => {
  it("answers all four checks and cites the documents", async () => {
    route();
    const out = await permitCheck({ ehrCode: "120542346" });
    expect(out.kontrollid.ehitusluba?.staatus).toBe("olemas");
    expect(out.kontrollid.kasutusluba?.staatus).toBe("olemas");
    expect(out.kontrollid.ehitusteatis?.staatus).toBe("puudub");
    expect(out.kontrollid.kasutusteatis?.staatus).toBe("puudub");
    expect(out.aadress).toContain("Tagamaa tee 14"); // from the buildingData fixture
    expect(out.kontrollitud).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stays under 2 KB by default", async () => {
    route();
    const out = await permitCheck({ ehrCode: "120542346" });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(2048);
  });

  it("fetches the document list once and details only for cited documents", async () => {
    const calls = route();
    await permitCheck({ ehrCode: "120542346" });
    const lists = calls.filter((u) => u.includes("/document/building/"));
    const details = calls.filter((u) => /\/document\/v1\/document\/\d+$/.test(u));
    expect(lists).toHaveLength(1);
    // 4 permits cited out of 20 documents in the list.
    expect(details.length).toBeLessThanOrEqual(6);
    expect(details.length).toBeGreaterThan(0);
  });

  it("honours the kontrollid filter", async () => {
    route();
    const out = await permitCheck({ ehrCode: "120542346", kontrollid: ["ehitusluba"] });
    expect(Object.keys(out.kontrollid)).toEqual(["ehitusluba"]);
  });

  it("warns about a pre-2003 building instead of reporting a permit", async () => {
    route();
    const out = await permitCheck({ ehrCode: "101018690" });
    expect(out.kontrollid.kasutusluba?.staatus).toBe("puudub");
    expect(out.hoiatused?.some((m) => m.includes("pre-2003"))).toBe(true);
  });

  it("reports an unknown EHR code as not found", async () => {
    route({ "/buildingData": () => new Response(JSON.stringify({ message: "Building Not Found!" }), { status: 400 }) });
    await expect(permitCheck({ ehrCode: "999999999" })).rejects.toBeInstanceOf(EhrNotFoundError);
  });

  it("adds the full classified document list under taielik", async () => {
    route();
    const out = await permitCheck({ ehrCode: "120542346", taielik: true });
    expect(out.koik_dokumendid).toHaveLength(20);
  });
});

describe("documentList", () => {
  it("returns every document with its category", async () => {
    route();
    const out = await documentList({ ehrCode: "120542346" });
    expect(out.dokumente_kokku).toBe(20);
    expect(out.dokumendid.every((d) => d.kategooria !== undefined)).toBe(true);
  });

  it("filters by category", async () => {
    route();
    const out = await documentList({ ehrCode: "120542346", liik: "ehitusluba" });
    expect(out.dokumendid.map((d) => d.doty).sort()).toEqual([12229, 12291]);
  });

  it("truncates at limit and says so", async () => {
    route();
    const out = await documentList({ ehrCode: "120542346", limit: 5 });
    expect(out.dokumendid).toHaveLength(5);
    expect(out.karbitud).toBe(true);
    expect(out.dokumente_kokku).toBe(20);
  });

  it("adds menetleja and the related chain with kaasa_detailid", async () => {
    route();
    const out = await documentList({ ehrCode: "120542346", liik: "ehitusluba", kaasaDetailid: true });
    expect(out.dokumendid[0]?.menetleja).toBe("Tallinna Linnaplaneerimise Amet");
    expect(out.dokumendid[0]?.seotud_dokumendid).toBeDefined();
  });

  it("distinguishes 'no documents' from 'no such building'", async () => {
    route({ "/document/building/": () => new Response("[]", { status: 200 }) });
    // Building exists → an empty list is a valid answer.
    const ok = await documentList({ ehrCode: "120542346" });
    expect(ok.dokumendid).toEqual([]);

    resetDocumentCache();
    route({
      "/document/building/": () => new Response("[]", { status: 200 }),
      "/buildingData": () => new Response(JSON.stringify({ message: "Building Not Found!" }), { status: 400 }),
    });
    await expect(documentList({ ehrCode: "999999999" })).rejects.toBeInstanceOf(EhrNotFoundError);
  });

  it("serves the second call from the 15-minute cache, and force_refresh bypasses it", async () => {
    const calls = route();
    await documentList({ ehrCode: "120542346" });
    await documentList({ ehrCode: "120542346" });
    expect(calls.filter((u) => u.includes("/document/building/"))).toHaveLength(1);

    await documentList({ ehrCode: "120542346", forceRefresh: true });
    expect(calls.filter((u) => u.includes("/document/building/"))).toHaveLength(2);
  });
});

describe("proceedingCheck", () => {
  it("always states that the proceeding state is derived, not authoritative", async () => {
    route();
    const out = await proceedingCheck({ ehrCode: "120542346" });
    expect(out.allikas).toBe("tuletatud_documentStatus_valjast");
    expect(out.taielik_menetlusinfo_kattesaadav).toBe(false);
    expect(out.pohjus).toContain("X-tee/TARA");
  });

  it("carries the state code, its text and the authority", async () => {
    route();
    const out = await proceedingCheck({ ehrCode: "120542346" });
    const d = out.dokumendid[0]!;
    expect(d.olek).toMatch(/^DO_DOKUSEIS_/);
    expect(d.olek_tekst).toBeDefined();
    expect(d.menetleja).toBe("Tallinna Linnaplaneerimise Amet");
  });

  it("omits register entries by default and includes them under taielik", async () => {
    route();
    const compact = await proceedingCheck({ ehrCode: "120542346" });
    expect(compact.dokumendid.some((d) => d.kategooria === "muu")).toBe(false);
    resetDocumentCache();
    route();
    const full = await proceedingCheck({ ehrCode: "120542346", taielik: true });
    expect(full.dokumendid).toHaveLength(20);
  });

  it("looks up a single document by id", async () => {
    route();
    const out = await proceedingCheck({ documentId: 8790980 });
    expect(out.document_id).toBe(8790980);
    expect(out.dokumendid[0]?.number).toBe("27486");
    expect(out.dokumendid[0]?.kategooria).toBe("ehitusluba");
  });

  it("keeps the derived-source marker when the document is restricted", async () => {
    route({ "/document/v1/document/": () => new Response("unauthorized", { status: 401 }) });
    const out = await proceedingCheck({ documentId: 8790980 });
    expect(out.allikas).toBe("tuletatud_documentStatus_valjast");
    expect(out.dokumendid).toEqual([]);
    expect(out.hoiatused?.[0]).toContain("juurdepääsupiirang");
  });

  it("asks for an argument when given neither", async () => {
    route();
    const out = await proceedingCheck({});
    expect(out.hoiatused?.[0]).toContain("ehr_kood");
  });
});

describe("registryPartCheck", () => {
  it("never invents a registriosa number and returns the cadastral bridge", async () => {
    route();
    const out = await registryPartCheck("101018690");
    expect(out.registriosa_number).toBeNull();
    expect(out.saadaval).toBe(false);
    expect(out.pohjus).toContain("ei sisalda");
    expect(out.sild.katastritunnus).toEqual(["78401:120:0090"]);
    expect(out.sild.jargmine_samm).toContain("kinnistusraamatust");
  });

  it("fails clearly for an unknown building rather than returning a hollow answer", async () => {
    route({ "/buildingData": () => new Response("{}", { status: 400 }) });
    await expect(registryPartCheck("999999999")).rejects.toBeInstanceOf(EhrNotFoundError);
  });
});

describe("fullCheck", () => {
  it("returns all six checks in one answer", async () => {
    route();
    const out = await fullCheck({ ehrCode: "120542346" });
    expect(Object.keys(out.kontrollid)).toHaveLength(4);
    expect(out.registriosa.registriosa_number).toBeNull();
    expect(out.menetlus.taielik_menetlusinfo_kattesaadav).toBe(false);
  });

  it("reuses the document-list cache across the three sub-checks", async () => {
    const calls = route();
    await fullCheck({ ehrCode: "120542346" });
    expect(calls.filter((u) => u.includes("/document/building/"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/alldocumenttypes"))).toHaveLength(1);
  });
});

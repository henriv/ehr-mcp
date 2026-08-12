import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { trimBuildingData, fullBuildingData } from "../src/ehr/trim.js";
import type { RawBuildingData } from "../src/ehr/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  readFileSync(join(here, "fixtures", "buildingData.raw.json"), "utf8"),
) as RawBuildingData;

describe("trimBuildingData — real fixture", () => {
  const trimmed = trimBuildingData(raw);
  const json = JSON.stringify(trimmed);

  it("serialises under 2 KB", () => {
    expect(Buffer.byteLength(json)).toBeLessThan(2048);
  });

  it("drops geometry, body/part trees, and construction classifiers", () => {
    expect(json).not.toContain("kujud");
    expect(json).not.toContain("kehand");
    expect(json).not.toContain("Kujud");
    expect(json).not.toContain("tehnilineNaitaja");
    expect(json.toLowerCase()).not.toContain("coord");
    expect(json).not.toContain("koodaadress");
  });

  it("keeps core identity fields", () => {
    expect(trimmed.ehr_kood).toBe("101018690");
    expect(trimmed.nimetus).toBe("puhkemaja");
    expect(trimmed.tyyp).toBe("hoone");
    expect(trimmed.seisund).toBe("Olemas");
    expect(trimmed.esmane_kasutus).toBe("1925");
  });

  it("keeps full address strings only", () => {
    expect(trimmed.aadressid).toEqual([
      "Harju maakond, Tallinn, Kesklinna linnaosa, Tagamaa tee 14",
    ]);
  });

  it("keeps key dimensional indicators from pohiandmed", () => {
    expect(trimmed.tehnilised_naitajad).toEqual({
      ehitisalune_pind: "903.0",
      suletud_netopind: "791.2",
      korruste_arv: "1",
      maht: "3443.0",
    });
  });

  it("keeps usage code + name pairs, de-duplicated", () => {
    expect(trimmed.kasutusotstarbed).toHaveLength(1);
    expect(trimmed.kasutusotstarbed?.[0]?.kood).toBe("12114");
    expect(trimmed.kasutusotstarbed?.[0]?.nimetus).toContain("Sanatooriumi");
  });

  it("keeps cadastral numbers only", () => {
    expect(trimmed.katastriuksused).toEqual(["78401:120:0090"]);
  });

  it("omits energy certificate when the fixture has none", () => {
    expect(trimmed.energiamargis).toBeUndefined();
  });
});

describe("fullBuildingData — full dataset minus geometry", () => {
  const full = fullBuildingData(raw);
  const json = JSON.stringify(full);

  it("drops only geometry, keeping every other section", () => {
    expect(full).not.toHaveProperty("ehitiseKujud");
    expect(json).not.toContain("ehitiseKujud");
    // sections that trim drops but full keeps:
    expect(full).toHaveProperty("ehitiseTehnilisedNaitajad");
    expect(full).toHaveProperty("ehitiseKehand");
    expect(full).toHaveProperty("ehitisePohiandmed");
    expect(full).toHaveProperty("ehitiseAndmed");
  });

  it("is larger than the trimmed view but smaller than the raw (geometry removed)", () => {
    const rawBytes = Buffer.byteLength(JSON.stringify(raw));
    const trimBytes = Buffer.byteLength(JSON.stringify(trimBuildingData(raw)));
    const fullBytes = Buffer.byteLength(json);
    expect(fullBytes).toBeGreaterThan(trimBytes);
    expect(fullBytes).toBeLessThan(rawBytes);
  });

  it("is total: null / empty / missing ehitis never throw", () => {
    expect(fullBuildingData(null)).toEqual({});
    expect(fullBuildingData(undefined)).toEqual({});
    expect(fullBuildingData({})).toEqual({});
    expect(fullBuildingData({ ehitis: {} })).toEqual({});
  });

  it("removes geometry even when other sections are present", () => {
    const out = fullBuildingData({
      ehitis: { ehitiseKujud: { kuju: [1, 2, 3] }, ehitiseAndmed: { ehrKood: "1" } },
    });
    expect(out).not.toHaveProperty("ehitiseKujud");
    expect(out).toHaveProperty("ehitiseAndmed");
  });
});

describe("trimBuildingData — totality (missing sections never throw)", () => {
  it("handles null / undefined input", () => {
    expect(trimBuildingData(null)).toEqual({});
    expect(trimBuildingData(undefined)).toEqual({});
  });

  it("handles empty object", () => {
    expect(trimBuildingData({})).toEqual({});
    expect(trimBuildingData({ ehitis: {} })).toEqual({});
  });

  it("omits keys for empty-string fields rather than emitting them", () => {
    const out = trimBuildingData({
      ehitis: { ehitiseAndmed: { ehrKood: "123", nimetus: "  ", seisundTxt: "" } },
    });
    expect(out.ehr_kood).toBe("123");
    expect(out).not.toHaveProperty("nimetus");
    expect(out).not.toHaveProperty("seisund");
  });

  it("picks the latest energy certificate by issue date", () => {
    const out = trimBuildingData({
      ehitis: {
        ehitiseEnergiamargised: {
          energiamargis: [
            { energiaKlass: "D", energiaValjastKp: "2015-01-01", energiaKehtibKuniKp: "2025-01-01" },
            { energiaKlass: "B", energiaValjastKp: "2021-06-01", energiaKehtibKuniKp: "2031-06-01" },
          ],
        },
      },
    });
    expect(out.energiamargis).toEqual({ klass: "B", kehtib_kuni: "2031-06-01" });
  });

  it("falls back to core taisaadress when the address list is empty", () => {
    const out = trimBuildingData({
      ehitis: { ehitiseAndmed: { taisaadress: "Tartu, Näidise 1" } },
    });
    expect(out.aadressid).toEqual(["Tartu, Näidise 1"]);
  });
});

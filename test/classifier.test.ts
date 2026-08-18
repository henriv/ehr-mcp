import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyName,
  classifyDocument,
  frameworkOf,
  parseClassifierDate,
  type ClassifierTable,
  type DocumentTypeRecord,
} from "../src/ehr/classifier.js";

const here = dirname(fileURLToPath(import.meta.url));
const types = JSON.parse(
  readFileSync(join(here, "fixtures", "documenttypes.subset.json"), "utf8"),
) as DocumentTypeRecord[];

const table: ClassifierTable = {
  byId: new Map(types.map((t) => [t.id, t])),
  allikas: "klassifikaator",
};
const fallbackTable: ClassifierTable = { byId: new Map(), allikas: "fallback" };
const nameOf = (id: number) => table.byId.get(id)!.name;

describe("classifyName — Rule 2, anchored to the start of the name", () => {
  it("classifies permits", () => {
    expect(classifyName("Ehitusluba ehitise laiendamiseks").kategooria).toBe("ehitusluba");
    expect(classifyName("Kasutusluba ehitise laiendamisel").kategooria).toBe("kasutusluba");
    expect(classifyName("Ehitusluba").kategooria).toBe("ehitusluba");
    expect(classifyName("Kasutusluba").kategooria).toBe("kasutusluba");
  });

  it("classifies notices, which exist only from 01.07.2015", () => {
    expect(classifyName("Ehitusteatis ehitise püstitamiseks").kategooria).toBe("ehitusteatis");
    expect(classifyName("Kasutusteatis ehitise kasutamiseks").kategooria).toBe("kasutusteatis");
  });

  it("does NOT classify an application as the permit it applies for", () => {
    const c = classifyName("Ehitusloa taotlus ehitise laiendamiseks");
    expect(c.kategooria).toBe("taotlus");
    expect(c.seotud_kategooria).toBe("ehitusluba");
  });

  it("does NOT classify a revocation as the permit it revokes", () => {
    const otsus = classifyName("Ehitusloa kehtetuks tunnistamise otsus");
    expect(otsus.kategooria).toBe("kehtetuks_tunnistamine");
    expect(otsus.seotud_kategooria).toBe("ehitusluba");
    expect(otsus.kehtetuks_liik).toBe("otsus");

    // Contains "taotlus" too — revocation must win over the application rule.
    const taotlus = classifyName("Kasutusloa kehtetuks tunnistamise taotlus");
    expect(taotlus.kategooria).toBe("kehtetuks_tunnistamine");
    expect(taotlus.seotud_kategooria).toBe("kasutusluba");
    expect(taotlus.kehtetuks_liik).toBe("taotlus");
  });

  it("leaves register entries and pre-2003 carry-overs as 'muu'", () => {
    expect(classifyName("Hooneregistri ehitise teatis").kategooria).toBe("muu");
    expect(classifyName("Registri paranduskanne").kategooria).toBe("muu");
    expect(classifyName("Ehitamise alustamise teatis").kategooria).toBe("muu");
    expect(classifyName("").kategooria).toBe("muu");
    expect(classifyName(undefined).kategooria).toBe("muu");
  });
});

describe("classifyDocument — Rule 1, the code prefix is not a signal", () => {
  it("11229 (Ehitusloa taotlus) is NOT an ehitusluba despite the 112 prefix", () => {
    expect(classifyDocument(11229, nameOf(11229), table).kategooria).toBe("taotlus");
  });

  it("11202 (Ehitusteatis) is an ehitusteatis, not an application, on the same prefix", () => {
    expect(classifyDocument(11202, nameOf(11202), table).kategooria).toBe("ehitusteatis");
  });

  it("11329 (Kasutusloa taotlus) is NOT a kasutusteatis despite the 113 prefix", () => {
    expect(classifyDocument(11329, nameOf(11329), table).kategooria).toBe("taotlus");
  });

  it("11301 (Kasutusteatis) is a kasutusteatis on that same prefix", () => {
    expect(classifyDocument(11301, nameOf(11301), table).kategooria).toBe("kasutusteatis");
  });
});

describe("raamistik — Rule 5, historical subtypes are kept, not filtered", () => {
  it("marks a kasutusluba subtype that expired 01.10.2014 as pre-EhS2015", () => {
    const c = classifyDocument(12311, nameOf(12311), table);
    expect(c.kategooria).toBe("kasutusluba");
    expect(c.raamistik).toBe("pre-EhS2015");
  });

  it("marks a type introduced on 01.07.2015 as EhS2015", () => {
    expect(frameworkOf({ id: 0, name: "x", validFrom: "01.07.2015", validTo: "2099-12-31 00:00:00.0" })).toBe(
      "EhS2015",
    );
  });

  it("marks a type spanning the reform as 'molemad'", () => {
    expect(classifyDocument(12329, nameOf(12329), table).raamistik).toBe("molemad");
  });

  it("omits raamistik when the type is unknown to the classifier", () => {
    expect(classifyDocument(12329, "Kasutusluba ehitise laiendamisel", fallbackTable).raamistik).toBeUndefined();
  });

  it("parses both classifier date formats", () => {
    expect(parseClassifierDate("01.10.2002")).toBe(Date.UTC(2002, 9, 1));
    expect(parseClassifierDate("2099-12-31 00:00:00.0")).toBe(Date.UTC(2099, 11, 31));
    expect(parseClassifierDate(null)).toBeUndefined();
    expect(parseClassifierDate("rubbish")).toBeUndefined();
  });
});

describe("offline fallback ids", () => {
  it("classifies by id when the classifier is unavailable and the name is missing", () => {
    expect(classifyDocument(12229, undefined, fallbackTable).kategooria).toBe("ehitusluba");
    expect(classifyDocument(11202, undefined, fallbackTable).kategooria).toBe("ehitusteatis");
    expect(classifyDocument(12311, undefined, fallbackTable).kategooria).toBe("kasutusluba");
    // Not a permit type — must stay 'muu' rather than be guessed.
    expect(classifyDocument(11229, undefined, fallbackTable).kategooria).toBe("muu");
  });

  it("prefers the name over the fallback id table", () => {
    expect(classifyDocument(12229, "Ehitusloa taotlus ehitise laiendamiseks", fallbackTable).kategooria).toBe(
      "taotlus",
    );
  });
});

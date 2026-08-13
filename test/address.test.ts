import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCandidates } from "../src/inads/parse.js";
import { lookupAddress } from "../src/inads/client.js";
import type { GazetteerResponse } from "../src/inads/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "gazetteer.roseni.json"), "utf8"),
) as GazetteerResponse;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseCandidates — real Roseni fixture", () => {
  const candidates = parseCandidates(fixture.addresses ?? []);

  it("groups building + cadastral rows by adr_id", () => {
    const c = candidates.find((x) => x.adrId === "2124765");
    expect(c).toBeDefined();
    expect(c?.katastritunnus).toBe("78401:114:0950");
    expect(c?.ehrCode).toBe("120542346");
    expect(c?.address).toContain("Roseni tn 7");
    expect(c?.lon).toBeCloseTo(24.755442, 5);
    expect(c?.lat).toBeCloseTo(59.438522, 5);
  });

  it("keeps a candidate with a cadastral number but no building code (ehrCode null)", () => {
    const c = candidates.find((x) => x.adrId === "2124726");
    expect(c).toBeDefined();
    expect(c?.katastritunnus).toBe("78401:114:0610");
    expect(c?.ehrCode).toBeNull();
  });
});

describe("parseCandidates — edge cases", () => {
  it("returns ehrCode as an array when a location has several buildings", () => {
    const out = parseCandidates([
      { liik: "E", tunnus: "111", adr_id: "1", pikkaadress: "A" },
      { liik: "E", tunnus: "222", adr_id: "1", pikkaadress: "A" },
      { liik: "4", tunnus: "78401:114:0950", adr_id: "1", pikkaadress: "A" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.ehrCode).toEqual(["111", "222"]);
    expect(out[0]?.katastritunnus).toBe("78401:114:0950");
  });

  it("drops candidates where both ehrCode and katastritunnus are null", () => {
    const out = parseCandidates([
      { liik: "E", tunnus: "", adr_id: "1", pikkaadress: "A" }, // empty building code
      { liik: "TANAV", tunnus: "", adr_id: "2", pikkaadress: "B" }, // street, no codes
    ]);
    expect(out).toHaveLength(0);
  });

  it("handles an empty addresses array", () => {
    expect(parseCandidates([])).toEqual([]);
  });
});

describe("lookupAddress — validation and shortcuts", () => {
  it("returns [] for queries shorter than 3 chars without calling the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await lookupAddress("ab")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns a bare cadastral number directly without a lookup", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await lookupAddress("78401:114:0950");
    expect(spy).not.toHaveBeenCalled();
    expect(out).toEqual([
      { address: null, katastritunnus: "78401:114:0950", ehrCode: null, adrId: null },
    ]);
  });

  it("parses a mocked gazetteer response and respects limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 })),
    );
    const out = await lookupAddress("Tallinn Roseni 7", 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.ehrCode).toBe("120542346");
  });

  it("returns [] on upstream HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await lookupAddress("Tallinn Roseni 7")).toEqual([]);
  });

  it("returns [] on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await lookupAddress("Tallinn Roseni 7")).toEqual([]);
  });

  it("returns [] when addresses is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ addresses: [] }), { status: 200 })),
    );
    expect(await lookupAddress("Nonexistent 999")).toEqual([]);
  });
});

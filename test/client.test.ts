import { describe, it, expect, vi, afterEach } from "vitest";
import { getBuildingData, EhrNotFoundError, EhrUpstreamError } from "../src/ehr/client.js";

function mockFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getBuildingData", () => {
  it("returns parsed JSON on 200", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ ehitis: { ehitiseAndmed: { ehrKood: "1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const data = await getBuildingData("1");
    expect(data.ehitis?.ehitiseAndmed?.ehrKood).toBe("1");
  });

  it("maps 400 to EhrNotFoundError", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ message: "Building Not Found!" }), { status: 400 }),
    );
    await expect(getBuildingData("999")).rejects.toBeInstanceOf(EhrNotFoundError);
  });

  it("maps 404 to EhrNotFoundError", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));
    await expect(getBuildingData("999")).rejects.toBeInstanceOf(EhrNotFoundError);
  });

  it("maps a timeout to EhrUpstreamError", async () => {
    mockFetch(async () => {
      const e = new Error("The operation was aborted");
      e.name = "TimeoutError";
      throw e;
    });
    await expect(getBuildingData("1")).rejects.toBeInstanceOf(EhrUpstreamError);
    await expect(getBuildingData("1")).rejects.toThrow(/timed out/);
  });

  it("maps a network failure to EhrUpstreamError", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(getBuildingData("1")).rejects.toThrow(/unreachable/);
  });

  it("maps a 500 to EhrUpstreamError", async () => {
    mockFetch(async () => new Response("boom", { status: 500 }));
    await expect(getBuildingData("1")).rejects.toBeInstanceOf(EhrUpstreamError);
  });

  it("maps malformed JSON to EhrUpstreamError", async () => {
    mockFetch(async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(getBuildingData("1")).rejects.toThrow(/malformed/);
  });

  it("sends ehr_code and json=true in the query", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await getBuildingData("101018690");
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/v3/buildingData?ehr_code=101018690");
    expect(calledUrl).toContain("json=true");
  });
});

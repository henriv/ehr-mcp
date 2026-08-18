import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchJson, mapWithConcurrency, EhrAuthRequiredError } from "../src/ehr/http.js";
import { EhrUpstreamError } from "../src/ehr/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchJson", () => {
  it("retries a 5xx and succeeds on a later attempt", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        return n < 3 ? new Response("boom", { status: 503 }) : new Response('{"ok":true}', { status: 200 });
      }),
    );
    expect(await fetchJson<{ ok: boolean }>("https://x/y")).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("gives up after 2 retries (3 requests in total)", async () => {
    const spy = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", spy);
    await expect(fetchJson("https://x/y")).rejects.toBeInstanceOf(EhrUpstreamError);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("retries a timeout", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (++n === 1) {
          const e = new Error("aborted");
          e.name = "TimeoutError";
          throw e;
        }
        return new Response("{}", { status: 200 });
      }),
    );
    expect(await fetchJson("https://x/y")).toEqual({});
    expect(n).toBe(2);
  });

  it("never retries a 4xx", async () => {
    const spy = vi.fn(async () => new Response("nope", { status: 400 }));
    vi.stubGlobal("fetch", spy);
    await expect(fetchJson("https://x/y")).rejects.toThrow(/HTTP 400/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("maps configured statuses to null without retrying", async () => {
    const spy = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", spy);
    expect(await fetchJson("https://x/y", { nullStatuses: [500] })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws EhrAuthRequiredError on 401 without leaking the query string", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const err = await fetchJson("https://x/y?ehr_code=123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EhrAuthRequiredError);
    expect((err as EhrAuthRequiredError).url).toBe("https://x/y");
  });

  it("maps malformed JSON to EhrUpstreamError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(fetchJson("https://x/y")).rejects.toThrow(/malformed/);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and respects the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

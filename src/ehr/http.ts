/**
 * Shared HTTP helper for the public (unauthenticated) Ehitisregister APIs.
 * Timeout + bounded exponential-backoff retry, and a loud warning if an
 * endpoint that is public today starts demanding authentication.
 */
import { EhrUpstreamError } from "./client.js";

const TIMEOUT_MS = 10_000;
/** Retries *after* the first attempt, so at most 3 requests in total. */
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 250;

/** Thrown when the upstream answers 401/403 — these endpoints are meant to be public. */
export class EhrAuthRequiredError extends Error {
  constructor(public readonly url: string, public readonly status: number) {
    super(`EHR API nõuab autentimist (HTTP ${status})`);
    this.name = "EhrAuthRequiredError";
  }
}

/** Thrown when the upstream answers 404 for a resource that should exist. */
export class EhrResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EhrResourceNotFoundError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip the query string before logging — addresses and codes are not logged. */
function safeUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Log a 401 on an endpoint that is documented as public. Should never fire; if
 * it does, EHR has changed its access policy and the tools need re-verifying.
 */
export function warnUnexpectedAuth(err: EhrAuthRequiredError): void {
  console.error(
    `WARNING: ${err.url} returned HTTP ${err.status} — this endpoint was public; ` +
      "EHR may have changed its access policy.",
  );
}

export interface FetchJsonOptions {
  /** Statuses that should resolve to `null` instead of throwing (e.g. 404, 500). */
  nullStatuses?: readonly number[];
  timeoutMs?: number;
}

/**
 * GET a JSON document. Retries timeouts, network errors and 5xx with
 * exponential backoff; 4xx is never retried.
 *
 * @throws EhrAuthRequiredError on 401/403
 * @throws EhrUpstreamError on exhausted retries, non-OK status or malformed JSON
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T | null> {
  const nullStatuses = opts.nullStatuses ?? [];
  let lastError: EhrUpstreamError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));

    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
      lastError = new EhrUpstreamError(`EHR API ${reason}`);
      continue; // transient — retry
    }

    // 401/403 is never retried. Whether it is alarming depends on the endpoint —
    // a single restricted document is normal, a 401 on the document *list* is not —
    // so the decision to warn is left to the caller (see warnUnexpectedAuth).
    if (res.status === 401 || res.status === 403) {
      throw new EhrAuthRequiredError(safeUrl(url), res.status);
    }

    if (nullStatuses.includes(res.status)) return null;

    if (res.status >= 500) {
      lastError = new EhrUpstreamError(`EHR API returned HTTP ${res.status}`);
      continue; // transient — retry
    }

    if (!res.ok) throw new EhrUpstreamError(`EHR API returned HTTP ${res.status}`);

    try {
      return (await res.json()) as T;
    } catch {
      throw new EhrUpstreamError("EHR API returned malformed JSON");
    }
  }

  throw lastError ?? new EhrUpstreamError("EHR API request failed");
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]!, i);
    }
  });

  await Promise.all(runners);
  return results;
}

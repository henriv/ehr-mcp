import { config } from "../config.js";
import type { RawBuildingData } from "./types.js";

/** Thrown when the EHR code does not resolve to a building (upstream 400). */
export class EhrNotFoundError extends Error {
  constructor(public readonly ehrCode: string) {
    super(`EHR code not found: ${ehrCode}`);
    this.name = "EhrNotFoundError";
  }
}

/** Thrown for timeouts, network failures, and non-200/400 upstream responses. */
export class EhrUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EhrUpstreamError";
  }
}

const TIMEOUT_MS = 10_000;

/**
 * Fetch the current (kehtivad) data of a building by EHR code.
 * @throws EhrNotFoundError on upstream 400 (unknown EHR code)
 * @throws EhrUpstreamError on timeout, network error, or any other non-200 status
 */
export async function getBuildingData(ehrCode: string): Promise<RawBuildingData> {
  const url = `${config.ehrBaseUrl}/v3/buildingData?ehr_code=${encodeURIComponent(ehrCode)}&json=true`;

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    // AbortSignal.timeout → TimeoutError; anything else is a network failure.
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
    throw new EhrUpstreamError(`EHR API ${reason}`);
  }

  // This upstream returns 400 ({"message":"Building Not Found!"}) for an unknown
  // code; 404 is treated the same way for robustness / conventional semantics.
  if (res.status === 400 || res.status === 404) {
    throw new EhrNotFoundError(ehrCode);
  }
  if (!res.ok) {
    throw new EhrUpstreamError(`EHR API returned HTTP ${res.status}`);
  }

  try {
    return (await res.json()) as RawBuildingData;
  } catch {
    throw new EhrUpstreamError("EHR API returned malformed JSON");
  }
}

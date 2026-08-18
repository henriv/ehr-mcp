/**
 * Runtime configuration read from the environment. No dotenv dependency —
 * Render (and local `node --env-file`) inject env vars directly.
 */

/** Strip a trailing `/api/<anything>` path so a single host serves every API family. */
function rootOf(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/api(\/.*)?$/, "");
}

const buildingBase = (
  process.env.EHR_BASE_URL ?? "https://livekluster.ehr.ee/api/building"
).replace(/\/+$/, "");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: "0.0.0.0",
  /** Base of the buildingData API (kept for backwards compatibility). */
  ehrBaseUrl: buildingBase,
  /**
   * Cluster root, e.g. https://livekluster.ehr.ee — the document, classifier and
   * archive APIs hang off it. Defaults to the host of EHR_BASE_URL.
   * Alternatives: prelivekluster / testkluster / devkluster .ehr.ee
   */
  ehrRootUrl: (process.env.EHR_ROOT_URL ?? rootOf(buildingBase)).replace(/\/+$/, ""),
  /** Shared bearer secret. When empty, POST /mcp is open (local dev only). */
  mcpToken: process.env.MCP_TOKEN ?? "",
} as const;

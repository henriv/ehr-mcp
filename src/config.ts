/**
 * Runtime configuration read from the environment. No dotenv dependency —
 * Render (and local `node --env-file`) inject env vars directly.
 */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: "0.0.0.0",
  ehrBaseUrl: (process.env.EHR_BASE_URL ?? "https://livekluster.ehr.ee/api/building").replace(/\/+$/, ""),
  /** Shared bearer secret. When empty, POST /mcp is open (local dev only). */
  mcpToken: process.env.MCP_TOKEN ?? "",
} as const;

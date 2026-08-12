import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "./config.js";

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Length is not secret; comparing lengths first avoids timingSafeEqual throwing.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bearer auth for /mcp. If MCP_TOKEN is unset (empty), auth is disabled — this
 * allows local no-auth dev. When set, requires `Authorization: Bearer <token>`.
 */
export const requireBearer: RequestHandler = (req, res, next) => {
  const expected = config.mcpToken;
  if (!expected) {
    next();
    return;
  }

  const header = req.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  const presented = match?.[1] ?? "";

  if (presented && safeEqual(presented, expected)) {
    next();
    return;
  }

  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
};

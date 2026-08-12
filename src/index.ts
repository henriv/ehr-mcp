import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { buildServer } from "./mcp.js";

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Stateless MCP endpoint: a new server + transport per POST, no session store.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.listen(config.port, config.host, () => {
  console.log(`ehr-mcp listening on http://${config.host}:${config.port}`);
});

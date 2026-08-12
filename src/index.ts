import express from "express";
import { config } from "./config.js";

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.listen(config.port, config.host, () => {
  console.log(`ehr-mcp listening on http://${config.host}:${config.port}`);
});

# ehr-mcp

A small [MCP](https://modelcontextprotocol.io) server (streamable HTTP) that exposes
**one** tool backed by the Estonian Building Register (Ehitisregister) endpoint
`GET /v3/buildingData`. It lets you ask Claude about a building by its EHR code and
get back a compact, trimmed answer — address, key technical indicators, usage
purpose, energy certificate and cadastral units. **Geometry is never returned.**

- **Tool:** `ehr_building_data` — input `ehr_kood` (numeric string).
- **Upstream:** `https://livekluster.ehr.ee/api/building/v3/buildingData` (public, no auth).
- **Output budget:** trimmed result stays well under ~2 KB (≈0.5 KB typical) so it is
  cheap to load into model context. See [docs/upstream.md](docs/upstream.md) for the
  full contract and trim decisions.

## Stack

Node 20+, TypeScript (strict), Express, `@modelcontextprotocol/sdk`, `zod`, Vitest.

## Develop

```bash
npm install
cp .env.example .env      # optional; leave MCP_TOKEN empty for no-auth local dev
npm run dev               # tsx watch on http://localhost:3000
```

Other scripts: `npm run build` (tsc → `dist/`), `npm start` (`node dist/index.js`),
`npm test` (Vitest).

Health check: `GET /healthz` → `{ "ok": true }`.

## Smoke test with MCP Inspector

Start the dev server (`npm run dev`), then in another terminal:

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:3000/mcp --method tools/list
```

Expect one tool, `ehr_building_data`. Then call it with a real EHR code
(101018690 is the Tallinn sample used in the tests):

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:3000/mcp --method tools/call --tool-name ehr_building_data --tool-arg ehr_kood=101018690
```

Expect trimmed JSON (< 2 KB, no `kujud` key). An unknown code such as `120896`
returns a friendly `EHR koodiga 120896 ehitist ei leitud.` message.

> If `MCP_TOKEN` is set, add `--header "Authorization: Bearer <token>"` to the
> Inspector commands.

## Project layout

```
src/
  config.ts        env-derived config (PORT, EHR_BASE_URL, MCP_TOKEN)
  index.ts         Express app: /healthz + stateless POST /mcp
  mcp.ts           McpServer + ehr_building_data tool
  ehr/
    client.ts      getBuildingData() with timeout + typed errors
    trim.ts        trimBuildingData() -> <2 KB, drops geometry
    types.ts       loose response types
docs/upstream.md   upstream contract, params, response shape, trim map
test/              Vitest: trim + client, plus the raw response fixture
```

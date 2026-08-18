# ehr-mcp

A small [MCP](https://modelcontextprotocol.io) server (streamable HTTP) over the
Estonian Building Register (Ehitisregister). It answers, for a building:
*what is it*, *where is it*, and *does it have a valid permit* — using only the
**public, unauthenticated** EHR endpoints. **Geometry is never returned.**

### Tools

**Building and address**

- `ehr_building_data` — input `ehr_kood` (numeric string), optional `taielik`
  (boolean). Default returns a compact <2 KB summary; `taielik: true` returns
  every field **except geometry** (~6 KB compact). Geometry is never returned in
  either mode.
- `address_lookup` — input `query` (free-text address), optional `limit`
  (default 8). Resolves an address to candidates, each with a
  `katastritunnus` and building `ehrCode`, via the In-ADS gazetteer. Feed the
  `ehrCode` into `ehr_building_data`. See [docs/address-lookup.md](docs/address-lookup.md).

**Permit and proceeding checks** — see [docs/permits.md](docs/permits.md) for the
upstream contract, the classification rules and the verified endpoint list.

- `ehr_permit_check` ⭐ — the main tool. One call answers all four permit
  questions (kasutusluba, kasutusteatis, ehitusluba, ehitusteatis). Each returns a
  **status**, not a boolean: `olemas` | `puudub` | `kehtetu` | `menetluses`, with
  the documents that justify it (number, date, state, authority, legal framework).
- `ehr_document_list` — the low-level building block: the building's public
  document list, each entry classified and marked with its legal framework.
- `ehr_proceeding_check` — proceeding states by `ehr_kood` or `document_id`.
  **Derived** from the public `documentState` field, and says so in every response.
- `ehr_registry_part_check` — land-register (kinnistusraamat) *registriosa*
  number. EHR does not hold this field, so the answer is always
  `registriosa_number: null` plus the cadastral number to continue with at RIK.
- `ehr_full_check` — all six checks in one answer, by `ehr_kood` or `aadress`.

- **Upstream:** `https://livekluster.ehr.ee` — the `building`, `document` and
  `classifier` APIs, all public, no auth. Configurable via `EHR_ROOT_URL`
  (`prelivekluster` / `testkluster` / `devkluster`).
- **Output budget:** every compact result stays under ~2 KB
  (`ehr_permit_check` ≈1.5 KB for a 20-document building), so it is cheap to load
  into model context. `taielik: true` opts into the full data. See
  [docs/upstream.md](docs/upstream.md) for the `buildingData` trim decisions.

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

Expect seven tools. Then call one with a real EHR code (101018690 is the Tallinn
sample used in the tests):

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:3000/mcp --method tools/call --tool-name ehr_building_data --tool-arg ehr_kood=101018690
```

Expect trimmed JSON (< 2 KB, no `kujud` key). An unknown code such as `120896`
returns a friendly `EHR koodiga 120896 ehitist ei leitud.` message.

The permit check on Roseni tn 7, Tallinn:

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:3000/mcp --method tools/call --tool-name ehr_permit_check --tool-arg ehr_kood=120542346
```

> If `MCP_TOKEN` is set, add `--header "Authorization: Bearer <token>"` to the
> Inspector commands.

## Auth

> **Compatibility note:** the **claude.ai web custom-connector** dialog authenticates
> only via **OAuth** (Client ID + Client Secret) — it has **no field for a static
> bearer token**. So the bearer token below *cannot* be used from the web connector;
> to use claude.ai, run the service **authless** (leave `MCP_TOKEN` unset — see
> [Connect to Claude](#connect-to-claude)). The bearer token still works anywhere a
> custom header can be sent: **Claude Code** (`--header`), the MCP Inspector, and
> direct `curl`.

Auth on `POST /mcp` is a **single shared bearer token** — it is a secret string, not
a hash or a signed token, and there is no issuance, expiry, or user model by design.
`/healthz` is always open. If `MCP_TOKEN` is **unset/empty**, `/mcp` is open too
(local no-auth dev); if it is set, every request must send
`Authorization: Bearer <token>`. The comparison is constant-time
(`crypto.timingSafeEqual`, length-checked first so it can't throw).

**Generate the token once:**

```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**The same value goes in three places:**

1. **Local `.env`** — `MCP_TOKEN=...` (gitignored, never committed).
2. **Render → your service → Environment → `MCP_TOKEN`.** This is why `render.yaml`
   marks it `sync: false`: the value is entered in the dashboard, never stored in the
   repo.
3. **Wherever you send it as a header** — Claude Code (`--header "Authorization:
   Bearer ..."`), the MCP Inspector (`--header`), or `curl`. (Not the claude.ai web
   connector — see the compatibility note above.)

**Rotation:** generate a new value, update it in Render's Environment and in the
connector, and redeploy. The old token stops working the moment the new value is live
— there is no grace window or revocation list to manage.

**Verify auth against the deployed service** (replace host + token):

```bash
# 401 without the header
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ehr-mcp.onrender.com/mcp \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 200 with it
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ehr-mcp.onrender.com/mcp \
  -H "content-type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Deploy to Render

The repo includes [`render.yaml`](render.yaml) (a web service: `npm ci && npm run
build` → `node dist/index.js`, health check `/healthz`).

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Web Service** (or **Blueprint** to pick up
   `render.yaml` directly) and connect the GitHub repo.
3. Set the **`MCP_TOKEN`** environment variable in the dashboard (see [Auth](#auth)).
   `EHR_BASE_URL` is supplied by `render.yaml`; `EHR_ROOT_URL` defaults to the same
   host and only needs setting to target a non-live cluster.
4. Deploy. The service will be at `https://<service>.onrender.com`, with the MCP
   endpoint at `https://<service>.onrender.com/mcp`.

> **Free-tier cold start:** the free plan spins the service down after ~15 min idle;
> the next request then waits **~30–50 s** while it wakes. The first Inspector or
> Claude call after idle may look like a timeout — retry. Render's **Starter** tier
> keeps the service always-on and removes the cold start.

## Connect to Claude

**claude.ai (custom connector):** Settings → Connectors → **Add custom connector** →
URL `https://<service>.onrender.com/mcp`. **Leave the OAuth Client ID / Client Secret
fields empty** — the web connector only supports OAuth, not a static bearer token, so
the service must be running **authless** (`MCP_TOKEN` unset in Render). Once connected,
ask in Estonian, e.g. *"Mis hoone on EHR koodiga 101018690?"* — Claude will call
`ehr_building_data` and answer with the address and key indicators.

> Running authless means anyone with the URL can call the tool. That's low-risk here
> — it only reads **public, read-only** Ehitisregister data — but it does mean your
> Render compute is open. If you need it locked down, use Claude Code with the bearer
> token instead of the web connector.

**Claude Code (CLI):**

```bash
claude mcp add --transport http ehr https://<service>.onrender.com/mcp
```

If auth is enabled, add the header:

```bash
claude mcp add --transport http ehr https://<service>.onrender.com/mcp --header "Authorization: Bearer <token>"
```

## Known limitations

These are properties of the public EHR API, not of this server. They are surfaced
in the tool output rather than papered over.

1. **Attached document files are closed.** EHR has restricted access to public
   documents containing personal data. `fileInfos` is often `null` even when the
   document exists, and some documents answer `401` on their detail view — those
   are marked `juurdepaas_piiratud: true` rather than dropped.
2. **You cannot search for a document by its number.** `POST /document/v1/document/search`
   requires authentication. Publicly, documents are reachable only *through a
   building*. Searching by permit number needs your own index or an authenticated
   contract.
3. **Full proceeding data requires an X-tee/TARA agreement** with the Land and
   Spatial Agency (Maa- ja Ruumiamet). `/api/proceeding/v1/**` returns `401`.
   `ehr_proceeding_check` therefore derives the state from the public
   `documentState` field and labels the result as derived in every response.
4. **The registriosa number requires a separate RIK integration.** EHR holds no
   land-register reference — verified absent from `v3/buildingData`, the document
   detail view and the archive records. `ehr_registry_part_check` returns `null`
   plus the cadastral number to query the land register with.
5. **Pre-2003 buildings often carry only a "Hooneregistri ehitise teatis"**
   (DOTY 91511). That is **not** a kasutusluba. Such buildings get a warning, not a
   false positive.

## Acceptance checklist

- [x] Inspector `tools/list` returns all seven tools
- [x] `tools/call` with a valid EHR code returns trimmed JSON < 2 KB, no `kujud` key
- [x] Invalid EHR code returns a friendly not-found message
- [x] `ehr_permit_check` on 120542346 → `ehitusluba: olemas` (12229, 12291),
      `kasutusluba: olemas` (12329, 12391), applications 11229/11329 not counted as permits
- [x] `ehr_permit_check` on 101018690 → all four `puudub` + pre-2003 warning
- [x] `ehr_registry_part_check` never returns a number
- [x] `ehr_proceeding_check` always marks its answer as derived
- [x] Request without bearer token (when `MCP_TOKEN` set) → 401
- [ ] From claude.ai, *"Mis hoone on EHR koodiga <code>?"* triggers the tool
      (verify after deploying + connecting)

## Project layout

```
src/
  config.ts        env-derived config (PORT, EHR_BASE_URL, EHR_ROOT_URL, MCP_TOKEN)
  index.ts         Express app: /healthz + stateless POST /mcp
  mcp.ts           McpServer + all seven tool registrations
  ehr/
    client.ts      getBuildingData() with timeout + typed errors
    trim.ts        trimBuildingData() / fullBuildingData(), drops geometry
    types.ts       loose buildingData response types
    http.ts        fetchJson() timeout + backoff retry, bounded concurrency
    classifier.ts  DOTY classification by name, 24 h cache, offline fallback
    documents.ts   document list (15 min cache) + document detail
    permits.ts     pure status derivation + warnings (no I/O)
    checks.ts      orchestration for the five check tools
  inads/
    client.ts      lookupAddress() -> In-ADS gazetteer, validation + shortcut
    parse.ts       parseCandidates() -> group by adr_id, cadastral + EHR code
    types.ts       gazetteer row + candidate types
docs/upstream.md        ehr_building_data upstream contract + trim map
docs/address-lookup.md  address_lookup upstream contract + parsing
docs/permits.md         permit-check endpoints, DOTY rules, status derivation
test/              Vitest: trim, client, address, http, classifier, permits,
                   checks — plus live-captured response fixtures
```

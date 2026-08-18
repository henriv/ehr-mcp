# CLAUDE.md

MCP server (streamable HTTP) over the Estonian Building Register (Ehitisregister).
Full walkthrough lives in [README.md](README.md) — this file is the dense reference,
not a duplicate of it.

## Commands

```bash
npm run dev              # tsx watch, http://localhost:3000
npm run build             # tsc -> dist/
npm start                 # node dist/index.js
npm test                  # vitest run (all)
npm run test:watch        # vitest watch
npx vitest run test/permits.test.ts   # single file
```

No lint/format script configured — match existing style by eye.

## Stack

Node 20+, TypeScript (strict), Express, `@modelcontextprotocol/sdk`, `zod`, Vitest.
No dotenv — `config.ts` reads `process.env` directly (Render and `node --env-file`
inject vars).

## Architecture

```
src/
  config.ts        env-derived config (PORT, EHR_BASE_URL, EHR_ROOT_URL, MCP_TOKEN)
  auth.ts          requireBearer middleware (constant-time compare)
  index.ts         Express app: /healthz + stateless POST /mcp
  mcp.ts           McpServer + all seven tool registrations
  ehr/
    client.ts      getBuildingData() with timeout + typed errors
    trim.ts        trimBuildingData() / fullBuildingData() — drops geometry, pure
    types.ts       loose buildingData response types
    http.ts        fetchJson() timeout + backoff retry, bounded concurrency
    classifier.ts  DOTY classification by name, 24h cache, offline fallback
    documents.ts   document list (15 min cache) + document detail
    permits.ts     pure status derivation + warnings (no I/O)
    checks.ts      orchestration for the five check tools
  inads/
    client.ts      lookupAddress() -> In-ADS gazetteer
    parse.ts       parseCandidates() -> group by adr_id, cadastral + EHR code
docs/
  upstream.md        buildingData contract + trim map
  address-lookup.md  address_lookup contract + parsing
  permits.md         permit endpoints, DOTY rules, status derivation, verified list
test/               vitest specs + live-captured fixtures in test/fixtures/
```

Each tool in `mcp.ts` is orchestration only; the actual logic lives in `src/ehr/*`
and `src/inads/*` so it's directly unit-testable without spinning up the server.

### Request flow

```
   Claude Code        claude.ai        MCP Inspector
  (bearer auth)       (authless)          / curl
        |                  |                  |
        +------------------+------------------+
                           |
                           v   POST /mcp
              +--------------------------+
              |  requireBearer (auth.ts)  |
              |   constant-time compare   |
              +--------------------------+
                           |
                           v
              +--------------------------+
              |    McpServer (mcp.ts)     |
              |  built fresh per request  |
              |     7 tool handlers       |
              +--------------------------+
                           |
              +------------+-------------+
              v                          v
   +--------------------------+   +--------------------------+
   | src/ehr/*                |   | src/inads/*              |
   | client, trim,            |   | client, parse            |
   | classifier, documents,   |   | (address_lookup)         |
   | permits, checks          |   |                          |
   +--------------------------+   +--------------------------+
               |                              |
               v                              v
   +--------------------------+   +--------------------------+
   | livekluster.ehr.ee       |   | In-ADS gazetteer         |
   | building / document /    |   | (address search)         |
   | classifier APIs          |   |                          |
   +--------------------------+   +--------------------------+
```

No session store — every `POST /mcp` builds a new `McpServer` +
`StreamableHTTPServerTransport`, handles the one request, and closes both.

## Conventions

- **Pure/I-O split is deliberate.** `permits.ts`, `trim.ts`, `parse.ts` are pure
  functions over already-fetched data (see their header comments) — no fetches, no
  caches. `http.ts`, `client.ts`, `documents.ts`, `classifier.ts` own I/O and
  caching. Keep new logic on the correct side of that line so it stays unit-testable.
- **Field names mirror the Estonian upstream API** (`doty`, `olek`, `kuupaev`,
  `staatus`, etc.) — don't translate them to English in code. English is only used
  in TS type/variable names and comments explaining meaning.
- **Comments are one-liners explaining a non-obvious constraint**, not what the code
  does (e.g. `// Calendar date in Europe/Tallinn — the upstream timestamp is UTC.`).
  Follow that density — don't add explanatory blocks.
- **Tests use live-captured JSON fixtures** under `test/fixtures/` rather than
  hand-rolled mocks. When covering a new upstream shape, capture a real response into
  a new fixture rather than constructing one by hand.
- **Geometry (`kujud`) must never be returned**, in any mode. This is a product rule
  enforced in `trim.ts`, not a size optimization — don't loosen it for convenience.

## Gotchas

- `MCP_TOKEN` unset/empty → `/mcp` is open (local dev only). The **claude.ai web
  connector only supports OAuth**, not a static bearer — it must run authless. Bearer
  auth works from Claude Code, MCP Inspector, and `curl`.
- Render free tier cold-starts after ~15 min idle; first request after that can take
  ~30–50s. Don't mistake that for a bug when testing the deployed service.
- `classifier.ts` caches 24h, `documents.ts` caches 15 min (with offline fallback) —
  check these before chasing a "stale response" bug.
- Known upstream limitations are documented in README's *Known limitations* section
  (closed document files, no doc search by number, no registriosa data, proceedings
  are derived not authoritative). These are upstream API properties, surfaced in tool
  output on purpose — don't try to "fix" them with retries/workarounds without
  checking there first.
- **Don't run two Claude Code sessions (e.g. desktop app + CLI) in this working
  directory concurrently** — no git worktree isolation is set up here, so concurrent
  writes can silently clobber each other. Use one session at a time, or a worktree.

## Docs to check before touching upstream integration

- [docs/upstream.md](docs/upstream.md) — buildingData contract + trim decisions
- [docs/address-lookup.md](docs/address-lookup.md) — address_lookup contract
- [docs/permits.md](docs/permits.md) — permit endpoints, DOTY rules, verified list

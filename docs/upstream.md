# Upstream contract — Ehitisregister `GET /v3/buildingData`

Source of truth: the OpenAPI 3.0.2 spec **Buildings Actual Data API** (v1.0.1) that
`swaggerui.ehr.ee` renders. The swagger site is a React SPA; the spec is not served
at the conventional `/v3/api-docs` paths (those return 404). It is bundled as a
webpack chunk. Resolution trail used to obtain it:

1. `https://swaggerui.ehr.ee/` → `static/js/main.<hash>.js`
2. Service **"Ehitise kehtivate andmete teenus"** maps to `eh-api.yaml`, webpack
   module `45209`, chunk id `209`.
3. Chunk map in the main bundle: `209 → "bd1f423f"`.
4. Spec object fetched from `https://swaggerui.ehr.ee/static/js/209.bd1f423f.chunk.js`
   (a JS module exporting the OpenAPI object). Saved parsed to `docs/eh-api.spec.json`.

> The chunk hash will change when EHR redeploys the swagger site. If the fetch 404s,
> re-run the resolution trail from step 1 to find the new hash.

## Endpoint

- **Base URL**: `https://livekluster.ehr.ee/api/building` (Live server; the spec also
  lists dev/test/prelive servers). Public, **no authentication**.
- **Operation**: `GET /v3/buildingData` — "tagastab EHR koodi alusel ehitise kehtivad
  andmed V3" (returns the current/valid data of a building by EHR code).

### Query parameters

| name       | in    | type    | required | notes |
|------------|-------|---------|----------|-------|
| `ehr_code` | query | string  | no*      | EHR code. If absent, `ehr_id` is used. **This is the parameter our tool sends.** |
| `ehr_id`   | query | string  | no       | Internal building id (alternative lookup key). |
| `version`  | query | integer | no       | Specific building version number. Omitted → latest/current version. |
| `json`     | query | boolean | no       | JSON vs XML. Absent → JSON. We always send `json=true`. |

\* Both `ehr_code` and `ehr_id` are marked `required: false` in the spec, but in
practice a lookup key is needed. Our client always sends `ehr_code`.

### Responses

| code | meaning | body |
|------|---------|------|
| 200  | Building found | `{ "ehitis": ehitisBuildingDataV3 }` |
| 400  | **Unknown EHR code** | `{ "message": "Building Not Found!" }` (content-type `application/json`) |
| 500  | Upstream error | error message related to the problem |

Our client maps **400 → `EhrNotFoundError`** and **timeout / non-200 (incl. 500) →
`EhrUpstreamError`**.

## 200 response shape — `ehitis` object

Top-level sections (schema names, camelCase, as returned in live JSON):

| key                          | content | trim decision |
|------------------------------|---------|---------------|
| `ehitiseAndmed`              | core: `ehrKood`, `nimetus`, `seisund`/`seisundTxt`, `taisaadress`, `rajatishoonetxt`, `esmaneKasutus`, `kaosKood`/`kaosIdTxt` | **keep (selected fields)** |
| `ehitisePohiandmed`          | dimensions: `ehitisalunePind`, `suletud_netopind`, `maxKorrusteArv`/`minKorrusteArv`, `mahtBruto`/`maht`, `korgus`, `koetavPind`, `lift`, `omandiLiikTxt` … | **keep (selected → technical indicators)** |
| `ehitiseAadressid`           | `aadress[]` — full address strings + ADS ids/olekviit tree | **keep `taisaadress` strings only** |
| `ehitiseTehnilisedNaitajad`  | `tehnilineNaitaja[]` — construction-material classifiers (foundation, walls, roof…) | **drop** (2.5 KB, not the "key indicators"; those live in pohiandmed) |
| `ehitiseKasutusotstarbed`    | `kasutusotstarve[]` — usage purposes | **keep code + name** |
| `ehitiseEnergiamargised`     | `energiamargis[]` — energy certificates (often empty `[]`) | **keep latest class + validity only** |
| `ehitiseKatastriyksused`     | `ehitiseKatastriyksus[]` — cadastral units | **keep `katastritunnus` only** |
| `ehitiseKujud`               | geometry shapes / coordinate arrays | **DROP — never returned** (biggest token sink) |
| `ehitiseKehand`              | body/part detail tree | **DROP** |

### Field references used by the trim layer

- Building name: `ehitiseAndmed.nimetus`
- Type: `ehitiseAndmed.rajatishoonetxt` ("hoone"/"rajatis")
- Status: `ehitiseAndmed.seisundTxt` (e.g. "Olemas")
- First use year: `ehitiseAndmed.esmaneKasutus`
- Full address: `ehitiseAndmed.taisaadress` and `ehitiseAadressid.aadress[].taisaadress`
- Technical indicators (from `ehitisePohiandmed`):
  - `ehitisalunePind` — built-up area (m²)
  - `suletud_netopind` — closed net area (m²)
  - `maxKorrusteArv` / `minKorrusteArv` — floor count
  - `mahtBruto` (bruto) / `maht` — volume (m³)
  - `korgus` — height, `koetavPind` — heated area (when present)
- Usage purpose item: `kaosKood` (code) + `kaosIdTxt` (name)
- Energy certificate item: `energiaKlass` (class) + `energiaKehtibKuniKp` (valid until)
- Cadastral item: `katastritunnus`

## Sizes (justifying the trim layer)

Raw live response for EHR **101018690** (Tallinn, Kesklinna, Tagamaa tee 14):
**13,694 bytes**. Per-section: `ehitiseTehnilisedNaitajad` ≈ 2568 B,
`ehitiseKujud` ≈ 1977 B, `ehitiseKehand` ≈ 1153 B. The trimmed tool output targets
**< 2 KB**. Saved raw sample: `test/fixtures/buildingData.raw.json`.

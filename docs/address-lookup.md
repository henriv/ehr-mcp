# `address_lookup` — In-ADS gazetteer

Resolves a free-text Estonian address to candidate locations, each carrying a
**cadastral number** (`katastritunnus`) and a building **EHR code** (`ehrCode`) so
the codes can be fed into `ehr_building_data`.

## Upstream

- **Endpoint:** `GET https://inaadress.maaamet.ee/inaadress/gazetteer` — In-ADS
  gazetteer (Maa- ja Ruumiamet open data). Public, no auth. **Server-side only**
  (browser CORS blocks it).
- **Query params** (see [src/inads/client.ts](../src/inads/client.ts)):
  `results=<limit>`, `features=EHAK,VAIKEKOHT,KATASTRIYKSUS,TANAV,EHITISHOONE`,
  `ihist=1993`, `address=<query>`, `appartment=1`, `unik=0`, **`tech=1`**
  (required — adds `tunnus`/`adr_id`/`liik`), `iTappAsendus=0`, `ky=0`, `poi=0`,
  `knr=0`, `help=1`.
- **Response:** `{ "addresses": [ {row}, ... ] }`. Relevant row fields:
  - `liik` — object type. `"E"` (`liikVal=EHITISHOONE`) → `tunnus` is the **EHR
    code**; `"4"` (`liikVal=KATASTRIYKSUS`) → `tunnus` is the **cadastral number**
    (`\d{5}:\d{3}:\d{4}`).
  - `adr_id` — address-object id that **links the building and cadastral rows of the
    same place** (same `adr_id` on both).
  - `pikkaadress` — human-readable address.
  - `viitepunkt_l` / `viitepunkt_b` — WGS84 lon / lat.

## Parsing ([src/inads/parse.ts](../src/inads/parse.ts))

1. Group rows by `adr_id`.
2. Per group → one candidate: `ehrCode` from `liik="E"` `tunnus` (string, or **array**
   if a location has several buildings, else `null`); `katastritunnus` from the
   `liik="4"` `tunnus`; `address` from a `pikkaadress`; `lon`/`lat` from viitepunkt.
3. A bare cadastral query (`^\d{5}:\d{3}:\d{4}$`) is returned directly, no lookup.
4. Candidates with both `ehrCode` and `katastritunnus` null are dropped.

## Behaviour / edge cases

- `query` shorter than 3 chars → `[]` (no network call).
- Upstream HTTP error, network failure, or empty `addresses` → `[]` (never an error).
- Multiple buildings on one cadastral unit → `ehrCode` is an array.
- Building with an empty `tunnus` → `ehrCode: null` (kept if it has a cadastral number).

## Example (`query = "Tallinn Roseni 7"`)

```json
[
  {"address":"Harju maakond, Tallinn, Kesklinna linnaosa, Roseni tn 7",
   "katastritunnus":"78401:114:0950","ehrCode":"120542346","adrId":"2124765",
   "lon":24.755442,"lat":59.438522},
  {"address":"Harju maakond, Tallinn, Kesklinna linnaosa, Roseni tn 7a",
   "katastritunnus":"78401:114:0610","ehrCode":null,"adrId":"2124726",
   "lon":24.755537,"lat":59.438836}
]
```

`ehrCode 120542346` then resolves via `ehr_building_data` to the Roseni tn 7
büroohoone (its `katastriuksused` is `78401:114:0950` — the loop closes).

## Optional: cadastral geometry / metadata

Not part of this tool, but a cadastral number can be expanded separately via
`https://cadastre.kataster.ee/api/cadastre/<tunnus>` → `message.geom` (Polygon,
EPSG:3301) plus `pindala`, `siht1`, `omvorm`, `maksHind`, etc.

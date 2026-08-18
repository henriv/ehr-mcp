# Permit and proceeding checks

How `ehr_permit_check`, `ehr_document_list`, `ehr_proceeding_check`,
`ehr_registry_part_check` and `ehr_full_check` work: which endpoints they use,
how document types are classified, and how a status is derived.

Everything below was verified against the live cluster on **2026-08-18** and needs
**no authentication**.

## Upstream

Base: `EHR_ROOT_URL`, default `https://livekluster.ehr.ee`. Alternatives:
`prelivekluster` / `testkluster` / `devkluster`.

| Endpoint | Used for |
| --- | --- |
| `GET /api/document/v1/document/building/{ehrCode}` | The building's document list — the heart of every check |
| `GET /api/document/v1/document/{documentId}` | One document: `prosecutingAuthority`, `relatedDocuments`, `hasAkMark` |
| `GET /api/classifier/v1/alldocumenttypes` | The 306-entry document-type (DOTY) classifier, incl. expired types |
| `GET /api/building/v3/buildingData?ehr_code=…` | Existence check, address, `katastritunnus` |

Two response quirks the code depends on:

- An **unknown EHR code returns `200 []`** from the document list, not `404`. So
  "no documents" and "no such building" are indistinguishable there — every check
  confirms existence via `buildingData`, which does return `400` for an unknown code.
- An **unknown `documentId` returns `500`**, not `404`; a **restricted** document
  returns `401`. Both are handled as data (`null` / `juurdepaas_piiratud: true`),
  not as failures.

### Endpoints deliberately not used

These return `401` without an X-tee/TARA agreement and are never called:
`/api/proceeding/v1/**`, `POST /api/document/v1/document/search`,
`GET /api/document/v1/document/starting_rights`,
`/api/building/v2/buildingSecureData`, `/api/document-api/v1/**`.
`/api/av/v1/**` (open-data API) is `404` on live and is not used either.

## Classification ([src/ehr/classifier.ts](../src/ehr/classifier.ts))

**The numeric DOTY prefix is not a signal.** Applications and notices share code
ranges with permits:

```
11201–11206  Ehitusteatis        (notice)
11229, 11291 Ehitusloa taotlus   (application — same 112 prefix)
11301–11306  Kasutusteatis       (notice)
11329        Kasutusloa taotlus  (application — same 113 prefix)
```

So classification runs on the **type name, anchored to the start of the string**:

| Category | Pattern |
| --- | --- |
| `kasutusluba` | `^Kasutusluba\b` |
| `ehitusluba` | `^Ehitusluba\b` |
| `ehitusteatis` | `^Ehitusteatis\b` |
| `kasutusteatis` | `^Kasutusteatis\b` |

The anchor does the work by itself: "Ehitusloa taotlus ehitise laiendamiseks" and
"Ehitusloa kehtetuks tunnistamise otsus" start with the genitive *Ehitusloa*, not
the nominative *Ehitusluba*, so neither is mistaken for a permit. Those same
genitive stems tell us **which** permit an application or revocation concerns.

Order matters: revocations are matched before applications, because
"Kasutusloa kehtetuks tunnistamise **taotlus**" also contains the word *taotlus*.

The classifier is fetched at startup-on-first-use and cached for **24 h**. The
hard-coded id sets in `FALLBACK_IDS` are used **only** when that fetch fails; when
they are in play the response carries a warning.

### `raamistik` — legal framework

EhS 2015 took effect on **01.07.2015**. Many kasutusluba subtypes expired at or
before that date (e.g. DOTY 12311, `validTo` 2014-10-01). Those are **still valid
evidence** and are never filtered out — they are labelled instead:

- `pre-EhS2015` — the type expired on or before 01.07.2015
- `EhS2015` — the type was introduced on or after 01.07.2015 (all *teatis* types)
- `molemad` — the type spans the reform

## Status derivation ([src/ehr/permits.ts](../src/ehr/permits.ts))

A permit *found* is not a permit *in force*. Each category resolves to one of four
statuses, never a bare boolean:

| Status | Meaning |
| --- | --- |
| `olemas` | At least one document of this category in state `DO_DOKUSEIS_REG_KANTUD`, not revoked |
| `kehtetu` | Documents exist, but a **registered revocation decision** for this category exists |
| `menetluses` | Only an application, or documents in a non-final state |
| `puudub` | Nothing in this category |

Notes:

- A revocation **application** (`…kehtetuks tunnistamise taotlus`) does not revoke
  anything. It raises a warning; only a registered **otsus** yields `kehtetu`.
- A revocation is scoped to the permit it names — a revoked kasutusluba does not
  make the ehitusluba `kehtetu`.
- The evidence is returned in three separate arrays — `dokumendid` (the permits
  themselves), `taotlused`, `kehtetuks_tunnistamised` — so the caller never has to
  guess which document proves what.
- State **codes are not hard-coded**: the human-readable `documentStateText` from
  the response is passed through as `olek_tekst`. Verified codes include
  `DO_DOKUSEIS_REG_KANTUD` (Registrisse kantud), `DO_DOKUSEIS_TEAVITATUD`,
  `DO_DOKUSEIS_ALLKIRJASTAMISEL`, `DO_DOKUSEIS_ALLKIRJASTATUD`.

### Warnings

`hoiatused` is added when the documents do not mean what they might appear to:

- the building has no public document entries at all;
- the building has only pre-2003 *Hooneregistri* carry-overs (DOTY 91511) — that
  is **not** a kasutusluba;
- a revocation application is pending;
- a revocation could not be attributed to a permit category;
- the offline classifier fallback was used.

## Dates

The API returns UTC instants such as `2003-12-30T22:00:00.000+00:00`, which is
**31.12.2003** in Estonia — the date the register itself displays. `kuupaev` is the
Europe/Tallinn calendar date, converted rather than truncated.

## Request economy and caching

- `ehr_permit_check` = **one** document-list request + **one** `buildingData`
  request + the cached classifier. Document *details* are fetched only for the
  documents actually cited (max 12, 4 in flight), never for all 300.
- Document list: cached **15 min** per EHR code — proceeding states change.
- Classifier: cached **24 h**.
- `force_refresh: true` bypasses both.
- Timeouts, network errors and 5xx are retried twice with exponential backoff
  (250 ms, 500 ms); 4xx is never retried.

## Privacy

The document detail response carries `relatedEntities` and
`documentVersionCreator`, which include names, personal codes and contact details
of private individuals. **These fields are never read and never returned** — only
`prosecutingAuthority.registrationName` (an institution) is surfaced, as
`menetleja`. The test fixture has them stripped for the same reason.

## Registriosa

EHR holds no land-register (kinnistusraamat) *registriosa* number. Verified absent
from `v3/buildingData`, the document detail view, and the `arhiiv/v1/ehitisToimik`
records. `ehr_registry_part_check` therefore always returns
`registriosa_number: null`, with `saadaval: false`, a reason, and the cadastral
number(s) to continue the query at RIK. It never guesses.

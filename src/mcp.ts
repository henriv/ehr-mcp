import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBuildingData, EhrNotFoundError, EhrUpstreamError } from "./ehr/client.js";
import { EhrAuthRequiredError } from "./ehr/http.js";
import { trimBuildingData, fullBuildingData } from "./ehr/trim.js";
import { lookupAddress } from "./inads/client.js";
import { PERMIT_CATEGORIES, type PermitCategory } from "./ehr/classifier.js";
import {
  documentList,
  permitCheck,
  proceedingCheck,
  registryPartCheck,
  fullCheck,
  DEFAULT_DOCUMENT_LIMIT,
  type DocumentFilter,
} from "./ehr/checks.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const TOOL_DESCRIPTION =
  "Ehitise kehtivad andmed Ehitisregistrist EHR koodi järgi (aadress, tehnilised näitajad, kasutusotstarve, energiamärgis, katastriüksused). Vaikimisi kompaktne kokkuvõte; taielik=true tagastab kõik väljad. Ei tagasta geomeetriat.";

const ehrKoodSchema = z
  .string()
  .regex(/^\d+$/, "EHR kood peab olema numbriline")
  .describe("Ehitise EHR kood (numbriline), nt 101018690");

const forceRefreshSchema = z
  .boolean()
  .optional()
  .describe("Kui true, eira vahemälu (dokumendinimekiri 15 min, klassifikaator 24 h).");

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
});

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Uniform failure handling for every EHR-backed tool: an unknown code is a
 * normal answer, an upstream problem is an error, and a 401 on a documented
 * public endpoint is reported as such rather than disguised.
 */
async function run(ehrKoodForMessage: string | undefined, fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof EhrNotFoundError) {
      return textResult(
        `EHR koodiga ${ehrKoodForMessage ?? err.ehrCode} ehitist ei leitud.`,
      );
    }
    if (err instanceof EhrAuthRequiredError) {
      return textResult(
        `Ehitisregistri avalik endpoint ${err.url} tagastas HTTP ${err.status} — ligipääsureeglid on ilmselt muutunud ja päring nõuab nüüd autentimist.`,
        true,
      );
    }
    const message =
      err instanceof EhrUpstreamError ? err.message : "Ehitisregistri päring ebaõnnestus.";
    return textResult(message, true);
  }
}

/**
 * Build a fresh McpServer with all building, address and permit tools.
 * Stateless design: a new server is created per POST request. The document and
 * classifier caches are module-level, so they survive across requests.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "ehr-mcp", version: pkg.version });

  server.registerTool(
    "ehr_building_data",
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        ehr_kood: ehrKoodSchema,
        taielik: z
          .boolean()
          .optional()
          .describe(
            "Kui true, tagasta kõik EHR väljad (v.a geomeetria); vaikimisi false = kompaktne kokkuvõte (<2 KB).",
          ),
      },
    },
    async ({ ehr_kood, taielik }) =>
      run(ehr_kood, async () => {
        const raw = await getBuildingData(ehr_kood);
        return taielik ? fullBuildingData(raw) : trimBuildingData(raw);
      }),
  );

  server.registerTool(
    "address_lookup",
    {
      description:
        "Otsi Eesti aadressi järgi ehitisi. Vabateksti-aadressist tagastab kandidaadid, igaühel katastritunnus ja ehitise EHR kood — koodid saab edasi anda ehr_building_data tööriistale.",
      inputSchema: {
        query: z
          .string()
          .describe("Vabateksti-aadress, nt \"Tallinn Roseni 7\". Alla 3 tähemärgi -> tühi tulemus."),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Max tulemuste arv (vaikimisi 8)."),
      },
    },
    async ({ query, limit }) => json(await lookupAddress(query, limit ?? 8)),
  );

  server.registerTool(
    "ehr_document_list",
    {
      description:
        "Ehitise avalik dokumendinimekiri EHR koodi järgi. Iga kirje on klassifitseeritud dokumenditüübi NIME järgi (kasutusluba / kasutusteatis / ehitusluba / ehitusteatis / taotlus / kehtetuks_tunnistamine / muu) ning märgitud õigusraamistikuga (pre-EhS2015 = enne 01.07.2015 kehtinud alamtüüp, endiselt kehtiv tõend). Madala taseme ehitusplokk — lubade kontrolliks kasuta ehr_permit_check.",
      inputSchema: {
        ehr_kood: ehrKoodSchema,
        liik: z
          .enum(["kasutusluba", "kasutusteatis", "ehitusluba", "ehitusteatis", "taotlus", "koik"])
          .optional()
          .describe("Filtreeri kategooria järgi; vaikimisi koik."),
        kaasa_detailid: z
          .boolean()
          .optional()
          .describe(
            "Kui true, päri iga dokumendi detailvaade ja lisa menetleja, seotud dokumendid ja juurdepääsupiirangu märge (max 12 dokumenti).",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(300)
          .optional()
          .describe("Max tagastatavaid dokumente (vaikimisi 50). Kärpimisel lisatakse karbitud: true."),
        force_refresh: forceRefreshSchema,
      },
    },
    async ({ ehr_kood, liik, kaasa_detailid, limit, force_refresh }) =>
      run(ehr_kood, () =>
        documentList({
          ehrCode: ehr_kood,
          liik: liik as DocumentFilter | undefined,
          kaasaDetailid: kaasa_detailid ?? false,
          limit: limit ?? DEFAULT_DOCUMENT_LIMIT,
          forceRefresh: force_refresh ?? false,
        }),
      ),
  );

  server.registerTool(
    "ehr_permit_check",
    {
      description:
        "Peamine kontrollitööriist: vastab ühe päringuga kas ehitisel on kasutusluba, kasutusteatis, ehitusluba ja ehitusteatis. Iga kategooria staatus on olemas | puudub | kehtetu | menetluses koos tõendavate dokumentidega (number, kuupäev, olek, menetleja, raamistik). Ei tagasta lihtsat true/false ega tuleta midagi, mida avalikes andmetes ei ole.",
      inputSchema: {
        ehr_kood: ehrKoodSchema,
        kontrollid: z
          .array(z.enum(["kasutusluba", "kasutusteatis", "ehitusluba", "ehitusteatis"]))
          .optional()
          .describe("Millised kontrollid teha; vaikimisi kõik neli."),
        taielik: z
          .boolean()
          .optional()
          .describe("Kui true, lisa vastusesse ka kogu klassifitseeritud dokumendinimekiri."),
        force_refresh: forceRefreshSchema,
      },
    },
    async ({ ehr_kood, kontrollid, taielik, force_refresh }) =>
      run(ehr_kood, () =>
        permitCheck({
          ehrCode: ehr_kood,
          kontrollid: (kontrollid as PermitCategory[] | undefined) ?? PERMIT_CATEGORIES,
          taielik: taielik ?? false,
          forceRefresh: force_refresh ?? false,
        }),
      ),
  );

  server.registerTool(
    "ehr_proceeding_check",
    {
      description:
        "Dokumentide menetlusseisud ehitise EHR koodi või ühe document_id järgi. TÄHELEPANU: tulemus on TULETATUD avalikust documentState/documentStatus väljast, mitte menetlusregistri väljavõte — täielik menetlusinfo (/api/proceeding/v1) nõuab X-tee/TARA autentimist. Vastuses on see alati eraldi väljadega märgitud.",
      inputSchema: {
        ehr_kood: ehrKoodSchema.optional(),
        document_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Ühe dokumendi id (ehr_document_list väljundist). Alternatiiv ehr_kood-ile."),
        taielik: z
          .boolean()
          .optional()
          .describe("Kui true, kaasa ka registrikanded ja muud mittemenetluslikud dokumendid."),
        force_refresh: forceRefreshSchema,
      },
    },
    async ({ ehr_kood, document_id, taielik, force_refresh }) => {
      if (ehr_kood === undefined && document_id === undefined) {
        return textResult("Anna kas ehr_kood või document_id.", true);
      }
      return run(ehr_kood, () =>
        proceedingCheck({
          ehrCode: ehr_kood,
          documentId: document_id,
          taielik: taielik ?? false,
          forceRefresh: force_refresh ?? false,
        }),
      );
    },
  );

  server.registerTool(
    "ehr_registry_part_check",
    {
      description:
        "Kinnistusraamatu registriosa numbri kontroll. Ehitisregistris seda välja EI OLE, seega vastus on alati registriosa_number: null koos põhjendusega ja sillaga edasiseks päringuks: ehitise katastritunnus(ed) ja aadress, mille alusel saab pärida kinnistusraamatust (RIK). Väljamõeldud numbrit ei tagastata kunagi.",
      inputSchema: { ehr_kood: ehrKoodSchema },
    },
    async ({ ehr_kood }) => run(ehr_kood, () => registryPartCheck(ehr_kood)),
  );

  server.registerTool(
    "ehr_full_check",
    {
      description:
        "Koondtööriist: teeb ühe ehitise kohta kõik kuus kontrolli (kasutusluba, kasutusteatis, ehitusluba, ehitusteatis, registriosa, menetlus). Sisendiks kas ehr_kood või vabateksti-aadress. Kui aadress annab mitu kandidaati, tagastatakse valikunimekiri — tööriist ei vali ise ehitist.",
      inputSchema: {
        ehr_kood: ehrKoodSchema.optional(),
        aadress: z
          .string()
          .optional()
          .describe("Vabateksti-aadress, nt \"Tallinn Roseni 7\". Alternatiiv ehr_kood-ile."),
        taielik: z.boolean().optional().describe("Kui true, tagasta täielik dokumendinimekiri."),
        force_refresh: forceRefreshSchema,
      },
    },
    async ({ ehr_kood, aadress, taielik, force_refresh }) => {
      let code = ehr_kood;

      if (code === undefined) {
        if (aadress === undefined) return textResult("Anna kas ehr_kood või aadress.", true);

        const candidates = await lookupAddress(aadress, 8);
        // Flatten: one location can carry several buildings.
        const codes = candidates.flatMap((c) =>
          c.ehrCode === null ? [] : Array.isArray(c.ehrCode) ? c.ehrCode : [c.ehrCode],
        );
        if (codes.length === 0) {
          return json({
            aadress,
            ehr_kood: null,
            pohjus: "Aadressi järgi ei leitud ühtegi ehitise EHR koodi.",
            kandidaadid: candidates,
          });
        }
        if (codes.length > 1) {
          return json({
            aadress,
            valik_vajalik: true,
            pohjus: "Aadress vastab mitmele ehitisele — vali EHR kood ja korda päringut.",
            kandidaadid: candidates,
          });
        }
        code = codes[0]!;
      }

      const resolved = code;
      return run(resolved, () =>
        fullCheck({
          ehrCode: resolved,
          taielik: taielik ?? false,
          forceRefresh: force_refresh ?? false,
        }),
      );
    },
  );

  return server;
}

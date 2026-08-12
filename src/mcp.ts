import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBuildingData, EhrNotFoundError, EhrUpstreamError } from "./ehr/client.js";
import { trimBuildingData, fullBuildingData } from "./ehr/trim.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const TOOL_DESCRIPTION =
  "Ehitise kehtivad andmed Ehitisregistrist EHR koodi järgi (aadress, tehnilised näitajad, kasutusotstarve, energiamärgis, katastriüksused). Vaikimisi kompaktne kokkuvõte; taielik=true tagastab kõik väljad. Ei tagasta geomeetriat.";

/**
 * Build a fresh McpServer with the single ehr_building_data tool.
 * Stateless design: a new server is created per POST request.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "ehr-mcp", version: pkg.version });

  server.registerTool(
    "ehr_building_data",
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        ehr_kood: z
          .string()
          .regex(/^\d+$/, "EHR kood peab olema numbriline")
          .describe("Ehitise EHR kood (numbriline), nt 101018690"),
        taielik: z
          .boolean()
          .optional()
          .describe(
            "Kui true, tagasta kõik EHR väljad (v.a geomeetria); vaikimisi false = kompaktne kokkuvõte (<2 KB).",
          ),
      },
    },
    async ({ ehr_kood, taielik }) => {
      try {
        const raw = await getBuildingData(ehr_kood);
        const payload = taielik ? fullBuildingData(raw) : trimBuildingData(raw);
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        if (err instanceof EhrNotFoundError) {
          return {
            content: [
              { type: "text", text: `EHR koodiga ${ehr_kood} ehitist ei leitud.` },
            ],
          };
        }
        const message =
          err instanceof EhrUpstreamError
            ? err.message
            : "Ehitisregistri päring ebaõnnestus.";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );

  return server;
}

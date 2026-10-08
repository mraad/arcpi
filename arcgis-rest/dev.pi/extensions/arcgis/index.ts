// pi extension of the arcgis-rest plugin: gives codemode scripts one HTTP tool
// that calls ArcGIS REST as the signed-in user. Mappi shares the stored session;
// tokens never appear in tool arguments or results.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configFromEnv, login, logout, request, signedInAs, status } from "./arcgis.ts";
import { pluginMcpServers } from "./mcp.ts";

const namespace = {
  name: "arcgis",
  description: "ArcGIS REST endpoints, called as the signed-in portal user",
  instructions: "Read the arcgis-rest skill for endpoints and parameters. arcgis_request throws on ArcGIS "
    + "errors; never pass, print or store a token.",
};

/**
 * A tool result from a plain value. Scripts receive `structuredContent`; the
 * text summarizes the envelope without serializing the response body again.
 */
const reply = (value: object) => {
  const { data, ...envelope } = value as { data?: unknown };
  // Results must be JSON values, so undefined members are dropped. Only the small
  // envelope needs that: `data` is parsed JSON and is passed on as it is, not copied.
  const text = JSON.stringify(envelope);
  const structuredContent = { ...JSON.parse(text), ...(data === undefined ? {} : { data }) };
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
    structuredContent,
  };
};

export default function (pi: ExtensionAPI) {
  const { servers, problems } = pluginMcpServers();
  for (const [name, config] of servers) {
    try {
      pi.registerMcpServer(name, config as Parameters<ExtensionAPI["registerMcpServer"]>[1]);
    } catch (error) {
      problems.push(`${name}: ${(error as Error).message}`);
    }
  }
  if (problems.length > 0) {
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(`arcgis-rest MCP servers skipped: ${problems.join("; ")}`, "warning"));
  }

  pi.registerTool({
    name: "arcgis_request",
    label: "ArcGIS REST",
    description: "Call an ArcGIS REST endpoint as the signed-in user and return its JSON. The user's token is "
      + "added automatically for hosts of the configured portal and refreshed when needed. Throws on ArcGIS "
      + "error responses. Geometry is returned by reference, never as coordinates.",
    exposure: "codemode",
    namespace,
    parameters: Type.Object({
      url: Type.String({
        description: "Absolute endpoint URL, or a path starting with / on the configured portal, "
          + "for example /sharing/rest/search",
      }),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), {
        description: "REST parameters under their documented names (outFields, returnGeometry). Objects and "
          + "arrays are sent as JSON. f defaults to json. Never include token. Pass a shape as the reference "
          + "an earlier result gave: { $geometry: \"<path>#<n>\" }, or a list of references to merge them.",
      })),
      method: Type.Optional(Type.Union([Type.Literal("POST"), Type.Literal("GET")], {
        description: "POST (default) sends the parameters as a form; GET puts them in the query string",
      })),
      save_to: Type.Optional(Type.String({
        description: "File path under artifacts/ to write the response body to instead of returning it; "
          + "required for binary responses such as PDF reports",
      })),
    }),
    outputSchema: Type.Object({
      status: Type.Number({ description: "HTTP status" }),
      data: Type.Optional(Type.Any({
        description: "Parsed JSON body, or text for a non-JSON text response. Lines, polygons and multipoints "
          + "are replaced by { $geometry, type, vertices, bbox } references to files on disk",
      })),
      geometry_files: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ description: "Absolute path of the GeoJSON file under artifacts/geometry/ holding the shapes and their attributes" }),
        features: Type.Number(),
        wkid: Type.Optional(Type.Number({ description: "Spatial reference of the coordinates in the file" })),
      }))),
      saved: Type.Optional(Type.Object({
        path: Type.String({ description: "Absolute path of the written file" }),
        bytes: Type.Number(),
        content_type: Type.String(),
        features: Type.Optional(Type.Number({ description: "Feature count, when the saved body has a features array" })),
        exceededTransferLimit: Type.Optional(Type.Boolean({ description: "Service paging flag, including GeoJSON properties.exceededTransferLimit; true means the file is incomplete" })),
      })),
      note: Type.Optional(Type.String({ description: "Set when the request went out without the user's token" })),
    }),
    execute: async (_toolCallId, params, signal) => reply(await request(configFromEnv(), params, signal)),
  });

  pi.registerTool({
    name: "arcgis_status",
    label: "ArcGIS session",
    description: "Report the configured portal and whether a user is signed in (username, token expiry, "
      + "refreshability). Never returns a token and makes no network call.",
    exposure: "codemode",
    namespace,
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: Type.Object({}),
    outputSchema: Type.Object({
      portal: Type.String(),
      signed_in: Type.Boolean(),
      username: Type.Optional(Type.String()),
      token_expires_at: Type.Optional(Type.String()),
      refreshable: Type.Boolean(),
      refresh_expires_at: Type.Optional(Type.String()),
      refresh_error: Type.Optional(Type.String()),
      session_file: Type.String(),
    }),
    execute: async () => reply(status(configFromEnv())),
  });

  pi.registerCommand("arcgis-login", {
    description: "Sign in to the ArcGIS portal in the browser",
    handler: async (_args, ctx) => {
      try {
        const session = await login(configFromEnv(), { say: (message) => ctx.ui.notify(message, "info") });
        ctx.ui.notify(signedInAs(session), "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("arcgis-logout", {
    description: "Remove the stored ArcGIS session for this portal and client",
    handler: async (_args, ctx) => {
      try {
        logout(configFromEnv());
        ctx.ui.notify("Signed out of ArcGIS.", "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
}

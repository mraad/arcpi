// mappi: the live map for arcpi. One process, no dependencies:
//   POST /mcp       MCP (streamable HTTP, JSON responses), one tool: run_map_code
//   GET  /          the map page (ArcGIS Maps SDK 5.1), signed in by arcpi login
//   GET  /events    page channel (SSE): auth + runJs out; POST /result: results back
//   GET  /config    non-secret portal URL + client id
//   GET  /artifacts read-only .geojson/.json/.parquet under arcpi's ARCPI_ARTIFACTS_DIR (default artifacts/)
//   GET  /health
// Run: node mappi/server.ts   (HOST, PORT; default 127.0.0.1:8787)
// node mappi/server.ts --static serves artifacts/ by path on 127.0.0.1:8000 (PORT; never HOST) instead,
// for generated standalone maps that need HTTP; mappi refuses that origin.
// The access token reaches the page only through /events; refresh tokens stay in Node.
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsFolder } from "../arcgis-rest/dev.pi/extensions/arcgis/geometry.ts";
import { configFromEnv, mapAuth } from "../arcgis-rest/dev.pi/extensions/arcgis/arcgis.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PROJECT = join(HERE, "..");
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1 << 20;
// ponytail: loopback only; add an allow-list env if the page must be served beyond this machine.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// What /artifacts serves: GeoJSONLayer and ParquetLayer inputs.
const FILE_TYPES: Record<string, string> = {
  ".geojson": "application/geo+json",
  ".json": "application/geo+json",
  ".parquet": "application/vnd.apache.parquet",
};
// What --static serves: a generated map and what it loads.
const STATIC_TYPES: Record<string, string> = {
  ...FILE_TYPES,
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

type Reply = { ok: boolean; result: unknown; error: string | null; console: unknown[] };
type Auth = Awaited<ReturnType<typeof mapAuth>> | { portalUrl: null; token: null };
type Page = { res: ServerResponse; secret: string; auth?: string };
type Pending = { page: Page; done: (reply: Reply) => void };

const failure = (error: string): Reply => ({ ok: false, result: null, error, console: [] });

const TOOL = {
  name: "run_map_code",
  description: `Execute generated JavaScript in the open map page and return its result.

The code runs as an async function body taking \`api\` (you may \`await\`). Use
ONLY \`api\` and \`return\` a small JSON-safe summary. The \`api\` surface:
  api.view, api.map, api.signal (AbortSignal; honor it in long work)
  api.import(paths)            -> $arcgis.import(...) for ANY @arcgis/core module
  api.addLayer(layer, {name, zoom}), api.removeLayer(name), api.clearLayers(), api.layers
  api.zoomTo(target), api.legend()
  api.parquetLayer(absolutePath, {name, zoom}) -> a saved .parquet file as a ParquetLayer
  api.user                     -> signed-in ArcGIS username, or null
Every added layer gets an automatic attribute popup; the legend updates itself.

Data: load services by URL (FeatureLayer, MapImageLayer, Layer.fromPortalItem…);
the page inherits arcpi's login and supplies credentials for trusted ArcGIS hosts.
A secured layer while \`api.user\` is null fails: ask the user to run ./arcpi login
(or /arcgis-login), then re-send. Never pass a token in generated code. Saved
GeoJSON (e.g. arcpi's geometry_files[].path) loads as
GeoJSONLayer({url: "/artifacts?path=" + encodeURIComponent(absolutePath)}); saved
(Geo)Parquet loads with api.parquetLayer, which handles a missing CRS (CRS84)
and MultiLineString.

Returns {ok, result, error, console}. Requires the page open. On a runtime
error, \`error\` carries the stack so you can fix and re-send.`,
  inputSchema: {
    type: "object",
    properties: {
      js: { type: "string", description: "Async function body; receives `api`." },
      timeout: { type: "number", default: 15, description: "Seconds for the whole call." },
    },
    required: ["js"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      result: {},
      error: { type: ["string", "null"] },
      console: { type: "array" },
    },
    required: ["ok"],
  },
};

/** Relays run_map_code to the newest page and matches results by id. */
function createBroker(getAuth: () => Promise<Auth>) {
  // ponytail: newest page is the only target; add per-tab routing if several tabs matter.
  const pages: Page[] = [];
  const pending = new Map<string, Pending>();
  let ids = 0;
  let polling: NodeJS.Timeout | undefined;
  let syncing: Promise<void> | undefined;
  const tokens = new Set<string>();
  const send = (page: Page, message: object) => page.res.write(`data: ${JSON.stringify(message)}\n\n`);
  const redact = (value: Reply): Reply => {
    let text = JSON.stringify(value);
    for (const token of tokens) text = text.split(token).join("[redacted]");
    return JSON.parse(text);
  };
  const syncAuth = () => syncing ??= (async () => {
    // Configuration/refresh failures must clear old page credentials, not leak diagnostics.
    const auth = await getAuth().catch(() => ({ portalUrl: null, token: null }));
    if (auth.token) tokens.add(auth.token);
    const encoded = JSON.stringify({ type: "auth", ...auth });
    for (const page of pages) {
      if (page.auth === encoded) continue;
      page.auth = encoded;
      page.res.write(`data: ${encoded}\n\n`);
    }
  })().finally(() => { syncing = undefined; });

  return {
    get pages() {
      return pages.length;
    },
    add(res: ServerResponse): Page {
      const page = { res, secret: randomBytes(24).toString("base64url") };
      pages.push(page);
      send(page, { type: "hello", secret: page.secret });
      void syncAuth();
      polling ??= setInterval(() => { void syncAuth(); }, 5_000);
      polling.unref();
      return page;
    },
    remove(page: Page) {
      const index = pages.indexOf(page);
      if (index >= 0) pages.splice(index, 1);
      if (!pages.length) { clearInterval(polling); polling = undefined; }
      for (const call of [...pending.values()]) {
        if (call.page === page) call.done(failure("page disconnected during execution"));
      }
    },
    /** A result counts only from the page the call was sent to. */
    resolve(secret: string, message: Record<string, unknown>): boolean {
      const call = pending.get(String(message.id));
      if (!call || !safeEqual(call.page.secret, secret)) return false;
      call.done(redact({
        ok: message.ok === true,
        result: message.result ?? null,
        error: typeof message.error === "string" ? message.error : null,
        console: Array.isArray(message.console) ? message.console : [],
      }));
      return true;
    },
    exec(code: string, timeout: number): Promise<Reply> {
      if (!Number.isFinite(timeout) || timeout <= 0) return Promise.resolve(failure("timeout must be a positive finite number"));
      const page = pages.at(-1);
      if (!page) return Promise.resolve(failure("no page connected — open the map in a browser"));
      const id = String(++ids);
      return new Promise((resolve) => {
        // One deadline covers the send, page execution and the result relay.
        const timer = setTimeout(() => done(failure(`exec timeout after ${timeout}s`)), Math.min(timeout * 1000, 2 ** 31 - 1));
        const done = (reply: Reply) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(reply);
        };
        pending.set(id, { page, done });
        const deadline = Date.now() + timeout * 1000;
        void syncAuth().then(() => {
          if (pending.has(id)) send(page, { type: "runJs", id, code, timeoutMs: Math.max(0, deadline - Date.now()) });
        });
      });
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Loopback Host (no DNS rebinding) and, when sent, mappi's own Origin. An
 * EventSource needs no CORS preflight: without this, any site open in the
 * user's browser, or a page on another loopback port (a static server for
 * generated maps), could become the exec target, and a rebound name could read it.
 */
function localRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!LOOPBACK.has(URL.parse(`http://${host}`)?.hostname ?? "")) return false;
  return req.headers.origin === undefined || req.headers.origin === `http://${host}`;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One `types` file inside the artifacts folder, read-only; everything else is 404.
 * ParquetLayer reads by size and byte ranges: Content-Length always, HEAD, one Range.
 */
async function sendArtifact(req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv, project: string,
  path: string | null, types: Record<string, string>) {
  try {
    if (!path || !isAbsolute(path)) return plain(res, 404);
    // artifactsFolder throws on a name arcpi refuses: that is a 404 too.
    const folder = join(project, artifactsFolder(env));
    // A symlinked artifacts/ could point at .arcgis/; the launcher refuses it too.
    if ((await lstat(folder)).isSymbolicLink()) return plain(res, 404);
    // realpath follows every symlink, so containment is checked on the real file.
    const [root, real] = await Promise.all([realpath(folder), realpath(path)]);
    const inside = relative(root, real);
    // ".." leaves the root; dot folders (.arcgis) hold credentials.
    if (!inside || isAbsolute(inside) || inside.split(sep).some((part) => part.startsWith("."))) return plain(res, 404);
    const type = types[extname(real).toLowerCase()];
    const info = await stat(real);
    if (!type || !info.isFile()) return plain(res, 404);
    const headers = { "content-type": type, "cache-control": "no-store", "accept-ranges": "bytes", "x-content-type-options": "nosniff" };
    let start = 0, end = info.size - 1;
    // ponytail: one range ("a-b", "a-", "-n"); a multi-range request gets the whole file.
    const [, from = "", to = ""] = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "") ?? [];
    if (from || to) {
      if (from) [start, end] = [Number(from), to ? Math.min(Number(to), end) : end];
      else start = Math.max(0, info.size - Number(to));
      if (start > end) return plain(res, 416, { "content-range": `bytes */${info.size}` });
      res.writeHead(206, { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${info.size}` });
    } else {
      res.writeHead(200, { ...headers, "content-length": String(info.size) });
    }
    if (req.method === "HEAD" || info.size === 0) return res.end();
    // A file removed after stat() fails here, after the headers: drop that one response.
    createReadStream(real, { start, end }).on("error", () => res.destroy()).pipe(res);
  } catch {
    plain(res, 404);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function plain(res: ServerResponse, status: number, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(`${status}\n`);
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** `project` is arcpi's checkout, which holds the artifacts folder. */
export function createMappi(env: NodeJS.ProcessEnv = process.env, project = PROJECT): Server {
  const broker = createBroker(async () => {
    if (!env.ARCGIS_PORTAL_URL || !env.ARCGIS_CLIENT_ID) return { portalUrl: null, token: null };
    return mapAuth(configFromEnv(env, project));
  });

  async function rpc(method: unknown, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = String(params.protocolVersion);
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "mappi", version: "1.0.0" },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: [TOOL] };
      case "tools/call": {
        if (params.name !== TOOL.name) throw Object.assign(new Error(`Unknown tool: ${String(params.name)}`), { code: -32602 });
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args.js !== "string" || (args.timeout !== undefined && typeof args.timeout !== "number")) {
          return { content: [{ type: "text", text: "run_map_code needs js (string) and an optional timeout (number)" }], isError: true };
        }
        const reply = await broker.exec(args.js, (args.timeout as number | undefined) ?? 15);
        return { content: [{ type: "text", text: JSON.stringify(reply) }], structuredContent: reply, isError: false };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${String(method)}`), { code: -32601 });
    }
  }

  async function mcp(req: IncomingMessage, res: ServerResponse) {
    const token = env.MCP_BEARER_TOKEN;
    if (token && !safeEqual(req.headers.authorization ?? "", `Bearer ${token}`)) {
      return plain(res, 401, { "www-authenticate": "Bearer" });
    }
    // No server-initiated stream (GET) and no sessions to end (DELETE).
    if (req.method !== "POST") return plain(res, 405, { allow: "POST" });
    const body = await readBody(req);
    if (body === null) return plain(res, 413);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(body);
    } catch {
      return json(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return json(res, 400, rpcError(null, -32600, "Invalid Request"));
    }
    // Notifications and client responses get no reply.
    if (message.id === undefined || message.id === null || message.method === undefined) return plain(res, 202);
    try {
      const params = (message.params ?? {}) as Record<string, unknown>;
      json(res, 200, { jsonrpc: "2.0", id: message.id, result: await rpc(message.method, params) });
    } catch (error) {
      const { code = -32603, message: text } = error as { code?: number; message: string };
      json(res, 200, rpcError(message.id, code, text));
    }
  }

  function events(res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 1000\n\n");
    const page = broker.add(res);
    res.on("close", () => broker.remove(page));
  }

  async function result(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req);
    if (body === null) return plain(res, 413);
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return plain(res, 400);
    }
    const secret = String(req.headers["x-mappi-page"] ?? "");
    if (!message || typeof message !== "object" || !broker.resolve(secret, message as Record<string, unknown>)) return plain(res, 404);
    plain(res, 204);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    if (!localRequest(req)) return plain(res, 403);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") return mcp(req, res);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(await readFile(join(HERE, "index.html")));
      case "GET /events":
        return events(res);
      case "POST /result":
        return result(req, res);
      case "GET /config":
        // Non-secret settings the page cannot read from the shell.
        return json(res, 200, { portalUrl: env.ARCGIS_PORTAL_URL || null, clientId: env.ARCGIS_CLIENT_ID || null });
      case "GET /artifacts":
      case "HEAD /artifacts":
        return sendArtifact(req, res, env, project, url.searchParams.get("path"), FILE_TYPES);
      case "GET /health":
        return json(res, 200, { ok: true, pages: broker.pages });
      default:
        return plain(res, 404);
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(error);
      if (res.headersSent) res.destroy();
      else plain(res, 500);
    });
  });
}

/**
 * The artifacts folder by path (`/<name>.html`, and the relative files a map loads), read-only,
 * with the same checks as /artifacts. Its origin is not mappi's, so its pages cannot drive the map.
 */
export function createStatic(env: NodeJS.ProcessEnv = process.env, project = PROJECT): Server {
  return createServer((req, res) => {
    if (!localRequest(req)) return plain(res, 403);
    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, { allow: "GET, HEAD" });
    let path: string;
    try {
      path = join(project, artifactsFolder(env), decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname));
    } catch {
      return plain(res, 404);
    }
    sendArtifact(req, res, env, project, path, STATIC_TYPES).catch(() => res.destroy());
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const statics = process.argv.includes("--static");
  // Static mode stays on loopback whatever HOST says: a remote client could send a loopback Host header.
  const host = statics ? "127.0.0.1" : process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || (statics ? 8000 : 8787));
  const shown = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`;
  (statics ? createStatic() : createMappi()).listen(port, host, () =>
    console.error(statics ? `mappi static: ${shown}<file> from the artifacts folder` : `mappi: ${shown} (MCP at /mcp)`));
}

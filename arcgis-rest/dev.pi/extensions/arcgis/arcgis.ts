// ArcGIS session and REST request core of the arcgis-rest plugin.
// Node built-ins and erasable TypeScript only, so pi, `node --test` and
// `node arcgis.ts login|logout|status` all load this same file unbuilt.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { artifactPath, artifactsFolder, externalize, resolveReferences } from "./geometry.ts";
import type { GeometryFile } from "./geometry.ts";

export interface Config {
  /** Portal URL without a trailing slash. */
  portal: string;
  clientId: string;
  sessionFile: string;
  artifactsDir: string;
  /** Operator-supplied extra hosts that may receive the token. */
  trustedHosts: string[];
}

export interface Session {
  token: string;
  portal: string;
  client_id: string;
  expires_at: string;
  refresh_token?: string;
  refresh_expires_at?: string;
  username?: string;
  /** Identifies a login across processes; refresh preserves it. */
  login_id?: string;
}

interface RequestArgs {
  url: string;
  params?: Record<string, unknown>;
  method?: string;
  save_to?: string;
}

interface RequestResult {
  status: number;
  data?: unknown;
  saved?: { path: string; bytes: number; content_type: string; features?: number; exceededTransferLimit?: boolean };
  /** Where the shapes of this response were written; `data` holds references to them. */
  geometry_files?: GeometryFile[];
  note?: string;
}

interface Trust {
  hosts: Set<string>;
  /** Domains whose subdomains are trusted too. */
  suffixes: string[];
}

/** What this process remembers about one profile (session file); dropped whole on login and logout. */
interface Profile {
  sessionIdentity?: string;
  refreshing?: Promise<string | undefined>;
  refreshFailure?: { at: number; message: string };
  trust?: Promise<Trust>;
  /** Set when the portal could not be asked as a signed-in user: when to ask again. */
  trustRetryAt?: number;
  /** Trusted hosts that turned down even a newly issued token; they are called without one. */
  tokenRefusedBy?: Set<string>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REFRESH_SKEW_MS = 60_000;
/** Pause before repeating a refresh or a trust discovery that did not succeed. */
const RETRY_COOLDOWN_MS = 30_000;
const LOGIN_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
// Sign-in and refresh belong to this module; a script reaching these would receive raw tokens.
const TOKEN_ENDPOINT = /\/(oauth2|tokens|generateToken)(?=[/;]|$)/i;

const profiles = new Map<string, Profile>();

const profileOf = (cfg: Config): Profile => {
  let profile = profiles.get(cfg.sessionFile);
  const session = readSession(cfg);
  const identity = session?.login_id ?? session?.username;
  if (!profile || (profile.sessionIdentity !== undefined && profile.sessionIdentity !== identity)) {
    profiles.set(cfg.sessionFile, (profile = {}));
  }
  profile.sessionIdentity = identity;
  return profile;
};

const hostOf = (raw: string): string =>
  URL.parse(raw.includes("://") ? raw : `https://${raw}`)?.hostname.toLowerCase() ?? "";

const isHttp = (url: URL): boolean => url.protocol === "https:" || url.protocol === "http:";

const isTokenEndpoint = (url: URL): boolean => {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed escapes: match the path as written.
  }
  return TOKEN_ENDPOINT.test(path);
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const portal = (env.ARCGIS_PORTAL_URL ?? "").trim().replace(/\/+$/, "");
  const clientId = (env.ARCGIS_CLIENT_ID ?? "").trim();
  if (!portal || !clientId) throw new Error("Set ARCGIS_PORTAL_URL and ARCGIS_CLIENT_ID.");
  const url = URL.parse(portal);
  if (!url) throw new Error(`ARCGIS_PORTAL_URL is not a URL: ${portal}`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("ARCGIS_PORTAL_URL must use https.");
  }
  const artifacts = artifactsFolder(env);
  // One session per portal/client pair, so switching either never reuses the other's login.
  const profile = createHash("sha256").update(`${portal}\n${clientId}`).digest("hex");
  return {
    portal,
    clientId,
    sessionFile: join(resolve(cwd, env.ARCGIS_SESSION_DIR || ".arcgis"), profile, "session.json"),
    artifactsDir: resolve(cwd, artifacts),
    trustedHosts: (env.ARCGIS_TRUSTED_TOKEN_HOSTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
  };
}

export function readSession(cfg: Config): Session | undefined {
  try {
    const session = JSON.parse(readFileSync(cfg.sessionFile, "utf8"));
    return typeof session?.token === "string" ? session : undefined;
  } catch {
    return undefined;
  }
}

function writeSession(cfg: Config, session: Session): void {
  mkdirSync(dirname(cfg.sessionFile), { recursive: true, mode: 0o700 });
  // Write beside the target and rename, so a reader never sees half a session.
  const temporary = `${cfg.sessionFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, cfg.sessionFile);
}

export function logout(cfg: Config): void {
  rmSync(cfg.sessionFile, { force: true });
  profiles.delete(cfg.sessionFile);
}

const unexpired = (session: Session | undefined, skewMs = 0): string | undefined =>
  session && Date.parse(session.expires_at) - Date.now() > skewMs ? session.token : undefined;

const canRefresh = (session: Session): boolean =>
  !!session.refresh_token && !(session.refresh_expires_at && Date.parse(session.refresh_expires_at) <= Date.now());

export function status(cfg: Config) {
  const session = readSession(cfg);
  const refreshable = !!session && canRefresh(session);
  return {
    portal: cfg.portal,
    signed_in: !!unexpired(session) || refreshable,
    username: session?.username,
    token_expires_at: session?.expires_at,
    refreshable,
    refresh_expires_at: session?.refresh_expires_at,
    refresh_error: profiles.get(cfg.sessionFile)?.refreshFailure?.message,
    session_file: cfg.sessionFile,
  };
}

export const signedInAs = (session: Session): string =>
  `Signed in to ${session.portal}${session.username ? ` as ${session.username}` : ""}.`;

/** POST to the portal's OAuth token endpoint and turn the answer into a session. */
async function tokenGrant(cfg: Config, form: Record<string, string>, previous?: Session): Promise<Session> {
  const response = await fetch(`${cfg.portal}/sharing/rest/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({ ...form, client_id: cfg.clientId, f: "json" }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new Error(`ArcGIS sign-in failed: the portal answered HTTP ${response.status} without JSON`);
  }
  if (body?.error || !body?.access_token) {
    // Portals answer either OAuth style (error is a string) or ArcGIS style (error is an object).
    const error = body?.error;
    const reason = typeof error === "string"
      ? body.error_description ?? error
      : error?.error_description ?? error?.message ?? "no access token returned";
    throw new Error(`ArcGIS sign-in failed: ${reason}`);
  }
  const after = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
  // ArcGIS does not always rotate the refresh token; when it sends none, the one in use stays valid.
  const rotated: string | undefined = body.refresh_token || undefined;
  return {
    token: body.access_token,
    portal: cfg.portal,
    client_id: cfg.clientId,
    expires_at: after(body.expires_in > 0 ? body.expires_in : 3600),
    refresh_token: rotated ?? previous?.refresh_token,
    refresh_expires_at: rotated
      ? body.refresh_token_expires_in > 0 ? after(body.refresh_token_expires_in) : undefined
      : previous?.refresh_expires_at,
    username: body.username ?? previous?.username,
    login_id: previous ? previous.login_id : randomBytes(16).toString("hex"),
  };
}

/**
 * The signed-in user's access token, refreshed when it is within a minute of
 * expiry. `rejected` names a token the portal just refused, which is then not
 * reused even if its recorded expiry is still ahead.
 */
export async function accessToken(cfg: Config, rejected?: string): Promise<string | undefined> {
  const usable = (session: Session | undefined, skewMs = 0) => {
    const token = unexpired(session, skewMs);
    return token === rejected ? undefined : token;
  };
  const session = readSession(cfg);
  if (!session) return undefined;
  const fresh = usable(session, REFRESH_SKEW_MS);
  if (fresh) return fresh;
  if (!canRefresh(session)) return usable(session);
  const profile = profileOf(cfg);
  if (Date.now() - (profile.refreshFailure?.at ?? 0) < RETRY_COOLDOWN_MS) return usable(session);
  // Parallel requests share one refresh: a rotated refresh token can be spent only once.
  profile.refreshing ??= refresh(cfg, profile, rejected).finally(() => {
    profile.refreshing = undefined;
  });
  // After a failed refresh the file is read again: another process may have renewed the session.
  return (await profile.refreshing) ?? usable(readSession(cfg));
}

/** One refresh across Pi and mappi. A crashed holder's lease expires after two minutes. */
async function refreshLock(cfg: Config): Promise<{ owns: () => boolean; release: () => void }> {
  const lock = `${cfg.sessionFile}.lock`;
  const owner = join(lock, randomBytes(16).toString("hex"));
  mkdirSync(dirname(cfg.sessionFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 35_000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(owner, "", { mode: 0o600 });
      return {
        owns: () => existsSync(owner),
        release: () => {
          // Remove only our marker: a stale holder must not delete a successor's lock.
          try { rmSync(owner); rmdirSync(lock); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      // ENOENT: another worker reclaimed the directory between our mkdir and write; retry.
      if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code!)) throw error;
    }
    try {
      // Reclaim a crashed holder's lease by removing only markers already stale when listed,
      // so a successor's fresh marker survives and rmdir fails (ENOTEMPTY) instead.
      const stale = (path: string) => Date.now() - statSync(path).mtimeMs > 120_000;
      const markers = readdirSync(lock);
      if (markers.length ? markers.every((marker) => stale(join(lock, marker))) : stale(lock)) {
        for (const marker of markers) rmSync(join(lock, marker), { force: true });
        rmdirSync(lock);
        continue;
      }
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code!)) throw error;
    }
    if (Date.now() >= deadline) throw new Error("ArcGIS session refresh is busy; try again shortly.");
    await pause(25);
  }
}

async function refresh(cfg: Config, profile: Profile, rejected?: string): Promise<string | undefined> {
  let lock: Awaited<ReturnType<typeof refreshLock>> | undefined;
  let renewed: Session;
  try {
    lock = await refreshLock(cfg);
    // Another process may have renewed, signed in or signed out while we waited.
    const session = readSession(cfg);
    if (!session) return undefined;
    const fresh = unexpired(session, REFRESH_SKEW_MS);
    if (fresh && fresh !== rejected) return fresh;
    if (!canRefresh(session) || !lock.owns()) return undefined;
    renewed = await tokenGrant(cfg, { grant_type: "refresh_token", refresh_token: session.refresh_token! }, session);
    profile.refreshFailure = undefined;
    // Login/logout wins, including portals that do not rotate refresh tokens.
    const onDisk = readSession(cfg);
    if (!lock.owns() || onDisk?.token !== session.token || onDisk?.refresh_token !== session.refresh_token
      || onDisk?.login_id !== session.login_id) return unexpired(onDisk);
    writeSession(cfg, renewed);
    return renewed.token;
  } catch (error) {
    profile.refreshFailure = { at: Date.now(), message: (error as Error).message };
    return undefined;
  } finally {
    lock?.release();
  }
}

function openBrowser(url: string): void {
  const [command, ...args] = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : ["xdg-open", url];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/**
 * Listen on the first free port of the range registered as OAuth redirect URIs.
 * The redirect names `localhost`, but the socket binds 127.0.0.1: where the
 * name resolves to ::1 first, binding by name would listen on IPv6 only and
 * miss clients that connect over IPv4. Browsers try both addresses.
 */
async function listenForCallback(server: Server): Promise<number> {
  for (let port = 9500; port <= 9600; port++) {
    const bound = await new Promise<boolean>((done, failed) => {
      // Only a taken port means "try the next one"; anything else would fail on every port.
      const refused = (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? done(false) : failed(error));
      server.once("error", refused);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", refused);
        done(true);
      });
    });
    if (bound) return port;
  }
  throw new Error("No free port in 9500-9600 for the ArcGIS sign-in callback.");
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * OAuth 2.0 authorization code flow with PKCE against the portal; stores the
 * session. `say` receives the message for the user, `open` the authorization URL.
 */
export async function login(
  cfg: Config,
  { say = console.error, open = openBrowser }: { say?: (message: string) => void; open?: (url: string) => void } = {},
): Promise<Session> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  const redirectUri = `http://localhost:${await listenForCallback(server)}/callback`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await new Promise<string>((received, failed) => {
      timer = setTimeout(
        () => failed(new Error(`ArcGIS sign-in timed out after ${LOGIN_TIMEOUT_MS / 1000} seconds.`)),
        LOGIN_TIMEOUT_MS,
      );
      server.on("request", (request, response) => {
        const query = new URL(request.url ?? "/", redirectUri).searchParams;
        // Only the redirect this login started carries its state; anything else is ignored.
        if (!request.url?.startsWith("/callback") || query.get("state") !== state) {
          response.writeHead(400).end();
          return;
        }
        const code = query.get("code");
        const problem = query.get("error")
          ? query.get("error_description") || query.get("error")!
          : code ? undefined : "no authorization code received";
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        response.end(`<html><body><h2>${problem ? "Sign-in failed" : "Sign-in successful"}</h2>`
          + `<p>${escapeHtml(problem ?? "")}</p><p>You can close this window.</p></body></html>`);
        if (problem) failed(new Error(`ArcGIS sign-in failed: ${problem}`));
        else received(code!);
      });
      const authorize = `${cfg.portal}/sharing/rest/oauth2/authorize?${new URLSearchParams({
        client_id: cfg.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      })}`;
      say(`ArcGIS OAuth redirect URI: ${redirectUri}\nRegister this exact URL in the OAuth application identified by ARCGIS_CLIENT_ID.`);
      say(`Opening the browser for ArcGIS sign-in. If it does not open, visit:\n  ${authorize}`);
      open(authorize);
    });
    const session = await tokenGrant(cfg, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    writeSession(cfg, session);
    profiles.delete(cfg.sessionFile);
    return session;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

async function portalJson(cfg: Config, path: string, token: string | undefined): Promise<any> {
  const body = new URLSearchParams({ f: "json" });
  if (token) body.set("token", token);
  const response = await fetch(cfg.portal + path, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(10_000) });
  const json: any = await response.json();
  if (json?.error) throw new Error(json.error.message ?? "portal error");
  return json;
}

/** Every "url" and "adminUrl" string in a helperServices document, which nests irregularly. */
function collectUrls(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectUrls);
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "string" ? (key === "url" || key === "adminUrl" ? [value] : []) : collectUrls(value));
}

/**
 * The hosts that may receive the user's token. The URL of a request is written
 * by a model, so without this a mistaken or injected host would be handed a
 * live credential. Trusted are the portal, what the portal names as its own
 * (helper services, federated servers, trusted servers) and operator entries.
 * `complete` says the portal answered a signed-in user, so nothing is missing.
 */
async function discoverTrust(cfg: Config): Promise<{ trust: Trust; complete: boolean }> {
  const portalHost = hostOf(cfg.portal);
  const trust: Trust = { hosts: new Set([portalHost]), suffixes: [] };
  const add = (raw: unknown) => {
    const host = typeof raw === "string" ? hostOf(raw) : "";
    if (host) trust.hosts.add(host);
  };
  // ArcGIS Online keeps an organization's hosted services on sibling hosts
  // (services1.arcgis.com, tiles.arcgis.com) that portals/self does not list.
  if (portalHost === "arcgis.com" || portalHost.endsWith(".arcgis.com")) trust.suffixes.push("arcgis.com");
  for (const entry of cfg.trustedHosts) {
    if (entry.includes("*")) continue;
    if (!entry.startsWith(".")) add(entry);
    // ponytail: no public-suffix list; a suffix needs two labels, so ".com" is refused but ".co.uk" is not.
    else if (hostOf(entry.slice(1)).includes(".")) trust.suffixes.push(hostOf(entry.slice(1)));
  }
  let complete = false;
  try {
    const token = await accessToken(cfg);
    const self = await portalJson(cfg, "/sharing/rest/portals/self", token);
    collectUrls(self.helperServices).forEach(add);
    (self.authorizedCrossOriginDomains ?? []).forEach(add);
    // Federated servers exist only on ArcGIS Enterprise.
    if (self.isPortal && self.id) {
      const federated = await portalJson(cfg, `/sharing/rest/portals/${encodeURIComponent(self.id)}/servers`, token);
      for (const server of federated.servers ?? []) {
        add(server.url);
        add(server.adminUrl);
      }
    }
    complete = !!token;
  } catch {
    // An unreachable portal leaves what was gathered: the token reaches fewer hosts, never more.
  }
  return { trust, complete };
}

function trustFor(cfg: Config): Promise<Trust> {
  const profile = profileOf(cfg);
  if (!profile.trust || (profile.trustRetryAt !== undefined && Date.now() >= profile.trustRetryAt)) {
    profile.trustRetryAt = undefined;
    profile.trust = discoverTrust(cfg).then(({ trust, complete }) => {
      // An answer given without a session, or none at all, is not kept for good:
      // a portal outage, or a login made in another process, must not pin it.
      if (!complete) profile.trustRetryAt = Date.now() + RETRY_COOLDOWN_MS;
      return trust;
    });
  }
  return profile.trust;
}

const allowsToken = (trust: Trust, url: URL): boolean =>
  (url.protocol === "https:" || LOOPBACK.has(url.hostname))
  && (trust.hosts.has(url.hostname)
    || trust.suffixes.some((apex) => url.hostname === apex || url.hostname.endsWith(`.${apex}`)));

/** Internal page-channel payload, never a tool result. The refresh token stays in Node. */
export async function mapAuth(cfg: Config) {
  const token = await accessToken(cfg);
  const trust = token ? await trustFor(cfg) : undefined;
  const session = readSession(cfg);
  const current = token && session?.token === token && unexpired(session) ? session : undefined;
  return {
    portalUrl: cfg.portal,
    token: current?.token ?? null,
    username: current?.username ?? null,
    expires: current ? Date.parse(current.expires_at) : 0,
    hosts: current && trust ? [...trust.hosts] : [],
    suffixes: current && trust ? trust.suffixes : [],
    refusedHosts: current ? [...(profileOf(cfg).tokenRefusedBy ?? [])] : [],
  };
}

/**
 * Call an ArcGIS REST endpoint as the signed-in user. Throws on transport
 * failures and on ArcGIS error bodies, which arrive with HTTP 200.
 */
export async function request(cfg: Config, args: RequestArgs, signal?: AbortSignal): Promise<RequestResult> {
  const method = (args.method ?? "POST").toUpperCase();
  if (method !== "GET" && method !== "POST") throw new Error(`method must be GET or POST, not ${args.method}.`);
  const url = URL.parse(args.url.startsWith("/") ? cfg.portal + args.url : args.url);
  if (!url) throw new Error(`Not a URL: ${args.url}. Use an absolute URL, or a path starting with / for the portal.`);
  if (!isHttp(url)) throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  const fields = new URLSearchParams();
  // Shapes are passed by reference; the real coordinates are filled in here, outside the script.
  for (const [key, value] of Object.entries(resolveReferences(args.params ?? {}, cfg.artifactsDir))) {
    if (value === undefined || value === null) continue;
    fields.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  if (fields.has("token") || url.searchParams.has("token")) {
    throw new Error("Do not pass a token: the signed-in user's token is added for trusted hosts.");
  }
  if (!fields.has("f") && !url.searchParams.has("f")) fields.set("f", "json");
  const savePath = args.save_to ? artifactPath(args.save_to, cfg.artifactsDir) : undefined;

  const limit = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  const profile = profileOf(cfg);
  const trust = await trustFor(cfg);
  const trusted = allowsToken(trust, url);
  const takesToken = (target: URL) => allowsToken(trust, target) && !profile.tokenRefusedBy?.has(target.hostname);
  const where = `${url.host}${url.pathname}`;

  /** The body as text with token strings redacted (decoded only when read), and as JSON when it is JSON. */
  const decode = (body: Buffer, token: string | undefined) => {
    let decoded: string | undefined;
    const text = () => {
      if (decoded === undefined) {
        decoded = body.toString("utf8");
        for (const secret of [token, readSession(cfg)?.refresh_token]) {
          if (secret) decoded = decoded.replaceAll(secret, "[redacted]");
        }
      }
      return decoded;
    };
    let json: any;
    // JSON can have arbitrarily long leading whitespace; binary bodies stay undecoded.
    const leading = body.find((byte) => byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13);
    if (leading === 123 || leading === 91) {
      try {
        json = JSON.parse(text());
      } catch {
        // Not JSON after all: text.
      }
    }
    return { text, json };
  };

  const send = async (token: string | undefined) => {
    let target = url;
    let post = method === "POST";
    let extra: URLSearchParams | undefined = fields;
    // Redirects are followed by hand so every hop gets the checks the first URL gets.
    for (let hop = 0; ; hop++) {
      if (isTokenEndpoint(target)) {
        throw new Error("Token endpoints are not callable: sign-in and refresh are handled outside scripts.");
      }
      if (target.searchParams.has("token")) {
        throw new Error("Do not pass a token: the signed-in user's token is added for trusted hosts.");
      }
      const form = new URLSearchParams(extra);
      if (extra && token && takesToken(target)) form.set("token", token);
      let destination = target;
      if (!post && extra) {
        destination = new URL(target);
        for (const [key, value] of form) destination.searchParams.set(key, value);
      }
      const response = await fetch(destination, {
        method: post ? "POST" : "GET",
        body: post ? form : undefined,
        redirect: "manual",
        signal: limit,
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) {
        const body = Buffer.from(await response.arrayBuffer());
        return { response, body, ...decode(body, token) };
      }
      if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects from ${where}.`);
      await response.body?.cancel();
      target = new URL(location, target);
      if (!isHttp(target)) throw new Error(`Redirect to ${target.protocol} refused.`);
      // 307/308 repeat a POST; any other redirect becomes a plain GET of Location, as in browsers.
      if (!post || (response.status !== 307 && response.status !== 308)) {
        post = false;
        extra = undefined;
      }
    }
  };

  let token = await accessToken(cfg);
  let reply = await send(token);
  // 498: the host refused the token although it had not expired here (revoked, or renewed elsewhere).
  if (token && takesToken(url) && reply.json?.error?.code === 498) {
    const renewed = await accessToken(cfg, token);
    if (renewed) {
      reply = await send((token = renewed));
      // A token issued a moment ago is valid, so it is the host that takes none: some services a
      // portal lists as its own (the public geometry service) reject every token. Such a host is
      // remembered only once it has answered an anonymous call, and the portal itself never is:
      // without a token it would answer with public content only, which looks like a result.
      if (reply.json?.error?.code === 498 && url.hostname !== hostOf(cfg.portal)) {
        const anonymous = await send(undefined);
        if (anonymous.response.ok && !anonymous.json?.error) {
          (profile.tokenRefusedBy ??= new Set()).add(url.hostname);
          reply = anonymous;
        }
      }
    }
  }
  const { response, body, text, json } = reply;

  const withheld = !token ? undefined
    : !trusted
      ? `The token was not sent: ${url.hostname} is not a trusted host of ${cfg.portal}. `
        + "If it belongs to this portal, add it to ARCGIS_TRUSTED_TOKEN_HOSTS and restart."
    : !takesToken(url)
      ? `The token was not sent: ${url.hostname} refuses this portal's tokens, so the request was anonymous.`
    : undefined;
  const signIn = token ? undefined : "Not signed in: ask the user to run ./arcpi login (or /arcgis-login).";
  /** What to do about an authentication failure, appended to its message. */
  const advice = (code: unknown) => {
    const hint = [401, 403, 498, 499].includes(code as number) ? withheld ?? signIn : undefined;
    return hint ? ` ${hint}` : "";
  };
  const error = json?.error;
  if (error) {
    // Either ArcGIS style (an object) or OAuth style (a string beside error_description).
    const { code, message, details } = typeof error === "object"
      ? { ...error, message: error.message ?? error.error_description }
      : { code: response.status, message: json.error_description ?? error, details: undefined };
    const more = Array.isArray(details) ? details.filter(Boolean).join("; ") : "";
    throw new Error(`ArcGIS error ${code} from ${where}: ${message ?? "no message"}${more ? ` (${more})` : ""}${advice(code)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${where}: ${text().slice(0, 300)}${advice(response.status)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const textual = json !== undefined || /^text\/|json|xml|javascript|csv/i.test(contentType);
  if (savePath) {
    artifactPath(savePath, cfg.artifactsDir);
    mkdirSync(dirname(savePath), { recursive: true });
    const content = textual ? Buffer.from(text()) : body;
    writeFileSync(savePath, content);
    const features = Array.isArray(json?.features) ? json.features.length : undefined;
    const paging = json?.exceededTransferLimit ?? json?.properties?.exceededTransferLimit;
    return {
      status: response.status,
      saved: {
        path: savePath, bytes: content.length, content_type: contentType, features,
        ...(typeof paging === "boolean" ? { exceededTransferLimit: paging } : {}),
      },
      note: withheld,
    };
  }
  // An item without data, for example, answers 200 with no body at all.
  if (body.length === 0) return { status: response.status, data: null, note: withheld };
  if (!textual) {
    throw new Error(`The response from ${where} is ${contentType || "binary"} (${body.length} bytes): `
      + `pass save_to: "${basename(cfg.artifactsDir)}/<name>" to keep it.`);
  }
  if (json === undefined) return { status: response.status, data: text(), note: withheld };
  // Shapes stay on disk: the caller gets references, never coordinates. The geometry service
  // answers bare shapes without saying their spatial reference: it is the one that was asked for.
  const asked = fields.get("outSR") ?? fields.get("sr");
  const askedSr = asked && /^\d+$/.test(asked) ? { wkid: Number(asked) } : undefined;
  const { data, files } = externalize(json, cfg.artifactsDir, askedSr);
  return { status: response.status, data, geometry_files: files.length ? files : undefined, note: withheld };
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const command = process.argv[2];
  if (command === "login") {
    console.log(signedInAs(await login(cfg)));
  } else if (command === "logout") {
    logout(cfg);
    console.log("Signed out.");
  } else if (command === "status") {
    console.log(JSON.stringify(status(cfg), null, 2));
  } else {
    console.error("usage: arcgis.ts login|logout|status");
    process.exit(2);
  }
}

if (import.meta.main) {
  main().then(() => process.exit(0), (error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}

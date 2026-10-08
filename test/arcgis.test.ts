import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { text } from 'node:stream/consumers';
import { promisify } from 'node:util';
import { after, before, beforeEach, test } from 'node:test';
import { accessToken, configFromEnv, login, logout, mapAuth, readSession, request, status } from '../arcgis-rest/dev.pi/extensions/arcgis/arcgis.ts';
import type { Config, Session } from '../arcgis-rest/dev.pi/extensions/arcgis/arcgis.ts';
import { pluginMcpServers } from '../arcgis-rest/dev.pi/extensions/arcgis/mcp.ts';

const plugin = join(import.meta.dirname, '../arcgis-rest');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'arcgis-rest-')));

// What the fake portal currently accepts and what it has seen; reset before every case.
const untouched = () => ({
  validToken: '', refreshToken: '', refreshes: 0, refreshAttempts: 0, rotate: true, requireValid: false,
  refreshDelay: 0,
  challenge: '', self: {} as Record<string, unknown>, redirectGrant: false, redirectTrust: false, failServers: false,
  seen: [] as { server: string; path: string; method: string; token: string | null; fields: Record<string, string> }[],
});
const portal = untouched();
// A clockwise outline with a counter-clockwise hole, and a second outline: how Esri lists rings.
const outline = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
const island = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]];
const shapes: Record<string, unknown> = {
  '/rest/polygons': {
    geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
    features: [
      { attributes: { NAME: 'A' }, geometry: { rings: [outline, hole] } },
      { attributes: { NAME: 'B' }, geometry: { rings: [island] } },
      { attributes: { NAME: 'C' }, geometry: null },
    ],
  },
  '/rest/route': {
    routes: { spatialReference: { wkid: 102100, latestWkid: 3857 }, features: [{ attributes: { Total_Miles: 1 }, geometry: { paths: [[[0, 0], [1000, 1000]]] } }] },
    directions: [{ features: [{ attributes: { text: 'Go' }, compressedGeometry: '+1m91-66os8+1poms' }] }],
    stops: { features: [{ attributes: { Name: 'Depot' }, geometry: { x: 1, y: 2 } }] },
  },
  // GeoJSON winds the other way: outline counter-clockwise.
  '/rest/collection': { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { NAME: 'G' }, geometry: { type: 'Polygon', coordinates: [[...outline].reverse()] } }] },
  '/rest/shapes': { geometries: [{ rings: [outline] }, { rings: [island] }] },
  '/rest/union': { geometryType: 'esriGeometryPolygon', geometry: { rings: [island], spatialReference: { wkid: 4326 } } },
  '/rest/curves': { features: [{ geometry: { curveRings: [[[0, 0], { c: [[1, 1], [0, 1]] }]] } }] },
};
let portalUrl = '';
let otherUrl = '';
const servers: Server[] = [];

const formOf = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const form = new URLSearchParams(await text(request));
  for (const [key, value] of new URL(request.url!, 'http://x').searchParams) form.set(key, value);
  return form;
};

// Both servers bind 127.0.0.1; `host` is only the name their URL is given.
const serve = (name: string, host: string) => new Promise<string>((listening) => {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://x').pathname;
    const form = await formOf(request);
    const json = (value: unknown) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (path === '/sharing/rest/oauth2/authorize') {
      portal.challenge = form.get('code_challenge')!;
      const back = new URL(form.get('redirect_uri')!);
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', form.get('state')!);
      return response.writeHead(302, { Location: back.href }).end();
    }
    if (path === '/sharing/rest/oauth2/token') {
      if (portal.redirectGrant) return response.writeHead(307, { Location: `${otherUrl}/rest/echo` }).end();
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (form.get('code') !== 'the-code' || challenge !== portal.challenge) return json({ error: { code: 400, error: 'invalid_grant', error_description: 'bad code or verifier' } });
        portal.validToken = 'access-0';
        portal.refreshToken = 'refresh-0';
        return json({ access_token: 'access-0', expires_in: 1800, refresh_token: 'refresh-0', refresh_token_expires_in: 1209600, username: 'tester' });
      }
      portal.refreshAttempts++;
      if (portal.refreshDelay) await new Promise(resolve => setTimeout(resolve, portal.refreshDelay));
      if (form.get('refresh_token') !== portal.refreshToken) return json({ error: { code: 400, error: 'invalid_grant', error_description: 'Invalid refresh_token' } });
      portal.refreshes++;
      portal.validToken = `access-${portal.refreshes}`;
      if (portal.rotate) portal.refreshToken = `refresh-${portal.refreshes}`;
      return json({ access_token: portal.validToken, expires_in: 1800, ...(portal.rotate ? { refresh_token: portal.refreshToken, refresh_token_expires_in: 1209600 } : {}) });
    }
    if (path === '/sharing/rest/portals/self') {
      if (portal.redirectTrust) return response.writeHead(307, { Location: `${otherUrl}/rest/echo` }).end();
      return json(form.get('token') ? portal.self : {});
    }
    if (path === '/sharing/rest/portals/org/servers') return json(portal.failServers
      ? { error: { code: 503, message: 'Unavailable' } }
      : { servers: [{ url: `${otherUrl}/rest` }] });
    const token = form.get('token');
    form.delete('token');
    portal.seen.push({ server: name, path, method: request.method!, token, fields: Object.fromEntries(form) });
    if (path === '/rest/redirect') return response.writeHead(307, { Location: `${otherUrl}/rest/echo` }).end();
    if (path === '/rest/to-token') return response.writeHead(307, { Location: `${portalUrl}/sharing/rest/generateToken` }).end();
    if (path === '/rest/token-param') return response.writeHead(307, { Location: `${otherUrl}/rest/echo?token=injected` }).end();
    if (path === '/rest/moved') return response.writeHead(302, { Location: `${otherUrl}/rest/echo?f=json` }).end();
    if (path === '/rest/failure') return json({ error: { code: 400, message: 'Invalid query', details: ['where is malformed'] } });
    if (path === '/rest/report') return response.writeHead(200, { 'Content-Type': 'application/pdf' }).end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff]));
    if (path === '/rest/leak') return json({ echoed: token });
    if (path === '/rest/empty') return response.writeHead(200).end();
    if (path === '/rest/padded') return response.writeHead(200, { 'Content-Type': 'application/json' }).end(' '.repeat(100) + JSON.stringify(shapes['/rest/polygons']));
    if (path === '/rest/large') return json({ rows: 'x'.repeat(500_000) });
    if (path === '/rest/page') return json({ features: [{ attributes: { id: 1 } }], exceededTransferLimit: true });
    if (path === '/rest/geo-page') return json({ type: 'FeatureCollection', features: [], properties: { exceededTransferLimit: form.get('more') === 'true' } });
    if (shapes[path]) return json(shapes[path]);
    // A public utility service: it answers anonymous callers and rejects every token.
    if (path === '/rest/public') return json(token ? { error: { code: 498, message: 'Invalid Token' } } : { areas: [1] });
    // Refuses our tokens but is not public either.
    if (path === '/rest/foreign') return json({ error: token ? { code: 498, message: 'Invalid Token' } : { code: 499, message: 'Token Required' } });
    if (portal.requireValid && token !== portal.validToken) return json({ error: { code: 498, message: 'Invalid token.' } });
    return json({ ok: true, features: [{ attributes: { id: 1 } }] });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1', () => listening(`http://${host}:${(server.address() as AddressInfo).port}`));
});

before(async () => {
  portalUrl = await serve('portal', '127.0.0.1');
  otherUrl = await serve('other', 'localhost'); // a different hostname, so not the portal's host
});
after(() => {
  for (const server of servers) server.close();
  rmSync(temporary, { recursive: true, force: true });
});
beforeEach(() => Object.assign(portal, untouched()));

let cases = 0;
// Every case gets its own project directory, and with it its own session file and caches.
const project = (env: Record<string, string> = {}): Config => {
  const cwd = join(temporary, `case-${cases++}`);
  mkdirSync(cwd);
  return configFromEnv({ ARCGIS_PORTAL_URL: `${portalUrl}/`, ARCGIS_CLIENT_ID: 'client', ...env }, cwd);
};
// A file's path as its references spell it: relative to the project.
const shown = (cfg: Config, path: string) => relative(dirname(cfg.artifactsDir), path);
const signedIn = (cfg: Config, changes: Partial<Session> = {}): Session => {
  const session: Session = {
    token: 'access-0', portal: cfg.portal, client_id: cfg.clientId, username: 'tester',
    expires_at: new Date(Date.now() + 1800_000).toISOString(),
    refresh_token: 'refresh-0', refresh_expires_at: new Date(Date.now() + 86400_000).toISOString(), ...changes,
  };
  mkdirSync(dirname(cfg.sessionFile), { recursive: true });
  writeFileSync(cfg.sessionFile, JSON.stringify(session));
  Object.assign(portal, { validToken: session.token, refreshToken: session.refresh_token });
  return session;
};
const expired = { expires_at: new Date(Date.now() - 1000).toISOString() };

test('login exchanges a PKCE code and stores an owner-only session', async () => {
  const cfg = project();
  assert.equal(cfg.portal, portalUrl, 'trailing slash is dropped');
  assert.equal(status(cfg).signed_in, false);
  let forged = 0;
  let callbackUrl = '';
  const said: string[] = [];
  const session = await login(cfg, {
    say: (message) => said.push(message),
    open: (url) => void (async () => {
      const callback = new URL(url).searchParams.get('redirect_uri');
      callbackUrl = callback!;
      forged = (await fetch(`${callback}?code=stolen&state=guessed`)).status;
      await (await fetch(url)).text();
    })(),
  });
  assert.match(session.login_id!, /^[a-f0-9]{32}$/);
  assert.equal(forged, 400, 'a callback without this login\'s state is refused');
  assert.ok(said[0].includes(`ArcGIS OAuth redirect URI: ${callbackUrl}`), 'the exact callback is readable without decoding the authorization URL');
  assert.match(said[0], /Register this exact URL/);
  assert.match(said.join(), /visit:\n {2}http:\/\/127\.0\.0\.1:\d+\/sharing\/rest\/oauth2\/authorize\?/, 'the user is told the URL to open');
  assert.equal(session.token, 'access-0');
  assert.deepEqual(readSession(cfg), session);
  assert.equal(statSync(cfg.sessionFile).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(cfg.sessionFile)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dirname(cfg.sessionFile)), ['session.json'], 'no temporary file is left');
  const state = status(cfg);
  assert.deepEqual([state.signed_in, state.username, state.refreshable], [true, 'tester', true]);
  assert.ok(!JSON.stringify(state).includes('access-0') && !JSON.stringify(state).includes('refresh-0'), 'status never carries tokens');
  assert.notEqual(project({ ARCGIS_CLIENT_ID: 'other' }).sessionFile, cfg.sessionFile, 'another client is another profile');
  logout(cfg);
  assert.equal(readSession(cfg), undefined);
});

test('login rejects a callback that the portal reports as failed', async () => {
  const cfg = project();
  const denied = (url: string) => {
    const authorize = new URL(url);
    void fetch(`${authorize.searchParams.get('redirect_uri')}?error=access_denied&error_description=<b>no</b>&state=${authorize.searchParams.get('state')}`)
      .then(async (response) => assert.ok(!(await response.text()).includes('<b>'), 'the callback page escapes portal text'));
  };
  await assert.rejects(login(cfg, { say: () => {}, open: denied }), /<b>no<\/b>/);
  assert.equal(readSession(cfg), undefined);
});

test('requests carry the token, REST parameters and f=json to the portal', async () => {
  const cfg = project();
  signedIn(cfg);
  const result = await request(cfg, { url: '/rest/echo', params: { where: '1=1', returnGeometry: false, geometry: { x: 1, y: 2 }, skipped: undefined } });
  assert.deepEqual(result, { status: 200, data: { ok: true, features: [{ attributes: { id: 1 } }] }, geometry_files: undefined, note: undefined });
  assert.deepEqual(portal.seen, [{
    server: 'portal', path: '/rest/echo', method: 'POST', token: 'access-0',
    fields: { where: '1=1', returnGeometry: 'false', geometry: '{"x":1,"y":2}', f: 'json' },
  }]);
  await request(cfg, { url: `${portalUrl}/rest/echo?f=pjson`, method: 'get', params: { num: 5 } });
  assert.deepEqual(portal.seen[1], { server: 'portal', path: '/rest/echo', method: 'GET', token: 'access-0', fields: { f: 'pjson', num: '5' } });
  await assert.rejects(request(cfg, { url: '/rest/echo', params: { token: 'mine' } }), /Do not pass a token/);
  await assert.rejects(request(cfg, { url: '/rest/echo?token=mine' }), /Do not pass a token/);
  await assert.rejects(request(cfg, { url: '/sharing/rest/oauth2/token' }), /Token endpoints/);
  await assert.rejects(request(cfg, { url: '/sharing/rest/generateToken' }), /Token endpoints/);
  await assert.rejects(request(cfg, { url: '/sharing/rest/generate%54oken' }), /Token endpoints/);
  await assert.rejects(request(cfg, { url: '/sharing/rest/generateToken;x' }), /Token endpoints/);
  await assert.rejects(request(cfg, { url: '/rest/echo', method: 'DELETE' }), /GET or POST/);
  await assert.rejects(request(cfg, { url: 'file:///etc/passwd' }), /Unsupported URL scheme/);
  assert.equal(portal.seen.length, 2, 'refused requests are never sent');
  await assert.rejects(request(cfg, { url: '/rest/to-token' }), /Token endpoints/);
  assert.deepEqual(portal.seen.slice(2).map((call) => call.path), ['/rest/to-token'], 'a redirect to a token endpoint is not followed');
  await assert.rejects(request(cfg, { url: '/rest/token-param' }), /Do not pass a token/);
  assert.equal(portal.seen.at(-1)!.path, '/rest/token-param', 'a token in a redirect URL is refused');
});

test('internal OAuth and trust requests never forward credentials through redirects', async () => {
  const cfg = project();
  signedIn(cfg, expired);
  portal.redirectGrant = true;
  assert.equal(await accessToken(cfg), undefined);
  assert.equal(portal.seen.length, 0, 'the refresh token is never sent to the redirect target');
  portal.redirectGrant = false;
  signedIn(cfg);
  portal.redirectTrust = true;
  await request(cfg, { url: `${otherUrl}/rest/echo` });
  assert.deepEqual(portal.seen.map((call) => [call.server, call.token]), [['other', null]], 'trust discovery does not forward the access token');
});

test('failed federated server discovery is retried after the cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cfg = project();
  signedIn(cfg);
  portal.self = { isPortal: true, id: 'org' };
  portal.failServers = true;
  assert.match((await request(cfg, { url: `${otherUrl}/rest/echo` })).note!, /not a trusted host/);
  portal.failServers = false;
  t.mock.timers.tick(31_000);
  assert.equal((await request(cfg, { url: `${otherUrl}/rest/echo` })).note, undefined);
  assert.deepEqual(portal.seen.map((call) => call.token), [null, 'access-0']);
});

test('an expired token is refreshed once for parallel requests and the rotation is stored', async () => {
  const cfg = project();
  signedIn(cfg, expired);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => accessToken(cfg))), Array(5).fill('access-1'));
  assert.deepEqual([portal.refreshAttempts, portal.refreshes], [1, 1], 'the refresh token is spent exactly once');
  await Promise.all(Array.from({ length: 5 }, () => request(cfg, { url: '/rest/echo' })));
  assert.deepEqual(portal.seen.map((call) => call.token), Array(5).fill('access-1'));
  const stored = readSession(cfg)!;
  assert.deepEqual([stored.token, stored.refresh_token, stored.username], ['access-1', 'refresh-1', 'tester']);
  assert.ok(Date.parse(stored.expires_at) > Date.now() + 60_000);
  assert.equal(statSync(cfg.sessionFile).mode & 0o777, 0o600);
  await request(cfg, { url: '/rest/echo' });
  assert.equal(portal.refreshes, 1, 'a fresh token is not refreshed again');
});

test('a refresh token that the portal does not rotate is kept', async () => {
  const cfg = project();
  const session = signedIn(cfg, expired);
  portal.rotate = false;
  assert.equal(await accessToken(cfg), 'access-1');
  const stored = readSession(cfg)!;
  assert.deepEqual([stored.refresh_token, stored.refresh_expires_at], [session.refresh_token, session.refresh_expires_at]);
});

test('independent Pi and mappi processes share one refresh, including unrotated refresh tokens', async () => {
  const moduleUrl = new URL('../arcgis-rest/dev.pi/extensions/arcgis/arcgis.ts', import.meta.url).href;
  const code = `import { accessToken } from ${JSON.stringify(moduleUrl)};
    const token = await accessToken(JSON.parse(process.argv[1]));
    if (token !== 'access-1') process.exitCode = 1;`;
  for (const rotate of [true, false]) {
    const cfg = project();
    signedIn(cfg, expired);
    Object.assign(portal, { rotate, refreshDelay: 100, refreshes: 0, refreshAttempts: 0 });
    await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', code, JSON.stringify(cfg)])));
    assert.equal(portal.refreshAttempts, 1);
    assert.equal(readSession(cfg)!.token, 'access-1');
    assert.deepEqual(readdirSync(dirname(cfg.sessionFile)), ['session.json'], 'the refresh lock is released');
  }
});

test('a crashed refresh holder leaves a recoverable lease', async () => {
  const cfg = project();
  signedIn(cfg, expired);
  const lock = `${cfg.sessionFile}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, 'dead-worker'), '');
  const old = new Date(Date.now() - 121_000);
  for (const path of [join(lock, 'dead-worker'), lock]) utimesSync(path, old, old);
  assert.equal(await accessToken(cfg), 'access-1');
  assert.ok(!existsSync(lock));
});

test('reclaiming a stale lease never removes a successor holder', async () => {
  const cfg = project();
  signedIn(cfg, expired);
  // What a second waiter sees when the first already reclaimed the stale lease and holds it.
  const lock = `${cfg.sessionFile}.lock`;
  const successor = join(lock, 'successor');
  mkdirSync(lock);
  writeFileSync(successor, '');
  const old = new Date(Date.now() - 121_000);
  utimesSync(lock, old, old);
  const waiting = accessToken(cfg);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(existsSync(successor), 'a fresh marker is kept while its holder works');
  rmSync(successor);
  rmSync(lock, { recursive: true });
  assert.equal(await waiting, 'access-1');
});

test('a login or logout during a refresh is not overwritten by it', async () => {
  const cfg = project();
  const session = signedIn(cfg, expired);
  const refreshing = accessToken(cfg); // the grant is now in flight
  const newer = { ...session, token: 'newer-login', refresh_token: 'newer-refresh', expires_at: new Date(Date.now() + 1800_000).toISOString() };
  writeFileSync(cfg.sessionFile, JSON.stringify(newer));
  assert.equal(await refreshing, 'newer-login');
  assert.deepEqual(readSession(cfg), newer);

  const gone = project();
  signedIn(gone, expired);
  const afterLogout = accessToken(gone);
  logout(gone);
  assert.equal(await afterLogout, undefined);
  assert.equal(readSession(gone), undefined, 'a refresh must not sign the user back in');
});

test('a failed refresh leaves the request anonymous and says how to sign in', async () => {
  const cfg = project();
  signedIn(cfg, expired);
  portal.refreshToken = 'revoked';
  portal.requireValid = true;
  await assert.rejects(request(cfg, { url: '/rest/echo' }), /ArcGIS error 498 .*Not signed in: ask the user to run \.\/arcpi login/);
  assert.equal(portal.seen[0].token, null);
  assert.match(status(cfg).refresh_error!, /Invalid refresh_token/);
  assert.equal(readSession(cfg)!.token, 'access-0', 'the stored session is left for a later login to replace');
  logout(cfg);
  assert.equal(status(cfg).refresh_error, undefined, 'signing out forgets the failure');
});

test('a token the portal refuses is refreshed and the request retried once', async () => {
  const cfg = project();
  signedIn(cfg);
  portal.validToken = 'something-else'; // revoked on the portal while unexpired here
  portal.requireValid = true;
  assert.equal((await request(cfg, { url: '/rest/echo' })).status, 200);
  assert.deepEqual(portal.seen.map((call) => call.token), ['access-0', 'access-1']);
  assert.equal(portal.refreshes, 1);
});

test('the token only reaches hosts the portal vouches for', async () => {
  const cfg = project();
  signedIn(cfg);
  const anonymous = await request(cfg, { url: `${otherUrl}/rest/echo` });
  assert.match(anonymous.note!, /token was not sent: localhost is not a trusted host/);
  await request(cfg, { url: '/rest/redirect' });
  assert.deepEqual(portal.seen.map((call) => [call.server, call.token]), [['other', null], ['portal', 'access-0'], ['other', null]],
    'a redirect to another host does not carry the token');
  assert.equal(portal.seen[2].fields.f, 'json', 'a 307 repeats the request body');
  await request(cfg, { url: '/rest/moved', params: { where: '1=1' } });
  assert.deepEqual(portal.seen.at(-1), { server: 'other', path: '/rest/echo', method: 'GET', token: null, fields: { f: 'json' } },
    'any other redirect becomes a GET of its Location, without the form');

  const listed = project();
  signedIn(listed);
  portal.self = { isPortal: false, helperServices: { geocode: [{ url: `${otherUrl}/arcgis/rest/services/World/GeocodeServer` }] } };
  assert.equal((await request(listed, { url: `${otherUrl}/rest/echo` })).note, undefined);
  assert.equal(portal.seen.at(-1)!.token, 'access-0', 'a helper service host named by the portal is trusted');

  const operator = project({ ARCGIS_TRUSTED_TOKEN_HOSTS: 'elsewhere.example.com, localhost' });
  signedIn(operator);
  portal.self = {};
  await request(operator, { url: `${otherUrl}/rest/echo` });
  assert.equal(portal.seen.at(-1)!.token, 'access-0', 'an operator entry is trusted');
});

test('a trusted host that refuses every token is called without one', async () => {
  const cfg = project();
  signedIn(cfg);
  portal.self = { isPortal: false, helperServices: { geometry: { url: `${otherUrl}/arcgis/rest/services/Geometry/GeometryServer` } } };
  const first = await request(cfg, { url: `${otherUrl}/rest/public` });
  assert.deepEqual(first.data, { areas: [1] });
  assert.match(first.note!, /token was not sent: localhost refuses this portal's tokens/);
  assert.deepEqual(portal.seen.map((call) => call.token), ['access-0', 'access-1', null], 'a renewed token is tried before going without');
  assert.equal((await request(cfg, { url: `${otherUrl}/rest/public` })).note, first.note);
  assert.deepEqual(portal.seen.map((call) => call.token).slice(3), [null], 'the host is remembered');
  assert.equal(portal.refreshAttempts, 1, 'and costs no further refresh');
  await request(cfg, { url: '/rest/echo' });
  assert.equal(portal.seen.at(-1)!.token, 'access-1', 'other hosts still get the token');

  // Nothing is concluded from a host that did not answer the anonymous call either,
  // and the portal is never called anonymously on the user's behalf.
  const strict = project();
  signedIn(strict);
  portal.seen.length = 0;
  await assert.rejects(request(strict, { url: `${otherUrl}/rest/foreign` }), /ArcGIS error 498 .*Invalid Token$/);
  await assert.rejects(request(strict, { url: `${otherUrl}/rest/foreign` }), /ArcGIS error 498/);
  assert.equal(portal.seen.at(-1)!.token, null, 'the anonymous attempt is the last resort each time');
  assert.ok(portal.seen.slice(3).some((call) => call.token), 'the host keeps getting the token first');
  portal.seen.length = 0;
  await assert.rejects(request(strict, { url: '/rest/public' }), /ArcGIS error 498/);
  assert.ok(portal.seen.every((call) => call.token), 'the portal host gets no anonymous retry');
});

test('trust learned before signing in is asked for again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cfg = project();
  portal.self = { isPortal: false, helperServices: { geocode: [{ url: `${otherUrl}/arcgis/rest/services/World/GeocodeServer` }] } };
  await request(cfg, { url: `${otherUrl}/rest/echo` }); // anonymous: the portal names no helper hosts
  signedIn(cfg); // as `./arcpi login` in another shell would
  assert.match((await request(cfg, { url: `${otherUrl}/rest/echo` })).note!, /token was not sent/, 'not asked again at once');
  t.mock.timers.tick(31_000);
  assert.equal((await request(cfg, { url: `${otherUrl}/rest/echo` })).note, undefined);
  assert.deepEqual(portal.seen.map((call) => call.token), [null, null, 'access-0']);
});

test('a login from another process invalidates the map trust and token-refusal cache', async () => {
  const cfg = project();
  signedIn(cfg, { login_id: 'first-login' });
  portal.self = { helperServices: { geometry: { url: `${otherUrl}/rest/public` } } };
  await request(cfg, { url: `${otherUrl}/rest/public` });
  const before = await mapAuth(cfg);
  assert.ok(before.hosts.includes('localhost'));
  assert.ok(before.refusedHosts.includes('localhost'));
  signedIn(cfg, { token: 'new-login-token', login_id: 'second-login' });
  portal.self = {};
  const after = await mapAuth(cfg);
  assert.equal(after.token, 'new-login-token');
  assert.ok(!after.hosts.includes('localhost'));
  assert.deepEqual(after.refusedHosts, []);
});

test('shapes come back as references to files and go out again by reference', async () => {
  const cfg = project();
  signedIn(cfg);
  const result = await request(cfg, { url: '/rest/polygons' });
  const [a, b, c] = (result.data as any).features;
  assert.ok(!/rings|coordinates|\[0,10\]/.test(JSON.stringify(result)), 'no coordinates reach the caller');
  const [stored] = result.geometry_files!;
  const reference = shown(cfg, stored.path);
  assert.match(reference, /^artifacts\/geometry\/[0-9a-f]{16}\.geojson$/);
  assert.deepEqual([stored.features, stored.wkid], [3, 4326]);
  assert.deepEqual(a, { attributes: { NAME: 'A' }, geometry: { $geometry: `${reference}#0`, type: 'esriGeometryPolygon', vertices: 10, bbox: [0, 0, 10, 10] } });
  assert.deepEqual([b.geometry.$geometry, b.geometry.bbox, c.geometry], [`${reference}#1`, [20, 0, 25, 5], null]);
  const onDisk = JSON.parse(readFileSync(stored.path, 'utf8'));
  assert.deepEqual([onDisk.type, onDisk.crs], ['FeatureCollection', undefined], 'WGS84 needs no crs member');
  assert.deepEqual(onDisk.features.map((feature: any) => [feature.properties.NAME, feature.geometry?.type, feature.geometry?.coordinates.length]),
    [['A', 'Polygon', 2], ['B', 'Polygon', 1], ['C', undefined, undefined]], 'the hole stays with its outline, attributes come along');
  assert.deepEqual((await request(cfg, { url: '/rest/polygons' })).geometry_files, result.geometry_files, 'the same answer lands in the same file');

  const sent = async (params: Record<string, unknown>, field: string) => {
    await request(cfg, { url: '/rest/echo', params });
    return JSON.parse(portal.seen.at(-1)!.fields[field]);
  };
  assert.deepEqual(await sent({ geometry: a.geometry, geometryType: a.geometry.type }, 'geometry'),
    { rings: [outline, hole], spatialReference: { wkid: 4326 } }, 'a reference is sent as the shape it names');
  assert.deepEqual(await sent({ geometry: { $geometry: [a.geometry.$geometry, b.geometry.$geometry] } }, 'geometry'),
    { rings: [outline, hole, island], spatialReference: { wkid: 4326 } }, 'a list of references is one multipart shape');
  assert.deepEqual(await sent({ polygons: [{ $geometry: stored.path }], sr: 4326 }, 'polygons'),
    [{ rings: [outline, hole, island], spatialReference: { wkid: 4326 } }], 'a file reference, here by its absolute path, means all its shapes, wherever it sits in the parameters');

  const odd = join(temporary, 'project #1');
  mkdirSync(odd);
  const oddCfg = configFromEnv({ ARCGIS_PORTAL_URL: `${portalUrl}/`, ARCGIS_CLIENT_ID: 'client' }, odd);
  signedIn(oddCfg);
  const [there] = (await request(oddCfg, { url: '/rest/polygons' })).geometry_files!;
  await request(oddCfg, { url: '/rest/echo', params: { geometry: { $geometry: `${there.path}#1` } } });
  assert.deepEqual(JSON.parse(portal.seen.at(-1)!.fields.geometry).rings, [island], 'only a trailing #<n> is the feature index: the path may contain #');
});

test('lines, other spatial references, GeoJSON and bare shapes are stored too', async () => {
  const cfg = project();
  signedIn(cfg);
  const route = await request(cfg, { url: '/rest/route' });
  const data = route.data as any;
  const line = data.routes.features[0].geometry;
  assert.deepEqual([line.type, line.vertices, line.bbox], ['esriGeometryPolyline', 2, [0, 0, 1000, 1000]]);
  assert.deepEqual(data.stops.features[0].geometry, { x: 1, y: 2 }, 'a single point stays inline');
  assert.deepEqual(data.directions[0].features[0], { attributes: { text: 'Go' } }, 'an encoded polyline is dropped');
  assert.deepEqual(route.geometry_files!.map((each) => each.wkid), [3857]);
  const routeFile = JSON.parse(readFileSync(route.geometry_files![0].path, 'utf8'));
  assert.deepEqual([routeFile.crs.properties.name, routeFile.features[0].geometry.type], ['EPSG:3857', 'LineString']);
  await request(cfg, { url: '/rest/echo', params: { geometry: line } });
  assert.deepEqual(JSON.parse(portal.seen.at(-1)!.fields.geometry),
    { paths: [[[0, 0], [1000, 1000]]], spatialReference: { wkid: 102100, latestWkid: 3857 } }, 'the shape goes back out in the spatial reference it came in');

  const collection = await request(cfg, { url: '/rest/collection', params: { f: 'geojson' } });
  const polygon = (collection.data as any).features[0];
  assert.deepEqual([polygon.properties, polygon.geometry.type, polygon.geometry.vertices], [{ NAME: 'G' }, 'esriGeometryPolygon', 5]);
  assert.equal(collection.geometry_files![0].wkid, 4326, 'GeoJSON without a crs member is WGS84');
  await request(cfg, { url: '/rest/echo', params: { geometry: polygon.geometry } });
  assert.deepEqual(JSON.parse(portal.seen.at(-1)!.fields.geometry), { rings: [outline], spatialReference: { wkid: 4326 } }, 'GeoJSON rings are turned clockwise for Esri');

  const bare = await request(cfg, { url: '/rest/shapes' });
  const [file] = bare.geometry_files!;
  assert.deepEqual((bare.data as any).geometries.map((each: any) => each.$geometry), [`${shown(cfg, file.path)}#0`, `${shown(cfg, file.path)}#1`]);
  assert.deepEqual([file.features, file.wkid], [2, undefined], 'a bare list of shapes is one file');
  const projected = await request(cfg, { url: '/rest/shapes', params: { inSR: 4326, outSR: 3857 } });
  assert.equal(projected.geometry_files![0].wkid, 3857, 'bare shapes are in the spatial reference that was asked for');
  await request(cfg, { url: '/rest/echo', params: { geometry: (projected.data as any).geometries[0] } });
  assert.deepEqual(JSON.parse(portal.seen.at(-1)!.fields.geometry).spatialReference, { wkid: 3857 });
  const union = await request(cfg, { url: '/rest/union' });
  assert.deepEqual([(union.data as any).geometry.vertices, union.geometry_files![0].wkid], [5, 4326], 'a shape on its own is stored as well');
  await assert.rejects(request(cfg, { url: '/rest/curves' }), /true curves/);
  const padded = await request(cfg, { url: '/rest/padded' });
  assert.equal((padded.data as any).features[0].geometry.type, 'esriGeometryPolygon', 'JSON after long whitespace is still externalized');
  assert.ok(!JSON.stringify(padded).includes('rings'), 'whitespace cannot bypass geometry externalization');
});

test('artifact reads and writes refuse symlinks, including the artifacts root', async () => {
  const cfg = project();
  const polygons = await request(cfg, { url: '/rest/polygons' });
  const outside = join(temporary, 'outside.geojson');
  const original = readFileSync(polygons.geometry_files![0].path, 'utf8');
  writeFileSync(outside, original);
  symlinkSync(outside, join(cfg.artifactsDir, 'linked.geojson'));
  symlinkSync(temporary, join(cfg.artifactsDir, 'linked-dir'));
  for (const path of ['artifacts/linked.geojson', 'artifacts/linked-dir/outside.geojson']) {
    await assert.rejects(request(cfg, { url: '/rest/echo', params: { geometry: { $geometry: path } } }), /symlinks/);
    await assert.rejects(request(cfg, { url: '/rest/echo', save_to: path }), /symlinks/);
  }
  const generated = polygons.geometry_files![0].path;
  rmSync(generated);
  symlinkSync(outside, generated);
  await assert.rejects(request(cfg, { url: '/rest/polygons' }), /symlinks/);
  rmSync(join(cfg.artifactsDir, 'geometry'), { recursive: true });
  symlinkSync(temporary, join(cfg.artifactsDir, 'geometry'));
  await assert.rejects(request(cfg, { url: '/rest/polygons' }), /symlinks/);
  rmSync(cfg.artifactsDir, { recursive: true });
  symlinkSync(temporary, cfg.artifactsDir);
  await assert.rejects(request(cfg, { url: '/rest/polygons' }), /symlinks/);
  await assert.rejects(request(cfg, { url: '/rest/echo', save_to: 'artifacts/new.json' }), /symlinks/);
  await assert.rejects(request(cfg, { url: '/rest/echo', params: { geometry: { $geometry: 'artifacts/outside.geojson' } } }), /symlinks/);
  assert.equal(readFileSync(outside, 'utf8'), original, 'no write escapes artifacts/');
});

test('saved JSON and GeoJSON retain paging flags without returning the body', async () => {
  const cfg = project();
  for (const [url, more, count] of [['/rest/page', true, 1], ['/rest/geo-page?more=true', true, 0], ['/rest/geo-page', false, 0]] as const) {
    const result = await request(cfg, { url, save_to: 'artifacts/page.json' });
    assert.equal(result.saved!.exceededTransferLimit, more);
    assert.equal(result.saved!.features, count);
    assert.equal(result.data, undefined);
  }
});

test('extension tools keep large bodies in structuredContent and small envelopes in text', async () => {
  // Only schema constructors need a stand-in; the real extension and request path run unchanged.
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === '@earendil-works/pi-ai'
        ? { url: 'data:text/javascript,export const Type = new Proxy({}, {get: () => (...args) => args});', shortCircuit: true }
        : next(specifier, context);
    },
  });
  let extension;
  try {
    extension = (await import('../arcgis-rest/dev.pi/extensions/arcgis/index.ts')).default;
  } finally {
    hooks.deregister();
  }
  const registered: any[] = [];
  const servers: string[] = [];
  extension({
    registerTool: (tool: unknown) => registered.push(tool), registerCommand: () => {},
    registerMcpServer: (name: string) => servers.push(name), on: () => assert.fail('no MCP problem to report'),
  } as any);
  assert.deepEqual(registered.map((tool) => [tool.name, tool.exposure, !!tool.outputSchema]), [
    ['arcgis_request', 'codemode', true], ['arcgis_status', 'codemode', true],
  ]);
  assert.deepEqual(servers, ['mappi'], 'the plugin mcp.json servers are registered with pi');
  const cfg = project();
  const keys = ['ARCGIS_PORTAL_URL', 'ARCGIS_CLIENT_ID', 'ARCGIS_SESSION_DIR'];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.ARCGIS_PORTAL_URL = cfg.portal;
    process.env.ARCGIS_CLIENT_ID = cfg.clientId;
    process.env.ARCGIS_SESSION_DIR = dirname(dirname(cfg.sessionFile));
    const result = await registered[0].execute('test', { url: '/rest/large' });
    assert.equal(result.structuredContent.data.rows.length, 500_000, 'the full body reaches codemode');
    assert.equal(result.content[0].text, '{"status":200}', 'text never duplicates the body');
    assert.deepEqual(Object.keys(result.structuredContent), ['status', 'data'], 'undefined envelope members are omitted');
    const session = await registered[1].execute('test', {});
    assert.equal(session.structuredContent.signed_in, false);
    assert.deepEqual(JSON.parse(session.content[0].text), session.structuredContent);
  } finally {
    keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]);
  }
});

test('the artifacts folder is configurable, but only as one plain folder of the project', () => {
  const base = { ARCGIS_PORTAL_URL: 'https://portal.example.com', ARCGIS_CLIENT_ID: 'client' };
  assert.equal(configFromEnv(base, '/work/arcpi').artifactsDir, '/work/arcpi/artifacts');
  assert.equal(configFromEnv({ ...base, ARCPI_ARTIFACTS_DIR: 'results' }, '/work/arcpi').artifactsDir, '/work/arcpi/results');
  for (const name of ['.git', '.arcgis', 'test', 'arcgis-rest', 'mappi', 'tasks', 'video', 'a/b', '..', '/tmp']) {
    assert.throws(() => configFromEnv({ ...base, ARCPI_ARTIFACTS_DIR: name }, '/work/arcpi'), /ARCPI_ARTIFACTS_DIR/, name);
  }
});

test('references only read geometry files under artifacts/', async () => {
  const cfg = project();
  signedIn(cfg);
  const polygons = await request(cfg, { url: '/rest/polygons' });
  const route = await request(cfg, { url: '/rest/route' });
  const path = polygons.geometry_files![0].path;
  const calls = portal.seen.length;
  const refused = (reference: unknown, message: RegExp) => assert.rejects(request(cfg, { url: '/rest/echo', params: { geometry: { $geometry: reference } } }), message);
  for (const outside of ['../.arcgis/profile/session.json#0', '/etc/hosts#0', 'artifacts/../arcpi#0', cfg.sessionFile]) await refused(outside, /not under artifacts\//);
  await refused('artifacts/geometry/0000000000000000.geojson#0', /is gone .*repeat the request/);
  writeFileSync(join(cfg.artifactsDir, 'notes.json'), JSON.stringify({ secret: 'do-not-echo' }));
  writeFileSync(join(cfg.artifactsDir, 'notes.txt'), 'do-not-echo');
  for (const other of ['artifacts/notes.json', 'artifacts/notes.txt#0']) {
    await refused(other, /is not a geometry file\.$/);
    await assert.rejects(request(cfg, { url: '/rest/echo', params: { geometry: { $geometry: other } } }), (error: Error) => !error.message.includes('do-not-echo'));
  }
  await refused(`${path}#9`, /names no geometry/);
  await refused(`${path}#2`, /names no geometry/);
  await refused(5, /reference string/);
  await refused([`${path}#0`, route.geometry_files![0].path], /one kind and one spatial reference/);
  assert.equal(portal.seen.length, calls, 'a refused reference sends nothing');
});

test('ArcGIS error bodies throw, tokens are redacted and binary bodies need save_to', async () => {
  const cfg = project();
  signedIn(cfg);
  await assert.rejects(request(cfg, { url: '/rest/failure' }), /ArcGIS error 400 from 127\.0\.0\.1:\d+\/rest\/failure: Invalid query \(where is malformed\)$/);
  assert.deepEqual((await request(cfg, { url: '/rest/leak' })).data, { echoed: '[redacted]' });
  assert.equal((await request(cfg, { url: '/rest/empty' })).data, null, 'an empty body is not an error');
  await assert.rejects(request(cfg, { url: '/rest/report' }), /application\/pdf \(5 bytes\): pass save_to/);
  const saved = await request(cfg, { url: '/rest/report', save_to: 'artifacts/reports/report.pdf' });
  assert.deepEqual(saved.saved, { path: join(cfg.artifactsDir, 'reports', 'report.pdf'), bytes: 5, content_type: 'application/pdf', features: undefined });
  assert.deepEqual([...readFileSync(saved.saved!.path)], [0x25, 0x50, 0x44, 0x46, 0xff]);
  const layer = await request(cfg, { url: '/rest/echo', save_to: 'artifacts/layer.json' });
  assert.equal(layer.saved!.features, 1);
  assert.equal(layer.data, undefined, 'a saved body is not also returned');
  for (const path of ['../escape.json', 'elsewhere/file.json', '/tmp/absolute.json', 'artifacts']) {
    await assert.rejects(request(cfg, { url: '/rest/echo', save_to: path }), /under artifacts\//);
  }
  assert.ok(!existsSync(join(dirname(cfg.artifactsDir), '../escape.json')));
});

test('the plugin follows the Agent Plugins layout', () => {
  const manifest = JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(manifest.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  assert.deepEqual(Object.keys(manifest).filter((key) => !allowed.includes(key)), [], 'the manifest schema is closed');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(readFileSync(join(plugin, 'LICENSE'), 'utf8'), readFileSync(join(plugin, '../LICENSE'), 'utf8'), 'the plugin ships the repository license');
  const skills = readdirSync(join(plugin, 'skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(skills.length > 0);
  for (const skill of skills) {
    const text = readFileSync(join(plugin, 'skills', skill.name, 'SKILL.md'), 'utf8');
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
    assert.equal(frontmatter.match(/^name: (.+)$/m)?.[1], skill.name, 'a skill is named after its directory');
    const description = frontmatter.match(/^description: (.+)$/m)?.[1] ?? '';
    assert.ok(description.length > 0 && description.length <= 1024, `${skill.name} needs a description of at most 1024 characters`);
    // Every reference the skill points to must ship with it.
    for (const [, reference] of text.matchAll(/`(references\/[\w.-]+)`/g)) {
      assert.ok(existsSync(join(plugin, 'skills', skill.name, reference)), `${skill.name} links missing ${reference}`);
    }
  }
  // The skills ship self-contained: no other checkout, product or skill tree is assumed.
  for (const file of readdirSync(join(plugin, 'skills'), { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.md'))) {
    assert.doesNotMatch(readFileSync(join(plugin, 'skills', file), 'utf8'), /gis-map-console|agent-harness|arcctl|arcgis-js-|DuckDB|ST_Read/i, `${file} depends on something outside the plugin`);
  }
  // mcp.json targets the manifest's spec version; each server is one closed variant.
  const mcp = JSON.parse(readFileSync(join(plugin, 'mcp.json'), 'utf8'));
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(mcp).sort(), ['$schema', 'mcpServers']);
  const variants: Record<string, string[]> = {
    stdio: ['type', 'command', 'args', 'env', 'cwd'], 'streamable-http': ['type', 'url', 'headers'], sse: ['type', 'url', 'headers'],
  };
  for (const [name, server] of Object.entries(mcp.mcpServers) as [string, Record<string, string>][]) {
    assert.ok(variants[server.type], `${name} has a known type`);
    assert.deepEqual(Object.keys(server).filter((key) => !variants[server.type].includes(key)), [], `${name} has only ${server.type} fields`);
    if (server.type !== 'stdio') {
      const url = new URL(server.url);
      assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname)), `${name} uses https or loopback http`);
      assert.ok(!url.username && !url.hash, `${name} has no user information or fragment`);
    }
  }
  assert.deepEqual(pluginMcpServers(plugin), {
    servers: [['mappi', { type: 'streamable-http', url: 'http://127.0.0.1:8787/mcp', description: manifest.extensions['dev.pi'].mcpServers.mappi.description }]],
    problems: [],
  });
});

test('mcp.json servers that pi cannot use are skipped and reported, not fatal', () => {
  const root = join(temporary, 'mcp-plugin');
  mkdirSync(root, { recursive: true });
  const write = (name: string, value: object) => writeFileSync(join(root, name), JSON.stringify(value));
  write('plugin.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'p' });
  assert.deepEqual(pluginMcpServers(root), { servers: [], problems: [] }, 'no mcp.json is not an error');
  write('mcp.json', { $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json', mcpServers: { a: { type: 'streamable-http', url: 'https://a.example/mcp' } } });
  assert.deepEqual(pluginMcpServers(root).servers, [], 'a version other than the manifest disables MCP');
  assert.match(pluginMcpServers(root).problems[0], /1\.0\.0\/mcp\.schema\.json/);
  write('mcp.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: ['a'] });
  assert.deepEqual(pluginMcpServers(root).servers, [], 'mcpServers must be an object');
  write('mcp.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
    a: { type: 'streamable-http', url: 'https://a.example/mcp' }, b: { type: 'stdio', command: './server' }, c: null, d: 'x',
  } });
  assert.deepEqual(pluginMcpServers(root), {
    servers: [['a', { type: 'streamable-http', url: 'https://a.example/mcp' }]],
    problems: ['b: transport stdio is not supported', 'c: not a server object', 'd: not a server object'],
  });
});

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import { createMappi, createStatic } from '../mappi/server.ts';
import { configFromEnv, request as arcgisRequest } from '../arcgis-rest/dev.pi/extensions/arcgis/arcgis.ts';

const env: NodeJS.ProcessEnv = {};
// A temporary project: the checkout may be read-only (Docker smoke test).
const dir = await mkdtemp(join(tmpdir(), 'mappi-'));
const server = createMappi(env, dir);
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

let rpcId = 0;
async function rpc(method: string, params: object = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

const call = async (args: object) => (await rpc('tools/call', { name: 'run_map_code', arguments: args })).body.result;

/** A fake page: reads the SSE stream, hands each runJs to `answer`. */
async function openPage(answer: (message: any, secret: string) => unknown, observeAuth = false) {
  const controller = new AbortController();
  const response = await fetch(`${base}/events`, { signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let secret = '';
  const hello = Promise.withResolvers<void>();
  (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, end).split('\n').find((line) => line.startsWith('data: '));
          buffer = buffer.slice(end + 2);
          if (!data) continue;
          const message = JSON.parse(data.slice(6));
          if (message.type === 'hello') {
            secret = message.secret;
            hello.resolve();
          } else if (message.type === 'runJs' || observeAuth) await answer(message, secret);
        }
      }
    } catch {}
  })();
  await hello.promise;
  return { close: () => controller.abort(), get secret() { return secret; } };
}

const postResult = (secret: string, body: object) =>
  fetch(`${base}/result`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mappi-page': secret }, body: JSON.stringify(body) });

async function waitForPages(n: number) {
  for (let i = 0; i < 100; i++) {
    if ((await (await fetch(`${base}/health`)).json()).pages === n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`pages never became ${n}`);
}

test('mappi speaks MCP: initialize, tools/list, notifications', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.body.result.capabilities, { tools: {} });
  const list = await rpc('tools/list');
  assert.deepEqual(list.body.result.tools.map((tool: any) => tool.name), ['run_map_code']);
  assert.equal(list.body.result.tools[0].inputSchema.required[0], 'js');
  const note = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  assert.equal((await rpc('nope')).body.error.code, -32601);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
});

test('run_map_code round-trips through the newest page; failures come back as ok:false', async () => {
  assert.deepEqual(await call({ js: 'return 1' }), {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, result: null, error: 'no page connected — open the map in a browser', console: [] }) }],
    structuredContent: { ok: false, result: null, error: 'no page connected — open the map in a browser', console: [] },
    isError: false,
  });
  assert.equal((await call({ js: 1 })).isError, true);

  const hung = Promise.withResolvers<void>();
  const page = await openPage((message, secret) =>
    message.code === 'hang' ? hung.resolve() : postResult(secret, { id: message.id, ok: true, result: { echo: message.code }, console: ['hi'] }));
  assert.deepEqual((await call({ js: 'draw' })).structuredContent, { ok: true, result: { echo: 'draw' }, error: null, console: ['hi'] });
  assert.equal((await call({ js: 'hang', timeout: 0.05 })).structuredContent.error, 'exec timeout after 0.05s');
  assert.equal((await call({ js: 'x', timeout: -1 })).structuredContent.error, 'timeout must be a positive finite number');

  const pending = call({ js: 'hang', timeout: 5 });
  await hung.promise;
  page.close();
  assert.equal((await pending).structuredContent.error, 'page disconnected during execution');
  await waitForPages(0);
});

test('a result from another page or without the secret is ignored', async () => {
  const sent = Promise.withResolvers<any>();
  const target = await openPage((message) => sent.resolve(message));
  const pending = call({ js: 'x', timeout: 0.3 });
  const seen = await sent.promise;
  const other = await openPage(() => {});
  assert.equal((await postResult(other.secret, { id: seen.id, ok: true, result: 'forged' })).status, 404);
  assert.equal((await postResult('', { id: seen.id, ok: true, result: 'forged' })).status, 404);
  assert.equal((await pending).structuredContent.error, 'exec timeout after 0.3s');
  target.close();
  other.close();
  await waitForPages(0);
});

test('arcpi credentials reach the page before code, renew while open, and never reach tool results', async () => {
  let grants = 0;
  let restToken: string | null = null;
  const portal = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/rest/echo') restToken = new URLSearchParams(body).get('token');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/sharing/rest/oauth2/token') {
      grants++;
      res.end(JSON.stringify({ access_token: 'map-access-1', refresh_token: 'map-refresh-1', expires_in: 1800 }));
    } else res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => portal.listen(0, '127.0.0.1', resolve));
  env.ARCGIS_PORTAL_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  env.ARCGIS_CLIENT_ID = 'map-client';
  const cfg = configFromEnv(env, dir);
  const session = {
    portal: cfg.portal, client_id: cfg.clientId, token: 'map-access-0', refresh_token: 'map-refresh-0',
    username: 'map-user', expires_at: new Date(Date.now() + 1800_000).toISOString(),
  };
  await mkdir(dirname(cfg.sessionFile), { recursive: true });
  await writeFile(cfg.sessionFile, JSON.stringify(session));
  const updates: any[] = [];
  const renewed = Promise.withResolvers<void>();
  const page = await openPage((message, secret) => {
    if (message.type === 'auth') {
      updates.push(message);
      if (message.token === 'map-access-1') renewed.resolve();
    } else {
      assert.equal(updates.at(-1).token, message.code === 'public map' ? null : 'map-access-0', 'auth precedes runJs');
      return postResult(secret, { id: message.id, ok: true, result: 'map-access-0', console: ['map-access-0'] });
    }
  }, true);
  try {
    const reply = await call({ js: 'draw a secured layer' });
    assert.deepEqual(reply.structuredContent.result, '[redacted]');
    assert.deepEqual(reply.structuredContent.console, ['[redacted]']);
    assert.equal(updates[0].username, 'map-user');
    assert.ok(!JSON.stringify(updates).includes('map-refresh'), 'only access tokens cross the page channel');
    assert.ok(!JSON.stringify(await (await fetch(`${base}/config`)).json()).includes('map-access'));
    assert.deepEqual((await arcgisRequest(cfg, { url: '/rest/echo' })).data, { ok: true });
    assert.equal(restToken, updates.at(-1).token, 'REST and the map share the same access token');
    await writeFile(cfg.sessionFile, JSON.stringify({ ...session, expires_at: new Date(0).toISOString() }));
    await Promise.race([renewed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('no background auth update')), 7000).unref())]);
    assert.equal(grants, 1, 'the open map refreshes without another code call');
    assert.ok(!JSON.stringify(updates).includes('map-refresh'));
    await rm(cfg.sessionFile);
    await call({ js: 'public map' });
    assert.equal(updates.at(-1).token, null, 'logout clears the page credentials before more code');
  } finally {
    page.close();
    await waitForPages(0);
    delete env.ARCGIS_PORTAL_URL;
    delete env.ARCGIS_CLIENT_ID;
    portal.closeAllConnections();
    await new Promise(resolve => portal.close(resolve));
  }
});

test('the page applies shared auth, scopes SDK requests, and redacts retired tokens before truncation', async () => {
  const html = await readFile(new URL('../mappi/index.html', import.meta.url), 'utf8');
  const source = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1];
  const config = { request: { interceptors: [] as any[], useIdentity: true }, portalUrl: '' };
  const idm = {
    credentials: [] as any[],
    destroyCredentials() { this.credentials = []; },
    registerToken(value: any) { this.credentials.push(value); },
    findCredential(url: string) { return this.credentials.find(c => url.startsWith(c.server)); },
    getCredential: async (_url: string) => null,
  };
  const elements: Record<string, any> = {
    map: { view: {}, map: {}, viewOnReady: async () => {} },
    status: { classList: { toggle() {} } }, user: {},
  };
  let events: any;
  const results: any[] = [];
  await runInNewContext(`(async () => { ${source} })()`, {
    document: { getElementById: (id: string) => elements[id] },
    customElements: { whenDefined: async () => {} },
    $arcgis: { import: async () => [config, idm] },
    EventSource: class { constructor() { events = this; } },
    fetch: async (_url: string, options: any) => { results.push(JSON.parse(options.body)); },
    location: { origin: 'http://127.0.0.1:8787' },
    console: { log() {}, warn() {}, error() {} },
    URL, Date, performance, setTimeout, clearTimeout, AbortController, DOMException,
  });
  const send = (value: object) => events.onmessage({ data: JSON.stringify(value) });
  const auth = { type: 'auth', portalUrl: 'https://example.maps.arcgis.com', token: 'page-access-0', username: 'tester',
    expires: Date.now() + 1800_000, hosts: ['example.maps.arcgis.com'], suffixes: ['arcgis.com'] };
  send({ type: 'hello', secret: 'page-secret' });
  send(auth);
  assert.equal(elements.user.textContent, 'tester');
  assert.equal(idm.credentials[0].server, `${auth.portalUrl}/sharing/rest`);
  assert.equal(config.request.useIdentity, false, 'the SDK does not start another login');
  const before = config.request.interceptors[0].before;
  const options = { query: { where: '1=1' } };
  before({ url: 'https://services1.arcgis.com/rest/services/private/FeatureServer', requestOptions: options });
  assert.equal((options.query as any).token, auth.token);
  for (const url of ['https://arcgis.com.evil.example/rest', 'http://services1.arcgis.com/rest', '/artifacts?path=data.geojson']) {
    const requestOptions = { query: {} };
    before({ url, requestOptions });
    assert.deepEqual(requestOptions.query, {}, 'untrusted requests stay anonymous');
  }
  assert.throws(() => before({ url: `${auth.portalUrl}/sharing/rest/generate%54oken`, requestOptions: {} }), /Token endpoints/);
  assert.throws(() => before({ url: `${auth.portalUrl}/rest?token=manual`, requestOptions: {} }), /Never pass a token/);
  send({ ...auth, refusedHosts: ['services1.arcgis.com'] });
  const refused = { query: {} };
  before({ url: 'https://services1.arcgis.com/rest/services/public/FeatureServer', requestOptions: refused });
  assert.deepEqual(refused.query, {}, 'hosts that refused the portal token stay anonymous');
  const execute = async (js: string) => {
    const count = results.length;
    send({ type: 'runJs', id: String(count), code: js, timeoutMs: 1000 });
    for (let n = 0; n < 100 && results.length === count; n++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(results.length, count + 1);
    return results.at(-1);
  };
  const reply = await execute('const [, idm] = await api.import([]); console.log(idm.credentials[0]); return {user: api.user, token: idm.credentials[0].token};');
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { user: 'tester', token: '[redacted]' });
  assert.ok(!JSON.stringify(reply).includes(auth.token));
  send({ ...auth, token: 'page-access-1' });
  const bounded = await execute('return "x".repeat(256 * 1024 - 4) + "page-access-0";');
  assert.equal(bounded.result.truncated, true);
  assert.ok(!bounded.result.preview.includes('page'), 'redaction precedes truncation');
  send({ ...auth, token: null, username: null, expires: 0, hosts: [], suffixes: [] });
  assert.equal(idm.credentials.length, 0);
  assert.equal((await execute('return api.user;')).result, null);
  await assert.rejects(idm.getCredential(auth.portalUrl), /arcpi login/);
});

test('/artifacts serves only .geojson/.json/.parquet inside ARCPI_ARTIFACTS_DIR, with HEAD and ranges', async () => {
  // ARCPI_ARTIFACTS_DIR is one folder of the project, as for the launcher.
  const artifacts = join(dir, 'results');
  env.ARCPI_ARTIFACTS_DIR = 'results';
  await mkdir(join(artifacts, 'geometry'), { recursive: true });
  await mkdir(join(artifacts, '.arcgis'));
  await writeFile(join(artifacts, 'geometry', 'a.geojson'), '{"type":"FeatureCollection","features":[]}');
  await writeFile(join(artifacts, 'b.parquet'), 'PAR1 0123456789 PAR1');
  await writeFile(join(artifacts, 'note.txt'), 'x');
  await writeFile(join(artifacts, '.arcgis', 'session.json'), '{"secret":1}');
  await writeFile(join(dir, 'outside.geojson'), '{}');
  await symlink(join(dir, 'outside.geojson'), join(artifacts, 'link.geojson'));
  const get = (path: string) => fetch(`${base}/artifacts?path=${encodeURIComponent(path)}`);

  const ok = await get(join(artifacts, 'geometry', 'a.geojson'));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/geo+json');
  assert.equal((await ok.json()).type, 'FeatureCollection');
  assert.equal(ok.headers.get('content-length'), '42');

  // ParquetLayer reads the size (HEAD), then byte ranges.
  const parquet = `${base}/artifacts?path=${encodeURIComponent(join(artifacts, 'b.parquet'))}`;
  const head = await fetch(parquet, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/vnd.apache.parquet');
  assert.equal(head.headers.get('content-length'), '20');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  const range = async (value: string) => {
    const response = await fetch(parquet, { headers: { range: value } });
    return [response.status, response.headers.get('content-range'), await response.text()];
  };
  assert.deepEqual(await range('bytes=5-14'), [206, 'bytes 5-14/20', '0123456789']);
  assert.deepEqual(await range('bytes=-4'), [206, 'bytes 16-19/20', 'PAR1']);
  assert.deepEqual(await range('bytes=15-99'), [206, 'bytes 15-19/20', ' PAR1']);
  assert.deepEqual(await range('bytes=20-'), [416, 'bytes */20', '416\n']);
  assert.deepEqual(await range('bytes=0-1,4-5'), [200, null, 'PAR1 0123456789 PAR1']);
  for (const path of [
    join(artifacts, 'geometry', '..', '..', 'outside.geojson'),
    join(artifacts, 'link.geojson'),
    join(artifacts, 'note.txt'),
    join(artifacts, '.arcgis', 'session.json'),
    join(artifacts, 'missing.geojson'),
    join(artifacts, 'geometry'),
    'geometry/a.geojson',
    '/etc/passwd',
  ]) assert.equal((await get(path)).status, 404, path);

  // A symlinked artifacts folder is refused, wherever it points.
  await mkdir(join(dir, '.arcgis', 'profile'), { recursive: true });
  await writeFile(join(dir, '.arcgis', 'profile', 'session.json'), '{"secret":1}');
  await symlink(join(dir, '.arcgis'), join(dir, 'linked'));
  env.ARCPI_ARTIFACTS_DIR = 'linked';
  assert.equal((await get(join(dir, 'linked', 'profile', 'session.json'))).status, 404);

  // arcpi's own name rule: never a dot folder or one of the project's folders.
  await mkdir(join(dir, 'arcgis-rest'));
  const plugin = join(dir, 'arcgis-rest', 'plugin.json');
  await writeFile(plugin, '{}');
  for (const name of ['arcgis-rest', '.', '..']) {
    env.ARCPI_ARTIFACTS_DIR = name;
    assert.equal((await get(plugin)).status, 404, name);
  }
  delete env.ARCPI_ARTIFACTS_DIR;
});

test('/config echoes the sign-in env; the page is served at /', async () => {
  assert.deepEqual(await (await fetch(`${base}/config`)).json(), { portalUrl: null, clientId: null });
  env.ARCGIS_PORTAL_URL = 'https://example.maps.arcgis.com';
  env.ARCGIS_CLIENT_ID = 'abc';
  assert.deepEqual(await (await fetch(`${base}/config`)).json(), { portalUrl: 'https://example.maps.arcgis.com', clientId: 'abc' });
  delete env.ARCGIS_PORTAL_URL;
  delete env.ARCGIS_CLIENT_ID;
  const page = await fetch(`${base}/`);
  assert.match(await page.text(), /<arcgis-map/);
});

test('MCP_BEARER_TOKEN gates /mcp only', async () => {
  env.MCP_BEARER_TOKEN = 's3cret';
  try {
    assert.equal((await rpc('ping')).status, 401);
    assert.equal((await rpc('ping', {}, { authorization: 'Bearer wrong' })).status, 401);
    assert.deepEqual((await rpc('ping', {}, { authorization: 'Bearer s3cret' })).body.result, {});
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    delete env.MCP_BEARER_TOKEN;
  }
});

test('foreign Origin or Host is refused on every route', async () => {
  const status = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      request(`${base}${path}`, { headers }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      }).on('error', reject).end();
    });
  for (const path of ['/events', '/mcp', '/config', '/artifacts?path=/etc/passwd', '/']) {
    assert.equal(await status(path, { origin: 'https://evil.example' }), 403, path);
    assert.equal(await status(path, { host: 'evil.example:8787' }), 403, path);
  }
  // Same origin only: another loopback port (a static server) is not the map page.
  assert.equal(await status('/events', { origin: 'http://127.0.0.1:8000' }), 403);
  assert.equal(await status('/health', { host: 'localhost:8787', origin: 'http://localhost:8787' }), 200);
  assert.equal(await status('/health', { host: 'localhost:8787' }), 200);
});

test('--static serves the artifacts folder by path, with the same checks', async () => {
  const site = createStatic(env, dir);
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  try {
    env.ARCPI_ARTIFACTS_DIR = 'site';
    const siteDir = join(dir, 'site');
    await mkdir(join(siteDir, 'data'), { recursive: true });
    await writeFile(join(siteDir, 'map.html'), '<!doctype html><title>map</title>');
    await writeFile(join(siteDir, 'data', 'a b.geojson'), '{"type":"FeatureCollection","features":[]}');
    await writeFile(join(siteDir, 'tool.exe'), 'x');
    await mkdir(join(dir, '.arcgis', 'p'), { recursive: true });
    await writeFile(join(dir, '.arcgis', 'p', 'session.json'), '{"secret":1}');
    await symlink(join(dir, '.arcgis', 'p', 'session.json'), join(siteDir, 'leak.json'));

    const page = await fetch(`${origin}/map.html`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /<title>map<\/title>/);
    assert.equal((await fetch(`${origin}/data/a%20b.geojson`)).status, 200);
    for (const path of ['/', '/leak.json', '/tool.exe', '/missing.html', '/%2e%2e/.arcgis/p/session.json', '/..%2f.arcgis/p/session.json', '/%E0%A4%A']) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${origin}/map.html`, { method: 'POST' })).status, 405);

    // A file that passes stat() but cannot be read fails after the headers: that
    // response is dropped and the server keeps serving.
    await writeFile(join(siteDir, 'locked.html'), 'x');
    await chmod(join(siteDir, 'locked.html'), 0o000);
    await assert.rejects(fetch(`${origin}/locked.html`).then((response) => response.text()));
    assert.equal((await fetch(`${origin}/map.html`)).status, 200);

    // A symlinked artifacts folder serves nothing.
    await symlink(siteDir, join(dir, 'site-link'));
    env.ARCPI_ARTIFACTS_DIR = 'site-link';
    assert.equal((await fetch(`${origin}/map.html`)).status, 404);
  } finally {
    delete env.ARCPI_ARTIFACTS_DIR;
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
  }
});

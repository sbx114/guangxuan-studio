import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';
import { PROJECT_BUNDLE_MAGIC } from '../lib/project-bundles.mjs';

const CONNECTION_FILE = 'connection-settings.json';
const settingsOf = value => value?.settings || value;
const keyOf = value => settingsOf(value)?.apiKey || '';
const noKey = (value, key) => { assert.equal(JSON.stringify(value).includes(key), false, 'A response outside the protected load must not echo the fixture credential'); };

async function fixture(t, { authenticated = true, connectionAccessToken } = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-connection-http-')), dataDir = path.join(directory, 'data'), apps = [];
  let providerCalls = 0;
  const provider = http.createServer((_req, res) => { providerCalls++; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"connection storage must not contact a provider"}'); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  let token = connectionAccessToken ?? (authenticated ? randomBytes(32).toString('base64url') : undefined);
  let app = await startServer({ port: 0, dataDir, connectionAccessToken: token }); apps.push(app); assert.notEqual(new URL(app.url).port, '4417');
  const key = 'fixture-connection-credential-' + randomUUID(), settings = { baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', model: 'storage-fixture', apiKey: key, apiStyle: 'responses', jsonMode: true, timeoutSeconds: 120 };
  t.after(async () => { await Promise.all(apps.map(value => value.close())); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  function request(route, { method = 'POST', body = {}, origin = app.url, host, sessionToken = token, contentType = 'application/json', headers = {}, raw } = {}) {
    const url = new URL(app.url), payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const requestHeaders = { Host: host || url.host, ...(origin === null ? {} : { Origin: origin }), ...(sessionToken == null ? {} : { 'X-Gx-Connection-Session': sessionToken }), ...(contentType === null ? {} : { 'Content-Type': contentType }), ...headers };
      if (payload !== undefined) requestHeaders['Content-Length'] = Buffer.byteLength(payload);
      const outgoing = http.request({ hostname: '127.0.0.1', port: Number(url.port), path: route, method, headers: requestHeaders }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch { data = null; } resolve({ status: res.statusCode, headers: res.headers, text, data }); }); });
      outgoing.once('error', reject); if (payload !== undefined) outgoing.write(payload); outgoing.end();
    });
  }
  return { dataDir, key, settings, request, providerCalls: () => providerCalls, get app() { return app; }, get token() { return token; }, connectionFile: path.join(dataDir, CONNECTION_FILE),
    async restart() { await app.close(); token = randomBytes(32).toString('base64url'); app = await startServer({ port: 0, dataDir, connectionAccessToken: token }); apps.push(app); assert.notEqual(new URL(app.url).port, '4417'); return app; } };
}
const save = fx => fx.request('/api/connection/save', { body: { settings: fx.settings, rememberKey: true } });

test('real Windows encrypted connection survives restart, clears persistently, and never contacts the provider', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fx = await fixture(t), saved = await save(fx); assert.equal(saved.status, 200, saved.text); assert.equal(saved.data.saved, true); noKey(saved.data, fx.key); assert.match(saved.headers['cache-control'] || '', /no-store/);
  assert.equal(Object.hasOwn(saved.data.settings || {}, 'apiKey'), false);
  const cipher = await readFile(fx.connectionFile); assert.equal(cipher.includes(Buffer.from(fx.key)), false); assert.equal(cipher.includes(Buffer.from(Buffer.from(fx.key).toString('base64'))), false); assert.equal(cipher.includes(Buffer.from(fx.key, 'utf16le')), false);
  await fx.restart(); let loaded = await fx.request('/api/connection/load'); assert.equal(loaded.status, 200); assert.equal(keyOf(loaded.data), fx.key); assert.match(loaded.headers['cache-control'] || '', /no-store/);
  assert.equal(loaded.data.rememberKey, true); assert.equal(loaded.data.hasSavedKey, true); assert.equal(loaded.data.encryptionAvailable, true);
  for (const name of ['baseUrl', 'model', 'apiStyle', 'jsonMode', 'timeoutSeconds']) assert.equal(settingsOf(loaded.data)[name], fx.settings[name], name);
  const cleared = await fx.request('/api/connection/clear'); assert.equal(cleared.status, 200); assert.equal(cleared.data.cleared, true); noKey(cleared.data, fx.key);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(fx.connectionFile, 'utf8')), 'encryptedApiKey'), false);
  await fx.restart(); loaded = await fx.request('/api/connection/load'); assert.equal(loaded.status, 200); assert.equal(keyOf(loaded.data), ''); assert.equal(loaded.data.rememberKey, false); assert.equal(loaded.data.hasSavedKey, false); assert.equal(settingsOf(loaded.data).baseUrl, fx.settings.baseUrl); assert.equal(fx.providerCalls(), 0);
});

test('sensitive connection routes reject methods, foreign origins, forms and authority mismatches without leaking or changing the saved key', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fx = await fixture(t); assert.equal((await save(fx)).status, 200); const port = new URL(fx.app.url).port, rejected = [
    { method: 'GET', body: undefined, expected: 405 }, { method: 'HEAD', body: undefined, expected: 405 }, { origin: null }, { origin: 'null' },
    { origin: 'https://foreign.invalid' }, { origin: 'http://localhost:' + port }, { host: 'localhost:' + port },
    { origin: 'http://127.0.0.1:' + (Number(port) + 1) }, { origin: fx.app.url + '/' },
    { host: 'foreign.invalid:' + port }, { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { contentType: 'application/x-www-form-urlencoded', raw: 'rememberKey=false', expected: 415 }, { contentType: 'text/plain', raw: '{}', expected: 415 }, { contentType: null, raw: '{}', expected: 415 },
    { origin: null, headers: { Referer: fx.app.url + '/' } },
  ];
  for (const route of ['/api/connection/load', '/api/connection/save', '/api/connection/clear']) {
    for (const options of rejected) {
      const body = route.endsWith('/save') ? { settings: { ...fx.settings, apiKey: 'must-not-overwrite-' + randomUUID() }, rememberKey: true } : {};
      const response = await fx.request(route, { body, ...options });
      assert.equal(response.status, options.expected || 403, `Unexpected guarded response for ${route}`); noKey(response.text, fx.key); noKey(response.headers, fx.key); assert.match(response.headers['cache-control'] || '', /no-store/);
    }
    const absolute = await fx.request('http://localhost:' + port + route, { origin: 'http://localhost:' + port }); assert.equal(absolute.status, 403); noKey(absolute.text, fx.key);
  }
  const unchanged = await fx.request('/api/connection/load'); assert.equal(unchanged.status, 200); assert.equal(keyOf(unchanged.data), fx.key); assert.equal(fx.providerCalls(), 0);
});

test('saved and reloaded credentials feed actual redaction, diagnostics omit bodies and headers, and project exports exclude connection files', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fx = await fixture(t); assert.equal((await save(fx)).status, 200);
  const putProject = async id => { const response = await fx.request('/api/projects/' + id, { method: 'PUT', body: { id, kind: 'video', title: 'Private fixture ' + fx.key, source: { text: 'Do not persist ' + fx.key }, video: { timeline: [], captions: [] } } }); assert.equal(response.status, 200, response.text); noKey(response.text, fx.key); assert.equal((await readFile(path.join(fx.dataDir, 'projects', id + '.json'), 'utf8')).includes(fx.key), false); };
  await putProject('before-restart'); await fx.restart(); const loaded = await fx.request('/api/connection/load'); assert.equal(keyOf(loaded.data), fx.key); await putProject('after-restart');
  const bodyMarker = 'body-only-fixture-' + randomUUID(), headerMarker = 'header-only-fixture-' + randomUUID();
  const failed = await fx.request('/api/projects/' + fx.key + '%ZZ', { body: { bodyMarker }, headers: { 'X-Private-Fixture': headerMarker } }); assert.equal(failed.status, 500); noKey(failed.text, fx.key);
  const diagnostics = await readFile(path.join(fx.dataDir, 'diagnostics/errors.ndjson'), 'utf8'); assert.equal(diagnostics.includes(fx.key), false); assert.equal(diagnostics.includes(bodyMarker), false); assert.equal(diagnostics.includes(headerMarker), false);
  const nativeRoot = path.join(fx.dataDir, 'openfilm/projects/after-restart'); await mkdir(path.join(nativeRoot, 'pages'), { recursive: true });
  const { filmHtml } = await import('../integrations/openfilm/packages/openfilm/src/film-doc.mjs');
  const { writeFile } = await import('node:fs/promises'); await writeFile(path.join(nativeRoot, 'film.html'), filmHtml({ stage: { w: 128, h: 72 }, tracks: [] }));
  await copyFile(fx.connectionFile, path.join(nativeRoot, CONNECTION_FILE)); await copyFile(fx.connectionFile, path.join(nativeRoot, 'pages', CONNECTION_FILE));
  const exported = await fx.request('/api/project-bundles/exports', { body: { projectId: 'after-restart' } }); assert.equal(exported.status, 201, exported.text); noKey(exported.data, fx.key);
  const response = await fetch(fx.app.url + exported.data.downloadUrl), archive = gunzipSync(Buffer.from(await response.arrayBuffer())); assert.equal(response.status, 200); assert.equal(archive.includes(Buffer.from(fx.key)), false); assert.equal(archive.includes(await readFile(fx.connectionFile)), false);
  const length = archive.readUInt32BE(PROJECT_BUNDLE_MAGIC.length), start = PROJECT_BUNDLE_MAGIC.length + 4, manifest = JSON.parse(archive.subarray(start, start + length).toString()); assert.ok(manifest.files.every(file => !/connection-settings\.json/i.test(file.path))); assert.equal(fx.providerCalls(), 0);
});

test('connection JSON shape and 64KiB bound do not change unrelated API body limits or persisted settings', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fx = await fixture(t); assert.equal((await save(fx)).status, 200); const before = await readFile(fx.connectionFile);
  for (const [route, body, expected] of [
    ['/api/connection/load', { unused: true }, 400], ['/api/connection/clear', { unused: true }, 400],
    ['/api/connection/save', { settings: fx.settings, rememberKey: 'true' }, 400], ['/api/connection/save', { settings: fx.settings, rememberKey: true, dataDir: 'not-an-HTTP-option' }, 400],
    ['/api/connection/load?unused=1', {}, 403], ['/api/connection/clear#unused', {}, 403],
    ['/api/connection/save', { settings: fx.settings, rememberKey: true, padding: 'x'.repeat(65536) }, 413],
  ]) { const response = await fx.request(route, { body }); assert.equal(response.status, expected); noKey(response.text, fx.key); }
  assert.deepEqual(await readFile(fx.connectionFile), before);
  const unrelated = await fx.request('/api/projects/large-json-fixture', { method: 'PUT', body: { id: 'large-json-fixture', kind: 'writing', title: 'Unrelated normal JSON', source: { text: 'y'.repeat(70000) } } });
  assert.equal(unrelated.status, 200, unrelated.text); assert.equal(unrelated.data.project.source.text.length, 70000); assert.equal(fx.providerCalls(), 0);
});

test('short placeholder credentials preserve ordinary project numbers after save and restart load', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fx = await fixture(t), id = 'short-key-project-1', title = '第1版标题', source = { title: '材料1', text: '第1段正文，版本v1保持原样。', url: 'https://example.invalid/v1' };
  const created = await fx.request('/api/projects/' + id, { method: 'PUT', body: { id, kind: 'writing', title, source } }); assert.equal(created.status, 200);
  const filename = path.join(fx.dataDir, 'projects', id + '.json'), before = await readFile(filename);
  const unchanged = async () => {
    const response = await fx.request('/api/projects/' + id, { method: 'GET', body: undefined }); assert.equal(response.status, 200);
    assert.equal(response.data.project.id, id); assert.equal(response.data.project.title, title); assert.deepEqual(response.data.project.source, created.data.project.source);
    assert.deepEqual(await readFile(filename), before, 'Reading with a saved short placeholder must not rewrite the project file');
  };
  const saved = await fx.request('/api/connection/save', { body: { settings: { ...fx.settings, apiKey: '1' }, rememberKey: true } }); assert.equal(saved.status, 200); await unchanged();
  await fx.restart(); const loaded = await fx.request('/api/connection/load'); assert.equal(loaded.status, 200); assert.equal(keyOf(loaded.data), '1'); await unchanged(); assert.equal(fx.providerCalls(), 0);
});

test('a valid Origin cannot load, save or clear without the correct current session capability', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const fx = await fixture(t), other = await fixture(t); assert.equal((await save(fx)).status, 200); const cipher = await readFile(fx.connectionFile);
  const wrongTokens = [null, '', 'x', fx.token.slice(0, -1), fx.token + 'x', 'x'.repeat(1024), randomBytes(32).toString('base64url'), other.token, [fx.token, other.token]];
  for (const route of ['/api/connection/load', '/api/connection/save', '/api/connection/clear']) {
    for (const sessionToken of wrongTokens) {
      const body = route.endsWith('/save') ? { settings: { ...fx.settings, model: 'must-not-be-saved' }, rememberKey: true } : {};
      const response = await fx.request(route, { body, sessionToken });
      assert.equal(response.status, 401); assert.equal(response.data.code, 'CONNECTION_SESSION_REQUIRED'); noKey(response.text, fx.key); noKey(response.text, fx.token); assert.match(response.headers['cache-control'] || '', /no-store/);
    }
  }
  assert.deepEqual(await readFile(fx.connectionFile), cipher); assert.equal(keyOf((await fx.request('/api/connection/load')).data), fx.key);
  assert.equal((await other.request('/api/connection/load', { sessionToken: fx.token })).status, 401);
  const previous = fx.token; await fx.restart(); assert.notEqual(fx.token, previous);
  for (const route of ['/api/connection/load', '/api/connection/save', '/api/connection/clear']) {
    const body = route.endsWith('/save') ? { settings: fx.settings, rememberKey: true } : {}, response = await fx.request(route, { body, sessionToken: previous });
    assert.equal(response.status, 401); noKey(response.text, fx.key); noKey(response.text, previous);
  }
  assert.equal(keyOf((await fx.request('/api/connection/load')).data), fx.key); assert.deepEqual(await readFile(fx.connectionFile), cipher); assert.equal(fx.providerCalls() + other.providerCalls(), 0);
});

test('missing or malformed trusted session configuration fails closed while public health remains available', { timeout: 60000 }, async t => {
  for (const connectionAccessToken of [undefined, 'not-a-32-byte-session']) {
    const fx = await fixture(t, { authenticated: false, connectionAccessToken });
    for (const route of ['/api/connection/load', '/api/connection/save', '/api/connection/clear']) {
      for (const sessionToken of [null, connectionAccessToken, randomBytes(32).toString('base64url')]) {
        const body = route.endsWith('/save') ? { settings: fx.settings, rememberKey: true } : {}, response = await fx.request(route, { body, sessionToken });
        assert.equal(response.status, 401); assert.equal(response.data.code, 'CONNECTION_SESSION_REQUIRED'); noKey(response.text, fx.key);
      }
    }
    await assert.rejects(readFile(fx.connectionFile), { code: 'ENOENT' });
    assert.equal((await fx.request('/api/health', { method: 'GET', body: undefined, origin: null, sessionToken: null })).status, 200); assert.equal(fx.providerCalls(), 0);
  }
});

test('session capability never appears in public bootstrap, project files, diagnostics or project packages', { timeout: 60000 }, async t => {
  const fx = await fixture(t); assert.equal(new URL(fx.app.url).hash, '');
  for (const route of ['/', '/api/health', '/api/assistant/capabilities', '/api/desktop/status', '/api/connection/bootstrap', '/api/connection/session']) {
    const response = await fx.request(route, { method: 'GET', body: undefined, origin: null, sessionToken: null }); noKey(response.text, fx.token); noKey(response.headers, fx.token);
  }
  const id = 'session-token-project', response = await fx.request('/api/projects/' + id, { method: 'PUT', body: { id, kind: 'writing', title: 'Session capability stays private', source: { text: 'Do not persist this capability: ' + fx.token } } });
  assert.equal(response.status, 200); noKey(response.text, fx.token); const project = await readFile(path.join(fx.dataDir, 'projects', id + '.json'), 'utf8'); assert.equal(project.includes(fx.token), false);
  const bodyMarker = 'session-body-' + randomUUID(), headerMarker = 'session-header-' + randomUUID();
  const failed = await fx.request('/api/projects/' + fx.token + '%ZZ', { body: { bodyMarker }, headers: { 'X-Private-Fixture': headerMarker } }); assert.equal(failed.status, 500); noKey(failed.text, fx.token);
  const diagnostics = await readFile(path.join(fx.dataDir, 'diagnostics/errors.ndjson'), 'utf8'); assert.equal(diagnostics.includes(fx.token), false); assert.equal(diagnostics.includes(bodyMarker), false); assert.equal(diagnostics.includes(headerMarker), false);
  const exported = await fx.request('/api/project-bundles/exports', { body: { projectId: id } }); assert.equal(exported.status, 201); noKey(exported.data, fx.token);
  const archiveResponse = await fetch(fx.app.url + exported.data.downloadUrl), archive = gunzipSync(Buffer.from(await archiveResponse.arrayBuffer())); assert.equal(archiveResponse.status, 200); assert.equal(archive.includes(Buffer.from(fx.token)), false);
  await assert.rejects(readFile(fx.connectionFile), { code: 'ENOENT' }); assert.equal(fx.providerCalls(), 0);
});

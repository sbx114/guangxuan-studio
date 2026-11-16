import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_ROOT = path.join(ROOT, 'public', 'rhine');

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function resourceUrl(filename, origin) {
  return new URL(`/rhine/${path.relative(BUILT_ROOT, filename).split(path.sep).map(encodeURIComponent).join('/')}`, origin);
}

test('built Rhine homepage embeds only on the same origin and serves real local scripts, fonts and GLB models', { timeout: 60000 }, async t => {
  try { await access(path.join(BUILT_ROOT, 'index.html')); }
  catch { assert.fail('缺少构建后的 public/rhine/index.html，请先运行 npm run build:home。'); }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-rhine-static-'));
  let app;
  t.after(async () => {
    await app?.close();
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-rhine-static-')) throw new Error('Refusing unsafe cleanup target');
    await rm(resolved, { recursive: true, force: true });
  });
  app = await startServer({ port: 0, dataDir });
  assert.notEqual(new URL(app.url).port, '4417', 'The test must not bind the user session port');

  const main = await fetch(`${app.url}/`);
  assert.equal(main.status, 200);
  assert.equal(main.headers.get('x-frame-options'), 'DENY');
  assert.match(main.headers.get('content-security-policy'), /(?:^|;\s*)frame-ancestors 'none'(?:;|$)/);
  assert.match(main.headers.get('content-security-policy'), /(?:^|;\s*)frame-src 'self'(?:;|$)/);
  await main.text();

  const homeUrl = `${app.url}/rhine/index.html`;
  const home = await fetch(homeUrl, { headers: { Origin: app.url } });
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /^text\/html/);
  assert.equal(home.headers.get('x-frame-options'), 'SAMEORIGIN');
  const policy = home.headers.get('content-security-policy');
  assert.match(policy, /(?:^|;\s*)frame-ancestors 'self'(?:;|$)/);
  assert.match(policy, /(?:^|;\s*)script-src 'self'(?:;|$)/);
  const html = await home.text();
  assert.match(html, /<script\b[^>]*\bsrc=/i, 'Use the actual built JavaScript entry, not a test placeholder');

  const queried = await fetch(`${homeUrl}?skipBoot=1`, { method: 'HEAD' });
  assert.equal(queried.status, 200);
  assert.equal(queried.headers.get('x-frame-options'), 'SAMEORIGIN');
  const foreign = await fetch(homeUrl, { headers: { Origin: 'https://outside.example' } });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, 'INVALID_ORIGIN');

  const scriptReferences = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]);
  const styleReferences = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.css(?:\?[^"']*)?)["']/gi)].map(match => match[1]);
  assert.ok(scriptReferences.length > 0 && styleReferences.length > 0, 'Built entry must reference local scripts and styles');
  for (const reference of [...new Set([...scriptReferences, ...styleReferences])]) {
    const url = new URL(reference, homeUrl);
    assert.equal(url.origin, app.url, 'Homepage dependencies must stay local');
    assert.ok(url.pathname.startsWith('/rhine/'), `Homepage dependency has an incorrect base path: ${url.pathname}`);
    const result = await fetch(url);
    assert.equal(result.status, 200, url.pathname);
    assert.match(result.headers.get('content-type'), /^(?:text\/javascript|text\/css)/, url.pathname);
    assert.ok((await result.text()).length > 100, `Built resource is unexpectedly empty: ${url.pathname}`);
  }

  const allFiles = await filesBelow(BUILT_ROOT);
  const models = allFiles.filter(filename => /\.glb$/i.test(filename));
  assert.ok(models.length > 0, 'The actual homepage model assets must be included');
  for (const filename of models) {
    const result = await fetch(resourceUrl(filename, app.url));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'model/gltf-binary');
    const buffer = Buffer.from(await result.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString(), 'glTF');
    assert.equal(buffer.readUInt32LE(4), 2);
    assert.equal(buffer.readUInt32LE(8), buffer.length, 'Model response must contain the complete GLB');
  }

  const fonts = allFiles.filter(filename => /\.(?:woff2?|ttf|otf)$/i.test(filename));
  assert.ok(fonts.length > 0, 'Local font files must ship with the homepage');
  const fontDirectories = new Map();
  for (const filename of fonts) if (!fontDirectories.has(path.dirname(filename))) fontDirectories.set(path.dirname(filename), filename);
  for (const filename of [...fontDirectories.values()].slice(0, 3)) {
    const result = await fetch(resourceUrl(filename, app.url));
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /^font\//);
    const buffer = Buffer.from(await result.arrayBuffer());
    assert.ok(buffer.length > 100);
    if (filename.endsWith('.woff2')) assert.equal(buffer.subarray(0, 4).toString(), 'wOF2');
    else if (filename.endsWith('.woff')) assert.equal(buffer.subarray(0, 4).toString(), 'wOFF');
  }
});

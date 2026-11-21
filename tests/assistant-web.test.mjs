import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createAssistantWebService, requestPinnedAssistantUrl, resolvePublicAssistantUrl, normalizePublicAssistantUrl } from '../lib/assistant-web.mjs';

const publicIp = '93.184.216.34';
const lookupPublic = async () => [{ address: publicIp, family: 4 }];
const code = expected => error => { assert.equal(error.code, 'ASSISTANT_WEB_' + expected); return true; };
const html = '<!doctype html><html><head><title>Knowledge &amp; science</title></head><body><nav>navigation rubbish</nav><main><h1>Research</h1><p>Science uses observation, evidence, and experiments. 研究需要可以核对的依据。</p><script>doNotReadThisSecret()</script><style>.invisible{}</style><p>Discussing scientific results helps us ask better questions.</p><a href="/article?utm_source=news&amp;v=1#notes">Read more</a><a href="http://127.0.0.1/secret">Internal</a><a href="https://public.example.com/a?token=secret">Signed</a></main><footer>footer rubbish</footer></body></html>';
const rss = '<rss version="2.0"><channel><title>Bing results</title><item><title>A &amp; B</title><link>https://public.example.com/article?utm_source=rss&amp;v=1</link><description><![CDATA[Evidence <b>from</b> a genuine test item.]]></description></item><item><title>Duplicate</title><link>https://public.example.com/article?v=1</link><description>same</description></item><item><title>Private</title><link>http://127.0.0.1/secret</link></item><item><title>Other result</title><link>https://other.example.com/page</link><description>Plain &lt;b&gt;description&lt;/b&gt;.</description></item></channel></rss>';

async function setup(t, handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }, options = {}) {
  const sockets = new Set(), requests = [], lookups = [];
  const server = http.createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (target, requestOptions) => {
    requests.push({ url: target.url.href, address: target.address, family: target.family });
    return new Promise((resolve, reject) => {
      // Only this construction-time test transport maps validated public hosts
      // to the fixture. The production request always uses the pinned address.
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target.url.pathname + target.url.search, signal: requestOptions.signal, headers: { Host: target.url.host } }, resolve);
      req.once('error', reject); req.end();
    });
  };
  const service = createAssistantWebService({ ...options, dependencies: {
    lookup: async (...args) => { lookups.push(args); return (options.dependencies?.lookup || lookupPublic)(...args); },
    request, ...options.dependencies,
  } });
  t.after(async () => { await service.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { service, requests, lookups, server };
}

test('public URL policy rejects credentials, private hosts, alternate IP spellings, reserved addresses and protocols before I/O', async t => {
  const run = await setup(t);
  for (const value of ['C:\\private\\paper.txt', 'file:///C:/private/paper.txt', 'ftp://public.example.com/a', 'https://user:pass@public.example.com/a', 'https://localhost/a', 'https://local/a', 'http://metadata.google.internal/a', 'http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://[::1]/a', 'http://[::ffff:7f00:1]/a', 'http://169.254.169.254/a', 'http://100.100.100.200/a', 'https://public.example.com:22/a', 'https://public.example.com/a?api_key=abc', 'https://public.example.com/a?key=abc', 'https://public.example.com/a?access_token=abc']) {
    await assert.rejects(run.service.read(value), error => error.status === 400, value);
  }
  assert.equal(run.requests.length, 0); assert.equal(run.lookups.length, 0);
});

test('DNS validation requires every answer to be public and refuses empty or oversized answer sets', async () => {
  for (const answers of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: publicIp, family: 4 }, { address: 'fd00::1', family: 6 }], Array.from({ length: 65 }, () => ({ address: publicIp, family: 4 }))]) {
    await assert.rejects(resolvePublicAssistantUrl('https://public.example.com/a', { lookup: async () => answers }), code('URL_PRIVATE'));
  }
  const resolved = await resolvePublicAssistantUrl('https://public.example.com/a?utm_source=test&v=1#source', { lookup: lookupPublic });
  assert.equal(resolved.url.href, 'https://public.example.com/a?v=1'); assert.equal(resolved.address, publicIp); assert.equal(resolved.family, 4);
});

test('pure public URL normalization rejects credential query and unsafe literals without requiring DNS', () => {
  assert.equal(normalizePublicAssistantUrl('https://files.example.com/video.mp4?utm_source=feed&v=1#play'), 'https://files.example.com/video.mp4?v=1');
  for (const value of ['https://files.example.com/a?api_key=abc', 'https://files.example.com/a?access_token=abc', 'https://user:pass@files.example.com/a', 'http://127.1/a', 'http://169.254.169.254/a', 'https://files.example.com:8443/a', 'file:///C:/video.mp4']) assert.throws(() => normalizePublicAssistantUrl(value), error => error.status === 400);
});

test('HTML discovers real video, source and OpenGraph media candidates ahead of navigation within its link budget', async t => {
  const page = '<html><head><title>Official university video</title><meta property="og:video:secure_url" content="/official.mp4?utm_medium=site"><meta property="og:video" content="http://127.0.0.1/private.mp4"><meta property="og:video:type" content="video/mp4"></head><body>' +
    '<video src="/background.mp4" title="校园影像"><source src="//cdn.example.com/campus.webm" type="video/webm"><source src="/sound.mp3" type="audio/mpeg"></video>' +
    '<source src="/private.mp4?token=secret" type="video/mp4"><script>const falseSource = \'<video src="https://injected.example.com/fake.mp4">\';</script>' +
    '<p>Official public campus video material with a publisher description and useful surrounding text.</p>' + Array.from({ length: 30 }, (_, index) => `<a href="/nav/${index}">Navigation ${index}</a>`).join('') + '<a href="/promotion.mp4">招生宣传片：生长</a></body></html>';
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
  const result = await run.service.read('https://public.example.com/');
  assert.equal(result.links.length, 20);
  for (const url of ['https://public.example.com/background.mp4', 'https://cdn.example.com/campus.webm', 'https://public.example.com/official.mp4', 'https://public.example.com/promotion.mp4']) assert.ok(result.links.some(link => link.url === url), url);
  assert.equal(result.links[0].title, '校园影像');
  assert.ok(result.links.every(link => !/127\.0\.0\.1|token=|falseSource|injected\.example|sound\.mp3|\/video\/mp4$/.test(link.url)));
  assert.equal(run.requests.length, 1, 'candidate discovery must not fetch media');
});

test('pinned production transport connects to its target address without a second DNS lookup and sends no cookie or credentials', async t => {
  let observed;
  const run = await setup(t, (req, res) => { observed = { headers: req.headers, method: req.method }; res.end('done'); });
  const port = run.server.address().port;
  const response = await requestPinnedAssistantUrl({ url: new URL('http://must-never-resolve.invalid:' + port + '/fixture'), address: '127.0.0.1', family: 4 });
  const chunks = []; for await (const chunk of response) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'done'); assert.equal(observed.method, 'GET');
  assert.equal(observed.headers.host, 'must-never-resolve.invalid:' + port); assert.equal(observed.headers.cookie, undefined); assert.equal(observed.headers.authorization, undefined);
});

test('reading HTML extracts the main body, entities, paragraphs and useful public links', async t => {
  const run = await setup(t), result = await run.service.read('https://public.example.com/article?utm_medium=feed#ignored');
  assert.equal(result.title, 'Knowledge & science'); assert.equal(result.url, 'https://public.example.com/article'); assert.match(result.id, /^web-[a-f0-9]{20}$/); assert.equal(result.id, result.sourceId);
  assert.match(result.text, /Science uses observation/); assert.match(result.text, /研究需要可以核对的依据/);
  assert.doesNotMatch(result.text, /navigation rubbish|footer rubbish|doNotReadThisSecret|invisible/);
  assert.deepEqual(result.links, [{ title: 'Read more', url: 'https://public.example.com/article?v=1' }]);
  assert.equal(result.text, result.paragraphs.map(item => item.text).join('\n\n')); assert.equal(result.paragraphs[0].id, 'p1'); assert.equal(result.truncated, false);
  assert.equal(run.requests[0].address, publicIp); assert.equal(run.lookups.length, 1);
});

test('text budgets bound all paragraphs and mark truncation instead of silently returning a full page', async t => {
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Evidence science and research. '.repeat(4000)); });
  const result = await run.service.read('https://public.example.com/paper.txt', { maxChars: 630 });
  assert.ok(result.text.length <= 630); assert.equal(result.truncated, true); assert.ok(result.paragraphs.every(item => item.text.length <= 2500));
});

test('non-UTF8 declared web encodings are decoded without mojibake', async t => {
  const body = Buffer.from('<html><title>Caf\xe9 paper</title><body><p>Un caf\xe9 pour comprendre la science avec des preuves et des exp\xe9riences.</p></body></html>', 'latin1');
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }); res.end(body); });
  const result = await run.service.read('https://public.example.com/article'); assert.equal(result.title, 'Café paper'); assert.match(result.text, /expériences/);
});

test('each redirect is validated and DNS rebinding cannot open a second connection', async t => {
  let lookups = 0;
  const run = await setup(t, (_req, res) => { res.writeHead(302, { location: '/next' }); res.end(); }, { dependencies: { lookup: async () => [{ address: ++lookups === 1 ? publicIp : '127.0.0.1', family: 4 }] } });
  await assert.rejects(run.service.read('https://public.example.com/start'), code('URL_PRIVATE')); assert.equal(run.requests.length, 1); assert.equal(lookups, 2);
});

test('redirects refuse metadata, credential URLs, nonstandard ports, and HTTPS downgrade', async t => {
  for (const [location, expected] of [['https://169.254.169.254/latest/meta-data/', 'URL_PRIVATE'], ['https://user:pass@public.example.com/a', 'URL_INVALID'], ['https://public.example.com/a?token=abc', 'URL_SENSITIVE'], ['https://public.example.com:8443/a', 'URL_PORT'], ['http://public.example.com/a', 'URL_INVALID']]) {
    const run = await setup(t, (_req, res) => { res.writeHead(302, { location }); res.end(); });
    await assert.rejects(run.service.read('https://public.example.com/start'), code(expected)); assert.equal(run.requests.length, 1);
  }
});

test('public redirects work and redirect loops are bounded', async t => {
  const run = await setup(t, (req, res) => { if (req.url === '/start') { res.writeHead(302, { location: 'https://other.example.com/end' }); res.end(); } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); } });
  const result = await run.service.read('https://public.example.com/start'); assert.equal(result.url, 'https://other.example.com/end'); assert.equal(run.requests.length, 2);
  const loop = await setup(t, (_req, res) => { res.writeHead(307, { location: '/again' }); res.end(); });
  await assert.rejects(loop.service.read('https://public.example.com/start'), code('REDIRECT')); assert.equal(loop.requests.length, 6);
});

test('gzip, deflate and Brotli bodies decode correctly within independent wire and decoded budgets', async t => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding }); res.end(compress(Buffer.from(html))); });
    const result = await run.service.read('https://public.example.com/a'); assert.match(result.text, /Science uses observation/);
  }
});

test('declared size, streamed size, compression bombs and invalid encodings fail explicitly', async t => {
  const declared = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 1000000 }); res.end(); }, { maxBytes: 512 });
  await assert.rejects(declared.service.read('https://public.example.com/a'), code('TOO_LARGE'));
  const streamed = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('a'.repeat(1000)); }, { maxBytes: 512 });
  await assert.rejects(streamed.service.read('https://public.example.com/a'), code('TOO_LARGE'));
  const bomb = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.from('a'.repeat(100000)))); }, { maxDecodedBytes: 1024 });
  await assert.rejects(bomb.service.read('https://public.example.com/a'), code('TOO_LARGE'));
  const invalid = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'compress' }); res.end('body'); });
  await assert.rejects(invalid.service.read('https://public.example.com/a'), code('ENCODING'));
  const corrupt = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end('not gzip'); });
  await assert.rejects(corrupt.service.read('https://public.example.com/a'), code('BODY'));
});

test('HTTP failures, challenge pages, dynamic shells, unsupported binaries and empty text cannot masquerade as read success', async t => {
  for (const [status, type, body, expected] of [
    [403, 'text/html', '<html>Forbidden</html>', 'BLOCKED'],
    [429, 'text/plain', 'Rate limited', 'BLOCKED'],
    [404, 'text/html', '<html>Not found</html>', 'HTTP'],
    [200, 'text/html', '<html><title>Just a moment</title><body>Verify you are human before reading this website</body></html>', 'BLOCKED'],
    [200, 'text/html', '<html><title>App</title><body><div id="root"></div><script src="app.js"></script></body></html>', 'NO_TEXT'],
    [200, 'application/octet-stream', 'binary executable content', 'CONTENT_TYPE'],
    [200, 'text/plain', '   ', 'NO_TEXT'],
  ]) {
    const run = await setup(t, (_req, res) => { res.writeHead(status, { 'content-type': type }); res.end(body); });
    await assert.rejects(run.service.read('https://public.example.com/a'), code(expected));
  }
});

test('search returns only actual RSS items, deduplicates URLs, cleans snippets and has stable source IDs', async t => {
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(rss); });
  const result = await run.service.search('evidence science', { limit: 8 });
  assert.equal(result.provider, 'Bing'); assert.equal(result.results.length, 2); assert.equal(result.results[0].title, 'A & B');
  assert.equal(result.results[0].url, 'https://public.example.com/article?v=1'); assert.equal(result.results[0].snippet, 'Evidence from a genuine test item.');
  assert.equal(result.results[1].snippet, 'Plain description.'); assert.equal(new URL(run.requests[0].url).searchParams.get('q'), 'evidence science');
  const read = await run.service.read(result.results[0].url); assert.equal(result.results[0].sourceId, read.sourceId);
  const limit = await run.service.search('science', { limit: 1 }); assert.equal(limit.results.length, 1);
});

test('search fallback is real RSS and blocked or empty results stay errors', async t => {
  const fallback = await setup(t, (req, res) => { if (req.headers.host === 'www.bing.com') { res.writeHead(403); res.end(); } else { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(rss); } });
  assert.equal((await fallback.service.search('science')).results.length, 2); assert.equal(fallback.requests.length, 2); assert.equal(new URL(fallback.requests[1].url).hostname, 'cn.bing.com');
  const blocked = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>Human verification</body></html>'); });
  await assert.rejects(blocked.service.search('science'), code('SEARCH_BLOCKED')); assert.equal(blocked.requests.length, 2);
  const empty = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end('<rss><channel></channel></rss>'); });
  await assert.rejects(empty.service.search('science'), code('SEARCH_EMPTY')); assert.equal(empty.requests.length, 1);
});

test('search rejects API credentials and local paths before any outbound request', async t => {
  const run = await setup(t);
  for (const value of ['sk-secretcredential123456789012345', 'Bearer abcdefghijklmnopqrstuvwxyz', 'api_key=privatevalue', 'C:\\Users\\person\\secret.txt 论文', '\\\\server\\private\\key', '/home/person/.config/key', 'https://provider.example.com/api?token=secret']) {
    await assert.rejects(run.service.search(value), code('QUERY_SENSITIVE'));
  }
  await assert.rejects(run.service.search(''), code('QUERY_INVALID')); await assert.rejects(run.service.search('x'.repeat(801)), code('QUERY_INVALID')); assert.equal(run.requests.length, 0);
});

test('read inputs cannot enable a private transport or dependency override', async t => {
  const run = await setup(t);
  await assert.rejects(run.service.read('http://127.0.0.1/secret', { allowPrivate: true, dependencies: { lookup: lookupPublic } }), code('URL_PRIVATE'));
  assert.equal(run.requests.length, 0);
});

test('fetched image elements supply literal public candidates without requesting images or credentials', async t => {
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>实验图片材料</title><meta property="og:image" content="/figures/summary.png"></head><body><main><p>这是一段用于说明对照实验和实际图片资料的正文，知识处理必须以真实图片为依据，不得只根据文件名猜测实验结论。</p><img alt="实验装置" data-src="/figures/apparatus.jpg" src="data:image/png;base64,abc"><img src="http://127.0.0.1/private.png"><img src="https://public.example.com/a.png?token=private"></main></body></html>'); });
  const result = await run.service.read('https://public.example.com/lesson');
  assert.ok(result.links.some(link => link.url === 'https://public.example.com/figures/apparatus.jpg'));
  assert.ok(result.links.some(link => link.url === 'https://public.example.com/figures/summary.png'));
  assert.ok(result.links.every(link => !/127\.0\.0\.1|token=|data:/.test(link.url))); assert.equal(run.requests.length, 1);
});

test('cancellation interrupts an unresolved DNS lookup before a connection opens', async t => {
  const run = await setup(t, undefined, { dependencies: { lookup: async () => new Promise(() => {}) } });
  const controller = new AbortController(), pending = run.service.read('https://public.example.com/a', { signal: controller.signal });
  const rejected = assert.rejects(pending, code('CANCELLED')); controller.abort(); await rejected; assert.equal(run.requests.length, 0);
});

test('cancellation and total timeout release a streaming response promptly', async t => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('pending science response'); began(); });
  const controller = new AbortController(), pending = run.service.read('https://public.example.com/a', { signal: controller.signal });
  const rejected = assert.rejects(pending, code('CANCELLED')); await started; controller.abort(); await rejected;
  const timed = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('pending science response'); }, { timeoutMs: 40 });
  await assert.rejects(timed.service.read('https://public.example.com/a'), code('TIMEOUT'));
});

test('closing the service aborts active work and rejects later calls', async t => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('pending science response'); began(); });
  const pending = run.service.read('https://public.example.com/a'), rejected = assert.rejects(pending, code('CANCELLED'));
  await started; await run.service.close(); await rejected; await assert.rejects(run.service.search('science'), code('CANCELLED'));
});

test('malformed HTML cannot block server cancellation while its parser is busy', async t => {
  let sent; const delivered = new Promise(resolve => { sent = resolve; });
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>' + '<script>'.repeat(100000) + '</body></html>'); sent(); });
  const controller = new AbortController(), pending = run.service.read('https://public.example.com/malformed', { signal: controller.signal });
  const rejected = assert.rejects(pending, code('CANCELLED')); await delivered;
  const started = Date.now(); setTimeout(() => controller.abort(), 100);
  await rejected; assert.ok(Date.now() - started < 2000, 'cancellation must remain responsive during HTML parsing');
});

test('PDF reading uses local bounded worker extraction and scan-only PDFs report that no OCR happened', async t => {
  const document = await readFile(new URL('./fixtures/science-documents/bilingual-paper.pdf', import.meta.url));
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(document); });
  const result = await run.service.read('https://public.example.com/paper.pdf', { maxChars: 4000 });
  assert.match(result.text, /力矩等于力/); assert.match(result.text, /Torque is the product/); assert.equal(result.pageCount, 3); assert.ok(result.warnings.some(item => /OCR/.test(item.message)));
  const scan = await readFile(new URL('./fixtures/science-documents/scan-only.pdf', import.meta.url));
  const empty = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(scan); });
  await assert.rejects(empty.service.read('https://public.example.com/scanned.pdf'), error => { assert.equal(error.code, 'ASSISTANT_WEB_PDF_NO_TEXT'); assert.match(error.message, /扫描件|OCR/); return true; });
});

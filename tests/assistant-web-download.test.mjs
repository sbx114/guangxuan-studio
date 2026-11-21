import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createAssistantWebService } from '../lib/assistant-web.mjs';
import { makeZip } from '../lib/documents.mjs';

const code = expected => error => { assert.equal(error.code, 'ASSISTANT_WEB_' + expected); return true; };
const publicIp = '93.184.216.34';
const lookupPublic = async () => [{ address: publicIp, family: 4 }];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pdf = await readFile(new URL('./fixtures/science-documents/bilingual-paper.pdf', import.meta.url));
const zip = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document>材料原文</document>' });
const html = Buffer.from('<!doctype html><html><title>材料</title><body><p>原始网页正文。</p><script>window.original = true;</script></body></html>');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function setup(t, handler, options = {}) {
  const sockets = new Set(), requests = [], lookups = [];
  const server = http.createServer(handler || ((_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length }); res.end(pdf); }));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (target, config) => {
    requests.push({ url: target.url.href, address: target.address, family: target.family });
    return new Promise((resolve, reject) => {
      // Construction-time fixture transport only. Download options cannot enable
      // local addresses; production connects directly to the pinned public IP.
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target.url.pathname + target.url.search, signal: config.signal, headers: { Host: target.url.host } }, resolve);
      req.once('error', reject); req.end();
    });
  };
  const service = createAssistantWebService({ ...options, dependencies: { lookup: async (...args) => { lookups.push(args); return (options.dependencies?.lookup || lookupPublic)(...args); }, request, ...options.dependencies } });
  t.after(async () => { await service.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { service, requests, lookups, server };
}

test('download returns the exact original PDF bytes, filename, content type, size and digest', async t => {
  const run = await setup(t), progress = [];
  const result = await run.service.download('https://files.example.com/%E7%A7%91%E5%AD%A6%E6%95%99%E6%9D%90.pdf?utm_source=news#page=2', { onProgress: item => progress.push(item) });
  assert.ok(Buffer.isBuffer(result.buffer)); assert.deepEqual(result.buffer, pdf); assert.equal(result.size, pdf.length); assert.equal(result.sha256, sha256(pdf));
  assert.equal(result.fileName, '科学教材.pdf'); assert.equal(result.contentType, 'application/pdf'); assert.equal(result.url, 'https://files.example.com/%E7%A7%91%E5%AD%A6%E6%95%99%E6%9D%90.pdf');
  assert.ok(progress.length >= 2); assert.equal(progress[0].receivedBytes, 0); assert.equal(progress.at(-1).receivedBytes, pdf.length); assert.equal(progress.at(-1).totalBytes, pdf.length);
  assert.equal(run.requests[0].address, publicIp);
});

test('scan-only PDF downloads preserve its bytes without attempting extraction or OCR', async t => {
  const scanned = await readFile(new URL('./fixtures/science-documents/scan-only.pdf', import.meta.url));
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(scanned); });
  assert.deepEqual((await run.service.download('https://files.example.com/scan.pdf')).buffer, scanned);
});

test('RFC5987 filenames take precedence, retain Unicode, discard paths and handle language or legacy charset', async t => {
  for (const [disposition, expected] of [
    ["attachment; filename=default.pdf; filename*=UTF-8'zh'%E8%AE%BA%E6%96%87%20%E5%AE%9A%E7%A8%BF.pdf", '论文 定稿.pdf'],
    ["attachment; filename*=UTF-8''..%2F..%2F%E6%95%99%E6%9D%90.pdf", '教材.pdf'],
    ["attachment; filename*=ISO-8859-1''caf%E9.pdf", 'café.pdf'],
    ["attachment; filename*=UTF-8''bad%QQ; filename=valid.pdf", 'valid.pdf'],
    ['attachment; filename="C:\\private\\paper.pdf"', 'paper.pdf'],
  ]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': disposition }); res.end(pdf); });
    assert.equal((await run.service.download('https://files.example.com/download')).fileName, expected);
  }
});

test('filenames are safe on Windows and preserve valid extensions when shortened', async t => {
  for (const [filename, expected] of [['../CON.pdf', '_CON.pdf'], ['NUL.txt', 'NUL.pdf'], ['COM1.pdf', '_COM1.pdf'], ['report:chapter?.pdf...', 'report_chapter_.pdf']]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${filename}"` }); res.end(pdf); });
    const result = await run.service.download('https://files.example.com/download');
    assert.equal(result.fileName, expected === 'NUL.pdf' ? '_NUL.pdf' : expected); assert.doesNotMatch(result.fileName, /[\\/:*?"<>|]/);
  }
  const longName = '研究'.repeat(160) + '.pdf';
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(longName) }); res.end(pdf); });
  const result = await run.service.download('https://files.example.com/download'); assert.ok(Array.from(result.fileName).length <= 180); assert.match(result.fileName, /\.pdf$/); assert.ok(result.fileName.startsWith('研究'));
});

test('Office, EPUB and ZIP bytes are saved without extraction and require a ZIP signature', async t => {
  const formats = [
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['epub', 'application/epub+zip'], ['zip', 'application/zip'], ['docx', 'application/zip'],
  ];
  for (const [extension, mime] of formats) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': mime }); res.end(zip); });
    const result = await run.service.download('https://files.example.com/book.' + extension);
    assert.deepEqual(result.buffer, zip); assert.equal(result.fileName, 'book.' + extension); assert.match(result.contentType, /zip|openxmlformats/); assert.ok(result.warnings.some(item => item.code === 'DOWNLOAD_ARCHIVE_NOT_EXTRACTED'));
    const invalid = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': mime }); res.end('not the Office file'); });
    await assert.rejects(invalid.service.download('https://files.example.com/book.' + extension), code('DOWNLOAD_TYPE_MISMATCH'));
  }
});

test('TXT, Markdown, CSV, JSON, original HTML and common images keep their original bytes', async t => {
  for (const [name, mime, bytes, expectedType] of [
    ['notes.txt', 'text/plain; charset=utf-8', Buffer.from('原始教材文字\r\nline two\r\n'), 'text/plain'],
    ['book.md', 'text/markdown', Buffer.from('# 章节\n\n**教材原文**'), 'text/markdown'],
    ['table.csv', 'text/csv', Buffer.from('名称,数值\r\n样本,4\r\n'), 'text/csv'],
    ['data.json', 'application/json', Buffer.from('{"教材":[1,2],"ok":true}\n'), 'application/json'],
    ['article.html', 'text/html', html, 'text/html'], ['picture.png', 'image/png', png, 'image/png'],
  ]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': mime }); res.end(bytes); });
    const result = await run.service.download('https://files.example.com/' + name);
    assert.deepEqual(result.buffer, bytes); assert.equal(result.sha256, sha256(bytes)); assert.equal(result.contentType, expectedType); assert.equal(result.fileName, name);
  }
});

test('trusted type and actual magic normalize a misleading extension while genuine HTML saves as HTML', async t => {
  const pdfRun = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename=paper.txt' }); res.end(pdf); });
  const result = await pdfRun.service.download('https://files.example.com/download'); assert.equal(result.fileName, 'paper.pdf'); assert.ok(result.warnings.some(item => item.code === 'DOWNLOAD_EXTENSION_NORMALIZED'));
  const page = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-disposition': 'attachment; filename=chapter.txt' }); res.end(html); });
  const saved = await page.service.download('https://files.example.com/article'); assert.equal(saved.fileName, 'chapter.html'); assert.deepEqual(saved.buffer, html); assert.ok(saved.buffer.includes(Buffer.from('<script>window.original')));
});

test('PDF URLs or declarations cannot save login pages, HTML containing a PDF marker, wrong signatures or fake JSON', async t => {
  for (const [url, type, body] of [
    ['paper.pdf', 'text/html', html], ['paper.pdf', 'application/octet-stream', html], ['download', 'application/pdf', html],
    ['paper.pdf', 'application/pdf', Buffer.from('<html><body>%PDF-1.7 This is a login page.</body></html>')],
    ['paper.pdf', 'application/pdf', Buffer.from('%PDF-FAKE not a document')], ['image.png', 'image/png', pdf],
    ['data.json', 'application/json', Buffer.from('not JSON')], ['data.json', 'application/octet-stream', Buffer.from('not JSON')],
  ]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': type }); res.end(body); });
    await assert.rejects(run.service.download('https://files.example.com/' + url), code('DOWNLOAD_TYPE_MISMATCH'));
  }
  const redirected = await setup(t, (req, res) => { if (req.url === '/paper.pdf') { res.writeHead(302, { location: '/login' }); res.end(); } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); } });
  await assert.rejects(redirected.service.download('https://files.example.com/paper.pdf'), code('DOWNLOAD_TYPE_MISMATCH'));
});

test('active filenames, MIME types and MZ bytes are rejected even with a friendly extension or declaration', async t => {
  for (const name of ['program.exe', 'do.cmd', 'do.bat', 'script.ps1', 'script.js', 'script.vbs', 'shortcut.lnk', 'component.dll', 'setup.msi', 'book.docm', 'book.xlsm', 'script.sh', 'script.py', 'program.exe.', '.js', '.exe']) {
    const run = await setup(t);
    await assert.rejects(run.service.download('https://files.example.com/' + name), code('DOWNLOAD_ACTIVE'));
  }
  for (const [mime, disposition, body] of [
    ['application/pdf', 'attachment; filename=setup.exe', pdf], ['text/javascript', 'attachment; filename=notes.txt', Buffer.from('alert(1)')],
    ['application/pdf', 'attachment; filename=paper.pdf', Buffer.from('MZ' + 'x'.repeat(100))],
    ['application/octet-stream', 'attachment; filename=notes.txt', Buffer.from([127, 69, 76, 70, 0, 0, 0, 0])],
  ]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': mime, 'content-disposition': disposition }); res.end(body); });
    await assert.rejects(run.service.download('https://files.example.com/file'), code('DOWNLOAD_ACTIVE'));
  }
});

test('octet-stream requires an allowed filename plus matching minimum magic or text', async t => {
  for (const [name, body, expected] of [['paper.pdf', pdf, 'application/pdf'], ['book.docx', zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['picture.png', png, 'image/png'], ['notes.txt', Buffer.from('原始文本'), 'text/plain']]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body); });
    assert.equal((await run.service.download('https://files.example.com/' + name)).contentType, expected);
  }
  for (const [name, body, expected] of [['download', pdf, 'DOWNLOAD_TYPE'], ['archive.bin', zip, 'DOWNLOAD_TYPE'], ['paper.pdf', Buffer.from('plain text'), 'DOWNLOAD_TYPE_MISMATCH'], ['notes.txt', png, 'DOWNLOAD_TYPE_MISMATCH'], ['notes.txt', Buffer.from([0, 1, 2, 3]), 'DOWNLOAD_TYPE_MISMATCH']]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body); });
    await assert.rejects(run.service.download('https://files.example.com/' + name), code(expected));
  }
});

test('downloads retain the same credential, public-DNS, redirect and anti-rebinding policy', async t => {
  const blocked = await setup(t);
  for (const value of ['file:///C:/paper.pdf', 'http://127.1/paper.pdf', 'http://169.254.169.254/paper.pdf', 'https://user:pass@files.example.com/paper.pdf', 'https://files.example.com/paper.pdf?token=private']) await assert.rejects(blocked.service.download(value), error => error.status === 400);
  assert.equal(blocked.requests.length, 0);
  let lookups = 0;
  const rebind = await setup(t, (_req, res) => { res.writeHead(302, { location: '/redirected.pdf' }); res.end(); }, { dependencies: { lookup: async () => [{ address: ++lookups === 1 ? publicIp : '127.0.0.1', family: 4 }] } });
  await assert.rejects(rebind.service.download('https://files.example.com/start.pdf'), code('URL_PRIVATE')); assert.equal(rebind.requests.length, 1);
  const downgrade = await setup(t, (_req, res) => { res.writeHead(302, { location: 'http://files.example.com/paper.pdf' }); res.end(); });
  await assert.rejects(downgrade.service.download('https://files.example.com/start.pdf'), code('URL_INVALID'));
});

test('valid public redirect uses the final URL and attachment name', async t => {
  const run = await setup(t, (req, res) => { if (req.url === '/start') { res.writeHead(302, { location: 'https://cdn.example.com/material.pdf?utm_campaign=paper' }); res.end(); } else { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename=final.pdf' }); res.end(pdf); } });
  const result = await run.service.download('https://files.example.com/start'); assert.equal(result.url, 'https://cdn.example.com/material.pdf'); assert.equal(result.fileName, 'final.pdf'); assert.equal(run.requests.length, 2);
});

test('transport compression preserves original file bytes and uses wire-byte progress', async t => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    const compressed = compress(pdf), progress = [];
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-encoding': encoding, 'content-length': compressed.length }); res.end(compressed); });
    const result = await run.service.download('https://files.example.com/paper.pdf', { onProgress: item => progress.push(item) });
    assert.deepEqual(result.buffer, pdf); assert.equal(result.size, pdf.length); assert.equal(progress.at(-1).receivedBytes, compressed.length); assert.equal(progress.at(-1).totalBytes, compressed.length);
  }
});

test('the 64MiB default download cap differs from the original read limit', async t => {
  const body = Buffer.alloc(13 * 1024 * 1024, 65);
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length }); res.end(body); });
  const result = await run.service.download('https://files.example.com/big.txt'); assert.equal(result.size, body.length); assert.equal(result.sha256, sha256(body));
  await assert.rejects(run.service.read('https://files.example.com/big.txt'), code('TOO_LARGE'));
  const tooBig = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 64 * 1024 * 1024 + 1 }); res.end(); });
  await assert.rejects(tooBig.service.download('https://files.example.com/big.txt'), code('TOO_LARGE'));
});

test('declared, streamed and decoded size caps reject the entire download, with no partial result', async t => {
  const declared = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 1000000 }); res.end(); }, { maxDownloadBytes: 512 });
  await assert.rejects(declared.service.download('https://files.example.com/a.txt'), code('TOO_LARGE'));
  const streamed = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('a'.repeat(400)); res.end('b'.repeat(400)); }, { maxDownloadBytes: 512 });
  await assert.rejects(streamed.service.download('https://files.example.com/a.txt'), code('TOO_LARGE'));
  const bomb = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(100000, 65))); }, { maxDownloadBytes: 1024 });
  await assert.rejects(bomb.service.download('https://files.example.com/a.txt'), code('TOO_LARGE'));
});

test('partial HTTP status, incomplete transmission, failures and empty files never succeed', async t => {
  for (const [status, headers, body, expected] of [
    [206, { 'content-type': 'application/pdf', 'content-range': 'bytes 0-5/100' }, pdf.subarray(0, 6), 'DOWNLOAD_PARTIAL'],
    [200, { 'content-type': 'application/pdf', 'content-range': 'bytes 0-5/100' }, pdf.subarray(0, 6), 'DOWNLOAD_PARTIAL'],
    [404, { 'content-type': 'text/html' }, html, 'HTTP'], [403, {}, Buffer.from('Forbidden'), 'BLOCKED'],
    [200, { 'content-type': 'application/pdf' }, Buffer.alloc(0), 'DOWNLOAD_EMPTY'],
  ]) {
    const run = await setup(t, (_req, res) => { res.writeHead(status, headers); res.end(body); });
    await assert.rejects(run.service.download('https://files.example.com/paper.pdf'), code(expected));
  }
  const interrupted = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length + 100 }); res.write(pdf); setTimeout(() => res.destroy(), 15); });
  await assert.rejects(interrupted.service.download('https://files.example.com/paper.pdf'), code('BODY'));
});

test('download cancellation, its separate timeout and service close abort active streams', async t => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write(pdf); began(); });
  const controller = new AbortController(), pending = run.service.download('https://files.example.com/paper.pdf', { signal: controller.signal });
  const rejected = assert.rejects(pending, code('CANCELLED')); await started; controller.abort(); await rejected;
  const timed = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write(pdf); }, { timeoutMs: 1000, downloadTimeoutMs: 40 });
  await assert.rejects(timed.service.download('https://files.example.com/paper.pdf'), code('TIMEOUT'));
  let received; const open = new Promise(resolve => { received = resolve; });
  const closing = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write(pdf); received(); });
  const active = closing.service.download('https://files.example.com/paper.pdf'), stopped = assert.rejects(active, code('CANCELLED'));
  await open; await closing.service.close(); await stopped; await assert.rejects(closing.service.download('https://files.example.com/paper.pdf'), code('CANCELLED'));
});

test('downloads use a separate two-operation concurrency cap and release slots after cancellation', async t => {
  let connections = 0, ready; const both = new Promise(resolve => { ready = resolve; });
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write(pdf); if (++connections === 2) ready(); });
  const a = new AbortController(), b = new AbortController();
  const first = run.service.download('https://files.example.com/a.pdf', { signal: a.signal }), second = run.service.download('https://files.example.com/b.pdf', { signal: b.signal });
  const failA = assert.rejects(first, code('CANCELLED')), failB = assert.rejects(second, code('CANCELLED')); await both;
  await assert.rejects(run.service.download('https://files.example.com/c.pdf'), code('DOWNLOAD_BUSY')); a.abort(); b.abort(); await Promise.all([failA, failB]);
  const c = new AbortController(), third = run.service.download('https://files.example.com/c.pdf', { signal: c.signal }), failC = assert.rejects(third, code('CANCELLED')); c.abort(); await failC;
});

test('progress observers cannot corrupt the file and unknown totals are omitted', async t => {
  const values = [];
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write(pdf.subarray(0, 100)); setTimeout(() => res.end(pdf.subarray(100)), 15); });
  const result = await run.service.download('https://files.example.com/paper.pdf', { onProgress: value => { values.push(value); throw new Error('UI observer failed'); } });
  assert.deepEqual(result.buffer, pdf); assert.ok(values.every(value => !Object.hasOwn(value, 'totalBytes'))); assert.equal(values.at(-1).receivedBytes, pdf.length);
});

test('large JSON validation stays in a bounded worker and cannot return malformed JSON as a file', async t => {
  const value = Buffer.from(JSON.stringify({ records: '原始数据'.repeat(60000) }));
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(value); });
  assert.deepEqual((await run.service.download('https://files.example.com/records.json')).buffer, value);
  const invalid = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(Buffer.concat([value, Buffer.from('BROKEN')])); });
  await assert.rejects(invalid.service.download('https://files.example.com/records.json'), code('DOWNLOAD_TYPE_MISMATCH'));
});

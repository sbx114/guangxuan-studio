import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutPoster, exportPosterImage } from '../public/poster-export.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = () => ({ font: '', measureText(text) { return { width: Array.from(text).length * Number(this.font.match(/(\d+)px/)[1]) * .8 }; } });
const fullPoster = () => ({ eyebrow: '栏目完整保留', title: '完整导出'.repeat(30), subtitle: '副标题'.repeat(100), highlights: Array.from({ length: 8 }, (_, index) => `亮点${index + 1}全部保留`), details: Array.from({ length: 10 }, (_, index) => ({ label: `字段${index + 1}`, value: `值${index + 1}完整信息` })), footer: '最后信息'.repeat(150) });
const expectedText = output => [output.eyebrow, output.title, output.subtitle, ...output.highlights, ...output.details.map(item => item.label + '  ' + item.value), output.footer];

test('poster layout preserves every supported item and long field inside its measured canvas', () => {
  const output = fullPoster(), layout = layoutPoster(context(), output), rendered = layout.lines.map(line => line.text).join('');
  for (const value of expectedText(output)) assert.ok(rendered.includes(value), 'Missing field: ' + value.slice(0, 40));
  assert.ok(layout.height > 1440); assert.equal(layout.width, 1080);
  assert.ok(layout.lines.every(line => line.y + line.size < layout.height - 36));
  assert.ok(layout.lines.every((line, index) => !index || line.y > layout.lines[index - 1].y), 'Text baselines must never overlap');
  const unicode = layoutPoster(context(), { title: '中文🙂\n第二行', footer: '' });
  assert.equal(unicode.lines.map(line => line.text).join('\n'), '中文🙂\n第二行');
});

test('poster refuses an unsafe canvas size before painting or saving any partial image', async () => {
  const ctx = context(); let painted = false, saved = false;
  ctx.fillRect = () => { painted = true; };
  await assert.rejects(() => exportPosterImage({ title: '长稿', details: [{ label: '正文', value: '长'.repeat(30000) }] }, { document: { createElement: () => ({ getContext: () => ctx }) }, saveFile: () => { saved = true; }, safeName: value => value }), /高度上限/);
  assert.equal(painted, false); assert.equal(saved, false);
});

test('poster waits for fonts and reports a null encoder result without saving a fake PNG', async () => {
  let releaseFonts, created = false, saved = false;
  const ready = new Promise(resolve => { releaseFonts = resolve; }), ctx = Object.assign(context(), Object.fromEntries(['fillRect', 'strokeRect', 'save', 'restore', 'translate', 'beginPath', 'arc', 'stroke', 'moveTo', 'lineTo', 'fillText'].map(key => [key, () => {}])));
  const exporting = exportPosterImage({ title: '测试', footer: '完整内容' }, { document: { fonts: { ready }, createElement: () => { created = true; return { getContext: () => ctx, toBlob: callback => callback(null) }; } }, saveFile: () => { saved = true; }, safeName: value => value });
  await Promise.resolve(); assert.equal(created, false); releaseFonts();
  await assert.rejects(exporting, /图片生成失败/); assert.equal(saved, false);
});

test('Edge exports a real complete PNG with the measured dynamic dimensions', { timeout: 60000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  t.after(() => browser.close());
  const module = await fs.readFile(path.join(root, 'public/poster-export.js'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': req.url === '/poster-export.js' ? 'text/javascript' : 'text/html' }); res.end(req.url === '/poster-export.js' ? module : '<!doctype html><meta charset="utf-8"><title>Poster export fixture</title>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const output = fullPoster(), result = await page.evaluate(async output => {
    const { exportPosterImage } = await import('/poster-export.js'), drawn = [], original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) { drawn.push({ text, y }); return original.call(this, text, x, y, ...rest); };
    let result;
    await exportPosterImage(output, { document, safeName: value => value, saveFile: async (name, blob) => {
      const bitmap = await createImageBitmap(blob), bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = ''; for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
      result = { name, width: bitmap.width, height: bitmap.height, type: blob.type, base64: btoa(binary), drawn }; bitmap.close();
    } });
    return result;
  }, output);
  const bytes = Buffer.from(result.base64, 'base64'), rendered = result.drawn.map(line => line.text).join('');
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(result.type, 'image/png'); assert.equal(result.width, 1080); assert.ok(result.height > 1440);
  assert.equal(bytes.readUInt32BE(16), result.width); assert.equal(bytes.readUInt32BE(20), result.height);
  for (const value of expectedText(output)) assert.ok(rendered.includes(value));
  if (process.env.GUANGXUAN_POSTER_UI_EVIDENCE) {
    const evidence = path.resolve(process.env.GUANGXUAN_POSTER_UI_EVIDENCE); await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'poster-complete.png'), bytes);
    await fs.writeFile(path.join(evidence, 'poster-browser-verification.json'), JSON.stringify({ status: 'passed', actualBrowser: 'Edge', width: result.width, height: result.height, bytes: bytes.length, allEightHighlightsAndTenDetailsPreserved: true, longFieldsPreserved: true }, null, 2));
  }
});

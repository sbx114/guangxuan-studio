import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { hydratePlayableNovel } from './visual-novel.mjs';
import { resolveNovelArt } from '../public/visual-novel-art.js';
import { createNovelPlayer } from '../public/visual-novel-player.js';
import { AppError } from './errors.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** Same fixed offline reader and embedded assets as the product's manual exports. */
export async function exportAssistantNovel(project, { novelLibrary, format, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), signal } = {}) {
  if (!['html', 'json'].includes(format)) throw new AppError(400, '请选择HTML或JSON导出互动作品。', 'ASSISTANT_NOVEL_EXPORT_FORMAT');
  signal?.throwIfAborted();
  const resources = await novelLibrary.resolveSelection(project.science.novel.librarySelection, { signal }), value = hydratePlayableNovel(project.science.novel, resources);
  const referenced = new Map(), images = {}; let total = 0;
  for (const background of value.backgrounds) if (background.assetId) referenced.set(background.assetId, { kind: 'background', name: background.name });
  for (const character of value.characters) for (const pose of character.portraits) if (pose.assetId) referenced.set(pose.assetId, { kind: 'portrait', name: character.name + ' · ' + pose.name });
  for (const [id, meta] of referenced) {
    signal?.throwIfAborted(); const asset = await novelLibrary.file(id); total += asset.bytes.length;
    if (total > 30 * 1024 * 1024) throw new AppError(413, '离线导出所用图片合计超过30MB，请压缩图片后再导出。', 'ASSISTANT_NOVEL_EXPORT_LIMIT');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.contentType)) throw new AppError(422, '公用图片格式无效。', 'ASSISTANT_NOVEL_EXPORT_IMAGE');
    images[id] = { ...meta, mimeType: asset.contentType, dataUrl: 'data:' + asset.contentType + ';base64,' + asset.bytes.toString('base64') };
  }
  if (format === 'json') return { buffer: Buffer.from(JSON.stringify({ format: 'gx-visual-novel', version: 2, novel: value, assets: images }, null, 2)), contentType: 'application/json', extension: '.gxnovel.json', title: value.title };
  const art = resolveNovelArt(project.id, value);
  for (const background of value.backgrounds) art.backgrounds[background.id] = images[background.assetId].dataUrl;
  for (const character of value.characters) for (const pose of character.portraits) art.portraits[character.id][pose.id] = images[pose.assetId].dataUrl;
  const css = await readFile(path.join(root, 'public', 'visual-novel-reader.css'), 'utf8'); signal?.throwIfAborted();
  const json = JSON.stringify({ novel: value, art }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; font-src \'none\'; base-uri \'none\'"><title>' + escape(value.title) + '</title><style>html,body{margin:0;width:100%;height:100%;background:#10242f}#novel{height:100%}#novel>.vn-player{height:100dvh;min-height:100dvh;border:0;border-radius:0}' + css + '</style></head><body><main id="novel"></main><script type="application/json" id="novel-data">' + json + '</script><script>(' + createNovelPlayer.toString() + ')(document.getElementById("novel"),JSON.parse(document.getElementById("novel-data").textContent).novel,{art:JSON.parse(document.getElementById("novel-data").textContent).art});</script></body></html>';
  return { buffer: Buffer.from(html), contentType: 'text/html; charset=utf-8', extension: '-视觉小说.html', title: value.title };
}

import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocx } from './documents.mjs';

const MAX_TEXT = 2_000_000, MAX_PAGES = 800, MAX_PAGE_TEXT = 150_000;
const failure = (message, code) => Object.assign(new Error(message), { code });
const isScienceError = value => typeof value?.code === 'string' && value.code.startsWith('SCIENCE_');
function cleanText(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '').normalize('NFC');
  if (text.includes('\0')) throw failure('资料中包含非文本内容，请重新导入有效文字文件。', 'SCIENCE_DOCUMENT_INVALID_TEXT');
  return text;
}
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer); } catch { throw failure('无法识别文件编码，请另存为UTF-8文本后导入。', 'SCIENCE_DOCUMENT_ENCODING'); } }
}
function qualityWarning(text, page) {
  const invalid = (text.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
  return invalid > 0 && invalid / Math.max(1, text.length) > .01 ? { code: 'TEXT_GLYPHS_UNCERTAIN', message: (page ? '第' + page + '页' : '资料') + '含无法可靠还原的字形，请核对公式、符号与原文。', ...(page ? { page } : {}) } : null;
}
async function pdfDocument(buffer) {
  if (!buffer.subarray(0, Math.min(1024, buffer.length)).includes(Buffer.from('%PDF-'))) throw failure('文件内容不是有效PDF，请确认文件类型。', 'SCIENCE_PDF_INVALID');
  const { getDocumentProxy } = await import('unpdf');
  const assets = fileURLToPath(new URL('./science-pdf-assets/', import.meta.url));
  let document;
  try {
    document = await getDocumentProxy(new Uint8Array(buffer), {
      isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
      useWorkerFetch: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      maxImageSize: 1_000_000, cMapPacked: true,
      cMapUrl: path.join(assets, 'cmaps').replaceAll('\\', '/') + '/',
      standardFontDataUrl: path.join(assets, 'standard_fonts').replaceAll('\\', '/') + '/',
    });
    if (!Number.isInteger(document.numPages) || document.numPages < 1) throw failure('PDF中没有可读取的页面。', 'SCIENCE_PDF_INVALID');
    if (document.numPages > MAX_PAGES) throw failure('PDF超过800页，请先导出需要的章节后导入。', 'SCIENCE_DOCUMENT_PAGE_LIMIT');
    const pages = [], warnings = [];
    let total = 0, readable = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number), content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
        if (text.length > MAX_PAGE_TEXT) throw failure('单页文字过多，请拆分页面或导出为文本后导入。', 'SCIENCE_DOCUMENT_TEXT_LIMIT');
      }
      text = cleanText(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      total += text.length;
      if (total > MAX_TEXT) throw failure('资料超过200万个字符，请按章节拆分后导入。', 'SCIENCE_DOCUMENT_TEXT_LIMIT');
      if (text) readable++; else warnings.push({ code: 'PAGE_WITHOUT_TEXT', page: number, message: '第' + number + '页没有可提取文字，可能为空白或扫描页；未执行OCR。' });
      const warning = qualityWarning(text, number); if (warning) warnings.push(warning);
      pages.push({ page: number, label: '第' + number + '页', text });
      page.cleanup?.();
    }
    if (!readable) throw failure('PDF没有可提取文字。扫描件请先执行OCR，或粘贴正文后导入。', 'SCIENCE_PDF_NO_TEXT');
    let title = '';
    try { const metadata = await document.getMetadata(); if (typeof metadata.info?.Title === 'string') title = metadata.info.Title.trim().slice(0, 300); } catch {}
    warnings.push({ code: 'PDF_LAYOUT_REVIEW', message: '已按原页保留提取文字；公式、表格和双栏阅读顺序请与原文件核对。未执行OCR。' });
    return { title, pages, pageCount: document.numPages, warnings };
  } catch (error) {
    if (isScienceError(error)) throw error;
    if (error.name === 'PasswordException') throw failure('PDF受到密码保护，请解密后重新导入。', 'SCIENCE_PDF_PASSWORD_REQUIRED');
    throw failure('PDF无法解析，请另存为标准PDF或导入正文文本。', 'SCIENCE_PDF_INVALID');
  } finally { try { await document?.cleanup?.(); await document?.loadingTask?.destroy?.(); } catch {} }
}
async function run() {
  const buffer = Buffer.from(workerData.bytes), format = workerData.format;
  if (format === 'pdf') return pdfDocument(buffer);
  let text;
  if (format === 'docx') {
    try { text = extractDocx(buffer); }
    catch (error) { throw failure(error.code === 'INVALID_DOCX' ? error.message : 'DOCX无法解析，请另存为标准Word文档后导入。', 'SCIENCE_DOCX_INVALID'); }
  } else text = decodeText(buffer);
  text = cleanText(text).trim();
  if (!text) throw failure('文件没有可导入的文字，请粘贴正文或选择文本型文档。', 'SCIENCE_DOCUMENT_EMPTY');
  if (text.length > MAX_TEXT) throw failure('资料超过200万个字符，请按章节拆分后导入。', 'SCIENCE_DOCUMENT_TEXT_LIMIT');
  const warning = qualityWarning(text);
  return { title: '', pages: [{ label: '正文', text }], pageCount: null, warnings: [...(warning ? [warning] : []), ...(format === 'docx' ? [{ code: 'DOCX_TEXT_ONLY', message: '已提取Word正文；图片、公式对象和表格布局不作为已识别内容，请核对原文件。' }] : [])] };
}
try { parentPort.postMessage({ ok: true, result: await run() }); }
catch (error) { parentPort.postMessage({ ok: false, error: { code: isScienceError(error) ? error.code : 'SCIENCE_DOCUMENT_PARSE_FAILED', message: isScienceError(error) ? error.message : '资料解析未完成，请更换文件或导入文本。' } }); }
finally { parentPort.close(); }

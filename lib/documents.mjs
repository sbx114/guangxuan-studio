import { inflateRawSync } from 'node:zlib';
import { AppError, boundedString, requireObject } from './errors.mjs';

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TEXT = 60000;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit++) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipError(message = 'DOCX 文件损坏或格式不受支持。请另存为标准 DOCX，或直接粘贴文字。') {
  return new AppError(400, message, 'INVALID_DOCX');
}

export function readZipEntry(buffer, entryName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_FILE) throw zipError();
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { eocd = offset; break; }
  }
  if (eocd < 0 || buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)) throw zipError();
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count > 2000 || count === 0xffff || offset + centralSize > eocd) throw zipError();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw zipError();
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedLength = buffer.readUInt32LE(offset + 20);
    const originalLength = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > buffer.length) throw zipError();
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset = entryEnd;
    if (name !== entryName) continue;
    if (flags & 1) throw zipError('暂不支持加密 DOCX。请解密后导入，或粘贴正文。');
    if (originalLength > MAX_FILE || compressedLength > MAX_FILE || localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw zipError();
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedLength > buffer.length) throw zipError();
    const compressed = buffer.subarray(dataStart, dataStart + compressedLength);
    let data;
    try {
      if (compression === 0) data = Buffer.from(compressed);
      else if (compression === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_FILE });
      else throw zipError('DOCX 的压缩格式不受支持，请另存后导入。');
    } catch (error) { if (error instanceof AppError) throw error; throw zipError(); }
    if (data.length !== originalLength || crc32(data) !== expectedCrc) throw zipError();
    return data;
  }
  throw zipError('文件中没有找到 Word 正文。请选择 DOCX 文档。');
}

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(names, entity)) return names[entity];
    const number = entity.toLowerCase().startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  });
}

export function extractDocx(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw zipError();
  const tokens = /<(?:[\w.-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t\s*>|<\/(?:[\w.-]+:)?p\s*>|<(?:[\w.-]+:)?(?:tab|br|cr)\b[^>]*\/?>/g;
  let text = '';
  for (const match of xml.matchAll(tokens)) {
    if (match[1] !== undefined) text += decodeXml(match[1].replace(/<[^>]*>/g, ''));
    else text += /(?:^|:)tab\b/.test(match[0]) ? '\t' : '\n';
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
    catch { throw new AppError(400, '文本编码无法识别，请另存为 UTF-8 后导入。', 'INVALID_ENCODING'); }
  }
}

export function importDocument(input) {
  requireObject(input);
  const name = boundedString(input.name, '文件名', 300);
  const base64 = boundedString(input.contentBase64, '文件内容', Math.ceil(MAX_FILE * 4 / 3) + 8);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) throw new AppError(400, '文件内容编码不正确。', 'INVALID_FILE');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_FILE) throw new AppError(400, '请选择非空且不超过 10 MB 的文件。', 'FILE_TOO_LARGE');
  const extension = name.split('.').at(-1).toLowerCase();
  let text;
  if (extension === 'docx') text = extractDocx(buffer);
  else if (['txt', 'md', 'markdown'].includes(extension)) text = decodeText(buffer).replace(/^\uFEFF/, '').trim();
  else throw new AppError(400, '当前支持 TXT、Markdown 和 DOCX。其他文件可以先复制正文粘贴。', 'UNSUPPORTED_FILE');
  if (!text.trim()) throw new AppError(400, '没有提取到文字。图片或扫描件需要先转换成文字。', 'EMPTY_DOCUMENT');
  if (text.includes('\0')) throw new AppError(400, '文件中含有非文本内容，请导入有效文本。', 'INVALID_FILE');
  if (text.length > MAX_TEXT) throw new AppError(400, `材料超过 ${MAX_TEXT} 个字符，请拆分后导入。`, 'INPUT_TOO_LARGE');
  return { name, text, characterCount: text.length };
}

function xmlEscape(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [filename, content] of Object.entries(files)) {
    const name = Buffer.from(filename, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

export function createDocx(input) {
  requireObject(input);
  const title = boundedString(input.title, '文档标题', 500);
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 100) throw new AppError(400, '文档需要包含至少一个内容段落。', 'INVALID_DOCUMENT');
  const paragraphs = [];
  const paragraph = (text, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  paragraphs.push(paragraph(title, 'Title'));
  let total = 0;
  for (const section of input.sections) {
    requireObject(section, '文档段落');
    const heading = boundedString(section.heading, '段落标题', 1000, { optional: true });
    const content = boundedString(section.content, '段落正文', 180000, { optional: true });
    total += content.length + heading.length;
    if (total > 300000) throw new AppError(400, '导出内容过长，请分批导出。', 'INPUT_TOO_LARGE');
    if (heading) paragraphs.push(paragraph(heading, 'Heading1'));
    for (const line of content.replace(/\r\n?/g, '\n').split('\n')) paragraphs.push(paragraph(line));
  }
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="330" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="300"/></w:pPr><w:rPr><w:b/><w:color w:val="174B40"/><w:sz w:val="38"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>光宣工作台</dc:creator><dc:description>用户审核及导出的宣传草稿</dc:description></cp:coreProperties>`,
    'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Guangxuan Studio</Application></Properties>',
  };
  return makeZip(files);
}

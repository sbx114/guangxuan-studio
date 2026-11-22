import { createHash } from 'node:crypto';
import net from 'node:net';
import { AppError } from './errors.mjs';
import { isPublicReferenceAddress } from './reference-url.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, limit = 300) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
const fail = message => new AppError(400, message, 'ASSISTANT_MATERIAL_INVALID');
const SENSITIVE = /^(?:key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|auth|signature|x-amz-.+|x-goog-.+)$/i;
const TRACKING = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|yclid|_ga)$/i;
export function publicMaterialUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw fail('材料来源需要完整公开网址。');
  let url; try { url = new URL(value); } catch { throw fail('材料来源网址无效。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && url.port !== (url.protocol === 'https:' ? '443' : '80') || !host || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(host) || net.isIP(host) && !isPublicReferenceAddress(host) || !host.includes('.') && !net.isIP(host) || [...url.searchParams.keys()].some(key => SENSITIVE.test(key))) throw fail('材料来源仅支持不含凭据的公开HTTP(S)网址。');
  url.hash = ''; for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url.href;
}
const sourceId = url => 'web-' + hash(url).slice(0, 20);
const kindOfUrl = url => /\.(?:png|jpe?g|webp|bmp|gif|avif|tiff?)(?:[?#]|$)/i.test(url) ? 'image' : /\.(?:mp4|m4v|mov|webm|ogv|avi)(?:[?#]|$)/i.test(url) ? 'video' : /\.(?:mp3|wav|m4a|ogg|flac)(?:[?#]|$)/i.test(url) ? 'audio' : /\.(?:pdf|docx|pptx|xlsx|txt|md|csv|epub)(?:[?#]|$)/i.test(url) ? 'document' : null;
const integerDimension = value => /^[1-9]\d{0,4}$/.test(value || '') && Number(value) <= 64000 ? Number(value) : null;

/** Literal fetched-page metadata only; file contents and legal applicability are not inferred. */
export function discoverMaterialCandidates(html, pageUrl, { attribute, plain, normalizeUrl = publicMaterialUrl, title = '' } = {}) {
  html = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|canvas|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const sourceUrl = normalizeUrl(pageUrl), page = { id: sourceId(sourceUrl), url: sourceUrl, title: text(title) || new URL(sourceUrl).hostname };
  const baseHref = [...html.matchAll(/<base\b([^>]*)>/gi)].map(match => attribute(match[1], 'href')).find(Boolean);
  let baseUrl = sourceUrl, relativeAllowed = true;
  if (baseHref) try { baseUrl = new URL(baseHref, sourceUrl).href; } catch { relativeAllowed = false; }
  const resolve = href => { if (!relativeAllowed && !/^[a-z][a-z0-9+.-]*:/i.test(href)) throw fail('该相对链接没有可解析的base。'); return normalizeUrl(new URL(href, baseUrl).href); };
  const meta = [...html.matchAll(/<meta\b([^>]*)>/gi)].map(match => ({ name: (attribute(match[1], 'property') || attribute(match[1], 'name')).toLowerCase(), value: attribute(match[1], 'content') }));
  const author = meta.find(item => ['author', 'dc.creator', 'dcterms.creator'].includes(item.name))?.value;
  if (author) page.authorDeclared = text(author, 160);
  let pageRights = { status: 'unknown', applicability: 'unconfirmed-for-asset', verification: 'not-legally-verified' };
  for (const match of html.matchAll(/<(?:a|link)\b([^>]*)>(?:([^<]*)<\/a\s*>)?/gi)) {
    if (!/(?:^|\s)license(?:\s|$)/i.test(attribute(match[1], 'rel'))) continue;
    try { pageRights = { status: 'page-declaration', licenseUrl: resolve(attribute(match[1], 'href')), statement: text(plain(match[2] || '页面声明的许可链接')), evidenceUrl: sourceUrl, applicability: 'unconfirmed-for-asset', verification: 'not-legally-verified' }; break; } catch {}
  }
  const result = [], seen = new Map();
  const add = (href, kind, label, origin, attrs = '') => {
    if (!href || href.startsWith('#') || result.length >= 24) return;
    try {
      const url = resolve(href), type = kind || kindOfUrl(url); if (!type) return;
      const width = integerDimension(attribute(attrs, 'width')), height = integerDimension(attribute(attrs, 'height'));
      const candidate = { id: 'material-' + hash(sourceUrl + '\n' + url).slice(0, 24), kind: type, url, title: text(plain(label || '')) || page.title,
        sourcePage: { ...page }, discoveredBy: origin, contentVerified: false, rights: { ...pageRights },
        ...(width && height ? { declaredDimensions: { width, height, basis: 'html-element', verified: false } } : {}),
        inspectionRequired: ['image', 'video', 'audio'].includes(type), nextSteps: type === 'document' ? ['download-original', 'import-and-read-original', 'cite-source'] : ['download-original', 'import-current-project', 'read-actual-metadata-and-frames', 'cite-source'] };
      const ownLicense = attribute(attrs, 'data-license-url');
      if (ownLicense) try { candidate.rights = { status: 'asset-declaration', licenseUrl: resolve(ownLicense), statement: text(attribute(attrs, 'data-license') || '原页面对该链接资产的许可声明'), evidenceUrl: sourceUrl, applicability: 'declared-for-linked-asset', verification: 'not-legally-verified' }; } catch {}
      const previous = seen.get(url);
      if (previous) { if (!previous.declaredDimensions && candidate.declaredDimensions) previous.declaredDimensions = candidate.declaredDimensions; if (origin === 'file-link') previous.discoveredBy = origin; return previous; }
      seen.set(url, candidate); result.push(candidate);
      return candidate;
    } catch {}
  };
  // Direct original-file anchors take priority over thumbnails and navigation.
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) add(attribute(match[1], 'href'), null, plain(match[2]), 'file-link', match[1]);
  for (const match of html.matchAll(/<(video|audio|source)\b([^>]*)>/gi)) {
    const declaredType = attribute(match[2], 'type'), tag = match[1].toLowerCase(), kind = tag === 'audio' || /^audio\//i.test(declaredType) ? 'audio' : /^image\//i.test(declaredType) ? 'image' : tag === 'video' || /^video\//i.test(declaredType) ? 'video' : null;
    add(attribute(match[2], 'src'), kind, attribute(match[2], 'title') || attribute(match[2], 'aria-label'), 'media-element', match[2]);
    if (match[1].toLowerCase() === 'video') add(attribute(match[2], 'poster'), 'image', page.title + ' · 封面', 'video-poster', match[2]);
  }
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const label = attribute(match[1], 'alt') || attribute(match[1], 'title');
    for (const key of ['data-original', 'data-src', 'src']) add(attribute(match[1], key), 'image', label, key === 'src' ? 'image-element' : 'image-original-attribute', match[1]);
    const srcset = attribute(match[1], 'srcset');
    if (srcset && !/\?[^\s]*,/.test(srcset)) for (const part of srcset.split(',')) {
      const entry = /^\s*(\S+)\s+(\d+(?:\.\d+)?[wx])\s*$/.exec(part); if (entry) add(entry[1], 'image', label, 'image-srcset', match[1]);
    }
  }
  for (const entry of meta) if (/^og:(image|video)(?::(?:url|secure_url))?$/.test(entry.name)) {
    const kind = entry.name.startsWith('og:video') ? 'video' : 'image', candidate = add(entry.value, kind, page.title, 'open-graph');
    const width = integerDimension(meta.find(item => item.name === `og:${kind}:width`)?.value), height = integerDimension(meta.find(item => item.name === `og:${kind}:height`)?.value);
    if (candidate && !candidate.declaredDimensions && width && height) candidate.declaredDimensions = { width, height, basis: 'open-graph', verified: false };
  }
  return { materialCandidates: result, rightsDeclaration: pageRights, pageSource: page };
}

export function rankMaterialCandidates(candidates, { query = '', kind, aspect } = {}) {
  const tokens = [...new Set(text(query, 800).toLowerCase().split(/[\s,，、;；]+/).filter(value => value.length > 1))].slice(0, 12);
  const ratio = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }[aspect];
  return candidates.filter(candidate => !kind || candidate.kind === kind).map(candidate => {
    const haystack = `${candidate.title} ${candidate.sourcePage?.title || ''}`.toLowerCase(), reasons = [];
    let score = 0; for (const token of tokens) if (haystack.includes(token)) { score += 2; reasons.push('页面标题/说明匹配关键词：' + token); }
    if (candidate.discoveredBy === 'file-link' || candidate.discoveredBy === 'image-original-attribute') { score += 1; reasons.push('网页提供原文件链接；仍需实际下载核对'); }
    const size = candidate.declaredDimensions;
    if (ratio && size && Math.abs(Math.log(size.width / size.height / ratio)) < .2) { score += 1; reasons.push('HTML声明画幅近似匹配，未核对文件实际尺寸'); }
    return { ...candidate, match: { score, reasons, basis: 'retrieved-page-metadata', semanticMatchVerified: false, motionVerified: false } };
  }).sort((a, b) => b.match.score - a.match.score);
}

export function normalizeMaterialProvenance(value = {}, { requestedUrl, finalUrl, sha256, size } = {}) {
  const finalValue = finalUrl || value.finalUrl || value.url;
  const originalUrl = publicMaterialUrl(requestedUrl || value.requestedUrl || finalValue || value.sourcePage?.url);
  const actualUrl = finalValue ? publicMaterialUrl(finalValue) : null;
  let page;
  try { if (value.sourcePage?.url) { const url = publicMaterialUrl(value.sourcePage.url); page = { id: sourceId(url), url, title: text(value.sourcePage.title), ...(text(value.sourcePage.authorDeclared, 160) ? { authorDeclared: text(value.sourcePage.authorDeclared, 160) } : {}), ...(Number.isFinite(Date.parse(value.sourcePage.retrievedAt)) ? { retrievedAt: value.sourcePage.retrievedAt } : {}) }; } } catch {}
  const rawRights = value.rights || {}, rights = { status: 'unknown', verification: 'not-legally-verified' };
  if (['page-declaration', 'asset-declaration'].includes(rawRights.status)) {
    try { const licenseUrl = publicMaterialUrl(rawRights.licenseUrl), evidenceUrl = publicMaterialUrl(rawRights.evidenceUrl || page?.url); Object.assign(rights, { licenseUrl, evidenceUrl, status: rawRights.status, statement: text(rawRights.statement), applicability: rawRights.status === 'page-declaration' ? 'unconfirmed-for-asset' : 'declared-for-linked-asset' }); } catch {}
  }
  return { version: 1, requestedUrl: originalUrl, ...(actualUrl ? { finalUrl: actualUrl } : {}), locatorUrl: actualUrl || originalUrl, transportUrlVerified: Boolean(finalUrl || actualUrl && value.transportUrlVerified === true), sourceId: sourceId(page?.url || actualUrl || originalUrl), ...(page ? { sourcePage: page } : {}),
    ...(typeof value.candidateId === 'string' && /^material-[a-f0-9]{24}$/.test(value.candidateId) ? { candidateId: value.candidateId } : {}), rights,
    ...(/^[a-f0-9]{64}$/.test(sha256 || value.sha256 || '') ? { sha256: sha256 || value.sha256 } : {}), ...(Number.isSafeInteger(size ?? value.size) && (size ?? value.size) > 0 ? { size: size ?? value.size } : {}) };
}

/** Exact text-range ledger. Edited or shifted material cannot keep a stale citation. */
export function normalizeWritingMaterials(source = {}) {
  const whole = typeof source.text === 'string' ? source.text : '', raw = Array.isArray(source.materials) ? source.materials : [], items = [], seen = new Set();
  let invalidCount = 0;
  for (const entry of raw.slice(0, 64)) {
    try {
      const url = publicMaterialUrl(entry.url), start = entry.range?.start, end = entry.range?.end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > whole.length || !/^[a-f0-9]{64}$/.test(entry.contentSHA256 || '') || hash(whole.slice(start, end)) !== entry.contentSHA256 || !Number.isFinite(Date.parse(entry.fetchedAt))) throw fail('材料范围已变化。');
      const id = 'material-text-' + hash(url + '\n' + entry.contentSHA256 + '\n' + start).slice(0, 24);
      if (seen.has(id)) continue; seen.add(id);
      items.push({ id, title: text(entry.title) || new URL(url).hostname, url, kind: ['web-text', 'pdf-text', 'text'].includes(entry.kind) ? entry.kind : 'web-text', range: { start, end }, contentSHA256: entry.contentSHA256, fetchedAt: entry.fetchedAt, truncated: entry.truncated === true });
    } catch { invalidCount++; }
  }
  invalidCount += Math.max(0, raw.length - 64);
  return { items, status: !raw.length ? 'none' : !items.length ? 'stale' : invalidCount ? 'partial' : 'valid', invalidCount, hadLedger: raw.length > 0, canUseLegacyUrl: raw.length === 0 };
}
export function appendWritingMaterial(source = {}, readResult) {
  if (!readResult || typeof readResult.text !== 'string' || !readResult.text.trim()) throw fail('网页材料没有可追加的真实正文。');
  const url = publicMaterialUrl(readResult.url), content = readResult.text.trim(), old = typeof source.text === 'string' ? source.text : '';
  const ledger = normalizeWritingMaterials(source), contentSHA256 = hash(content);
  if (ledger.items.some(item => item.url === url && item.contentSHA256 === contentSHA256)) return { ...source, materials: ledger.items };
  if (ledger.items.length >= 64) throw fail('来源记录已达64条，请选择本次需要保留的材料。');
  const separator = old ? '\n\n' : '', start = old.length + separator.length, combined = old + separator + content;
  if (combined.length > 60000) throw fail('追加后原始材料超过60000字，请选择本次需要的资料段。');
  const entry = { title: text(readResult.title) || new URL(url).hostname, url, kind: /pdf/i.test(readResult.contentType || '') ? 'pdf-text' : 'web-text', range: { start, end: combined.length }, contentSHA256,
    fetchedAt: Number.isFinite(Date.parse(readResult.retrievedAt)) ? readResult.retrievedAt : new Date().toISOString(), truncated: readResult.truncated === true };
  const result = { ...source, title: source.title || entry.title, url: source.url || url, text: combined, materials: [...ledger.items, entry] };
  result.materials = normalizeWritingMaterials(result).items;
  return result;
}

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { readSource, sourceBody, elementsOf, elementAt } from './native-html-source.mjs';
import { declarations } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { parseMarkers } from '../integrations/openfilm/packages/openfilm/studio/server/markers.mjs';
import { versionFiles } from '../integrations/openfilm/packages/openfilm/studio/server/history.mjs';
import { writeAtomic } from '../integrations/openfilm/packages/openfilm/studio/server/atomic.mjs';
import { parseCanvas, applyCanvasOps, writeCanvas, readCanvas, listBoards } from '../integrations/openfilm/packages/openfilm/studio/server/canvas.mjs';
import { readable } from '../integrations/openfilm/packages/openfilm/studio/server/files.mjs';

const fail = (message, code = 'NATIVE_PROJECT_INVALID', status = 400) => new AppError(status, message, code);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sha1 = value => createHash('sha1').update(value).digest('hex');
const clone = value => structuredClone(value);
const object = (value, label = '参数') => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(label + '须为对象。'); return value; };
const text = (value, label, maximum = 10000) => { if (typeof value !== 'string' || value.length > maximum || /\x00/.test(value)) throw fail(label + '不是有效文本。'); return value; };
const keys = (value, allowed) => { object(value); for (const key of Object.keys(value)) if (!allowed.includes(key)) throw fail('不支持参数' + key + '。'); };
const number = (value, label, min = -1e7, max = 1e7) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(label + '数值无效。'); return value; };
const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const s = maxLength => ({ type: 'string', maxLength });
const target = { type: 'array', maxItems: 40, items: { type: 'integer', minimum: 0 }, description: 'page read返回的body内元素path；[]表示body。' };
const map = { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] } };
const node = { type: 'object', description: '声明式元素：{tag,attributes?,style?,text?,children?}，children可递归元素或纯文本；不接受HTML字符串、script、on事件或外部URL。' };
const position = { type: 'string', enum: ['before', 'after', 'append', 'prepend'] };
const page = { path: s(240), target };
const marker = schema({ id: s(64), t: { type: 'number', minimum: 0 }, clip: s(200), name: s(80), color: { type: 'string', enum: ['blue', 'green', 'yellow', 'orange', 'red', 'purple'] } }, ['t']);
const board = { type: 'string', pattern: '^(main|[a-z0-9]{1,32})$' };
const makeOptions = schema({ ratio: s(120), sec: { type: 'number', exclusiveMinimum: 0, maximum: 600 }, frames: { type: 'boolean' }, quality: s(120), mode: { type: 'string', enum: ['text', 'omni', 'first', 'firstLast', 'refs'] }, size: s(120), transparent: { type: 'boolean' }, format: { type: 'string', enum: ['gif', 'svg'] }, gifFrames: { type: 'integer', minimum: 2, maximum: 16 }, frameMs: { type: 'integer', minimum: 20, maximum: 2000 }, mask: s(1024), markup: s(1024), count: { type: 'integer', enum: [2, 4] }, voice: s(120) });
const canvasNode = schema({ id: s(64), x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, z: { type: 'integer' }, parent: s(64), text: s(20000), path: s(1024), title: s(120), group: s(80), color: s(20), cut: { type: 'boolean' }, make: { type: 'string', enum: ['image', 'video', 'sfx', 'music', 'tts'] }, prompt: s(20000), via: s(120), model: s(120), preset: s(120), opts: makeOptions, versions: { type: 'array', maxItems: 50, items: s(1024) }, made: s(120), by: schema({ agent: s(120), session: s(120) }, ['agent']) }, ['id', 'x', 'y']);
const canvasDoc = schema({ name: s(80), nodes: { type: 'array', maxItems: 2000, items: canvasNode }, edges: { type: 'array', maxItems: 4000, items: schema({ id: s(64), from: s(64), to: s(64), order: { type: 'integer', minimum: 0 } }, ['id', 'from', 'to']) } }, ['nodes', 'edges']);
const canvasOperation = schema({ op: { type: 'string', enum: ['add', 'set', 'remove', 'wire', 'unwire', 'version'] }, kind: { type: 'string', enum: ['note', 'file', 'image', 'video', 'sfx', 'music', 'tts', 'cut', 'group'] }, id: s(64), text: s(20000), path: s(1024), prompt: s(20000), via: s(120), model: s(120), preset: s(120), opts: makeOptions, name: s(80), color: s(20), x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, group: s(64), inputs: { type: 'array', items: s(64) }, around: { type: 'array', items: s(64) }, from: s(64), to: s(64), order: { type: 'integer', minimum: 0 } }, ['op']);
const readArgs = { markers: schema(), history: schema({ limit: { type: 'integer', minimum: 1, maximum: 1000 }, commit: s(64) }), page: schema({ path: s(240), includeSource: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, query: s(200), sourceOffset: { type: 'integer', minimum: 0 }, sourceLimit: { type: 'integer', minimum: 1, maximum: 20000 } }), canvas: schema({ board, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, query: s(200), textOffset: { type: 'integer', minimum: 0 }, textLimit: { type: 'integer', minimum: 1, maximum: 20000 } }) };
const actions = {
  markers: { add: schema({ marker }, ['marker']), update: schema({ id: s(64), patch: map }, ['id', 'patch']), remove: schema({ ids: { type: 'array', minItems: 1, maxItems: 1000, items: s(64) } }, ['ids']), replace: schema({ markers: { type: 'array', maxItems: 1000, items: marker } }, ['markers']) },
  history: { save: schema({ message: s(200) }), revert: schema({ commit: s(64) }, ['commit']) },
  page: {
    text: schema({ ...page, text: s(200000) }, ['path', 'target', 'text']),
    style: schema({ ...page, style: map }, ['path', 'target', 'style']),
    attr: schema({ ...page, attributes: map }, ['path', 'target', 'attributes']),
    layout: schema({ ...page, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 }, rotation: { type: 'number' }, opacity: { type: 'number', minimum: 0, maximum: 1 } }, ['path', 'target']),
    insert: schema({ ...page, position, node }, ['path', 'target', 'position', 'node']),
    remove: schema(page, ['path', 'target']),
    move: schema({ ...page, to: target, position }, ['path', 'target', 'to', 'position']),
    duplicate: schema({ ...page, idSuffix: s(40) }, ['path', 'target']),
  },
  canvas: {
    apply: schema({ board, ops: { type: 'array', minItems: 1, maxItems: 1000, items: canvasOperation } }, ['ops']),
    replace: schema({ board, canvas: canvasDoc }, ['canvas']),
    create: schema({ name: s(80), from: board }),
    rename: schema({ board, name: s(80) }, ['name']),
    remove: schema({ board }),
  },
};
export const NATIVE_PROJECT_CATALOG = { sections: Object.entries(actions).map(([section, operations]) => ({ section, read: readArgs[section], actions: operations })), notes: ['markers按作品秒数，带clip时t为该源片段秒数。', 'history保存/恢复完整当前工程；恢复前自动保留当前版本，可撤销。save仅新增版本，不改工作文件。', 'page读取真实源文件和body元素path，文件版本CAS；普通CSS属性与工程内资源可用，脚本字节保留。新增可执行React/TSX工程使用完整隔离Remotion。', '页面源文件由多片段共用时，局部选区不能改动范围外共享实例。', 'canvas是当前工程画板与节点，不改变时间线。apply复用原生排版/分组/连线/版本core；make节点只配置生成参数，创建节点不会调用模型或宣称素材已生成。画板修改与撤销有独立文件hash CAS。'] };
export const NATIVE_PROJECT_READ_SCHEMA = { oneOf: Object.entries(readArgs).map(([section, args]) => schema({ section: { const: section, type: 'string' }, args }, ['section'])) };
export const NATIVE_PROJECT_EDIT_SCHEMA = { oneOf: Object.entries(actions).flatMap(([section, operations]) => Object.entries(operations).map(([action, args]) => schema({ section: { const: section, type: 'string' }, action: { const: action, type: 'string' }, expectedRevision: { type: ['string', 'null'], maxLength: 64 }, args }, ['section', 'action', 'expectedRevision', 'args']))) };

const BLOCKED = new Set(['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form']);
const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'input', 'param', 'source', 'track', 'wbr']);
const URI = new Set(['src', 'href', 'xlink:href', 'poster']);
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const attr = (element, name) => element.attrs.find(item => item.name === name)?.value;
const walk = (element, callback, trail = []) => { callback(element, trail); elementsOf(element).forEach((child, index) => walk(child, callback, [...trail, index])); };
function safePath(value) {
  text(value, '页面路径', 240);
  if (!/\.html?$/i.test(value) || value.includes('\\') || /[:\x00-\x1f<>"|?*]/.test(value) || value.split('/').some(part => !part || part.startsWith('.') || part !== part.trimEnd())) throw fail('请使用当前工程内的相对HTML页面路径。');
  return value;
}
function pathArray(value) { if (!Array.isArray(value) || value.length > 40 || value.some(index => !Number.isInteger(index) || index < 0)) throw fail('图层target须使用page read返回的元素path。'); return value; }
function localReference(value, pagePath = 'index.html') {
  if (typeof value !== 'string' || /[\x00-\x20\\]/.test(value) || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) throw fail('页面资源只能引用当前工程内文件或#片段。', 'NATIVE_PROJECT_RESOURCE');
  if (value.startsWith('#')) return value;
  let decoded; try { decoded = decodeURIComponent(value.split(/[?#]/)[0]); } catch { throw fail('资源路径编码无效。'); }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(pagePath), decoded));
  if (!decoded || resolved.startsWith('../') || resolved.split('/').some(part => !part || part.startsWith('.') || part.includes(':'))) throw fail('资源路径不能越出当前工程或进入隐藏目录。', 'NATIVE_PROJECT_RESOURCE');
  return value;
}
function css(value, pagePath) {
  const result = String(value);
  if (result.length > 16000 || /[\\<>\x00-\x08]|\/\*|@import|expression\s*\(|(?:https?|file|javascript|vbscript|data|blob)\s*:|\/\//i.test(result)) throw fail('CSS不能包含脚本、外部地址或宿主文件引用。', 'NATIVE_PROJECT_STYLE');
  for (const match of result.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) localReference((match[1] ?? match[2] ?? match[3]).trim(), pagePath);
  return result;
}
function attributes(value, pagePath) {
  object(value, '属性'); const result = {};
  for (const [raw, item] of Object.entries(value)) {
    const name = raw.toLowerCase();
    if (!/^[a-z_:][a-z0-9_.:-]*$/i.test(name) || /^(?:on|srcdoc|formaction|action|xmlns|is$)/i.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw fail('不支持可执行或宿主控制属性' + raw + '。');
    if (item === null) { result[name] = null; continue; }
    if (!['string', 'number'].includes(typeof item) || typeof item === 'number' && !Number.isFinite(item)) throw fail('属性值须为文字、数字或null。');
    const encoded = text(String(item), '属性值', 16000);
    if (URI.has(name)) localReference(encoded, pagePath);
    if (name === 'srcset') for (const candidate of encoded.split(',')) localReference(candidate.trim().split(/\s+/)[0], pagePath);
    if (name === 'style') css(encoded, pagePath);
    if (name === 'attributename' && /^(?:on|href|src|style)/i.test(encoded)) throw fail('不能动态写入可执行或资源属性。');
    result[name] = encoded;
  }
  return result;
}
function styles(value, pagePath) {
  object(value, '样式'); const result = {};
  for (const [raw, item] of Object.entries(value)) {
    const name = raw.replace(/[A-Z]/g, character => '-' + character.toLowerCase());
    if (!/^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/i.test(name) || ['behavior', '-moz-binding', 'constructor', 'prototype', '__proto__'].includes(name)) throw fail('CSS属性名称无效。');
    if (item === null) result[name] = null;
    else if (typeof item === 'number') { number(item, 'CSS属性'); result[name] = css(String(item) + (/^(?:opacity|z-index|font-weight|line-height|flex.*|order|scale|zoom|grid-.*|orphans|widows)$/.test(name) || name.startsWith('--') ? '' : 'px'), pagePath); }
    else result[name] = css(text(item, 'CSS属性', 16000), pagePath);
  }
  return result;
}
function renderNode(value, depth = 0, pagePath) {
  if (typeof value === 'string') return esc(value);
  keys(value, ['tag', 'attributes', 'style', 'text', 'children']);
  if (depth > 30) throw fail('新图层结构嵌套过深。');
  const tag = text(value.tag, '元素标签', 60).toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/.test(tag) || BLOCKED.has(tag)) throw fail('请添加普通HTML/SVG图层；可执行动画使用隔离Remotion工程。');
  const props = attributes(value.attributes || {}, pagePath), style = styles(value.style || {}, pagePath);
  if (Object.keys(style).length) props.style = [props.style || '', ...Object.entries(style).filter(([, item]) => item !== null).map(([key, item]) => `${key}:${item}`)].filter(Boolean).join(';');
  let output = '<' + tag + Object.entries(props).filter(([, item]) => item !== null).map(([key, item]) => ` ${key}="${esc(item)}"`).join('') + '>';
  if (VOID.has(tag)) { if (value.text !== undefined || value.children?.length) throw fail('此图层不能包含子内容。'); return output; }
  if (value.text !== undefined) output += esc(text(value.text, '图层文字', 200000));
  if (value.children !== undefined) { if (!Array.isArray(value.children) || value.children.length > 1000) throw fail('children须为图层或文字列表。'); output += value.children.map(child => renderNode(child, depth + 1, pagePath)).join(''); }
  return output + `</${tag}>`;
}
function withAttributes(source, element, patch) {
  const edits = [];
  for (const [name, value] of Object.entries(patch)) {
    const existing = element.attrs.find(item => item.name === name), replacement = value === null ? '' : `${name}="${esc(value)}"`;
    if (existing) edits.push({ from: existing.start, to: existing.end, text: replacement });
    else if (value !== null) edits.push({ from: element.nameEnd, to: element.nameEnd, text: ' ' + replacement });
  }
  for (const edit of edits.sort((a, b) => b.from - a.from)) source = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
  return source;
}
function scriptBytes(source) { const result = []; walk(readSource(source), element => { if (element.tag === 'script') result.push(source.slice(element.start, element.end)); }); return result; }
function editPageSource(source, action, args) {
  const body = sourceBody(readSource(source)), selected = elementAt(body, pathArray(args.target), []);
  if (!selected || selected.implied || BLOCKED.has(selected.tag)) throw fail('图层已变化或不是可编辑视觉元素，请重新读取页面。', 'NATIVE_PROJECT_LAYER_CHANGED', 409);
  if (['remove', 'move', 'duplicate'].includes(action) && !args.target.length) throw fail('不能移除、移动或复制整个body。');
  let output = source;
  if (action === 'text') {
    if (VOID.has(selected.tag)) throw fail('此元素不承载文字。');
    output = source.slice(0, selected.openEnd) + esc(text(args.text, '图层文字', 200000)) + source.slice(selected.closeStart);
  } else if (action === 'attr' || action === 'style' || action === 'layout') {
    let patch;
    if (action === 'attr') patch = attributes(args.attributes, args.path);
    else {
      let requested = args.style;
      if (action === 'layout') {
        requested = {};
        for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity']) if (args[key] !== undefined) number(args[key], key, ['width', 'height', 'opacity'].includes(key) ? 0 : -1e7, key === 'opacity' ? 1 : 1e7);
        if (args.x !== undefined || args.y !== undefined) requested.position = 'absolute';
        if (args.x !== undefined) requested.left = args.x; if (args.y !== undefined) requested.top = args.y;
        if (args.width !== undefined) requested.width = args.width; if (args.height !== undefined) requested.height = args.height;
        if (args.rotation !== undefined) requested.rotate = args.rotation + 'deg'; if (args.opacity !== undefined) requested.opacity = args.opacity;
      }
      const merged = Object.fromEntries(declarations(attr(selected, 'style') || ''));
      for (const [key, value] of Object.entries(styles(requested, args.path))) if (value === null) delete merged[key]; else merged[key] = value;
      patch = { style: Object.entries(merged).map(([key, value]) => `${key}:${value}`).join(';') };
    }
    output = withAttributes(source, selected, patch);
  } else if (action === 'remove') output = source.slice(0, selected.start) + source.slice(selected.end);
  else if (action === 'duplicate') {
    const suffix = args.idSuffix === undefined ? '-copy-' + randomUUID().slice(0, 8) : text(args.idSuffix, '副本ID后缀', 40);
    if (!/^[a-z0-9_-]+$/i.test(suffix)) throw fail('副本ID后缀须使用字母、数字、横线或下划线。');
    let copy = source.slice(selected.start, selected.end); const ids = new Map();
    walk(readSource(copy), element => { const id = attr(element, 'id'); if (id) ids.set(id, id + suffix); });
    const copiedElements = []; walk(readSource(copy), element => copiedElements.push(element));
    for (const element of copiedElements.sort((a, b) => b.start - a.start)) {
      const patch = {}; const id = attr(element, 'id'); if (id) patch.id = ids.get(id);
      for (const name of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'headers']) if (attr(element, name)) patch[name] = attr(element, name).split(/\s+/).map(item => ids.get(item) || item).join(' ');
      for (const name of ['href', 'xlink:href']) { const value = attr(element, name); if (value?.startsWith('#') && ids.has(value.slice(1))) patch[name] = '#' + ids.get(value.slice(1)); }
      for (const entry of element.attrs) if (entry.value?.includes('url(')) {
        let value = entry.value;
        for (const [old, next] of ids) value = value.replace(new RegExp('url\\(\\s*(["\']?)#' + old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\1\\s*\\)', 'g'), 'url(#' + next + ')');
        if (value !== entry.value) patch[entry.name] = value;
      }
      copy = withAttributes(copy, element, patch);
    }
    output = source.slice(0, selected.end) + copy + source.slice(selected.end);
  } else {
    const destination = action === 'move' ? elementAt(body, pathArray(args.to), []) : selected;
    if (!destination || destination.implied || BLOCKED.has(destination.tag) || !['before', 'after', 'append', 'prepend'].includes(args.position)) throw fail('图层插入位置无效。');
    if (['append', 'prepend'].includes(args.position) && VOID.has(destination.tag)) throw fail('目标元素不能包含子图层。');
    if (action === 'move' && destination.start >= selected.start && destination.end <= selected.end) throw fail('不能把图层移动到自身或自己的子图层内。');
    const at = ({ before: destination.start, after: destination.end, append: destination.closeStart, prepend: destination.openEnd })[args.position];
    const markup = action === 'move' ? source.slice(selected.start, selected.end) : renderNode(args.node, 0, args.path);
    if (action === 'move') {
      output = source.slice(0, selected.start) + source.slice(selected.end);
      const shifted = at > selected.end ? at - (selected.end - selected.start) : at;
      output = output.slice(0, shifted) + markup + output.slice(shifted);
    } else output = source.slice(0, at) + markup + source.slice(at);
  }
  if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw fail('页面超过本次2MiB编辑容量。', 'NATIVE_PROJECT_TOO_LARGE', 413);
  if (JSON.stringify(scriptBytes(source)) !== JSON.stringify(scriptBytes(output))) throw fail('此次结构变化会改写或复制现有脚本，请改选纯视觉图层；脚本保持原样。', 'NATIVE_PROJECT_SCRIPT_CHANGED');
  return output;
}

/** Fixed current-project services; all paths/routes are derived here, never supplied by model code. */
export function createNativeProjectCapabilities({ projectRoot, nativeProjectId, api, route } = {}) {
  if (!path.isAbsolute(projectRoot || '') || typeof api !== 'function') throw new Error('Current native project is required.');
  const root = path.resolve(projectRoot), undoFolder = path.join(root, '.film', 'guangxuan-project-undo'); let tail = Promise.resolve();
  const serial = job => { const next = tail.catch(() => {}).then(job); tail = next; return next; };
  const execute = job => serial(job).catch(error => {
    if (error instanceof AppError) throw error;
    if (/^(?:ENOENT|ENOTDIR|EACCES|EPERM|EBUSY|ELOOP|ENOSPC)$/.test(error?.code || '')) throw fail('当前工程文件不存在或暂时无法访问，请重新读取工程。', 'NATIVE_PROJECT_IO', error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 502);
    if (typeof error?.message === 'string') error.message = error.message.replace(/\b[A-Za-z]:[\\/][^\r\n)"'<>]+|\\\\[^\r\n)"'<>]+/g, '[工程文件]');
    throw error;
  });
  async function guard(relative, missing = false) {
    const filename = path.resolve(root, ...relative.split('/'));
    if (filename !== root && !filename.startsWith(root + path.sep)) throw fail('路径超出当前工程。', 'NATIVE_PROJECT_PATH', 403);
    let current = root;
    for (const part of ['', ...path.relative(root, filename).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      try { const info = await lstat(current); if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw fail('工程编辑不能写入链接文件。', 'NATIVE_PROJECT_PATH', 403); }
      catch (error) { if (missing && error.code === 'ENOENT') return filename; throw error; }
    }
    const actualRoot = await realpath(root), actual = await realpath(filename);
    if (actual !== actualRoot && !actual.startsWith(actualRoot + path.sep)) throw fail('路径超出当前实际工程。', 'NATIVE_PROJECT_PATH', 403);
    return filename;
  }
  const film = () => api(route);
  async function checkFilm(expected) { const current = await film(); if (expected !== undefined && current.rev !== expected) throw fail('时间线已变化，请重新读取工程。', 'OPENFILM_REVISION_CONFLICT', 409); return current; }
  async function currentHistory(limit = 50) {
    await guard('.film', true); await guard('.film/history', true);
    for (const name of ['config', 'HEAD', 'commondir']) await guard('.film/history/' + name, true);
    const data = await api(route + '/history?limit=' + limit), files = [];
    for (const [relative, size] of [...await versionFiles(root)].sort(([a], [b]) => a.localeCompare(b))) {
      const file = path.join(root, ...relative.split('/')); let info; try { info = await lstat(file); } catch { continue; }
      files.push([relative, size, info.mtimeMs, info.ctimeMs, info.ino, /\.(?:html?|css|[cm]?js|json|vtt|srt|svg|txt)$/i.test(relative) && size <= 2 * 1024 * 1024 && !info.isSymbolicLink() ? hash(await readFile(file)) : '']);
    }
    return { data, revision: hash({ head: data.status?.head, files }) };
  }
  function boardId(value) { const result = value ?? 'main'; if (typeof result !== 'string' || !/^(?:main|[a-z0-9]{1,32})$/.test(result)) throw fail('画板编号无效。'); return result; }
  const boardRelative = id => id === 'main' ? '.film/canvas.json' : '.film/canvases/' + boardId(id) + '.json';
  const canvasRevision = snapshots => hash(snapshots.slice().sort((a, b) => a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.id.length - b.id.length || a.id.localeCompare(b.id)).map(item => [item.id, item.raw === null ? null : hash(item.raw)]));
  async function currentCanvas() {
    await guard('.film', true); await guard('.film/canvases', true); await guard('.film/canvas.json', true);
    const boards = await listBoards(root), snapshots = [], values = new Map();
    for (const info of boards) {
      const id = boardId(info.id), filename = await guard(boardRelative(id), true);
      let raw = null; try { raw = await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      snapshots.push({ id, raw }); values.set(id, await readCanvas(root, id));
    }
    return { boards, snapshots, values, revision: canvasRevision(snapshots) };
  }
  async function canvasResource(value) {
    if (typeof value !== 'string' || !value || value.length > 1024 || /[:\\\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part.startsWith('.'))) throw fail('画板素材须使用当前工程内的受控文件路径。', 'NATIVE_PROJECT_RESOURCE', 403);
    const filename = readable(root, value);
    if (!(await stat(filename)).isFile()) throw fail('画板素材文件不存在。', 'NATIVE_PROJECT_NOT_FOUND', 404);
    return true;
  }
  async function canvasReferences(value) {
    for (const candidate of [value?.path, ...(Array.isArray(value?.versions) ? value.versions : []), value?.opts?.mask, value?.opts?.markup].filter(item => item !== undefined)) await canvasResource(candidate);
    if (value?.opts !== undefined) keys(value.opts, Object.keys(makeOptions.properties));
  }
  async function editCanvas(action, args, beforeRevision, currentFilmRevision) {
    const before = await currentCanvas();
    if (before.revision !== beforeRevision) throw fail('画板文件已变化，请重新读取画板。', 'NATIVE_PROJECT_REVISION_CONFLICT', 409);
    const id = boardId(args.board), existing = before.values.get(id);
    if (action !== 'create' && !existing) throw fail('当前工程没有这个画板。', 'NATIVE_PROJECT_NOT_FOUND', 404);
    let targetId = id, next, removed = false;
    const plan = clone(before.snapshots);
    if (action === 'apply') {
      if (!Array.isArray(args.ops) || !args.ops.length || args.ops.length > 1000) throw fail('画板ops须包含1至1000个原生操作。');
      for (const operation of args.ops) { keys(operation, Object.keys(canvasOperation.properties)); await canvasReferences(operation); }
      const result = await applyCanvasOps(existing, args.ops, { by: { agent: 'Gx AI' }, exists: async relative => { await canvasResource(relative); return true; } });
      next = { ...result.canvas, ...(existing.name ? { name: existing.name } : {}) };
    } else if (action === 'replace') {
      keys(args.canvas, ['nodes', 'edges', 'name']);
      if (!Array.isArray(args.canvas.nodes) || !Array.isArray(args.canvas.edges)) throw fail('画板须包含nodes和edges列表。');
      for (const item of args.canvas.nodes) { keys(item, Object.keys(canvasNode.properties)); await canvasReferences(item); }
      for (const item of args.canvas.edges) keys(item, ['id', 'from', 'to', 'order']);
      next = parseCanvas({ ...args.canvas, name: args.canvas.name ?? existing.name ?? '' });
      if (next.nodes.length !== args.canvas.nodes.length || next.edges.length !== args.canvas.edges.length) throw fail('画板节点或连线无效、重复或超出原生容量。');
    } else if (action === 'rename') next = { ...existing, name: text(args.name, '画板名称', 80).trim() };
    else if (action === 'create') {
      if (before.boards.length >= 100) throw fail('当前工程最多100个画板。');
      if (args.from !== undefined && !before.values.has(boardId(args.from))) throw fail('待复制画板不存在。', 'NATIVE_PROJECT_NOT_FOUND', 404);
      do { targetId = Date.now().toString(36) + randomUUID().replaceAll('-', '').slice(0, 8); } while (before.values.has(targetId));
      const from = args.from === undefined ? { nodes: [], edges: [] } : before.values.get(args.from);
      next = { nodes: clone(from.nodes), edges: clone(from.edges), ...(args.name === undefined ? {} : { name: text(args.name, '画板名称', 80).trim() }) };
    } else {
      if (before.boards.length < 2) throw fail('不能删除当前工程唯一的画板。', 'NATIVE_PROJECT_CANVAS', 409);
      removed = true;
      if (id === 'main') { const promoted = plan.find(item => item.id !== 'main'); plan.find(item => item.id === 'main').raw = promoted.raw; plan.splice(plan.indexOf(promoted), 1); }
      else plan.splice(plan.findIndex(item => item.id === id), 1);
    }
    if (next) {
      next = parseCanvas(next); const raw = JSON.stringify(next, null, 1) + '\n', at = plan.findIndex(item => item.id === targetId);
      if (at < 0) plan.push({ id: targetId, raw }); else plan[at].raw = raw;
    }
    const undo = await saveUndo({ section: 'canvas', beforeBoards: before.snapshots, readBoard: action === 'create' || id === 'main' ? 'main' : id, afterRevision: canvasRevision(plan) });
    await checkFilm(currentFilmRevision);
    if ((await currentCanvas()).revision !== beforeRevision) throw fail('画板文件已变化，请重新读取画板。', 'NATIVE_PROJECT_REVISION_CONFLICT', 409);
    if (removed) await api(route + '/canvases/' + id, undefined, 'DELETE');
    else { await guard(boardRelative(targetId), true); await writeCanvas(root, { ...next, name: next.name ?? '' }, targetId); }
    const after = await currentCanvas();
    if (after.revision !== canvasRevision(plan)) throw fail('画板提交期间又有修改，请重新读取；原状态已保留在撤销记录中。', 'NATIVE_PROJECT_REVISION_CONFLICT', 409);
    return { undo, board: removed ? 'main' : targetId };
  }
  function restricted(scope) { return Boolean(scope?.assetIds || scope?.placement?.mode === 'range' || scope?.placement?.clipIds?.length); }
  function markerScope(marker, current, scope) {
    if (!restricted(scope)) return;
    let at = marker.t;
    if (marker.clip) {
      const clip = current.doc?.tracks.flatMap(track => track.clips).find(item => item.id === marker.clip);
      if (!clip) throw fail('标记引用的片段不存在。');
      if (scope.assetIds && !scope.assetIds.includes(clip.attrs?.['data-guangxuan-asset-id'])) throw fail('标记不在当前素材选择中。', 'NATIVE_PROJECT_SCOPE', 403);
      if (scope.placement?.clipIds?.length && !scope.placement.clipIds.includes(clip.id)) throw fail('标记不在当前框选片段中。', 'NATIVE_PROJECT_SCOPE', 403);
      at = Number(clip.at || 0) + (marker.t - Number(clip.time?.[0] || 0)) / Number(clip.speed || 1);
    } else if (scope.assetIds || scope.placement?.clipIds?.length) throw fail('此全局标记没有绑定当前选中片段。', 'NATIVE_PROJECT_SCOPE', 403);
    if (scope.placement?.mode === 'range' && (at < scope.placement.start || at > scope.placement.end)) throw fail('标记超出当前选择区间。', 'NATIVE_PROJECT_SCOPE', 403);
  }
  function pageScope(relative, current, scope) {
    const references = (current.doc?.tracks || []).flatMap(track => track.clips.map(clip => ({ clip, track }))).filter(item => item.clip.src === relative);
    if (references.some(({ clip, track }) => track.locked || clip.locked)) throw fail('页面被锁定片段引用，请先显式解锁后编辑。', 'NATIVE_PROJECT_SHARED_PAGE', 409);
    if (!restricted(scope)) return;
    if (!references.length) throw fail('此页面未绑定当前所选片段，请选择全工程范围后编辑。', 'NATIVE_PROJECT_SCOPE', 403);
    for (const { clip, track } of references) {
      const start = Number(clip.at || 0), end = start + (Number(clip.time?.[1]) - Number(clip.time?.[0] || 0)) / Number(clip.speed || 1);
      if (track.locked || clip.locked || scope.assetIds && !scope.assetIds.includes(clip.attrs?.['data-guangxuan-asset-id']) || scope.placement?.clipIds?.length && !scope.placement.clipIds.includes(clip.id) || scope.placement?.mode === 'range' && (!Number.isFinite(end) || start < scope.placement.start || end > scope.placement.end)) throw fail('页面还被选区外或锁定片段共用，请选中全部引用后编辑。', 'NATIVE_PROJECT_SHARED_PAGE', 409);
    }
  }
  async function readState(section, args = {}, fullSource = false) {
    if (!Object.hasOwn(readArgs, section)) throw fail('不支持的工程能力。'); keys(args, Object.keys(readArgs[section].properties));
    let data, revision;
    if (section === 'markers') { await guard('.film/markers.json', true); data = await api(route + '/markers'); revision = hash(data.markers); }
    if (section === 'history') {
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) throw fail('版本数量须为1至1000。');
      const current = await currentHistory(args.limit || 50); ({ data, revision } = current);
      if (args.commit !== undefined) { if (!/^[a-f0-9]{7,64}$/.test(args.commit)) throw fail('版本编号无效。'); data = { ...data, diff: await api(route + '/history/versions/' + args.commit) }; }
    }
    if (section === 'page') {
      if (args.path === undefined) {
        const pages = new Map(), current = await film();
        for (const clip of (current.doc?.tracks || []).flatMap(track => track.clips)) if (/\.html?$/i.test(clip.src)) {
          let relative; try { relative = safePath(clip.src); await guard(relative); } catch { continue; }
          const item = pages.get(relative) || { path: relative, clipIds: [], title: String(clip.attrs?.title || path.posix.basename(relative)).slice(0, 200) };
          if (clip.id) item.clipIds.push(clip.id); pages.set(relative, item);
        }
        data = { pages: [...pages.values()] }; revision = hash(data.pages);
        return { section, revision, data, filmRevision: current.rev };
      }
      const relative = safePath(args.path); await guard(relative);
      const source = await api(route + '/page?path=' + encodeURIComponent(relative));
      if (Buffer.byteLength(source.text) > 2 * 1024 * 1024) throw fail('页面过大，请先拆分后编辑。', 'NATIVE_PROJECT_TOO_LARGE', 413);
      const offset = args.offset ?? 0, limit = args.limit ?? 40, sourceOffset = args.sourceOffset ?? 0, sourceLimit = args.sourceLimit ?? 8000;
      for (const [label, value, max] of [['offset', offset, 1e7], ['limit', limit, 200], ['sourceOffset', sourceOffset, 2 * 1024 * 1024], ['sourceLimit', sourceLimit, 20000]]) if (!Number.isInteger(value) || value < (label.endsWith('Limit') || label === 'limit' ? 1 : 0) || value > max) throw fail('页面读取分页参数无效。');
      const query = args.query === undefined ? '' : text(args.query, '图层检索', 200).toLowerCase(), tree = [];
      walk(sourceBody(readSource(source.text)), (element, trail) => {
        const words = element.children.filter(item => item.kind === 'text').map(item => source.text.slice(item.start, item.end)).join('').slice(0, 1000), id = attr(element, 'id');
        if (query && ![element.tag, id || '', words].join(' ').toLowerCase().includes(query)) return;
        tree.push({ path: trail, tag: element.tag, ...(id ? { id } : {}), attributes: Object.fromEntries(element.attrs.map(item => [item.name, item.value])), text: words.slice(0, 300), editable: relative !== 'film.html' && !BLOCKED.has(element.tag) && !element.implied });
      });
      data = { path: relative, tree: tree.slice(offset, offset + limit), total: tree.length, offset, truncated: tree.length > offset + limit, ...(args.includeSource === true ? { source: fullSource ? source.text : source.text.slice(sourceOffset, sourceOffset + sourceLimit), sourceOffset, sourceLength: source.text.length, sourceTruncated: !fullSource && source.text.length > sourceOffset + sourceLimit } : {}) }; revision = source.rev;
    }
    if (section === 'canvas') {
      const current = await currentCanvas(), id = boardId(args.board), selected = current.values.get(id);
      if (!selected) throw fail('当前工程没有这个画板。', 'NATIVE_PROJECT_NOT_FOUND', 404);
      const offset = args.offset ?? 0, limit = args.limit ?? 40, textOffset = args.textOffset ?? 0, textLimit = args.textLimit ?? 1000, query = args.query === undefined ? '' : text(args.query, '画板节点检索', 200).toLowerCase();
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(textOffset) || textOffset < 0 || !Number.isInteger(textLimit) || textLimit < 1 || textLimit > 20000) throw fail('画板分页参数无效。');
      const matched = selected.nodes.filter(item => !query || [item.id, item.text, item.path, item.group, item.title, item.make, item.prompt].filter(Boolean).join(' ').toLowerCase().includes(query)), visible = matched.slice(offset, offset + limit), ids = new Set(visible.map(item => item.id));
      data = { boards: current.boards, boardId: id, canvas: { ...selected, nodes: visible.map(item => ({ ...item, ...(typeof item.text === 'string' ? { text: item.text.slice(textOffset, textOffset + textLimit), textLength: item.text.length, textOffset, textTruncated: item.text.length > textOffset + textLimit } : {}), ...(typeof item.prompt === 'string' ? { prompt: item.prompt.slice(textOffset, textOffset + textLimit), promptLength: item.prompt.length, promptOffset: textOffset, promptTruncated: item.prompt.length > textOffset + textLimit } : {}) })), edges: selected.edges.filter(item => ids.has(item.from) || ids.has(item.to)) }, total: matched.length, edgeTotal: selected.edges.length, offset, truncated: matched.length > offset + limit };
      revision = current.revision;
    }
    return { section, revision, data, filmRevision: (await film()).rev };
  }
  async function saveUndo(value) {
    const id = randomUUID(); await guard('.film', true); await mkdir(undoFolder, { recursive: true }); await guard('.film/guangxuan-project-undo');
    await writeAtomic(path.join(undoFolder, id + '.json'), JSON.stringify({ ...value, id, nativeProjectId }));
    return { id, section: value.section, label: value.section === 'page' ? '页面图层编辑' : value.section === 'markers' ? '时间线标记编辑' : value.section === 'canvas' ? '画板编排编辑' : '恢复工程版本' };
  }
  async function editState({ section, action, expectedRevision, args = {}, editScope, expectedFilmRevision } = {}) {
    const fields = Object.hasOwn(actions, section) && Object.hasOwn(actions[section], action) ? actions[section][action] : null; if (!fields) throw fail('不支持的工程操作。'); keys(args, Object.keys(fields.properties));
    const current = await checkFilm(expectedFilmRevision), before = await readState(section, section === 'page' ? { path: args.path, includeSource: true } : section === 'canvas' ? { board: args.board } : {}, true);
    if (before.revision !== expectedRevision) throw fail('工程内容已变化，请重新读取后修改。', 'NATIVE_PROJECT_REVISION_CONFLICT', 409);
    let undo = null;
    if (section === 'markers') {
      let list = clone(before.data.markers);
      const checkedMarker = input => { keys(input, ['id', 't', 'clip', 'name', 'color']); const candidate = { ...input, id: input.id || randomUUID() }; number(candidate.t, '标记秒数', 0, 1e9); if (candidate.clip !== undefined) { text(candidate.clip, '标记片段', 200); if (!current.doc?.tracks.flatMap(track => track.clips).some(clip => clip.id === candidate.clip)) throw fail('标记引用的片段不存在。', 'NATIVE_PROJECT_NOT_FOUND', 404); } if (candidate.name !== undefined) text(candidate.name, '标记名称', 80); if (candidate.color !== undefined && !marker.properties.color.enum.includes(candidate.color)) throw fail('标记颜色无效。'); const parsed = parseMarkers([candidate]); if (parsed.length !== 1) throw fail('标记编号无效。'); markerScope(parsed[0], current, editScope); return parsed[0]; };
      if (action === 'add') { const added = checkedMarker(args.marker); if (list.some(item => item.id === added.id)) throw fail('标记编号已存在。'); list.push(added); }
      if (action === 'update') { text(args.id, '标记编号', 64); const index = list.findIndex(item => item.id === args.id); if (index < 0) throw fail('标记不存在。', 'NATIVE_PROJECT_NOT_FOUND', 404); markerScope(list[index], current, editScope); keys(args.patch, ['t', 'clip', 'name', 'color']); const patched = { ...list[index], ...args.patch }; for (const name of ['clip', 'name']) if (patched[name] === null) delete patched[name]; list[index] = checkedMarker(patched); }
      if (action === 'remove') { if (!Array.isArray(args.ids) || !args.ids.length || args.ids.some(id => typeof id !== 'string' || !list.some(item => item.id === id))) throw fail('请选择实际存在的标记。'); for (const item of list.filter(item => args.ids.includes(item.id))) markerScope(item, current, editScope); list = list.filter(item => !args.ids.includes(item.id)); }
      if (action === 'replace') { if (restricted(editScope)) throw fail('整表替换标记需要全工程范围。', 'NATIVE_PROJECT_SCOPE', 403); if (!Array.isArray(args.markers)) throw fail('markers须为标记列表。'); list = args.markers.map(checkedMarker); }
      if (list.length > 1000 || new Set(list.map(item => item.id)).size !== list.length) throw fail('标记最多1000项且编号不能重复。');
      undo = await saveUndo({ section, before: before.data.markers, afterRevision: hash(list) });
      await checkFilm(current.rev); if ((await readState('markers')).revision !== expectedRevision) throw fail('标记已变化，请重新读取。', 'NATIVE_PROJECT_REVISION_CONFLICT', 409);
      await guard('.film/markers.json', true); await api(route + '/markers', { markers: list }, 'PUT');
    } else if (section === 'page') {
      const relative = safePath(args.path); if (relative === 'film.html') throw fail('film.html是原生时间线，请使用原生剪辑操作修改；页面图层接口用于视觉页面。');
      pageScope(relative, current, editScope);
      const after = editPageSource(before.data.source, action, args); await guard(relative);
      const bytewise = sha1(Buffer.from(before.data.source, 'utf8')) !== before.revision;
      if (bytewise && /[^\u0000-\u00ff]/.test(after)) throw fail('旧页面编码不能保存这些文字。', 'NATIVE_PROJECT_ENCODING', 415);
      undo = await saveUndo({ section, path: relative, before: before.data.source, afterRevision: sha1(Buffer.from(after, bytewise ? 'latin1' : 'utf8')) });
      await checkFilm(current.rev); pageScope(relative, await film(), editScope); await guard(relative);
      await api(route + '/page', { path: relative, text: after, expect: before.revision }, 'PUT');
    } else if (section === 'canvas') {
      const applied = await editCanvas(action, args, expectedRevision, current.rev);
      return { ...(await readState('canvas', { board: applied.board })), changed: true, undo: applied.undo };
    } else {
      if (restricted(editScope)) throw fail('版本操作作用于完整当前工程，请使用全工程范围。', 'NATIVE_PROJECT_SCOPE', 403);
      await checkFilm(current.rev); if ((await currentHistory()).revision !== expectedRevision) throw fail('工程文件已变化，请重新读取版本状态。', 'NATIVE_PROJECT_REVISION_CONFLICT', 409);
      if (action === 'save') await api(route + '/history/save', { message: args.message === undefined ? '' : text(args.message, '版本说明', 200) });
      else {
        if (!/^[a-f0-9]{7,64}$/.test(args.commit || '')) throw fail('请选择真实版本编号。');
        await api(route + '/history/versions/' + args.commit);
        let kept = before.data.status?.head;
        if (before.data.status?.changes) kept = (await api(route + '/history/save', { message: 'AI恢复版本前保留当前工程' })).commit;
        if (!kept) throw fail('当前工程未能保留恢复点，请先保存版本。', 'NATIVE_PROJECT_HISTORY', 409);
        undo = await saveUndo({ section, beforeCommit: kept, afterCommit: args.commit });
        await api(route + '/history/checkout', { commit: args.commit, discard: false });
      }
    }
    return { ...(await readState(section, section === 'page' ? { path: args.path } : {})), changed: true, undo };
  }
  async function undoState({ undoId, editScope } = {}) {
    if (!/^[a-f0-9-]{36}$/.test(undoId || '')) throw fail('撤销编号无效。');
    const filename = await guard('.film/guangxuan-project-undo/' + undoId + '.json'), record = JSON.parse(await readFile(filename, 'utf8'));
    if (record.id !== undoId || record.nativeProjectId !== nativeProjectId) throw fail('撤销记录不属于当前工程。', 'NATIVE_PROJECT_UNDO', 409);
    const current = await film(), state = await readState(record.section, record.section === 'page' ? { path: record.path } : {});
    if (record.section !== 'history' && state.revision !== record.afterRevision) throw fail('修改后又有编辑，不能覆盖新内容；请使用版本历史。', 'NATIVE_PROJECT_UNDO_CONFLICT', 409);
    if (record.section === 'markers') {
      const was = new Map(record.before.map(item => [item.id, item])), now = new Map(state.data.markers.map(item => [item.id, item]));
      for (const id of new Set([...was.keys(), ...now.keys()])) if (JSON.stringify(was.get(id)) !== JSON.stringify(now.get(id))) for (const item of [was.get(id), now.get(id)].filter(Boolean)) markerScope(item, current, editScope);
      await guard('.film/markers.json', true); await api(route + '/markers', { markers: record.before }, 'PUT');
    }
    else if (record.section === 'page') { pageScope(record.path, current, editScope); await guard(record.path); await api(route + '/page', { path: record.path, text: record.before, expect: state.revision, undo: true }, 'PUT'); }
    else if (record.section === 'canvas') {
      if (!Array.isArray(record.beforeBoards)) throw fail('画板撤销记录无效。');
      const before = new Map(record.beforeBoards.map(item => [boardId(item.id), item.raw]));
      const now = await currentCanvas();
      for (const item of now.snapshots) if (!before.has(item.id) || before.get(item.id) === null) { const target = await guard(boardRelative(item.id), true); await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      for (const [id, raw] of before) if (raw !== null) { if (typeof raw !== 'string') throw fail('画板撤销内容无效。'); const target = await guard(boardRelative(id), true); await mkdir(path.dirname(target), { recursive: true }); await writeAtomic(target, raw); }
    }
    else { if (restricted(editScope) || state.data.status?.changes || !state.data.status?.head?.startsWith(record.afterCommit)) throw fail('恢复版本后又有修改，请先保存这些编辑再恢复。', 'NATIVE_PROJECT_UNDO_CONFLICT', 409); await api(route + '/history/checkout', { commit: record.beforeCommit, discard: false }); }
    await unlink(filename).catch(() => {});
    return { ...(await readState(record.section, record.section === 'page' ? { path: record.path } : record.section === 'canvas' ? { board: record.readBoard || 'main' } : {})), changed: true, undone: true };
  }
  return { read: input => execute(() => readState(input?.section, input?.args)), edit: input => execute(() => editState(input)), undo: input => execute(() => undoState(input)) };
}

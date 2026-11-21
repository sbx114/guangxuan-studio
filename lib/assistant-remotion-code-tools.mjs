import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
import { remotionSourcePath } from './remotion-projects.mjs';

const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const revision = { type: 'integer', minimum: 1 };
const base = { remotionId: text(100), expectedRevision: revision };
const fail = (status, message, code = 'ASSISTANT_CODE_INVALID') => new AppError(status, message, code);
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const ready = (service, method) => { if (typeof service?.[method] !== 'function') throw fail(503, '自由动画源码服务尚未就绪。', 'REMOTION_UNAVAILABLE'); };
const positive = (value, fallback, maximum) => { const result = value === undefined ? fallback : value; if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw fail(400, '行号或读取数量无效。'); return result; };
function exactText(value, label, { empty = false, maximum = 32768 } = {}) {
  if (typeof value !== 'string' || !empty && !value.length || value.length > maximum || value.includes('\0') || typeof value.isWellFormed === 'function' && !value.isWellFormed()) throw fail(400, label + '需要有效文字，不能包含空匹配或损坏字符。');
  return value;
}
function noCredentials(value, ctx) {
  const known = [ctx.settings?.apiKey, ctx.settings?.api_key, ctx.settings?.authorization].filter(item => typeof item === 'string' && item.length >= 8);
  if (known.some(secret => value.includes(secret)) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value) || /\bBearer\s+[A-Za-z0-9._~-]{16,}/i.test(value)) throw fail(403, '这段文字包含连接凭据，不能通过源码工具读取或写入。请先在本地移除凭据。', 'ASSISTANT_CODE_SECRET');
}
function lineStarts(content) { const result = [0]; for (const match of content.matchAll(/\r\n|\n|\r/g)) result.push(match.index + match[0].length); return result; }
function position(starts, offset) { let low = 0, high = starts.length; while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (starts[middle] <= offset) low = middle; else high = middle; } return { line: low + 1, column: offset - starts[low] + 1 }; }
const boundary = (value, at) => !(at > 0 && at < value.length && /[\uD800-\uDBFF]/.test(value[at - 1]) && /[\uDC00-\uDFFF]/.test(value[at]));
const safeOffset = (value, at) => { while (at > 0 && (!boundary(value, at) || value[at - 1] === '\r' && value[at] === '\n')) at--; return at; };
function bytePrefix(value, maximum) {
  if (Buffer.byteLength(value) <= maximum) return value;
  let low = 0, high = value.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(value.slice(0, middle)) <= maximum) low = middle; else high = middle - 1; }
  return value.slice(0, safeOffset(value, low));
}
function lineEnding(value) { const endings = new Set(value.match(/\r\n|\n|\r/g)); return endings.size > 1 ? 'mixed' : ({ '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR' })[[...endings][0]] || 'none'; }
function changedLineCounts(before, after) {
  const lines = value => value ? value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean) : [];
  const oldLines = lines(before), newLines = lines(after); let start = 0, oldEnd = oldLines.length, newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const a = oldLines.slice(start, oldEnd), b = newLines.slice(start, newEnd), maximum = a.length + b.length;
  if (!a.length || !b.length) return { removedLines: a.length, addedLines: b.length };
  // Myers length needs no trace. A bounded fallback remains a valid complete
  // delete/insert range and is explicitly labelled rather than a minimal diff.
  const offset = maximum + 1, frontier = new Int32Array(maximum * 2 + 3); frontier.fill(-1); frontier[offset + 1] = 0; let work = 0;
  for (let distance = 0; distance <= maximum; distance++) for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
    if (++work > 2000000) return { removedLines: a.length, addedLines: b.length, countsMode: 'replaced-line-range' };
    let x = diagonal === -distance || diagonal !== distance && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1] ? frontier[offset + diagonal + 1] : frontier[offset + diagonal - 1] + 1, y = x - diagonal;
    while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
    frontier[offset + diagonal] = x;
    if (x >= a.length && y >= b.length) return { removedLines: (distance + a.length - b.length) / 2, addedLines: (distance - a.length + b.length) / 2 };
  }
  throw new Error('Unreachable line diff');
}
function oldSnapshot(record) { return Object.fromEntries(['title', 'entryPoint', 'compositionId', 'inputProps', 'files'].map(key => [key, clone(record[key])])); }
function selectedFile(record, path) { const checked = remotionSourcePath(path), file = record.files.find(item => item.path === checked); if (!file) throw fail(404, '当前动画工程没有这个源文件。', 'REMOTION_FILE_NOT_FOUND'); return file; }

/** Actual before/after line windows, not a model's description of its edits. */
function sourceDiff(changes, ctx) {
  let budget = 12000; const files = [];
  const prepared = changes.map(change => {
    const oldStarts = lineStarts(change.before), newStarts = lineStarts(change.after), windows = [];
    for (const edit of change.edits) {
      const start = Math.max(1, position(oldStarts, edit.start).line - 2), end = Math.min(oldStarts.length, position(oldStarts, edit.end).line + 2), previous = windows.at(-1);
      if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end); else windows.push({ start, end });
    }
    return { change, oldStarts, newStarts, windows };
  });
  let remaining = prepared.reduce((sum, item) => sum + item.windows.length, 0);
  for (const { change, oldStarts, newStarts, windows } of prepared) {
    const hunks = windows.map(window => {
      const start = oldStarts[window.start - 1], end = oldStarts[window.end] ?? change.before.length;
      const delta = point => change.edits.filter(edit => edit.end <= point).reduce((sum, edit) => sum + edit.newText.length - (edit.end - edit.start), 0);
      const newStart = start + delta(start), newEnd = end + delta(end), before = change.before.slice(start, end), after = change.after.slice(newStart, newEnd);
      noCredentials(before, ctx); noCredentials(after, ctx);
      let common = 0; while (common < before.length && common < after.length && before[common] === after[common]) common++;
      const available = Math.floor(budget / remaining--), crop = Buffer.byteLength(before) + Buffer.byteLength(after) > available ? safeOffset(before, Math.max(0, common - 200)) : 0;
      const oldText = bytePrefix(before.slice(crop), Math.floor(available / 2)), newText = bytePrefix(after.slice(crop), available - Buffer.byteLength(oldText));
      budget -= Buffer.byteLength(oldText) + Buffer.byteLength(newText);
      const oldLocation = position(oldStarts, start + crop), newLocation = position(newStarts, newStart + crop);
      return { oldStartLine: oldLocation.line, oldStartColumn: oldLocation.column, oldEndLine: position(oldStarts, Math.max(start + crop, start + crop + oldText.length - 1)).line, newStartLine: newLocation.line, newStartColumn: newLocation.column, newEndLine: position(newStarts, Math.max(newStart + crop, newStart + crop + newText.length - 1)).line, before: oldText, after: newText, truncated: crop > 0 || oldText.length < before.length || newText.length < after.length };
    });
    files.push({ path: change.path, beforeSHA256: hash(change.before), afterSHA256: hash(change.after), replacements: change.edits.length, ...changedLineCounts(change.before, change.after), hunks });
  }
  return { format: 'actual-before-after-line-hunks', files, truncated: files.some(file => file.hunks.some(hunk => hunk.truncated)) };
}

/** Scoped hooks are trusted adapter closures. No project IDs, host paths or RPCs are model-selected. */
export function createRemotionCodeTools({ tool, owner, current, check = () => {}, prepareUndo, remotion, remotionProjects } = {}) {
  if (![tool, owner, current, prepareUndo].every(value => typeof value === 'function')) throw new TypeError('Code tools need the scoped adapter and pending undo reservation.');
  async function source(args, ctx, state, write = false) {
    if (write) await current(ctx, state, 'video'); else await owner(ctx, 'video'); check(ctx); ready(remotion, 'read');
    const record = await remotion.read(ctx.projectId, args.remotionId); check(ctx);
    if (!Number.isSafeInteger(args.expectedRevision) || record.revision !== args.expectedRevision) throw fail(409, '动画源码已有更新，请读取实际版本后再操作。', 'REMOTION_REVISION_CONFLICT');
    return record;
  }
  return [
    tool('remotion_code_read', '读取当前项目已有Remotion源文件的指定行段，返回原样文字、行列位置和下一页。path必须是工程内已有相对路径；先remotion_list取得实际版本。startColumn可继续读取超长行；不读取宿主文件/包配置/凭据。', schema({ ...base, path: text(200), startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, startColumn: { type: 'integer', minimum: 1 } }, ['remotionId', 'expectedRevision', 'path']), false, async (args, ctx, state) => {
      remotionSourcePath(args.path); const record = await source(args, ctx, state), file = selectedFile(record, args.path), starts = lineStarts(file.content); noCredentials(file.content, ctx);
      const startLine = positive(args.startLine, 1, starts.length), endLine = positive(args.endLine, Math.min(starts.length, startLine + 79), starts.length);
      if (endLine < startLine || endLine - startLine >= 200) throw fail(400, '每次请读取连续1至200行。');
      const firstEnd = starts[startLine] ?? file.content.length, firstLine = file.content.slice(starts[startLine - 1], firstEnd).replace(/(?:\r\n|\n|\r)$/, ''), column = positive(args.startColumn, 1, firstLine.length + 1);
      const start = starts[startLine - 1] + column - 1, requestedEnd = starts[endLine] ?? file.content.length;
      if (!boundary(file.content, start)) throw fail(400, '读取起点切开了字符，请使用完整字符边界。');
      const end = safeOffset(file.content, Math.min(requestedEnd, start + 12000));
      const content = file.content.slice(start, end); noCredentials(content, ctx);
      return { summary: '已读取真实源码行段。', data: { remotionId: record.id, revision: record.revision, path: file.path, totalLines: starts.length, lineEnding: lineEnding(file.content), start: position(starts, start), end: position(starts, end), content, truncated: end < requestedEnd, next: end < file.content.length ? position(starts, end) : null } };
    }),
    tool('remotion_code_search', '在当前项目指定Remotion源码中做字面文字搜索，返回实际路径/行/列和有界预览；不是正则或终端搜索。paths可限已存在文件，offset/limit分页，不扫描宿主或其它工程。', schema({ ...base, query: text(1000), paths: { type: 'array', minItems: 1, maxItems: 128, items: text(200) }, caseSensitive: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['remotionId', 'expectedRevision', 'query']), false, async (args, ctx, state) => {
      const query = exactText(args.query, '搜索文字', { maximum: 1000 }); noCredentials(query, ctx);
      if (args.paths !== undefined && (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 128 || new Set(args.paths).size !== args.paths.length)) throw fail(400, '请给出不重复的已有文件路径。');
      const record = await source(args, ctx, state), selected = args.paths ? args.paths.map(path => selectedFile(record, path)) : record.files;
      const offset = args.offset ?? 0, limit = positive(args.limit, 25, 100); if (!Number.isSafeInteger(offset) || offset < 0) throw fail(400, '搜索分页无效。');
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), expression = new RegExp(escaped, args.caseSensitive === false ? 'giu' : 'gu'), matches = []; let total = 0;
      for (const file of selected) { noCredentials(file.content, ctx); const starts = lineStarts(file.content); for (const match of file.content.matchAll(expression)) {
        if (total++ < offset || matches.length >= limit) continue;
        const location = position(starts, match.index), start = safeOffset(file.content, Math.max(starts[location.line - 1], match.index - 80)), end = safeOffset(file.content, Math.min(starts[location.line] ?? file.content.length, match.index + Math.min(match[0].length, 200) + 160)), preview = file.content.slice(start, end); noCredentials(preview, ctx);
        matches.push({ path: file.path, ...location, matchLength: match[0].length, preview });
      } }
      return { summary: '已搜索真实工程源码。', data: { remotionId: record.id, revision: record.revision, query, totalMatches: total, offset, matches, nextOffset: offset + matches.length < total ? offset + matches.length : null } };
    }),
    tool('remotion_code_patch', '精确修改当前项目已有Remotion源码，所有oldText必须在该原版本对应文件中且唯一匹配；同批旧文本均针对开始时的原文件，重叠/缺失/多义会整批拒绝。只提交一个新版本，保留其它文件与媒体，返回实际前后差异和真实撤销；不自动编译/加入时间线，随后用现有inspect/render核验。新建/完整写文件仍用remotion_create/update，不接收宿主路径/密钥/包配置或原生HTML脚本注入。', schema({ ...base, patches: { type: 'array', minItems: 1, maxItems: 40, items: schema({ path: text(200), oldText: text(32768), newText: { type: 'string', maxLength: 32768 } }, ['path', 'oldText', 'newText']) } }, ['remotionId', 'expectedRevision', 'patches']), true, async (args, ctx, state) => {
      if (!Array.isArray(args.patches) || !args.patches.length || args.patches.length > 40 || Buffer.byteLength(JSON.stringify(args.patches)) > 1024 * 1024) throw fail(400, '请提供1至40处有界精确修改。');
      for (const patch of args.patches) { remotionSourcePath(patch?.path); exactText(patch.oldText, '旧文字'); exactText(patch.newText, '新文字', { empty: true }); noCredentials(patch.newText, ctx); }
      const record = await source(args, ctx, state, true), grouped = new Map();
      for (const patch of args.patches) {
        const file = selectedFile(record, patch.path), start = file.content.indexOf(patch.oldText); noCredentials(file.content, ctx);
        if (start < 0) throw fail(409, '旧文字未匹配，未写入任何文件。请重新读取。', 'ASSISTANT_CODE_OLD_TEXT_MISSING');
        if (file.content.indexOf(patch.oldText, start + 1) >= 0) throw fail(409, '旧文字有多处匹配，未写入任何文件。请扩大唯一上下文。', 'ASSISTANT_CODE_OLD_TEXT_AMBIGUOUS');
        const end = start + patch.oldText.length; if (!boundary(file.content, start) || !boundary(file.content, end)) throw fail(400, '修改边界切开了字符。');
        if (!grouped.has(file.path)) grouped.set(file.path, { path: file.path, before: file.content, edits: [] });
        grouped.get(file.path).edits.push({ start, end, newText: patch.newText });
      }
      const changes = [];
      for (const file of grouped.values()) {
        file.edits.sort((a, b) => a.start - b.start);
        if (file.edits.some((edit, index) => index > 0 && file.edits[index - 1].end > edit.start)) throw fail(409, '同批修改范围重叠，未写入任何文件。', 'ASSISTANT_CODE_PATCH_OVERLAP');
        let content = file.before; for (const edit of [...file.edits].reverse()) content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
        if (content !== file.before) changes.push({ ...file, after: content });
      }
      if (!changes.length) return { summary: '源码内容无需修改。', data: { remotionId: record.id, revision: record.revision, changed: false, changes: { format: 'actual-before-after-line-hunks', files: [], truncated: false } }, effects: [] };
      const diff = sourceDiff(changes, ctx); await current(ctx, state, 'video'); check(ctx); ready(remotionProjects, 'update');
      const reservation = prepareUndo({ kind: 'remotion-source', projectId: ctx.projectId, createdAt: state.createdAt, runId: ctx.runId, remotionId: record.id, expectedRevision: record.revision + 1, before: oldSnapshot(record) });
      let saved;
      try { saved = await remotionProjects.update(ctx.projectId, record.id, { expectedRevision: record.revision, ownerCreatedAt: state.createdAt, files: changes.map(file => ({ path: file.path, content: file.after })) }); await reservation.commit({ expectedRevision: saved.revision }); }
      catch (error) { await reservation.cancel(); throw error; }
      // Do not turn a successfully committed source revision into a failure if
      // Stop arrives after the atomic write. The agent retains late receipts.
      return { summary: '已精确修改源码，需编译验证。', data: { remotionId: saved.id, revision: saved.revision, changed: true, changedFiles: changes.map(file => file.path), changes: diff }, effects: [{ type: 'remotion', projectId: ctx.projectId, label: '已精确修改动画源码', changed: true, undo: reservation.undo, sourceChanges: { version: 1, remotionId: saved.id, fromRevision: record.revision, toRevision: saved.revision, ...diff } }] };
    }),
  ].map(registered => ({ ...registered, evidence(result, { projectId } = {}) {
    const data = result?.data; if (typeof projectId !== 'string' || typeof data?.remotionId !== 'string' || !Number.isSafeInteger(data.revision)) return [];
    const saved = registered.name === 'remotion_code_patch' && data.changed === true;
    return [{ role: saved ? 'execution' : 'read', kind: saved ? 'source_saved' : registered.name === 'remotion_code_search' ? 'source_search' : 'source_read', outcome: 'completed', label: saved ? '已精确保存动画源码' : registered.name === 'remotion_code_search' ? '已搜索动画源码' : '已读取动画源码', resourceKey: `remotion:${projectId}:${data.remotionId}`, revision: data.revision, ...(saved ? { invalidates: true, limitations: ['仅保存源码，尚未编译或画面验证'] } : {}) }];
  } }));
}



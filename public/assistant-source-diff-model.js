const encoder = new TextEncoder(), decoder = new TextDecoder();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownerId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const line = value => Number.isSafeInteger(value) && value >= 1 && value <= 10000000;
const revision = value => Number.isSafeInteger(value) && value >= 1;
function sourcePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').some(part => !part || part === '.' || part === '..' || /[:<>"|?*\x00-\x1f]/.test(part) || part !== part.trimEnd() || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    && /\.(?:[cm]?[jt]sx?|css|json|svg|txt|glsl|vert|frag|wgsl)$/i.test(value)
    && !/(?:^|\/)(?:node_modules|\.git|\.env[^/]*)(?:\/|$)/i.test(value)
    && !/^(?:package(?:-lock)?\.json|tsconfig\.json|remotion\.config\.[^/]+)$/i.test(value) && !/^public\/media\//i.test(value);
}
const redact = value => value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [已隐藏]').replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[已隐藏]')
  .replace(/\b[A-Z]:[\\/](?:[^\s<>"'`，。；）)\]}]+[\\/]?)+/gi, '[本机路径]').replace(/\\\\[^\s<>"'`，。；）)\]}]+/g, '[本机路径]')
  .replace(/\/(?:Users|home|root)\/[^\s<>"'`，。；）)\]}]+/g, '[本机路径]');

/** Pure DTO normalizer shared by the server receipt and both assistant UIs. */
export function normalizeAssistantSourceChanges(value, { clean = String, maxBytes = 12000 } = {}) {
  if (!object(value) || value.version !== 1 || value.format !== 'actual-before-after-line-hunks' || !ownerId(value.remotionId)
    || !revision(value.fromRevision) || !revision(value.toRevision) || value.toRevision <= value.fromRevision || !Array.isArray(value.files)) return null;
  let budget = Number.isSafeInteger(maxBytes) ? Math.min(12000, Math.max(0, maxBytes)) : 12000, truncated = value.truncated === true || value.files.length > 40;
  const files = [];
  const take = (raw, allowed = budget) => {
    const original = raw.slice(0, 24000), safe = redact(clean(original)), bytes = encoder.encode(safe); let size = Math.min(budget, allowed, bytes.length);
    if (size < bytes.length) while (size > 0 && (bytes[size] & 0xC0) === 0x80) size--;
    budget -= size;
    const cut = size < bytes.length || original.length < raw.length || safe !== raw;
    if (cut) truncated = true;
    return { text: decoder.decode(bytes.subarray(0, size)), truncated: cut };
  };
  for (const raw of value.files.slice(0, 40)) {
    if (!object(raw) || !sourcePath(raw.path) || clean(raw.path) !== raw.path || !hash(raw.beforeSHA256) || !hash(raw.afterSHA256) || !Array.isArray(raw.hunks)) { truncated = true; continue; }
    const hunks = [];
    for (const hunk of raw.hunks.slice(0, 40)) {
      if (!object(hunk) || ![hunk.oldStartLine, hunk.oldEndLine, hunk.newStartLine, hunk.newEndLine].every(line) || hunk.oldEndLine < hunk.oldStartLine || hunk.newEndLine < hunk.newStartLine || typeof hunk.before !== 'string' || typeof hunk.after !== 'string') { truncated = true; continue; }
      const afterReserve = Math.min(Math.floor(budget / 2), encoder.encode(redact(clean(hunk.after.slice(0, 24000)))).length);
      const before = take(hunk.before, budget - afterReserve), after = take(hunk.after), cut = hunk.truncated === true || before.truncated || after.truncated;
      if (cut) truncated = true;
      hunks.push({ oldStartLine: hunk.oldStartLine, oldEndLine: hunk.oldEndLine, newStartLine: hunk.newStartLine, newEndLine: hunk.newEndLine,
        ...(line(hunk.oldStartColumn) ? { oldStartColumn: hunk.oldStartColumn } : {}), ...(line(hunk.newStartColumn) ? { newStartColumn: hunk.newStartColumn } : {}), before: before.text, after: after.text, truncated: cut });
    }
    if (raw.hunks.length > 40) truncated = true;
    if (hunks.length) files.push({ path: raw.path, beforeSHA256: raw.beforeSHA256.toLowerCase(), afterSHA256: raw.afterSHA256.toLowerCase(), replacements: Number.isSafeInteger(raw.replacements) && raw.replacements >= 0 ? Math.min(40, raw.replacements) : 0,
      ...(Number.isSafeInteger(raw.addedLines) && raw.addedLines >= 0 && raw.addedLines <= 10000000 ? { addedLines: raw.addedLines } : {}), ...(Number.isSafeInteger(raw.removedLines) && raw.removedLines >= 0 && raw.removedLines <= 10000000 ? { removedLines: raw.removedLines } : {}), ...(raw.countsMode === 'replaced-line-range' ? { countsMode: raw.countsMode } : {}), hunks });
  }
  return files.length ? { version: 1, remotionId: value.remotionId, fromRevision: value.fromRevision, toRevision: value.toRevision, format: value.format, files, truncated } : null;
}

export function assistantSourceChangeBytes(value) {
  return (value?.files || []).reduce((total, file) => total + (file.hunks || []).reduce((sum, hunk) => sum + encoder.encode(hunk.before || '').length + encoder.encode(hunk.after || '').length, 0), 0);
}

/** Retain recent source text without losing older change/undo receipts. */
export function boundAssistantSourceChangeEffects(effects, { clean = String, maxBytes = 24000 } = {}) {
  const result = Array.isArray(effects) ? effects.slice() : []; let remaining = Number.isSafeInteger(maxBytes) ? Math.min(24000, Math.max(0, maxBytes)) : 24000;
  for (let index = result.length - 1; index >= 0; index--) {
    const effect = result[index]; if (effect?.type !== 'remotion' || !effect.sourceChanges) continue;
    const sourceChanges = normalizeAssistantSourceChanges(effect.sourceChanges, { clean, maxBytes: remaining });
    result[index] = { ...effect }; delete result[index].sourceChanges;
    if (sourceChanges) { result[index].sourceChanges = sourceChanges; remaining -= assistantSourceChangeBytes(sourceChanges); }
  }
  return result;
}

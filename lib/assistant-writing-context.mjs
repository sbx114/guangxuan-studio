import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
import { normalizeWritingInput, WRITING_CHANNELS } from './writing.mjs';

export const assistantWritingFingerprint = output => createHash('sha256').update(JSON.stringify(output)).digest('hex');
const fail = message => { throw new AppError(409, message, 'ASSISTANT_WRITING_CONTEXT_CHANGED'); };
export function writingSelectionRequired(instruction = '') {
  const text = String(instruction).replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"\n]*"/g, ' ').replace(/(?:不要|别|不必|不是)\s*(?:只|仅)[^，。;；\n]*/g, ' ');
  return /改|润色|精修|重写|调整|\b(?:edit|revise|rewrite)\b/i.test(text) && /(?:只|仅)[^，。;；\n]{0,16}(?:选中|所选|选区|这段)|\bonly\b[^.!?\n]{0,40}\bselected\b/i.test(text);
}
export function normalizeAssistantWritingContext(value, project) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['channel', 'writingRevision', 'outputFingerprint', 'selection'].includes(key))) fail('文案窗口参数无效，请重新打开当前文案助手。');
  if (project?.kind !== 'writing') fail('文案窗口只使用当前文案项目，请重新选择项目。');
  const channel = value.channel || project.writing?.draft?.channel || 'auto';
  if (channel !== 'auto' && !WRITING_CHANNELS.includes(channel)) fail('文案窗口的稿件形式无效。');
  if (!Number.isSafeInteger(value.writingRevision) || value.writingRevision !== (project.writingRevision || 0)) fail('文稿已有新修改，请重新读取后再发送要求。');
  const output = project.writing?.draft?.channel === channel ? project.writing.draft.output : project.outputs?.[channel];
  const fingerprint = output ? assistantWritingFingerprint(output) : null;
  if ((value.outputFingerprint ?? null) !== fingerprint) fail('当前稿件与助手窗口快照不同，请重新读取后再发送要求。');
  let selection = null;
  if (value.selection != null) {
    if (!output) fail('当前没有可选择的稿件。');
    selection = normalizeWritingInput('writing-revise', { source: project.source || {}, writingBrief: { channel }, output, selection: value.selection, instruction: '校验当前选区' }).selection;
  }
  return { channel, writingRevision: value.writingRevision, outputFingerprint: fingerprint, selection };
}

/** Selection is advisory and expires when that output changes through a real write. */
export function currentAssistantWritingContext(project, hint) {
  const channel = project.writing?.draft?.channel || (WRITING_CHANNELS.includes(hint?.channel) ? hint.channel : null);
  const output = channel ? project.writing?.draft?.channel === channel ? project.writing.draft.output : project.outputs?.[channel] : null;
  const fingerprint = output ? assistantWritingFingerprint(output) : null;
  const selection = hint?.channel === channel && hint.outputFingerprint === fingerprint ? hint.selection : null;
  return { channel, output: output || null, outputFingerprint: fingerprint, writingRevision: project.writingRevision || 0,
    selection: selection || null, selectionIsReference: true, goal: project.writing?.brief?.goal || '',
    ...(hint?.selection && !selection ? { selectionNotice: '稿件已更新，原选区不再沿用；按当前对话读取最新稿件。' } : {}) };
}

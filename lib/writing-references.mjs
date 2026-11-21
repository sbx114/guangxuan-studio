import { createHash } from 'node:crypto';
import { AppError, requireObject } from './errors.mjs';
import { validateProjectId } from './store.mjs';
import { normalizeWritingReferenceSelection, writingOutputText } from '../public/writing-model.js';

const MAX_TEXT = 12000, MAX_PROJECT_TEXT = 16000;
const fail = (status, message, code = 'WRITING_REFERENCE_INVALID') => new AppError(status, message, code);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function normalizeWritingReferenceConfig(input) {
  const value = input == null ? {} : requireObject(input, '参考设置');
  if (Object.keys(value).some(key => !['enabled', 'purpose', 'text', 'projectId', 'projectPart', 'projectCreatedAt'].includes(key))) throw fail(400, '参考设置包含不支持的字段。');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean' || value.purpose !== undefined && !['auto', 'content', 'style'].includes(value.purpose) || value.projectPart !== undefined && !['work', 'material'].includes(value.projectPart)) throw fail(400, '参考用途或来源设置不正确。');
  for (const [key, maximum] of [['text', MAX_TEXT], ['projectId', 128], ['projectCreatedAt', 40]]) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > maximum || value[key].includes('\0'))) throw fail(400, key === 'text' ? '粘贴参考最多12000字。' : '参考项目设置不正确。');
  const config = normalizeWritingReferenceSelection(value);
  if (config.projectId) validateProjectId(config.projectId);
  if (config.projectCreatedAt && !Number.isFinite(Date.parse(config.projectCreatedAt))) throw fail(400, '参考项目版本不正确。');
  if (!config.projectId) config.projectCreatedAt = '';
  return config;
}

/** Only this resolved, bounded source form enters the writing prompt. */
export function normalizeWritingReferenceContext(input) {
  if (input == null || input.enabled === false) return { enabled: false, purpose: 'auto', items: [] };
  const value = requireObject(input, '写作参考');
  if (value.enabled !== true || !['auto', 'content', 'style'].includes(value.purpose) || !Array.isArray(value.items) || value.items.length > 2) throw fail(400, '写作参考尚未准备好，请重新选择。');
  const seen = new Set();
  const items = value.items.map(item => {
    if (!item || !['reference-text', 'reference-project'].includes(item.id) || seen.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_PROJECT_TEXT) throw fail(400, '写作参考内容不完整。');
    seen.add(item.id);
    return { id: item.id, title: item.title, text: item.text, truncated: item.truncated === true, ...(typeof item.projectId === 'string' ? { projectId: validateProjectId(item.projectId) } : {}), ...(item.part === 'material' || item.part === 'work' ? { part: item.part } : {}) };
  });
  if (!items.length) throw fail(400, '请粘贴参考或选择已有内容。', 'WRITING_REFERENCE_EMPTY');
  return { enabled: true, purpose: value.purpose, items, ...(typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint) ? { fingerprint: value.fingerprint } : {}) };
}

function workText(project) {
  const array = value => Array.isArray(value) ? value : [];
  const draft = project.writing?.draft;
  if (draft?.output) { const text = writingOutputText(draft.channel, draft.output); if (text) return text; }
  for (const channel of ['article', 'social', 'poster', 'video']) { const text = writingOutputText(channel, project.outputs?.[channel]); if (text) return text; }
  if (project.kind === 'video') return [typeof project.video?.script === 'string' ? project.video.script : '', ...array(project.video?.sourceStoryboard).filter(shot => shot && typeof shot === 'object').map(shot => [shot.narration, shot.caption, shot.visual].filter(value => typeof value === 'string').join('\n'))].filter(Boolean).join('\n\n');
  const novel = project.science?.novel;
  if (novel) return [novel.title, novel.logline, ...array(novel.scenes).flatMap(scene => array(scene?.lines).filter(line => line && typeof line === 'object').map(line => [line.text, line.card?.title, line.card?.text].filter(value => typeof value === 'string').join('\n')))].filter(value => typeof value === 'string' && value).join('\n\n');
  return project.science?.result?.explanation || '';
}

export function createWritingReferenceService({ store } = {}) {
  if (!store?.read) throw new TypeError('Writing references require a project store.');
  async function owner(projectId) { const project = await store.read(validateProjectId(projectId)); if (!project || project.kind !== 'writing') throw fail(404, '请先打开文案项目。', 'WRITING_PROJECT_REQUIRED'); return project; }
  async function selected(config, projectId) {
    if (!config.projectId) return null;
    if (config.projectId === projectId) throw fail(400, '当前材料和稿件已在写作上下文中，请选择其它项目参考。');
    const project = await store.read(config.projectId);
    if (!project || config.projectCreatedAt && project.createdAt !== config.projectCreatedAt) throw fail(409, '参考项目已移除或重建，请重新选择。', 'WRITING_REFERENCE_CHANGED');
    const text = config.projectPart === 'material' ? project.source?.text || '' : workText(project);
    if (typeof text !== 'string' || !text.trim()) throw fail(409, '所选项目暂无这类内容，请重新选择。', 'WRITING_REFERENCE_CHANGED');
    return { project, text };
  }
  async function configure(projectId, input) {
    await owner(projectId); const config = normalizeWritingReferenceConfig(input);
    const value = config.enabled ? await selected(config, projectId) : null;
    if (value) config.projectCreatedAt = value.project.createdAt;
    return config;
  }
  async function context(projectOrId, input) {
    const project = typeof projectOrId === 'string' ? await owner(projectOrId) : projectOrId;
    const config = normalizeWritingReferenceConfig(input ?? project.writing?.references);
    if (!config.enabled) return { enabled: false, purpose: 'auto', items: [], fingerprint: digest({ enabled: false }) };
    const items = [];
    if (config.text.trim()) items.push({ id: 'reference-text', title: '粘贴参考', text: config.text.trim(), truncated: false });
    const value = await selected(config, project.id);
    if (value) items.push({ id: 'reference-project', title: `${value.project.title || '未命名项目'} · ${config.projectPart === 'material' ? '材料' : '作品'}`.slice(0, 300), text: value.text.slice(0, MAX_PROJECT_TEXT), truncated: value.text.length > MAX_PROJECT_TEXT, projectId: value.project.id, part: config.projectPart });
    const resolved = normalizeWritingReferenceContext({ enabled: true, purpose: config.purpose, items });
    return { ...resolved, fingerprint: digest({ config, items, sourceCreatedAt: value?.project.createdAt || '' }) };
  }
  async function options(projectId) {
    if (!store.list) throw fail(503, '项目参考列表暂不可用。');
    const project = await owner(projectId), result = await store.list(), items = [];
    for (const candidate of result.projects || []) {
      if (candidate.id === projectId) continue;
      for (const part of ['work', 'material']) {
        const text = part === 'material' ? candidate.source?.text || '' : workText(candidate);
        if (typeof text !== 'string' || !text.trim()) continue;
        items.push({ projectId: candidate.id, part, title: candidate.title || '未命名项目', label: `${candidate.title || '未命名项目'} · ${part === 'material' ? '材料' : '作品'}`, projectCreatedAt: candidate.createdAt, characters: text.length, truncated: text.length > MAX_PROJECT_TEXT });
      }
    }
    return { config: normalizeWritingReferenceConfig(project.writing?.references), items, limits: { textCharacters: MAX_TEXT, projectCharacters: MAX_PROJECT_TEXT } };
  }
  return { options, configure, context };
}

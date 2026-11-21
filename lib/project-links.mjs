import path from 'node:path';
import { mkdir, lstat, readFile, realpath, rename, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { validateProjectId, withoutSecrets, assistantContentHash } from './store.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['narration', 'caption', 'visual', 'duration'];
const text = (value, limit = 6000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const emptyShot = () => ({ narration: '', caption: '', visual: '', duration: 8 });
function snapshot(project) {
  const video = project.outputs?.video || project.science?.result?.video;
  const shots = (Array.isArray(video?.shots) ? video.shots : []).slice(0, 200).map(value => {
    const shot = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { narration: text(shot.narration), caption: text(shot.caption || shot.narration, 2000), visual: text(shot.visual), duration: Number.isFinite(Number(shot.duration)) ? Math.max(.1, Math.min(120, Number(shot.duration))) : 8 };
  });
  const body = text(project.kind === 'science' ? project.science?.result?.explanation || project.source?.text : project.outputs?.article?.body || project.source?.text, 60000);
  const value = { title: text(project.title, 120), body, shots };
  return { ...value, hash: hash(value), updatedAt: project.updatedAt };
}
function draftCaptions(project) {
  const video = project.video || {};
  if (Object.hasOwn(video, 'openfilmDraftCaptions')) return Array.isArray(video.openfilmDraftCaptions) ? video.openfilmDraftCaptions : [];
  const legacy = video.openfilmScriptDraft;
  if (legacy?.source !== 'writing-draft' || !Array.isArray(legacy.captions)) return [];
  return legacy.captions.slice(0, 2000).filter(caption => caption && typeof caption === 'object' && Number.isFinite(caption.start) && Number.isFinite(caption.end) && caption.start >= 0 && caption.end > caption.start && caption.end <= 86400 && typeof caption.text === 'string' && caption.text.trim()).map(caption => ({ start: caption.start, end: caption.end, text: caption.text, ...(['title', 'bottom'].includes(caption.placement) ? { placement: caption.placement } : {}) }));
}
const draftHash = project => hash({ script: project.video?.script || '', captions: draftCaptions(project), storyboard: project.video?.sourceStoryboard || [] });
export const sourceLinkContentHash = state => hash(state ? [state.targetCreatedAt, state.sourceProjectId, state.baseline] : null);
function savedFields(project) {
  return [['sourceProjectId'], ['video', 'script'], ['video', 'openfilmDraftCaptions'], ['video', 'sourceStoryboard']].map(parts => {
    const parent = parts.length === 2 ? project.video : project, key = parts.at(-1), exists = !!parent && Object.hasOwn(parent, key);
    return { path: parts, exists, ...(exists ? { value: structuredClone(parent[key]) } : {}) };
  });
}
function restoreParents(project) { return !Object.hasOwn(project, 'video') || project.video === null ? [{ path: ['video'], exists: Object.hasOwn(project, 'video'), ...(project.video === null ? { value: null } : {}) }] : []; }
function changes(before, after) {
  const result = [];
  if ((before.body || '') !== (after.body || '')) result.push({ id: 'source:body', index: -1, field: 'sourceText', before: before.body || '', after: after.body || '', notice: true });
  for (let index = 0; index < Math.max(before.shots.length, after.shots.length); index++) {
    const old = before.shots[index] || emptyShot(), next = after.shots[index] || emptyShot();
    for (const field of fields) if (old[field] !== next[field]) result.push({ id: `${index}:${field}`, index, field, before: old[field], after: next[field], removed: !after.shots[index] });
  }
  return result;
}
function replaceOnce(script, before, after) {
  if (!before) return { value: after && !script.includes(after) ? [script, after].filter(Boolean).join('\n') : script };
  if (!script.includes(before)) return after && script.includes(after) ? { value: script } : { conflict: true };
  if (script.indexOf(before) !== script.lastIndexOf(before)) return { conflict: true };
  return { value: script.replace(before, after) };
}

export async function createProjectLinkService({ dataDir, store, sensitiveStrings = () => [] } = {}) {
  const root = path.join(path.resolve(dataDir), 'project-links'); await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || path.dirname(await realpath(root)).toLowerCase() !== (await realpath(dataDir)).toLowerCase()) throw new AppError(500, '来源版本目录无效。', 'SOURCE_LINK_STORAGE_INVALID');
  const queues = new Map();
  const file = id => path.join(root, validateProjectId(id) + '.json');
  const serial = (id, operation) => { const task = (queues.get(id) || Promise.resolve()).catch(() => {}).then(operation); queues.set(id, task); task.finally(() => { if (queues.get(id) === task) queues.delete(id); }).catch(() => {}); return task; };
  async function target(id) { const value = await store.read(validateProjectId(id)); if (!value || value.kind !== 'video') throw new AppError(404, '请选择视频项目。', 'PROJECT_NOT_FOUND'); return value; }
  async function source(id) { const value = await store.read(validateProjectId(id)); if (!value || !['writing', 'science'].includes(value.kind)) throw new AppError(404, '来源文案或科普项目已不存在。', 'SOURCE_PROJECT_NOT_FOUND'); return value; }
  async function read(id, owner) {
    try { const info = await lstat(file(id)); if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error(); const state = JSON.parse(await readFile(file(id), 'utf8')); if (state.version !== 1 || state.targetCreatedAt !== owner.createdAt) return null; if (!Array.isArray(state.baseline?.shots) || state.baseline.shots.length > 200 || state.baseline.shots.some(shot => !shot || fields.some(field => field === 'duration' ? !Number.isFinite(shot.duration) : typeof shot[field] !== 'string')) || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error(); validateProjectId(state.sourceProjectId); return state; }
    catch (error) { if (error.code === 'ENOENT') return null; throw new AppError(500, '来源版本记录无法读取，原文件已保留。', 'SOURCE_LINK_READ_FAILED'); }
  }
  async function write(id, value) { const temporary = file(id) + '.' + randomUUID() + '.tmp'; const serialized = JSON.stringify(withoutSecrets(value, 0, sensitiveStrings()), null, 2); if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new AppError(413, '来源分镜过大，请拆分项目。', 'SOURCE_LINK_TOO_LARGE'); try { await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 }); await rename(temporary, file(id)); } catch (error) { await unlink(temporary).catch(() => {}); throw new AppError(500, '来源版本记录保存失败，请重试。', 'SOURCE_LINK_WRITE_FAILED'); } }
  function compare(owner, state, options = {}) {
    if (options.expectedHash !== undefined && options.expectedHash !== assistantContentHash(owner) || options.expectedCreatedAt !== undefined && options.expectedCreatedAt !== owner.createdAt || options.expectedLinkHash !== undefined && options.expectedLinkHash !== sourceLinkContentHash(state)) throw new AppError(409, '项目或来源关联已经变化，请重新比较后再修改。', 'SOURCE_LINK_CONFLICT');
  }
  async function restoreFields(id, fields, parents, expectedHash) {
    return store.updateAssistant(id, { expectedHash, patch: fields.map(entry => ({ path: entry.path, ...(entry.exists ? { value: entry.value } : { remove: true }) })), restoreParents: parents });
  }
  async function publish(id, owner, prior, update, options, publishState) {
    compare(owner, prior, options);
    const project = await store.updateVideoDraft(id, update, options);
    try {
      if ((await target(id)).createdAt !== owner.createdAt) throw new AppError(409, '项目已重新创建，未写入来源关联。', 'SOURCE_LINK_CONFLICT');
      await publishState(); return project;
    } catch (error) {
      // Only compensate our exact published draft; never overwrite a later edit.
      try { await restoreFields(id, savedFields(owner), restoreParents(owner), assistantContentHash(project)); }
      catch { throw new AppError(409, '来源记录未能保存，期间项目又有编辑，已保留最新草稿，请重新比较来源状态。', 'SOURCE_LINK_PARTIAL_COMMIT'); }
      throw error;
    }
  }
  async function describe(id) {
    const owner = await target(id), state = await read(id, owner), sourceId = state?.sourceProjectId || owner.sourceProjectId;
    if (!sourceId) return { projectId: id, status: 'unlinked', changes: [], sourceProjectId: null, targetHash: draftHash(owner), targetScript: owner.video?.script || '', revision: 0, linkHash: sourceLinkContentHash(state) };
    let original; try { original = await source(sourceId); } catch (error) { if (error.code !== 'SOURCE_PROJECT_NOT_FOUND') throw error; return { projectId: id, status: 'source-missing', sourceProjectId: sourceId, sourceTitle: state?.baseline?.title || '', changes: [], targetHash: draftHash(owner), targetScript: owner.video?.script || '', revision: state?.revision || 0, linkHash: sourceLinkContentHash(state) }; }
    const current = snapshot(original), baseline = state?.baseline || { title: '', shots: [] }, diff = changes(baseline, current);
    return { projectId: id, sourceProjectId: sourceId, sourceTitle: current.title, status: !state ? 'untracked' : diff.length ? 'changed' : 'in-sync', sourceHash: current.hash, sourceUpdatedAt: current.updatedAt, targetHash: draftHash(owner), targetScript: owner.video?.script || '', revision: state?.revision || 0, changes: diff, storyboard: current.shots, baselineAt: state?.syncedAt || null, linkHash: sourceLinkContentHash(state) };
  }
  return {
    async status(id) { await queues.get(id)?.catch(() => {}); return describe(id); },
    async candidates() { const { projects } = await store.summary(); return { projects: projects.filter(project => ['writing', 'science'].includes(project.kind)) }; },
    async preview(sourceProjectId) { const value = await source(sourceProjectId), data = snapshot(value); return { sourceProjectId: value.id, sourceHash: data.hash, sourceTitle: data.title, sourceUpdatedAt: data.updatedAt, body: data.body, storyboard: data.shots }; },
    async assistantSnapshot(id) { await queues.get(id)?.catch(() => {}); const owner = await target(id), state = await read(id, owner); return { state, fields: savedFields(owner), restoreParents: restoreParents(owner), createdAt: owner.createdAt, expectedHash: assistantContentHash(owner), linkHash: sourceLinkContentHash(state) }; },
    restoreAssistant(id, before, options = {}) { return serial(id, async () => {
      const owner = await target(id), state = await read(id, owner); compare(owner, state, options);
      if (!before || before.createdAt !== owner.createdAt || !Array.isArray(before.fields) || before.fields.length !== 4 || options.expectedHash === undefined || options.expectedLinkHash === undefined) throw new AppError(400, '来源撤销记录无效。', 'SOURCE_LINK_UNDO_INVALID');
      const restored = await restoreFields(id, before.fields, before.restoreParents, options.expectedHash);
      try {
        if (before.state) await write(id, { ...before.state, revision: Math.max(state?.revision || 0, before.state.revision || 0) + 1, syncedAt: new Date().toISOString() });
        else await unlink(file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } catch (error) {
        try { await restoreFields(id, savedFields(owner), restoreParents(owner), restored.afterHash); } catch { throw new AppError(409, '来源撤销未完成，期间的新编辑已保留，请重新比较。', 'SOURCE_LINK_PARTIAL_COMMIT'); }
        throw error;
      }
      return { ...(await describe(id)), project: restored.project, restored: true, timelineChanged: false };
    }); },
    bind(id, input, options = {}) { return serial(id, async () => {
      const owner = await target(id), original = await source(input?.sourceProjectId);
      const baseline = snapshot(original), prior = await read(id, owner);
      if (input?.sourceHash !== undefined && input.sourceHash !== baseline.hash) throw new AppError(409, '来源又有更新，请重新比较。', 'SOURCE_VERSION_CHANGED');
      const project = await publish(id, owner, prior, async () => { if (input?.sourceHash !== undefined && snapshot(await source(original.id)).hash !== input.sourceHash) throw new AppError(409, '来源又有更新，请重新比较。', 'SOURCE_VERSION_CHANGED'); return { sourceProjectId: original.id }; }, options, () => write(id, { version: 1, targetCreatedAt: owner.createdAt, sourceProjectId: original.id, baseline, revision: (prior?.revision || 0) + 1, syncedAt: new Date().toISOString() }));
      return { ...(await describe(id)), project, timelineChanged: false };
    }); },
    unlink(id, options = {}) { return serial(id, async () => { const owner = await target(id), prior = await read(id, owner); const project = await publish(id, owner, prior, () => ({ sourceProjectId: null }), options, () => unlink(file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; })); return { ...(await describe(id)), project, timelineChanged: false }; }); },
    sync(id, input, options = {}) { return serial(id, async () => {
      const owner = await target(id), state = await read(id, owner), sourceId = state?.sourceProjectId || owner.sourceProjectId;
      if (!sourceId) throw new AppError(400, '请先关联来源项目。', 'SOURCE_PROJECT_REQUIRED');
      const original = await source(sourceId), current = snapshot(original), baseline = state?.baseline || { title: '', shots: [] };
      if (input?.sourceHash !== current.hash || input?.revision !== (state?.revision || 0)) throw new AppError(409, '来源又有更新，请重新比较后同步。', 'SOURCE_VERSION_CHANGED');
      if (!Array.isArray(input.selectedIds) || input.selectedIds.length > 801 || input.selectedIds.some(value => typeof value !== 'string')) throw new AppError(400, '请选择需要同步的变动。', 'INVALID_SOURCE_SELECTION');
      const selected = new Set(input.selectedIds), diff = changes(baseline, current), applied = [], conflicts = [];
      if (input.selectedIds.some(id => !diff.some(change => change.id === id))) throw new AppError(400, '所选变动已不存在，请刷新比较。', 'INVALID_SOURCE_SELECTION');
      const nextBaseline = structuredClone(baseline); nextBaseline.title = current.title;
      const project = await publish(id, owner, state, async latest => {
        if (snapshot(await source(sourceId)).hash !== input.sourceHash) throw new AppError(409, '来源又有更新，请重新比较后同步。', 'SOURCE_VERSION_CHANGED');
        if (input.targetHash !== draftHash(latest)) throw new AppError(409, '视频草稿已改变，请刷新比较，手动剪辑已保留。', 'TARGET_DRAFT_CHANGED');
        let script = latest.video?.script || '';
        const captions = structuredClone(draftCaptions(latest));
        const hasStoryboard = Array.isArray(latest.video?.sourceStoryboard);
        const storyboard = structuredClone(hasStoryboard ? latest.video.sourceStoryboard : baseline.shots);
        const manual = typeof input.manualScript === 'string' && input.manualScript !== script;
        if (manual) { if (input.manualScript.length > 30000) throw new AppError(400, '旁白草稿过长。', 'INVALID_VIDEO_DRAFT'); script = input.manualScript; }
        for (const change of diff.filter(change => selected.has(change.id))) {
          if (change.field === 'sourceText') { nextBaseline.body = current.body; applied.push(change.id); continue; }
          const draftShot = storyboard[change.index];
          if (hasStoryboard && draftShot && Object.hasOwn(draftShot, change.field) && draftShot[change.field] !== change.before && draftShot[change.field] !== change.after) {
            conflicts.push({ ...change, message: `第${change.index + 1}段分镜草稿已有手动修改，未覆盖该字段。` }); continue;
          }
          if (change.field === 'narration' && !manual) {
            const replacement = replaceOnce(script, String(change.before), String(change.after));
            if (replacement.conflict) { conflicts.push({ ...change, message: '该段旁白已有手动修改，请在下方草稿中合并后再同步。' }); continue; }
            script = replacement.value;
          }
          if (change.field === 'caption') {
            const matches = captions.filter(caption => caption?.text === change.before);
            if (change.before && matches.length !== 1 && !captions.some(caption => caption?.text === change.after)) { conflicts.push({ ...change, message: '拟定字幕已有修改，未覆盖该字幕。' }); continue; }
            if (matches.length === 1) { if (change.after) matches[0].text = change.after; else captions.splice(captions.indexOf(matches[0]), 1); }
            else if (!change.before && change.after && !captions.some(caption => caption?.text === change.after)) { const start = current.shots.slice(0, change.index).reduce((sum, shot) => sum + shot.duration, 0); captions.push({ start, end: start + current.shots[change.index].duration, text: change.after }); }
          }
          while (nextBaseline.shots.length <= change.index) nextBaseline.shots.push(emptyShot());
          while (storyboard.length <= change.index) storyboard.push(emptyShot());
          if (!storyboard[change.index] || typeof storyboard[change.index] !== 'object' || Array.isArray(storyboard[change.index])) storyboard[change.index] = emptyShot();
          storyboard[change.index][change.field] = change.after;
          nextBaseline.shots[change.index][change.field] = change.after; applied.push(change.id);
        }
        while (nextBaseline.shots.length > current.shots.length && Object.entries(nextBaseline.shots.at(-1)).every(([key, value]) => key === 'duration' ? value === 8 : !value)) nextBaseline.shots.pop();
        while (storyboard.length > current.shots.length && storyboard.at(-1) && Object.entries(storyboard.at(-1)).every(([key, value]) => key === 'duration' ? value === 8 : !value)) storyboard.pop();
        return { script, captions, storyboard, sourceProjectId: sourceId };
      }, options, () => write(id, { version: 1, targetCreatedAt: owner.createdAt, sourceProjectId: sourceId, baseline: nextBaseline, revision: (state?.revision || 0) + 1, syncedAt: new Date().toISOString() }));
      return { ...(await describe(id)), project, applied, conflicts, timelineChanged: false };
    }); },
    async context(id) {
      const value = await target(id);
      if (!value.sourceProjectId) return null;
      const sourceProjectId = validateProjectId(value.sourceProjectId);
      const sourceStoryboard = (Array.isArray(value.video?.sourceStoryboard) ? value.video.sourceStoryboard : []).slice(0, 200).filter(shot => shot && typeof shot === 'object' && !Array.isArray(shot) && Number.isFinite(shot.duration) && shot.duration >= .1 && shot.duration <= 120).map(shot => ({ narration: text(shot.narration), caption: text(shot.caption, 2000), visual: text(shot.visual), duration: shot.duration }));
      const openfilmDraftCaptions = draftCaptions(value).slice(0, 2000).filter(caption => caption && typeof caption === 'object' && Number.isFinite(caption.start) && Number.isFinite(caption.end) && caption.start >= 0 && caption.end > caption.start && caption.end <= 86400 && text(caption.text, 2000)).map(caption => ({ start: caption.start, end: caption.end, text: text(caption.text, 2000), ...(['title', 'bottom'].includes(caption.placement) ? { placement: caption.placement } : {}) }));
      if (!sourceStoryboard.length && !openfilmDraftCaptions.length) return null;
      return { sourceProjectId, version: Number.isSafeInteger(value.video?.sourceSyncRevision) && value.video.sourceSyncRevision >= 0 ? value.video.sourceSyncRevision : 0, ...(sourceStoryboard.length ? { sourceStoryboard } : {}), ...(openfilmDraftCaptions.length ? { openfilmDraftCaptions } : {}) };
    },
    async close() { await Promise.allSettled([...queues.values()]); },
  };
}

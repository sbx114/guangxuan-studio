import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { buildCaptionPage } from './typography-layout.mjs';
import { normalizeEditScope } from './edit-scope.mjs';
import { describeNativeTimeline, planNativeAdjustments, NATIVE_ADJUST_ACTIONS, NATIVE_MAX_TIME_SECONDS, nativeTimelineDuration, nativeTimelineEditLimits } from './native-adjustments.mjs';
import { applyOps } from '../integrations/openfilm/packages/openfilm/studio/server/ops.mjs';
import { clipSpan, kindOf, declarations, readFilm } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readVtt, writeVtt } from '../integrations/openfilm/packages/openfilm/src/captions.mjs';
import { applySubtitleStyle, SUBTITLE_STYLE_SCHEMA } from './native-subtitle-style.mjs';

const fail = (message, code = 'NATIVE_OPERATION_INVALID', status = 400) => new AppError(status, message, code);
const rules = {
  move_track: { fields: ['clipId', 'track', 'newTrack', 'at'], required: ['clipId', 'at'], description: '移动片段至已有轨道track或在newTrack插入新轨，at为绝对秒数；目标不可锁定、隐藏或同轨重叠。' },
  group_move: { fields: ['clipIds', 'groupId', 'delta'], required: ['delta'], groupSelector: true, description: '整组按delta秒移动；clipIds或已读groupId二选一，groupId自动读取整组。保留轨道及联动，组内每个片段仍须在授权范围。' },
  link: { fields: ['clipIds'], required: ['clipIds'], description: '将2个以上片段设为联动组；不能遗漏既有联动组成员。' },
  unlink: { fields: ['clipIds', 'groupId'], required: [], groupSelector: true, description: '解除整组联动；clipIds或已读groupId二选一，不能只处理一个组的部分成员。' },
  detach_audio: { fields: ['clipId'], required: ['clipId'], description: '将视频原声拆成新音轨并与画面联动，画面原声音量设为0，原时间和变速保留。' },
  track_set: { fields: ['track', 'field', 'value'], required: ['track', 'field', 'value'], wholeProject: true, description: '设置轨道locked/hidden/muted布尔开关。遵守当前对话范围；显式locked=false可解锁。' },
  track_reorder: { fields: ['from', 'to'], required: ['from', 'to'], wholeProject: true, description: '调整轨道叠放顺序；需全片、全部素材，涉及锁轨则拒绝。' },
  stage: { fields: ['width', 'height'], required: ['width', 'height'], wholeProject: true, description: '改变画布像素尺寸(1..8192)，保留现有片段位置；需全片及全部素材，任何锁轨则拒绝。' },
  enabled: { fields: ['clipId', 'value'], required: ['clipId', 'value'], description: 'value=true启用片段、false暂时禁用；不删除源素材，锁轨或未选片段不可改。' },
  fit: { fields: ['clipId', 'mode', 'x', 'y'], required: ['clipId', 'mode'], description: '图片或视频适应方式contain/cover/fill，x/y是0..100%的素材锚点。' },
  crop: { fields: ['clipId', 'top', 'right', 'bottom', 'left', 'radius'], required: ['clipId'], description: '画面四边裁切百分比0..99，每对合计须小于100；radius是0..50%的圆角。' },
  filter: { fields: ['clipId', 'brightness', 'contrast', 'saturation', 'hue', 'blur', 'grayscale', 'sepia', 'invert'], required: ['clipId'], description: '数值调色替换当前滤镜：brightness/contrast/saturation 0..4，hue -360..360，blur 0..100像素，grayscale/sepia/invert 0..1。' },
  asset_insert: { fields: ['assetId', 'at', 'start', 'end', 'track', 'newTrack', 'volume', 'sound'], required: ['assetId', 'at', 'end'], description: '将当前项目已选素材放至指定轨道；at为作品秒数，start/end为源秒数，图片start=0/end=显示秒数；sound=true仅取视频原声。省略轨道时新建末轨。' },
  caption_add: { fields: ['text', 'at', 'duration', 'placement', 'fontSize', 'color', 'layout'], required: ['text', 'at', 'duration'], description: '在指定绝对秒数添加可编辑纯文本标题/字幕，保留原字幕；layout支持role/anchor/align/safeMargin/maxWidth/maxLines/原生lookId/motionId。通常省略fontSize自动保持可读字号，明确指定时fontSize=8..200，color=#RRGGBB；拥挤文字需拆条而非截断。' },
  subtitles_write: { fields: ['cues', 'track'], required: ['cues'], description: 'cues=[{start,end,text}]实际写入新WebVTT字幕轨；秒数为作品时间。传track替换现有WebVTT字幕轨须全片选择，旧文件保留可撤销；不接受模型路径。' },
  subtitles_remove: { fields: ['track'], required: ['track'], wholeProject: true, description: '移除指定WebVTT字幕轨，保留原字幕文件，可撤销；需全片选择且轨道未锁定。' },
  subtitles_edit: { fields: ['track', 'edits'], required: ['track', 'edits'], description: '先native_subtitles_read取得当前index，再按edits:[{action:update/remove/insert,index,start?,end?,text?}]精确改WebVTT；insert在index前插入。保留其他句子与旧文件；文本按纯文本处理，范围只约束被改句子。' },
  subtitles_style: { fields: ['track', 'cueIndices', 'style'], required: ['track', 'style'], description: '先读真实字幕，再按原生UI完整style目录设置字体/描边/字效/动画/位置/逐字效果。cueIndices省略为整轨，指定为这些原始index；style schema见native_subtitles_style_catalog。保留未请求字段、未知CSS和词时间；新VTT+CAS+undo。' },
};
const numberSchema = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const operationFields = {
  clipId: { type: 'string', minLength: 1, maxLength: 200 }, clipIds: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } }, groupId: { type: 'string', minLength: 1, maxLength: 200 },
  assetId: { type: 'string', minLength: 1, maxLength: 200 }, track: { type: 'integer', minimum: 0 }, newTrack: { type: 'integer', minimum: 0 }, from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 0 },
  at: numberSchema(0, NATIVE_MAX_TIME_SECONDS), delta: numberSchema(-NATIVE_MAX_TIME_SECONDS, NATIVE_MAX_TIME_SECONDS), start: numberSchema(0, NATIVE_MAX_TIME_SECONDS), end: numberSchema(0, NATIVE_MAX_TIME_SECONDS), duration: numberSchema(.001, NATIVE_MAX_TIME_SECONDS),
  width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 }, value: { type: 'boolean' }, sound: { type: 'boolean' },
  field: { type: 'string', enum: ['locked', 'hidden', 'muted'] }, mode: { type: 'string', enum: ['contain', 'cover', 'fill'] }, placement: { type: 'string', enum: ['title', 'center', 'bottom'] },
  x: numberSchema(0, 100), y: numberSchema(0, 100), top: numberSchema(0, 99), right: numberSchema(0, 99), bottom: numberSchema(0, 99), left: numberSchema(0, 99), radius: numberSchema(0, 50),
  volume: numberSchema(0, 4), brightness: numberSchema(0, 4), contrast: numberSchema(0, 4), saturation: numberSchema(0, 4), hue: numberSchema(-360, 360), blur: numberSchema(0, 100), grayscale: numberSchema(0, 1), sepia: numberSchema(0, 1), invert: numberSchema(0, 1),
  text: { type: 'string', minLength: 1, maxLength: 2000 }, fontSize: numberSchema(8, 200), color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  cues: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', additionalProperties: false, required: ['start', 'end', 'text'], properties: { start: numberSchema(0, NATIVE_MAX_TIME_SECONDS), end: numberSchema(0, NATIVE_MAX_TIME_SECONDS), text: { type: 'string', minLength: 1, maxLength: 2000 } } } },
  edits: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['action', 'index'], properties: { action: { type: 'string', enum: ['update', 'remove', 'insert'] }, index: { type: 'integer', minimum: 0 }, start: numberSchema(0, NATIVE_MAX_TIME_SECONDS), end: numberSchema(0, NATIVE_MAX_TIME_SECONDS), text: { type: 'string', minLength: 1, maxLength: 2000 } } } },
  cueIndices: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'integer', minimum: 0, maximum: 1999 } }, style: SUBTITLE_STYLE_SCHEMA,
};
export const NATIVE_OPERATION_CATALOG = Object.freeze([
  ...NATIVE_ADJUST_ACTIONS.map(action => ({ action, tool: 'native_adjust', description: action === 'split' ? '先native_inspect读取clip.canSplitInScope/splitRange；普通媒体跨越对话区间时，可在区间边界保真拆分，再用返回的新ID编辑内部片段，不能修改外侧内容。' : '使用native_inspect取得真实片段ID后，以native_adjust执行；也可作为native_operation批次的一项。' })),
  ...Object.entries(rules).map(([action, rule]) => ({ action, tool: 'native_operation', ...rule, parameters: { type: 'object', additionalProperties: false, required: ['action', ...rule.required], ...(rule.groupSelector ? { oneOf: [{ required: ['clipIds'] }, { required: ['groupId'] }] } : {}), properties: { action: { type: 'string', enum: [action] }, ...Object.fromEntries(rule.fields.map(name => [name, operationFields[name]])) } } })),
]);
export function nativeOperationCatalogForLimit(maximumTime = NATIVE_MAX_TIME_SECONDS) {
  if (!Number.isFinite(maximumTime) || maximumTime < .001 || maximumTime > NATIVE_MAX_TIME_SECONDS) throw fail('目录时间数值范围无效。');
  return NATIVE_OPERATION_CATALOG.map(item => {
    const result = structuredClone(item), properties = result.parameters?.properties;
    if (properties?.at) properties.at.maximum = maximumTime;
    if (properties?.delta) { properties.delta.minimum = -maximumTime; properties.delta.maximum = maximumTime; }
    if (properties?.duration) properties.duration.maximum = maximumTime;
    for (const field of ['cues', 'edits']) if (properties?.[field]?.items?.properties) {
      if (properties[field].items.properties.start) properties[field].items.properties.start.maximum = maximumTime;
      if (properties[field].items.properties.end) properties[field].items.properties.end.maximum = maximumTime;
    }
    return result;
  });
}

function finite(value, name, min, max, integer = false) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw fail(name + '数值不正确。'); return Math.round(value * 1000) / 1000; }
function rows(doc, known) { return doc.tracks.flatMap((track, trackIndex) => track.clips.map(clip => { let span; try { span = clipSpan(clip, known[clip.src]?.duration); } catch {} return { clip, track, trackIndex, span, at: Number(clip.at || 0), end: span ? Number(clip.at || 0) + span.length : null, assetId: known[clip.src]?.assetId }; })); }
function safeLocal(value) { return typeof value === 'string' && !/^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(value) && !value.split(/[\\/]/).some(part => part === '..' || part.startsWith('.')); }
function assertClip(item, scope, { allowDisabled = false } = {}) {
  if (!item) throw fail('片段已变化，请重新读取。', 'NATIVE_OPERATION_STALE', 409);
  if (item.track.locked || item.clip.locked || item.track.hidden || !allowDisabled && item.clip.disabled) throw fail('轨道或片段已锁定、隐藏或禁用。', 'NATIVE_OPERATION_SCOPE', 403);
  if (!item.span || !safeLocal(item.clip.src)) throw fail('片段路径或时长无法安全核对。', 'NATIVE_OPERATION_SCOPE', 403);
  if (scope.assetIds && !scope.assetIds.includes(item.assetId) && item.clip.attrs?.['data-guangxuan-caption'] !== 'true') throw fail('片段素材不在用户选择中。', 'NATIVE_OPERATION_SCOPE', 403);
  const place = scope.placement;
  if (place.mode === 'range' && (item.at < place.start - .001 || item.end > place.end + .001 || place.clipIds?.length && !place.clipIds.includes(item.clip.id))) throw fail('片段不完整处于用户框选范围。', 'NATIVE_OPERATION_SCOPE', 403);
}
function assertDestination(item, at, track, all, moving, scope, maximumTime) {
  if (!Number.isFinite(item.span.length) || item.span.length < .001 || at < 0 || at + item.span.length > maximumTime || scope.placement.mode === 'range' && (at < scope.placement.start - .001 || at + item.span.length > scope.placement.end + .001)) throw fail('移动结果越过本轮指定范围，或时间无法精确表示。', 'NATIVE_OPERATION_SCOPE', 403);
  if (all.some(other => other.trackIndex === track && !moving.has(other.clip.id) && other.span && other.at < at + item.span.length - .001 && other.end > at + .001)) throw fail('目标轨道存在重叠片段。', 'NATIVE_OPERATION_COLLISION', 409);
}
function assertWhole(scope, all) {
  if (scope.placement.mode === 'range' || scope.assetIds && all.some(item => item.assetId && !scope.assetIds.includes(item.assetId))) throw fail('此操作影响全片，但当前对话限定了处理范围；请依据用户本轮的全片要求调整范围后再执行。', 'NATIVE_OPERATION_WHOLE_PROJECT_REQUIRED', 403);
}
function withStyle(style, patch) { return [...declarations(style || '').filter(([key]) => !Object.hasOwn(patch, key)).map(([key, value]) => `${key}: ${value}`), ...Object.entries(patch).map(([key, value]) => `${key}: ${value}`)].join('; '); }
function ids(value, minimum = 1) { if (!Array.isArray(value) || value.length < minimum || value.length > 200 || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !id || id.length > 200 || id.includes('\0'))) throw fail('请提供1至200个不重复的片段ID；大联动组可使用groupId。'); return new Set(value); }
function groupSelection(operation, all) {
  if ((operation.clipIds !== undefined) === (operation.groupId !== undefined)) throw fail('clipIds和groupId必须二选一。');
  if (operation.clipIds !== undefined) return ids(operation.clipIds);
  if (typeof operation.groupId !== 'string' || !operation.groupId || operation.groupId.length > 200 || operation.groupId.includes('\0')) throw fail('请使用已读到的有效联动组groupId。');
  const members = all.filter(item => item.clip.attrs?.['data-link'] === operation.groupId).map(item => item.clip.id);
  if (!members.length) throw fail('联动组已变化或不存在，请重新读取片段。', 'NATIVE_OPERATION_STALE', 409);
  return new Set(members);
}
function completeLinks(selected, all) { for (const item of all.filter(item => selected.has(item.clip.id))) { const link = item.clip.attrs?.['data-link']; if (link && all.some(other => other.clip.attrs?.['data-link'] === link && !selected.has(other.clip.id))) throw fail('请同时选择联动组的全部片段，或先明确解除整组联动。', 'NATIVE_OPERATION_LINKED', 409); } }

/** Expanded, declarative Studio operations; opaque CSS/HTML/fields/RPC never enter. */
export function planNativeOperations(doc, operations, { known = {}, editScope, subtitleSources = {}, idFactory = () => 'gx-operation-' + randomUUID() } = {}) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 40) throw fail('每批需要1至40项原生操作。');
  const scope = normalizeEditScope(editScope || { placement: { mode: 'append' } });
  const maximumTime = nativeTimelineEditLimits(doc, known).maxEditedTimelineSeconds;
  subtitleSources = structuredClone(subtitleSources);
  let value = structuredClone(doc), requiresRestore = false; const ops = [], results = [], touched = new Set(), files = [];
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw fail('原生操作格式不正确。');
    if (NATIVE_ADJUST_ACTIONS.includes(operation.action)) {
      const step = planNativeAdjustments(value, [operation], { known, editScope: scope, timelineLimit: maximumTime, idFactory });
      value = step.document; ops.push(...step.ops); results.push(...step.results); step.touchedClipIds.forEach(id => touched.add(id)); continue;
    }
    const rule = rules[operation.action];
    if (!rule || Object.keys(operation).some(key => key !== 'action' && !rule.fields.includes(key)) || rule.required.some(key => !Object.hasOwn(operation, key))) throw fail('操作名称或参数不在可用目录中。');
    const all = rows(value, known), step = [], byId = id => all.find(item => item.clip.id === id), prop = (id, name, val) => step.push({ op: 'props', edits: [{ clip: id, prop: name, value: val }] });
    let restoredTrack;
    if (rule.wholeProject) assertWhole(scope, all);
    if (operation.action === 'asset_insert' || operation.action === 'caption_add') {
      const at = finite(operation.at, '放置秒数', 0, maximumTime); let inserted;
      if (operation.action === 'asset_insert') {
        if (scope.assetIds && !scope.assetIds.includes(operation.assetId)) throw fail('新增素材不在用户选择中。', 'NATIVE_OPERATION_SCOPE', 403);
        const found = Object.entries(known).find(([src, item]) => safeLocal(src) && item.assetId === operation.assetId);
        if (!found) throw fail('素材尚未导入当前原生工程。', 'NATIVE_OPERATION_SCOPE', 403);
        const [src, asset] = found, start = finite(operation.start ?? 0, '源起点', 0, NATIVE_MAX_TIME_SECONDS), end = finite(operation.end, '源终点', 0, NATIVE_MAX_TIME_SECONDS);
        if (end <= start || asset.type !== 'image' && (!Number.isFinite(asset.duration) || end > asset.duration + .001) || asset.type === 'image' && start !== 0) throw fail('新增片段的源范围不正确。');
        if (operation.sound !== undefined && typeof operation.sound !== 'boolean' || operation.sound === true && asset.type !== 'video') throw fail('仅视频可以提取原声。');
        inserted = { id: idFactory(), src, at, time: [start, end], ...(operation.sound === true ? { sound: true } : {}), ...(['video', 'audio'].includes(asset.type) ? { volume: finite(operation.volume ?? 1, '音量', 0, 4) } : {}), attrs: { title: String(asset.name || '新增素材').slice(0, 100), 'data-guangxuan-asset-id': asset.assetId } };
        if (!operation.sound && asset.type !== 'audio') inserted.box = { x: 0, y: 0, w: value.stage.w, h: value.stage.h };
      } else {
        if (typeof operation.text !== 'string' || !operation.text.trim() || operation.text.length > 2000) throw fail('字幕需要1至2000字纯文本。');
        const duration = finite(operation.duration, '字幕时长', .001, maximumTime), placement = operation.placement || 'bottom', color = operation.color || '#FFFFFF', fontSize = operation.fontSize === undefined ? undefined : finite(operation.fontSize, '字幕字号', 8, 200);
        if (!['title', 'center', 'bottom'].includes(placement) || !/^#[0-9a-f]{6}$/i.test(color)) throw fail('字幕位置或颜色格式不正确。');
        const id = idFactory(), src = `pages/${id}.html`, align = { title: 'flex-start', center: 'center', bottom: 'flex-end' }[placement];
        files.push({ path: src, content: buildCaptionPage(operation.text, value.stage, duration, { ...(operation.layout || {}), ...(fontSize !== undefined ? { fontSize } : {}), color }, placement).html });
        inserted = { id, src, at, time: [0, duration], size: value.stage, box: { x: 0, y: 0, w: value.stage.w, h: value.stage.h }, attrs: { title: '字幕 · ' + operation.text.slice(0, 30), 'data-guangxuan-caption': 'true', 'data-guangxuan-text': operation.text, 'data-guangxuan-placement': placement } };
      }
      const span = clipSpan(inserted), target = operation.track === undefined ? -1 : finite(operation.track, '目标轨', 0, value.tracks.length - 1, true);
      if (operation.track !== undefined && operation.newTrack !== undefined) throw fail('目标轨与新增轨只能选择一种。');
      if (target >= 0 && (value.tracks[target].locked || value.tracks[target].hidden)) throw fail('目标轨道已锁定或隐藏。', 'NATIVE_OPERATION_SCOPE', 403);
      assertDestination({ span }, at, target, all, new Set(), scope, maximumTime);
      const track = target < 0 ? { insert: operation.newTrack === undefined ? value.tracks.length : finite(operation.newTrack, '新轨位置', 0, value.tracks.length, true) } : target;
      step.push({ op: 'insert', clip: inserted, track }); touched.add(inserted.id); results.push({ action: operation.action, createdClipId: inserted.id });
    } else if (operation.action === 'subtitles_style') {
      const index = finite(operation.track, '字幕轨道', 0, value.tracks.length - 1, true), track = value.tracks[index], original = track?.captions && subtitleSources[track.captions.src];
      if (!original || track.locked || track.hidden) throw fail('字幕轨道不可编辑或尚未读取真实内容。', 'NATIVE_OPERATION_SCOPE', 403);
      const next = applySubtitleStyle(original, operation.style, { cueIndices: operation.cueIndices, editScope: scope }), src = `captions/${idFactory()}.vtt`;
      files.push({ path: src, content: writeVtt(next) }); subtitleSources[src] = next;
      step.push({ op: 'uncaptions', src: track.captions.src }, { op: 'captions', at: index, captions: { ...track.captions, src } });
      restoredTrack = { index, value: { ...track, captions: { ...track.captions, src } } }; requiresRestore = true;
    } else if (operation.action === 'subtitles_edit') {
      const index = finite(operation.track, '字幕轨道', 0, value.tracks.length - 1, true), track = value.tracks[index], original = track?.captions && subtitleSources[track.captions.src];
      if (!original || track.locked || track.hidden) throw fail('字幕轨道不可编辑或尚未读取真实内容。', 'NATIVE_OPERATION_SCOPE', 403);
      if (!Array.isArray(operation.edits) || !operation.edits.length || operation.edits.length > 200) throw fail('每次需1至200项字幕修改。');
      if (operation.edits.some(edit => !edit || typeof edit !== 'object' || Array.isArray(edit))) throw fail('字幕编辑参数不正确。');
      const next = structuredClone(original), used = new Set(), validateCue = cue => { if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > maximumTime || scope.placement.mode === 'range' && (cue.start < scope.placement.start || cue.end > scope.placement.end)) throw fail('字幕句子不完整处于当前对话范围或本批时长上限。', 'NATIVE_OPERATION_SCOPE', 403); };
      for (const edit of [...operation.edits].sort((a, b) => b.index - a.index)) {
        if (!edit || typeof edit !== 'object' || Object.keys(edit).some(key => !['action', 'index', 'start', 'end', 'text'].includes(key)) || !['update', 'remove', 'insert'].includes(edit.action)) throw fail('字幕编辑参数不正确。');
        const cueIndex = finite(edit.index, '字幕编号', 0, original.cues.length - (edit.action === 'insert' ? 0 : 1), true);
        if (used.has(cueIndex)) throw fail('同一批不能重复编辑同一个字幕编号。'); used.add(cueIndex);
        const before = original.cues[cueIndex]; if (edit.action !== 'insert') validateCue(before);
        if (edit.action === 'remove') { if (['start', 'end', 'text'].some(key => edit[key] !== undefined)) throw fail('删除字幕不能同时重写文字时间。'); next.cues.splice(cueIndex, 1); continue; }
        const cue = edit.action === 'insert' ? { id: '', settings: '' } : { ...before };
        if (edit.start !== undefined) cue.start = finite(edit.start, '字幕起点', 0, maximumTime);
        if (edit.end !== undefined) cue.end = finite(edit.end, '字幕终点', 0, maximumTime);
        if (edit.text !== undefined) { if (typeof edit.text !== 'string' || !edit.text.trim() || edit.text.length > 2000) throw fail('字幕文字需1至2000字。'); cue.text = escapeText(edit.text).replace(/\r?\n\s*\r?\n/g, '\n'); }
        if (typeof cue.text !== 'string') throw fail('新增字幕需要文字与起止时间。'); validateCue(cue);
        if (edit.action === 'insert') next.cues.splice(cueIndex, 0, cue); else next.cues[cueIndex] = cue;
      }
      if (next.cues.length > 2000 || next.cues.some((cue, i) => i && cue.start < next.cues[i - 1].end)) throw fail('字幕不能重叠或超过2000句。');
      const src = `captions/${idFactory()}.vtt`; files.push({ path: src, content: writeVtt(next) }); subtitleSources[src] = next;
      step.push({ op: 'uncaptions', src: track.captions.src }, { op: 'captions', at: index, captions: { ...track.captions, src } });
      restoredTrack = { index, value: { ...track, captions: { ...track.captions, src } } }; requiresRestore = true;
    } else if (operation.action === 'subtitles_write' || operation.action === 'subtitles_remove') {
      const index = operation.track === undefined ? undefined : finite(operation.track, '字幕轨道', 0, value.tracks.length - 1, true), existing = index === undefined ? null : value.tracks[index];
      if (existing && (!existing.captions || existing.locked)) throw fail('请选择未锁定的真实WebVTT字幕轨。', 'NATIVE_OPERATION_SCOPE', 403);
      if (existing) { assertWhole(scope, all); step.push({ op: 'uncaptions', src: existing.captions.src }); }
      if (operation.action === 'subtitles_write') {
        if (!Array.isArray(operation.cues) || !operation.cues.length || operation.cues.length > 2000) throw fail('字幕需要1至2000条时间与文字。');
        let last = 0, characters = 0;
        const cues = operation.cues.map(cue => { if (!cue || Object.keys(cue).some(key => !['start', 'end', 'text'].includes(key)) || typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 2000) throw fail('字幕条目格式不正确。'); const start = finite(cue.start, '字幕起点', 0, maximumTime), end = finite(cue.end, '字幕终点', 0, maximumTime); if (end <= start || start < last || scope.placement.mode === 'range' && (start < scope.placement.start || end > scope.placement.end)) throw fail('字幕时间须有序且完整处于用户范围内。', 'NATIVE_OPERATION_SCOPE', 403); last = end; characters += cue.text.length; return `${stamp(start)} --> ${stamp(end)}\n${escapeText(cue.text).replace(/\r?\n\s*\r?\n/g, '\n')}\n`; });
        if (characters > 1000000) throw fail('字幕总文字超过限制。');
        const src = `captions/${idFactory()}.vtt`, content = 'WEBVTT\n\n' + cues.join('\n'); files.push({ path: src, content }); subtitleSources[src] = readVtt(content); step.push({ op: 'captions', at: index ?? value.tracks.length, captions: { src, kind: 'subtitles', label: 'AI编辑字幕' } });
        if (existing) { restoredTrack = { index, value: { ...existing, captions: { ...existing.captions, src } } }; requiresRestore = true; }
      }
    } else if (operation.action === 'stage') {
      if (value.tracks.some(track => track.locked)) throw fail('存在锁轨，不能更改画布。', 'NATIVE_OPERATION_SCOPE', 403);
      step.push({ op: 'stage', w: finite(operation.width, '画布宽度', 1, 8192, true), h: finite(operation.height, '画布高度', 1, 8192, true) });
    } else if (operation.action === 'track_set') {
      const index = finite(operation.track, '轨道', 0, value.tracks.length - 1, true), track = value.tracks[index];
      if (!['locked', 'hidden', 'muted'].includes(operation.field) || typeof operation.value !== 'boolean') throw fail('轨道开关需要locked/hidden/muted与布尔值。');
      if (track.locked && !(operation.field === 'locked' && operation.value === false)) throw fail('请先明确解锁该轨道。', 'NATIVE_OPERATION_SCOPE', 403);
      step.push({ op: 'track', track: index, field: operation.field, value: operation.value });
    } else if (operation.action === 'track_reorder') {
      const from = finite(operation.from, '来源轨', 0, value.tracks.length - 1, true), to = finite(operation.to, '目标轨', 0, value.tracks.length - 1, true);
      if (value.tracks.slice(Math.min(from, to), Math.max(from, to) + 1).some(track => track.locked)) throw fail('轨道顺序涉及锁轨。', 'NATIVE_OPERATION_SCOPE', 403);
      step.push({ op: 'reorder', from, to });
    } else if (['link', 'unlink', 'group_move'].includes(operation.action)) {
      const selected = operation.action === 'link' ? ids(operation.clipIds, 2) : groupSelection(operation, all); for (const id of selected) assertClip(byId(id), scope); completeLinks(selected, all);
      const delta = operation.action === 'group_move' ? finite(operation.delta, '移动秒数', -maximumTime, maximumTime) : 0, link = operation.action === 'link' ? idFactory() : null;
      for (const id of selected) { const item = byId(id); touched.add(id); if (operation.action === 'group_move') { assertDestination(item, item.at + delta, item.trackIndex, all, selected, scope, maximumTime); prop(id, 'at', item.at + delta); } else prop(id, 'link', link); }
    } else {
      const item = byId(operation.clipId); assertClip(item, scope, { allowDisabled: operation.action === 'enabled' }); touched.add(item.clip.id);
      if (operation.action === 'move_track') {
        completeLinks(new Set([item.clip.id]), all); const at = finite(operation.at, '放置秒数', 0, maximumTime);
        if (operation.track !== undefined && operation.newTrack !== undefined) throw fail('已有轨道和新轨道只能选择一种。');
        const newTrack = operation.newTrack === undefined ? undefined : finite(operation.newTrack, '新轨位置', 0, value.tracks.length, true), index = newTrack ?? (operation.track === undefined ? item.trackIndex : finite(operation.track, '目标轨', 0, value.tracks.length - 1, true));
        if (newTrack === undefined && (value.tracks[index].locked || value.tracks[index].hidden)) throw fail('目标轨道已锁定或隐藏。', 'NATIVE_OPERATION_SCOPE', 403);
        assertDestination(item, at, newTrack === undefined ? index : -1, all, new Set([item.clip.id]), scope, maximumTime);
        step.push({ op: 'move', clip: item.clip.id, at, ...(newTrack === undefined ? { track: index } : { newTrack }) });
      } else if (operation.action === 'enabled') {
        if (typeof operation.value !== 'boolean') throw fail('启用状态需要布尔值。'); prop(item.clip.id, 'disabled', operation.value ? null : true);
      } else if (operation.action === 'detach_audio') {
        if (kindOf(item.clip) !== 'video') throw fail('只能拆分视频原声。'); completeLinks(new Set([item.clip.id]), all);
        const group = idFactory(), id = idFactory(), sound = { id, src: item.clip.src, sound: true, at: item.at, time: [item.span.from, item.span.to], ...(item.clip.speed ? { speed: item.clip.speed } : {}), volume: item.clip.volume ?? 1, attrs: { title: '拆分原声', 'data-link': group } };
        const sourceFade = item.clip.overrides?.find(override => override.at === undefined)?.fade; if (sourceFade) sound.overrides = [{ fade: cloneArray(sourceFade) }];
        prop(item.clip.id, 'link', group); prop(item.clip.id, 'volume', 0); step.push({ op: 'insert', clip: sound, track: { insert: value.tracks.length } }); results.push({ action: operation.action, clipId: item.clip.id, createdClipId: id });
      } else {
        if (!['video', 'still'].includes(kindOf(item.clip))) throw fail('该画面操作仅支持视频或图片。');
        const patch = {};
        if (operation.action === 'fit') { if (!['contain', 'cover', 'fill'].includes(operation.mode)) throw fail('画面适应方式无效。'); patch['object-fit'] = operation.mode; if (operation.x !== undefined || operation.y !== undefined) patch['object-position'] = `${finite(operation.x ?? 50, '横锚点', 0, 100)}% ${finite(operation.y ?? 50, '纵锚点', 0, 100)}%`; }
        else if (operation.action === 'crop') { const sides = ['top', 'right', 'bottom', 'left'].map(name => finite(operation[name] ?? 0, name, 0, 99)); if (!rule.fields.slice(1).some(key => operation[key] !== undefined) || sides[0] + sides[2] >= 100 || sides[1] + sides[3] >= 100) throw fail('裁切后必须保留可见画面。'); patch['clip-path'] = `inset(${sides.map(side => side + '%').join(' ')} round ${finite(operation.radius ?? 0, '圆角', 0, 50)}%)`; }
        else if (operation.action === 'filter') { const units = { brightness: [0, 4, ''], contrast: [0, 4, ''], saturation: [0, 4, ''], hue: [-360, 360, 'deg'], blur: [0, 100, 'px'], grayscale: [0, 1, ''], sepia: [0, 1, ''], invert: [0, 1, ''] }; const parts = Object.entries(units).filter(([key]) => operation[key] !== undefined).map(([key, [min, max, unit]]) => `${({ saturation: 'saturate', hue: 'hue-rotate' })[key] || key}(${finite(operation[key], key, min, max)}${unit})`); if (!parts.length) throw fail('请提供至少一个滤镜数值。'); patch.filter = parts.join(' '); }
        prop(item.clip.id, 'style', withStyle(item.clip.style, patch));
      }
    }
    value = applyOps(value, step); if (restoredTrack) value.tracks[restoredTrack.index] = restoredTrack.value; ops.push(...step); if (!['detach_audio', 'asset_insert', 'caption_add'].includes(operation.action)) results.push({ action: operation.action, ...(operation.clipId ? { clipId: operation.clipId } : {}) });
  }
  if (!readFilm(value).doc) throw fail('操作批次无法生成有效工程，未作修改。');
  if (nativeTimelineDuration(value, known) > maximumTime) throw fail('编辑结果的时间无法精确表示，尚未修改工程。', 'NATIVE_OPERATION_TIMELINE_LIMIT');
  return { document: value, ops, files, requiresRestore, results, touchedClipIds: [...touched], summary: `已完成${operations.length}项原生操作。` };
}
const cloneArray = value => value.map(item => item);
const escapeText = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function stamp(seconds) { const ms = Math.round(seconds * 1000), hours = Math.floor(ms / 3600000), minutes = Math.floor(ms % 3600000 / 60000), whole = Math.floor(ms % 60000 / 1000); return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; }

export function nativeOperationContext(doc, known, scope, pageOptions, options) {
  const described = describeNativeTimeline(doc, known, scope, pageOptions, options), originals = new Map((doc.tracks || []).flatMap(track => track.clips || []).map(clip => [clip.id, clip]));
  return { ...described, clips: described.clips.map(clip => { const original = originals.get(clip.id); return { ...clip, disabled: original?.disabled === true, ...(original?.attrs?.['data-link'] ? { linkGroup: String(original.attrs['data-link']).slice(0, 200) } : {}) }; }), tracks: described.tracks.map(track => ({ ...track, captionTrack: Boolean(doc.tracks[track.index].captions) })) };
}

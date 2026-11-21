import { AppError } from './errors.mjs';
import { normalizeEditScope } from './edit-scope.mjs';

const plain = value => String(value || '').replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|“[^”]*”|‘[^’]*’|"[^"\n]*"/g, ' ');
const seconds = value => String(value).split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
export function resolveAssistantScope({ instruction, uiScope, storedScope, authority = 'dialog', duration } = {}) {
  const defaultScope = { placement: { mode: 'append' } }, value = uiScope ?? storedScope;
  const freeScope = value?.placement?.mode === 'free' ? normalizeEditScope({ placement: { mode: 'free' } }) : null;
  if (authority !== 'dialog') return { scope: normalizeEditScope(value ?? defaultScope), constraint: null, authority: 'explicit-scope' };
  const text = plain(instruction), selected = /(?:当前.{0,6}(?:选中|所选|选区)|所选|框选|I\s*\/\s*O|selected\s+(?:clips?|range)|selection)/i.test(text);
  const whole = /(?:全片|全工程|整个(?:项目|工程|视频|作品|片子)|全部(?:内容|轨道|素材)|不受.{0,12}(?:选区|勾选|范围).{0,6}限制|whole\s+(?:project|film|timeline))/i.test(text);
  // UI material, time and clip selections are suggestions. Only the current
  // user's explicit selection target can turn them into an edit constraint.
  const fallback = freeScope || defaultScope;
  // Source windows describe what to borrow, not where the output may change.
  // Keep each edit clause so a later output restriction wins over an earlier
  // source range, including “只参考…并仅改作品…” without punctuation.
  const scopeText = text.split(/[，,；;。!！?？\n]|(?<!\d)\.|\.(?!\d)|(?:并且?|然后|之后|接着|但是?|不过)|(?=(?:只|仅)(?:能|要|需)?(?:修改|改|编辑|调整|精修|处理|在))/)
    .filter(clause => !/参考|借鉴|学习|参照|模仿|\b(?:reference|borrow|learn from)\b/i.test(clause) || /(?:只|仅)(?:能|要|需)?(?:修改|改|编辑|调整|精修|处理|在)|(?:限于|within|only).{0,40}(?:修改|改|编辑|调整|精修|处理|edit)/i.test(clause)).join('，');
  const time = '(\\d{1,2}:\\d{1,2}(?::\\d{1,2})?(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
  const range = new RegExp(time + '\\s*(?:秒|s)?\\s*(?:到|至|—|–|-|~|～|to)\\s*' + time + '\\s*(?:秒|s)?', 'i').exec(scopeText);
  const only = /只(?:能|要|需|修改|改|在|处理|用)?|仅|限于|within|only/i.test(scopeText.replace(/不要只|不只是?|不仅(?:仅)?/g, ' ')) || /(?:其他|其它|其余).{0,8}(?:不动|不要动|不变|保留)/.test(scopeText);
  const selectedOnlyAssets = selected && /(?:只|仅)(?:能|要|需)?(?:使用|用).{0,12}(?:所选|选中|勾选).{0,6}素材/.test(scopeText);
  const selectedTarget = selected && (selectedOnlyAssets || !whole && (only || /(?:修改|编辑|调整|精修|处理|静音|删除|移除)(?:当前)?(?:所选|选中|选区|框选)|(?:当前)?(?:所选|选中|框选)片段.{0,12}(?:修改|编辑|调整|精修|静音|删除|移除)/.test(scopeText)));
  const selectedAssets = selectedTarget && Array.isArray(value?.assetIds) ? value.assetIds : null;
  const withSelectedAssets = scope => selectedAssets ? { ...scope, assetIds: [...selectedAssets] } : scope;
  const first = new RegExp('(?:前|开头|最初)\\s*' + time + '\\s*(?:秒|s)', 'i').exec(scopeText);
  const last = new RegExp('(?:最后|末尾|结尾|后)\\s*' + time + '\\s*(?:秒|s)', 'i').exec(scopeText);
  if (only && first && !/只保留|仅保留/.test(scopeText)) {
    const scope = withSelectedAssets(normalizeEditScope({ placement: { mode: 'range', start: 0, end: seconds(first[1]) } }));
    return { scope, constraint: structuredClone(scope), authority: 'dialog-range' };
  }
  if (only && last && !/只保留|仅保留/.test(scopeText)) {
    if (duration === undefined) return { scope: fallback, constraint: null, pending: 'tail', authority: 'dialog-pending' };
    if (!Number.isFinite(duration) || duration <= 0) throw new AppError(409, '当前时间线没有可修改的时长，无法定位末尾区间。', 'ASSISTANT_RANGE_UNAVAILABLE');
    const scope = withSelectedAssets(normalizeEditScope({ placement: { mode: 'range', start: Math.max(0, duration - seconds(last[1])), end: duration } }));
    return { scope, constraint: structuredClone(scope), authority: 'dialog-range' };
  }
  const timeRange = range && (range[1].includes(':') || range[2].includes(':') || /秒|\bs\b/i.test(range[0]));
  if (only && timeRange && !/只保留|仅保留/.test(scopeText)) {
    const scope = withSelectedAssets(normalizeEditScope({ placement: { mode: 'range', start: seconds(range[1]), end: seconds(range[2]) } }));
    return { scope, constraint: structuredClone(scope), authority: 'dialog-range' };
  }
  if (selectedTarget) {
    const value = uiScope ?? storedScope;
    if (value) {
      const scope = normalizeEditScope(value);
      if (selectedOnlyAssets && scope.assetIds) {
        const assetScope = { assetIds: scope.assetIds, placement: fallback.placement };
        return { scope: assetScope, constraint: structuredClone(assetScope), authority: 'dialog-selection' };
      }
      if (scope.placement.mode === 'range' || scope.assetIds || scope.placement.clipIds?.length) return { scope, constraint: structuredClone(scope), authority: 'dialog-selection' };
      if (scope.placement.mode === 'free' && /素材|assets?/i.test(text)) return { scope, constraint: null, authority: 'dialog-free' };
    }
    throw new AppError(409, '本轮要求修改当前所选内容，但没有可读取的选区；请给出片段或起止时间。', 'ASSISTANT_SELECTION_REQUIRED');
  }
  return { scope: fallback, constraint: null, authority: freeScope ? 'dialog-free' : 'dialog-project' };
}

/** Model-selected placement can narrow a dialog range, never enlarge its explicit limits. */
export function setAssistantScope(state, input, assets) {
  const constraint = state.dialogueConstraint;
  const value = constraint?.placement?.mode === 'free' && constraint.assetIds && input?.assetIds === undefined ? { ...input, assetIds: constraint.assetIds } : input;
  const scope = normalizeEditScope(value, assets);
  if (constraint?.assetIds && (!scope.assetIds || scope.assetIds.some(id => !constraint.assetIds.includes(id)))) throw new AppError(403, '本轮对话只允许使用指定素材，不能扩大。', 'ASSISTANT_DIALOG_SCOPE');
  if (constraint?.placement?.mode === 'range') {
    if (scope.placement.mode !== 'range' || scope.placement.start < constraint.placement.start - .001 || scope.placement.end > constraint.placement.end + .001) throw new AppError(403, '本轮对话明确限定了起止范围，不能扩大或改为全片。', 'ASSISTANT_DIALOG_SCOPE');
    const ids = constraint.placement.clipIds;
    if (ids?.length && (!scope.placement.clipIds || scope.placement.clipIds.some(id => !ids.includes(id)))) throw new AppError(403, '本轮对话只允许修改指定片段。', 'ASSISTANT_DIALOG_SCOPE');
  }
  state.scope = scope;
  return structuredClone(scope);
}

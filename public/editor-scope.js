import { clone, escapeHtml as h, icon, timecode, uid } from './ui.js';
import { formatTimecode, MAX_TIME_SECONDS } from './time-range.js';

const timeDrafts = new Map(), expanded = new Map();
const rangeDrafts = new Map();
const kindName = type => ({ video: '视频', image: '图片', audio: '音频' }[type] || '素材');

export const editPlacementText = scope => scope?.placement?.mode === 'free' ? '自由创作' : scope?.placement?.mode === 'range' ? '仅修改 ' + timecode(scope.placement.start) + '—' + timecode(scope.placement.end) : scope?.placement?.mode === 'replace' ? '替换当前主轨' : scope?.placement?.mode === 'insert' ? timecode(scope.placement.at) + ' 处插入' : '追加到末尾';

export function parseEditTime(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) throw new Error('请输入秒数或 mm:ss 时间码。');
  const parts = text.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some(part => part >= 60)) throw new Error('时间码的分、秒需小于 60。');
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIME_SECONDS) throw new Error('请输入可精确表示的非负时间。');
  return seconds;
}

export function readEditScope(project) {
  const stored = project?.video?.editScope;
  const mode = ['free', 'append', 'insert', 'replace', 'range'].includes(stored?.placement?.mode) ? stored.placement.mode : 'append';
  const scope = { placement: { mode } };
  if (stored && Object.hasOwn(stored, 'assetIds') && stored.assetIds !== undefined)
    scope.assetIds = Array.isArray(stored.assetIds) ? [...new Set(stored.assetIds.filter(id => typeof id === 'string'))] : [];
  if (mode === 'insert' && Number.isFinite(stored?.placement?.at)) scope.placement.at = stored.placement.at;
  if (mode === 'range') {
    for (const edge of ['start', 'end']) if (Number.isFinite(stored?.placement?.[edge])) scope.placement[edge] = stored.placement[edge];
    if (Array.isArray(stored?.placement?.clipIds)) scope.placement.clipIds = [...stored.placement.clipIds];
  }
  return scope;
}

export function editScopeSnapshot(project, context) {
  const scope = readEditScope(project);
  if (Array.isArray(scope.assetIds) && context) {
    const available = new Set((context.assets || []).map(asset => asset.id));
    scope.assetIds = scope.assetIds.filter(id => available.has(id));
  }
  if (scope.placement.mode === 'insert') {
    scope.placement.at = parseEditTime(timeDrafts.get(project.id) ?? scope.placement.at);
    scope.placement.at = Math.round(scope.placement.at * 1000) / 1000;
  }
  if (scope.placement.mode === 'replace' && Array.isArray(scope.assetIds)) {
    const selected = new Set(scope.assetIds);
    if (!selected.size || !context || (context.assets || []).some(asset => !selected.has(asset.id)))
      throw new Error('选择部分素材时不能替换整个主轨。');
  }
  if (scope.placement.mode === 'range') {
    const draft = rangeDrafts.get(project.id);
    for (const edge of ['start', 'end']) scope.placement[edge] = Math.round(parseEditTime(draft?.[edge] ?? scope.placement[edge]) * 1000) / 1000;
    if (scope.placement.end <= scope.placement.start || scope.placement.end > MAX_TIME_SECONDS) throw new Error('请选择有效区间，终点需晚于起点。');
    if (context && scope.placement.end > Number(context.duration) + .001) throw new Error('所选区间已超出当前时间线，请重新框选。');
  }
  return clone(scope);
}

export function contextForEditScope(context, scope) {
  const allowed = Array.isArray(scope?.assetIds) ? new Set(scope.assetIds) : null;
  let timeline = (context.timeline || []).filter(clip => !allowed || allowed.has(clip.assetId));
  if (scope?.placement?.mode === 'range') {
    const { start, end } = scope.placement;
    timeline = timeline.flatMap(clip => {
      const speed = Number(clip.speed) || 1, at = Number(clip.at) || 0;
      const a = Math.max(start, at), b = Math.min(end, at + (clip.end - clip.start) / speed);
      if (!(b > a)) return [];
      return [{ ...clip, start: Math.round((clip.start + (a - at) * speed) * 1000) / 1000, end: Math.round((clip.start + (b - at) * speed) * 1000) / 1000, at: Math.round(a * 1000) / 1000 }];
    });
  }
  if (!allowed && scope?.placement?.mode !== 'range') return context;
  return { ...context, assets: (context.assets || []).filter(asset => !allowed || allowed.has(asset.id)), timeline };
}

export function selectTimelineRange(project, selection) {
  const range = selection?.range;
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end - range.start < .001 || range.end > MAX_TIME_SECONDS) throw new Error('请框选有效区间，终点至少晚于起点1毫秒。');
  const scope = readEditScope(project);
  scope.placement = { mode: 'range', start: Math.round(range.start * 1000) / 1000, end: Math.round(range.end * 1000) / 1000 };
  if (scope.placement.end <= scope.placement.start) throw new Error('所选区间过短，请至少保留1毫秒。');
  const clipIds = (Array.isArray(selection.clipIds) ? selection.clipIds : []).filter(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)).slice(0, 200);
  if (clipIds.length) scope.placement.clipIds = [...new Set(clipIds)];
  project.video ||= {}; project.video.editScope = clone(scope);
  rangeDrafts.set(project.id, { start: formatTimecode(scope.placement.start), end: formatTimecode(scope.placement.end) }); expanded.set(project.id, true);
  return scope;
}

function requestSelection(projectId) {
  const requestId = uid();
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { clearTimeout(timer); window.removeEventListener('guangxuan:timeline-selection-result', receive); error ? reject(new Error(error)) : resolve(value); };
    const receive = event => { if (event.detail?.requestId === requestId && event.detail.projectId === projectId) finish(event.detail.error, event.detail.selection); };
    const timer = setTimeout(() => finish('时间线暂未响应，请先打开视频主时间线。'), 5500);
    window.addEventListener('guangxuan:timeline-selection-result', receive);
    window.dispatchEvent(new CustomEvent('guangxuan:request-timeline-selection', { detail: { projectId, requestId } }));
  });
}

/** UI choices belong to the user; AI responses never write this configuration. */
export function mountEditScope(host, project, { loadContext, loadSelection = () => requestSelection(project.id), onChange, onError, disabled: initiallyDisabled = false } = {}) {
  let context = null, loading = false, selecting = false, disposed = false, disabled = initiallyDisabled, request = 0;
  const initial = readEditScope(project);
  let timeText = timeDrafts.get(project.id) ?? (initial.placement.at === undefined ? '' : String(initial.placement.at));
  host.innerHTML = `<details class="gx-edit-scope" ${expanded.get(project.id) ? 'open' : ''}><summary>素材与位置 <small data-scope-summary></small></summary><div class="gx-scope-content"><div class="gx-scope-heading"><label><input type="checkbox" data-scope-all>全部素材</label><button class="icon-btn" type="button" data-scope-refresh aria-label="刷新可用素材" title="刷新素材">${icon('refresh')}</button></div><div class="gx-scope-assets" data-scope-assets></div><label class="gx-scope-placement">放置位置<select data-scope-placement><option value="free">自由创作</option><option value="append">追加到末尾</option><option value="insert">指定时间插入</option><option value="replace">替换当前主轨</option></select></label><input data-scope-time aria-label="插入时间" inputmode="decimal" maxlength="30" placeholder="秒 / mm:ss" value="${h(timeText)}" hidden><p data-scope-error role="status" hidden></p></div></details>`;
  const details = host.querySelector('details'), list = host.querySelector('[data-scope-assets]');
  const option = document.createElement('option'); option.value = 'range'; option.textContent = '仅修改所选区间'; host.querySelector('[data-scope-placement]').append(option);
  const region = document.createElement('div'); region.className = 'gx-scope-region';
  region.innerHTML = '<div class="gx-scope-range-fields"><label>区间起点<input data-scope-range-start inputmode="decimal" maxlength="24" aria-label="AI修改区间起点" placeholder="00:00.000"></label><label>区间终点<input data-scope-range-end inputmode="decimal" maxlength="24" aria-label="AI修改区间终点" placeholder="00:10.000"></label></div><p class="tiny muted">仅修改此区间，其余片段和轨道不顺延。</p>';
  host.querySelector('[data-scope-time]').after(region);
  const rangeButton = document.createElement('button'); rangeButton.type = 'button'; rangeButton.className = 'btn small'; rangeButton.dataset.scopeTimelineRange = ''; rangeButton.textContent = '使用时间轴选区';
  host.querySelector('.gx-scope-content').prepend(rangeButton);
  const clearRange = document.createElement('button'); clearRange.type = 'button'; clearRange.className = 'btn small subtle'; clearRange.dataset.scopeClearRange = ''; clearRange.textContent = '清除区间限制';
  clearRange.onclick = () => { const scope = readEditScope(project); scope.placement = { mode: 'append' }; rangeDrafts.delete(project.id); write(scope); };
  region.append(clearRange);

  function write(scope) {
    project.video ||= {};
    project.video.editScope = clone(scope);
    onChange?.(); paint();
    window.dispatchEvent(new CustomEvent('guangxuan:edit-scope-changed', { detail: { projectId: project.id, scope: clone(scope), timeText, rangeText: rangeDrafts.get(project.id), source: host } }));
  }
  const receiveScope = event => {
    if (disposed || event.detail?.projectId !== project.id || event.detail.source === host) return;
    project.video ||= {}; project.video.editScope = clone(event.detail.scope);
    timeText = event.detail.timeText;
    if (event.detail.rangeText) rangeDrafts.set(project.id, event.detail.rangeText);
    const input = host.querySelector('[data-scope-time]'); if (document.activeElement !== input) input.value = timeText;
    paint();
  };
  window.addEventListener('guangxuan:edit-scope-changed', receiveScope);
  function paint() {
    if (disposed || !host.isConnected) return;
    const scope = readEditScope(project), all = !Array.isArray(scope.assetIds);
    const assets = context?.assets || [], selected = new Set(scope.assetIds || []);
    const selectedCount = context ? assets.filter(asset => all || selected.has(asset.id)).length : selected.size;
    host.querySelector('[data-scope-all]').checked = all;
    host.querySelector('[data-scope-placement]').value = scope.placement.mode;
    host.querySelector('[data-scope-placement] option[value="replace"]').disabled = !all && (!selected.size || !context || assets.some(asset => !selected.has(asset.id)));
    host.querySelector('[data-scope-time]').hidden = scope.placement.mode !== 'insert';
    region.hidden = scope.placement.mode !== 'range';
    const rangeText = rangeDrafts.get(project.id) || {};
    for (const edge of ['start', 'end']) {
      const input = host.querySelector('[data-scope-range-' + edge + ']');
      if (document.activeElement !== input) input.value = rangeText[edge] ?? (Number.isFinite(scope.placement[edge]) ? formatTimecode(scope.placement[edge]) : '');
    }
    host.querySelector('[data-scope-summary]').textContent = (all ? '全部素材' : selectedCount + ' 项素材') + ' · ' + (scope.placement.mode === 'range' ? editPlacementText(scope) : { free: '自由创作', append: '末尾', insert: '指定时间', replace: '替换主轨' }[scope.placement.mode]);
    const markup = context ? assets.length ? assets.map(asset => `<label class="gx-scope-asset"><input type="checkbox" data-scope-asset="${h(asset.id)}" ${all || selected.has(asset.id) ? 'checked' : ''}><span title="${h(asset.name || '未命名素材')}">${h(asset.name || '未命名素材')}</span><small>${kindName(asset.type)}</small></label>`).join('') : '<span class="gx-scope-empty">暂无素材</span>' : `<span class="gx-scope-empty">${loading ? '正在读取…' : '展开后读取素材'}</span>`;
    if (list.innerHTML !== markup) {
      const focused = list.contains(document.activeElement) ? document.activeElement?.dataset.scopeAsset : null, scroll = list.scrollTop;
      list.innerHTML = markup;
      if (focused) [...list.querySelectorAll('[data-scope-asset]')].find(input => input.dataset.scopeAsset === focused)?.focus({ preventScroll: true });
      list.scrollTop = scroll;
    }
    host.querySelectorAll('input,select,button').forEach(input => { input.disabled = disabled || selecting || (input.matches('[data-scope-refresh]') && loading) || (input.matches('[data-scope-all]') && loading); });
  }
  async function refresh() {
    if (disposed || loading || disabled) return;
    const token = ++request; loading = true; host.querySelector('[data-scope-error]').hidden = true; paint();
    try {
      const latest = await loadContext?.();
      if (disposed || token !== request) return;
      if (!latest || !Array.isArray(latest.assets) || latest.projectId !== project.id) throw new Error('素材暂未读到，请重试。');
      context = latest;
    } catch (error) {
      if (!disposed && token === request) {
        const status = host.querySelector('[data-scope-error]'); status.textContent = error.message; status.hidden = false;
        onError?.(error);
      }
    } finally { if (!disposed && token === request) { loading = false; paint(); } }
  }
  details.ontoggle = () => { expanded.set(project.id, details.open); if (details.open && !context) void refresh(); };
  host.querySelector('[data-scope-refresh]').onclick = () => void refresh();
  host.querySelector('[data-scope-all]').onchange = event => {
    const scope = readEditScope(project);
    if (event.target.checked) delete scope.assetIds; else scope.assetIds = [];
    if (!event.target.checked && scope.placement.mode === 'replace') scope.placement = { mode: 'append' };
    write(scope);
  };
  list.onchange = event => {
    if (!event.target.matches('[data-scope-asset]')) return;
    const scope = readEditScope(project);
    scope.assetIds = [...list.querySelectorAll('[data-scope-asset]:checked')].map(input => input.dataset.scopeAsset);
    if (scope.placement.mode === 'replace' && scope.assetIds.length !== context.assets.length) scope.placement = { mode: 'append' };
    write(scope);
  };
  host.querySelector('[data-scope-placement]').onchange = event => {
    const scope = readEditScope(project); scope.placement = { mode: event.target.value };
    if (scope.placement.mode === 'insert') { try { scope.placement.at = parseEditTime(timeText); } catch { /* An incomplete time remains editable. */ } }
    if (scope.placement.mode === 'range') {
      const draft = rangeDrafts.get(project.id);
      for (const edge of ['start', 'end']) { try { scope.placement[edge] = parseEditTime(draft?.[edge]); } catch {} }
    }
    write(scope);
    if (scope.placement.mode === 'insert') host.querySelector('[data-scope-time]').focus();
  };
  host.querySelector('[data-scope-time]').oninput = event => {
    timeText = event.target.value; timeDrafts.set(project.id, timeText);
    const scope = readEditScope(project); delete scope.placement.at;
    try { scope.placement.at = parseEditTime(timeText); } catch { /* Validate the complete value when submitting. */ }
    write(scope);
  };
  rangeButton.onclick = async () => {
    if (disabled || loading) return;
    selecting = true; paint(); host.querySelector('[data-scope-error]').hidden = true;
    try { const selection = await loadSelection(); if (disposed) return; write(selectTimelineRange(project, selection)); details.open = true; }
    catch (error) { if (!disposed) { const status = host.querySelector('[data-scope-error]'); status.textContent = error.message; status.hidden = false; onError?.(error); } }
    finally { selecting = false; if (!disposed) paint(); }
  };
  for (const edge of ['start', 'end']) host.querySelector('[data-scope-range-' + edge + ']').oninput = event => {
    const draft = rangeDrafts.get(project.id) || { start: host.querySelector('[data-scope-range-start]').value, end: host.querySelector('[data-scope-range-end]').value };
    draft[edge] = event.target.value; rangeDrafts.set(project.id, draft);
    const scope = readEditScope(project); scope.placement.mode = 'range'; delete scope.placement.clipIds; delete scope.placement[edge];
    try { scope.placement[edge] = parseEditTime(draft[edge]); } catch {}
    write(scope);
  };
  paint();
  if (details.open) void refresh();
  return {
    snapshot: current => editScopeSnapshot(project, current || context),
    setContext(value) { if (!disposed) { context = value; paint(); } },
    setDisabled(value) { const wasDisabled = disabled; disabled = Boolean(value); paint(); if (wasDisabled && !disabled && details.open && !context) void refresh(); },
    dispose() { disposed = true; request++; window.removeEventListener('guangxuan:edit-scope-changed', receiveScope); },
  };
}

import { escapeHtml as h } from './ui.js';
import { parseTimecode, normalizeTimeRange, formatTimecode, formatTimeRange } from './time-range.js';

const field = (kind, edge, value) => `<label>${edge === 'start' ? '起点' : '终点'}<input type="text" inputmode="decimal" maxlength="20" data-reference-range="${kind}" data-range-edge="${edge}" aria-label="${kind === 'source' ? '参照片段' : '作品区间'}${edge === 'start' ? '起点' : '终点'}" placeholder="${edge === 'start' ? '00:00' : '00:10'}" value="${h(value)}"></label>`;
export const createReferenceSegmentState = () => ({ drafts: new Map(), errors: new Map(), notices: new Map() });

export function referenceSegmentsMarkup(item, state) {
  const group = kind => {
    const range = item[`${kind}Range`], draft = state.drafts.get(`${item.id}:${kind}`);
    const start = draft?.start ?? (range ? formatTimecode(range.start) : '00:00');
    const end = draft?.end ?? (range ? formatTimecode(range.end) : '');
    return `<section class="gx-reference-range-group" data-reference-range-group="${kind}"><label class="gx-reference-range-toggle"><input type="checkbox" data-reference-range-enable="${kind}" ${(draft?.enabled ?? Boolean(range)) ? 'checked' : ''}>${kind === 'source' ? '限定参考视频片段' : '限定作品中的应用区间'}</label><div class="gx-reference-range-fields">${field(kind, 'start', start)}<span aria-hidden="true">→</span>${field(kind, 'end', end)}</div>${kind === 'source' ? '<div class="row wrap gx-reference-range-tools"><button class="btn small" type="button" data-reference-playhead="start">播放位置设为起点</button><button class="btn small" type="button" data-reference-playhead="end">设为终点</button><button class="btn small" type="button" data-reference-play-segment>播放本段</button></div>' : '<button class="btn small" type="button" data-reference-timeline-selection hidden>使用时间线所选区间</button>'}</section>`;
  };
  return `<details class="gx-reference-segments"><summary>参考哪段 → 作品哪段 <small data-reference-range-summary></small></summary><p class="tiny muted">时间可填秒数或 00:12.500。每项参考分别绑定；未限定作品区间时用于全片。</p>${item.type === 'video' ? group('source') : ''}${group('target')}<p class="gx-reference-range-error" data-reference-range-error role="alert" hidden></p></details>`;
}

export function paintReferenceSegments(card, item, state, { hasSelection = false } = {}) {
  for (const kind of ['source', 'target']) {
    const group = card.querySelector(`[data-reference-range-group="${kind}"]`); if (!group) continue;
    const range = item[`${kind}Range`], draft = state.drafts.get(`${item.id}:${kind}`), enabled = draft?.enabled ?? Boolean(range);
    group.querySelector('[data-reference-range-enable]').checked = enabled;
    for (const input of group.querySelectorAll('[data-reference-range]')) {
      input.disabled = !enabled;
      const edge = input.dataset.rangeEdge, next = draft?.[edge] ?? (range ? formatTimecode(range[edge]) : edge === 'start' ? '00:00' : '');
      if (document.activeElement !== input && input.value !== next) input.value = next;
    }
    group.querySelectorAll('[data-reference-playhead],[data-reference-play-segment]').forEach(button => { button.disabled = !enabled; });
    const selection = group.querySelector('[data-reference-timeline-selection]'); if (selection) { selection.hidden = !hasSelection; selection.disabled = !enabled; }
  }
  const errors = [...state.errors].filter(([key]) => key.startsWith(item.id + ':')).map(([, message]) => message);
  for (const [key, message] of state.notices) if (key.startsWith(item.id + ':')) errors.push(message);
  const error = card.querySelector('[data-reference-range-error]'); error.hidden = !errors.length; error.textContent = errors.join(' ');
  card.querySelector('[data-reference-range-summary]').textContent = errors.length ? '区间待完成' : `${item.type === 'video' ? formatTimeRange(item.sourceRange, '整个参考') : '此项参考'} → ${formatTimeRange(item.targetRange)}`;
}

export function bindReferenceSegments({ panel, state, getItem, onEdit, onState, getTimelineRange }) {
  const lifecycle = new AbortController();
  const read = (card, kind) => {
    const id = card.dataset.referenceId, item = getItem(id), range = item?.[`${kind}Range`];
    if (!item) return null;
    const existing = state.drafts.get(`${id}:${kind}`);
    return existing ?? { enabled: Boolean(range), start: range ? formatTimecode(range.start) : '00:00', end: range ? formatTimecode(range.end) : '' };
  };
  const commit = (card, kind, patch) => {
    const id = card.dataset.referenceId, key = `${id}:${kind}`, item = getItem(id); if (!item) return;
    const draft = { ...read(card, kind), ...patch }; state.drafts.set(key, draft);
    try {
      const range = draft.enabled ? normalizeTimeRange({ start: parseTimecode(draft.start), end: parseTimecode(draft.end) }, { label: kind === 'source' ? '参照片段' : '作品应用区间' }) : null;
      state.errors.delete(key); onEdit(id, `${kind}Range`, range);
    } catch (error) { state.errors.set(key, error.message); }
    paintReferenceSegments(card, getItem(id), state, { hasSelection: typeof getTimelineRange === 'function' }); onState();
  };
  panel.addEventListener('input', event => {
    const input = event.target.closest('[data-reference-range]'); if (!input) return;
    commit(input.closest('[data-reference-id]'), input.dataset.referenceRange, { [input.dataset.rangeEdge]: input.value });
  }, { signal: lifecycle.signal });
  panel.addEventListener('change', event => {
    const input = event.target.closest('[data-reference-range-enable]'); if (!input) return;
    const card = input.closest('[data-reference-id]'), kind = input.dataset.referenceRangeEnable;
    const draft = read(card, kind), player = card.querySelector('video');
    const end = input.checked && !draft.end && kind === 'source' && Number.isFinite(player?.duration) ? formatTimecode(player.duration) : draft.end;
    commit(card, kind, { enabled: input.checked, end });
    if (input.checked && !end) card.querySelector(`[data-reference-range="${kind}"][data-range-edge="end"]`)?.focus();
  }, { signal: lifecycle.signal });
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-reference-playhead],[data-reference-play-segment],[data-reference-timeline-selection]'); if (!button) return;
    const card = button.closest('[data-reference-id]'), item = getItem(card.dataset.referenceId), player = card.querySelector('video');
    if (button.dataset.referencePlayhead) {
      commit(card, 'source', { [button.dataset.referencePlayhead]: formatTimecode(player?.currentTime || 0) });
    } else if (button.hasAttribute('data-reference-play-segment')) {
      const range = item?.sourceRange; if (!range || !player) return;
      state.notices.delete(`${item.id}:preview`);
      const preview = card.querySelector('.gx-reference-preview'); if (preview) preview.open = true;
      player.dataset.referenceStopAt = String(range.end); player.currentTime = range.start;
      void player.play().catch(() => { state.notices.set(`${item.id}:preview`, '此参考暂时无法播放，可继续填写区间或更换常见视频格式。'); paintReferenceSegments(card, item, state); onState(); });
    } else if (getTimelineRange) {
      button.disabled = true;
      state.notices.delete(`${item.id}:selection`);
      void Promise.resolve(getTimelineRange()).then(range => {
        if (!card.isConnected) return;
        if (!range) throw new Error('请先在时间线上标记一个区间。');
        commit(card, 'target', { enabled: true, start: formatTimecode(range.start), end: formatTimecode(range.end) });
      }).catch(error => { if (!card.isConnected) return; state.notices.set(`${item.id}:selection`, error.message); paintReferenceSegments(card, item, state); onState(); }).finally(() => { if (button.isConnected) button.disabled = false; });
    }
  }, { signal: lifecycle.signal });
  panel.addEventListener('timeupdate', event => {
    const player = event.target;
    if (!(player instanceof HTMLVideoElement) || !player.dataset.referenceStopAt) return;
    if (player.currentTime >= Number(player.dataset.referenceStopAt)) { player.pause(); delete player.dataset.referenceStopAt; }
  }, { capture: true, signal: lifecycle.signal });
  return { dispose() { lifecycle.abort(); } };
}

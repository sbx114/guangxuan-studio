import { api, escapeHtml as h, showModal, toast, icon } from './ui.js';

const labels = { narration: '旁白', caption: '拟定字幕', visual: '分镜画面', duration: '建议时长', sourceText: '来源正文（仅记为已阅）' };
export function createSourceVersions({ beforeAction, onChanged, onOpenSource } = {}) {
  const sessions = new Map(); let active = null;
  const endpoint = id => `/api/projects/${encodeURIComponent(id)}/source-link`;
  function styles() { if (document.querySelector('[data-source-versions-style]')) return; const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/source-versions.css'; link.dataset.sourceVersionsStyle = ''; document.head.append(link); }
  async function open(project) {
    const id = typeof project === 'string' ? project : project?.id; if (!id) return;
    styles(); const memory = sessions.get(id) || { manual: null, selected: new Map() }; sessions.set(id, memory);
    const view = { controller: new AbortController(), state: null, panel: null, busy: false, close: null }; active?.close?.(); active = view;
    const request = (url, body, options = {}) => api(url, body, { ...options, signal: view.controller.signal });
    const error = value => { if (value.name === 'AbortError' || !view.panel?.isConnected) return; view.panel.querySelector('[data-version-error]').textContent = value.message; };
    const busy = value => { view.busy = value; view.panel?.querySelectorAll('button,input,select,textarea').forEach(element => { element.disabled = value; }); };
    const paint = state => {
      view.state = state; const panel = view.panel; if (!panel?.isConnected) return;
      const stateLabels = { unlinked: '尚未关联来源文案', untracked: '旧关联尚未建立版本基线，可比较当前来源', changed: '来源有更新，可逐项选择同步', 'in-sync': '来源暂无新变动', 'source-missing': '来源项目已不存在，可重新关联' };
      panel.querySelector('[data-version-status]').textContent = `${state.sourceTitle ? state.sourceTitle + ' · ' : ''}${stateLabels[state.status] || state.status}`;
      panel.querySelector('[data-version-source]').hidden = !state.sourceProjectId || !onOpenSource;
      panel.querySelector('[data-version-unlink]').hidden = !state.sourceProjectId;
      panel.querySelector('[data-version-diff]').innerHTML = state.changes.map(change => {
        if (!memory.selected.has(change.id)) memory.selected.set(change.id, !change.notice);
        return `<article class="gx-version-change"><label><input type="checkbox" data-version-change="${h(change.id)}" ${memory.selected.get(change.id) ? 'checked' : ''}><strong>${change.index >= 0 ? `第${change.index + 1}段 · ` : ''}${h(labels[change.field] || change.field)}</strong></label><div><section><small>原版本</small><p>${h(String(change.before ?? '') || '（空）')}</p></section><section><small>新版本</small><p>${h(String(change.after ?? '') || '（空）')}</p></section></div></article>`;
      }).join('') || '<p class="muted small">当前没有待同步的分镜变化。</p>';
      panel.querySelector('[data-version-script]').value = memory.manual ?? state.targetScript;
      const staleManual = memory.manual !== null && memory.manualTargetHash && memory.manualTargetHash !== state.targetHash;
      panel.querySelector('[data-version-current]').hidden = !staleManual;
      panel.querySelector('[data-version-current-script]').value = state.targetScript || '';
      panel.querySelector('[data-version-error]').textContent = staleManual ? '旁白已在其它位置更新，本机草稿已保留。请对照当前旁白，编辑合并后再同步。' : '';
    };
    const load = async () => { await beforeAction?.(); const state = await request(endpoint(id)); if (view.panel?.isConnected) paint(state); return state; };
    view.close = showModal({ title: '文案与视频版本', wide: true, body: `<div class="gx-source-versions"><p class="small muted">同步旁白、拟定字幕和分镜草稿；时间线与手动剪辑保持独立。</p><div class="row wrap"><select data-version-candidate aria-label="来源文案"><option value="">选择来源文案或科普项目</option></select><button class="btn small" data-version-bind>${icon('link')}建立版本关联</button></div><div class="row wrap"><strong data-version-status>正在比较…</strong><button class="btn small" data-version-refresh>重新比较</button><button class="btn small" data-version-source hidden>查看来源</button><button class="btn small" data-version-unlink hidden>解除关联</button></div><div data-version-diff></div><details><summary>视频旁白草稿 · 可手动合并</summary><textarea data-version-script rows="7" maxlength="30000" aria-label="视频旁白草稿"></textarea></details><details data-version-current hidden><summary>当前已保存旁白 · 供比较</summary><textarea data-version-current-script rows="7" readonly aria-label="当前已保存旁白"></textarea></details><p data-version-error role="alert" class="gx-version-error"></p><div class="modal-actions"><button class="btn primary" data-version-sync>同步所选与手动草稿</button></div></div>`, onMount(root) {
      view.panel = root.querySelector('.gx-source-versions'); const panel = view.panel;
      panel.querySelector('[data-version-script]').oninput = event => { memory.manual = event.target.value; memory.manualTargetHash = view.state?.targetHash; };
      panel.addEventListener('change', event => { if (event.target.dataset.versionChange) memory.selected.set(event.target.dataset.versionChange, event.target.checked); });
      const mutate = async (suffix, body) => { if (view.busy) return; busy(true); try { await beforeAction?.(); const result = await request(endpoint(id) + suffix, body); if (result.project) await onChanged?.(result.project); if (!panel.isConnected) return; if (result.conflicts?.length) { paint(result); panel.querySelector('[data-version-error]').textContent = result.conflicts.map(item => item.message).join(' '); } else { memory.manual = null; memory.manualTargetHash = null; paint(result); toast(suffix === '/sync' ? '所选草稿已同步' : suffix === '/unlink' ? '已解除来源关联' : '已建立版本关联'); } } catch (value) { error(value); } finally { if (panel.isConnected) busy(false); } };
      panel.querySelector('[data-version-bind]').onclick = () => { const sourceProjectId = panel.querySelector('[data-version-candidate]').value; if (!sourceProjectId) return error(new Error('请选择来源项目。')); void mutate('', { sourceProjectId }); };
      panel.querySelector('[data-version-unlink]').onclick = () => { void mutate('/unlink', {}); };
      panel.querySelector('[data-version-sync]').onclick = () => { const state = view.state; if (!state?.sourceHash) return error(new Error('请先关联来源项目。')); const selectedIds = state.changes.filter(change => memory.selected.get(change.id)).map(change => change.id); if (!selectedIds.length && memory.manual === null) return error(new Error('请选择变动或编辑旁白草稿。')); void mutate('/sync', { sourceHash: state.sourceHash, targetHash: memory.manual !== null ? memory.manualTargetHash || state.targetHash : state.targetHash, revision: state.revision, selectedIds, ...(memory.manual !== null ? { manualScript: memory.manual } : {}) }); };
      panel.querySelector('[data-version-refresh]').onclick = () => { if (view.busy) return; busy(true); void load().catch(error).finally(() => { if (panel.isConnected) busy(false); }); };
      panel.querySelector('[data-version-source]').onclick = () => { const sourceId = view.state?.sourceProjectId; if (sourceId) { view.close(); void onOpenSource?.(sourceId); } };
      busy(true);
      void Promise.all([load(), request('/api/source-links/candidates')]).then(([, data]) => { if (!panel.isConnected) return; panel.querySelector('[data-version-candidate]').innerHTML = '<option value="">选择来源文案或科普项目</option>' + data.projects.map(item => `<option value="${h(item.id)}">${h(item.title)}</option>`).join(''); if (view.state?.sourceProjectId) panel.querySelector('[data-version-candidate]').value = view.state.sourceProjectId; }).catch(error).finally(() => { if (panel.isConnected) busy(false); });
    }, onClose() { view.controller.abort(); if (active === view) active = null; } });
  }
  return { open, dispose() { active?.close?.(); sessions.clear(); }, async status(projectId) { return api(endpoint(projectId)); } };
}

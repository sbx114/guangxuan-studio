import { escapeHtml as h, fetchLocal, icon, saveFile, showModal, toast } from './ui.js';

const sizeText = value => {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(value / 1024))} KB`;
};
async function request(url, body, { signal, binary = false, method = 'POST' } = {}) {
  const response = await fetchLocal(url, { method, signal, headers: method === 'DELETE' ? {} : { 'Content-Type': binary ? 'application/x-gxproject' : 'application/json' }, ...(method === 'DELETE' ? {} : { body: binary ? body : JSON.stringify(body) }) });
  let value; try { value = await response.json(); } catch { throw new Error('无法读取项目包响应，请重试。'); }
  if (!response.ok) throw Object.assign(new Error(value.error || '项目包操作未完成，请重试。'), { report: value.report });
  return value;
}
function reportMarkup(report) {
  if (!report) return '';
  const issueList = (items, title, error) => items?.length ? `<section class="gx-bundle-findings ${error ? 'is-error' : ''}"><strong>${h(title)}</strong><ul>${items.map(item => `<li>${h(item.message)}${item.file ? `<small>${h(item.file)}</small>` : ''}</li>`).join('')}</ul></section>` : '';
  return `<div class="gx-bundle-summary"><span><strong>${Number(report.fileCount) || 0}</strong> 个文件</span><span>${sizeText(Number(report.bytes) || 0)}</span><span>${Number(report.assetCount) || 0} 个素材</span>${report.native ? '<span>含剪辑工程</span>' : ''}</div>${report.dependencies?.length ? `<p class="small muted">包含关联项目：${report.dependencies.map(item => h(item.title)).join('、')}</p>` : ''}${issueList(report.issues, '请先处理这些问题', true)}${issueList(report.warnings, '恢复提示', false)}`;
}

/** Host entry points: bundles.openExport(projectOrId), bundles.openRestore(). */
export function createProjectBundles({ beforeExport = async () => {}, onRestored = async () => {} } = {}) {
  if (!document.querySelector('link[data-project-bundles-css]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/project-bundles.css'; link.dataset.projectBundlesCss = ''; document.head.append(link); }
  let active = null, disposed = false;
  function closeActive() { if (active?.panel?.isConnected) active.close(); active = null; }
  function modal(options) {
    closeActive();
    const lifetime = { panel: null, close: null, controller: new AbortController(), closed: false, token: null, restored: false };
    const close = showModal({ ...options, onMount(root, closeModal) { lifetime.panel = root.querySelector('.modal'); lifetime.close = closeModal; options.mount(lifetime); }, onClose() { lifetime.closed = true; lifetime.controller.abort(); if (lifetime.token && !lifetime.restored) void request(`/api/project-bundles/imports/${lifetime.token}`, undefined, { method: 'DELETE' }).catch(() => {}); if (active === lifetime) active = null; } });
    lifetime.close ||= close; active = lifetime; return lifetime;
  }
  function openExport(project) {
    if (disposed) return;
    const projectId = typeof project === 'string' ? project : project?.id;
    if (!projectId) { toast('请先选择要备份的项目'); return; }
    modal({ title: '导出完整项目包', body: '<div class="gx-project-bundles"><p class="small muted">包含资料、剪辑、素材、参考和封面，恢复时会新建项目。</p><div data-bundle-status role="status"><span class="spinner"></span> 正在保存并检查项目…</div><div data-bundle-report></div><div class="modal-actions"><button class="btn" data-bundle-close>关闭</button><a class="btn primary" data-bundle-download hidden>保存项目包</a></div></div>', mount(view) {
      const panel = view.panel, status = panel.querySelector('[data-bundle-status]');
      panel.querySelector('[data-bundle-close]').onclick = view.close;
      void (async () => {
        try {
          await beforeExport(projectId);
          if (view.closed) return;
          const value = await request('/api/project-bundles/exports', { projectId }, { signal: view.controller.signal });
          if (view.closed || !panel.isConnected) return;
          panel.querySelector('[data-bundle-report]').innerHTML = reportMarkup(value.report);
          status.textContent = `项目包已准备好 · ${sizeText(value.bytes)}`;
          if (!/^\/api\/project-bundles\/exports\/[a-f0-9-]{36}\/file$/.test(value.downloadUrl)) throw new Error('项目包下载地址无效，请重试。');
          const download = panel.querySelector('[data-bundle-download]'); download.href = value.downloadUrl; download.download = value.filename; download.hidden = false;
        } catch (error) {
          if (view.closed || error.name === 'AbortError') return;
          status.textContent = error.message; status.classList.add('is-error');
          panel.querySelector('[data-bundle-report]').innerHTML = reportMarkup(error.report);
        }
      })();
    } });
  }
  function openRestore() {
    if (disposed) return;
    modal({ title: '恢复完整项目包', body: `<div class="gx-project-bundles"><p class="small muted">恢复为新项目，现有项目会保留。</p><div><button class="btn" data-bundle-pick>${icon('upload')}选择 .gxproject 文件</button><input type="file" accept=".gxproject,application/x-gxproject" data-bundle-file hidden></div><div data-bundle-status role="status">尚未选择项目包</div><div data-bundle-report></div><label class="gx-bundle-name" hidden data-bundle-name>恢复后的项目名称<input data-bundle-title maxlength="120" autocomplete="off"></label><div class="modal-actions"><button class="btn" data-bundle-close>取消</button><button class="btn primary" data-bundle-restore disabled>确认恢复为新项目</button><button class="btn" data-bundle-save-report hidden>保存核验报告</button></div></div>`, mount(view) {
      const panel = view.panel, status = panel.querySelector('[data-bundle-status]'), fileInput = panel.querySelector('[data-bundle-file]'), pick = panel.querySelector('[data-bundle-pick]'), restore = panel.querySelector('[data-bundle-restore]');
      let busy = false, finalReport = null;
      panel.querySelector('[data-bundle-close]').onclick = view.close;
      pick.onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const file = fileInput.files?.[0]; if (!file || busy) return;
        busy = true; pick.disabled = true; restore.disabled = true; status.classList.remove('is-error'); status.innerHTML = '<span class="spinner"></span> 正在检查项目包…';
        panel.querySelector('[data-bundle-name]').hidden = true; panel.querySelector('[data-bundle-report]').replaceChildren();
        if (view.token) { void request(`/api/project-bundles/imports/${view.token}`, undefined, { method: 'DELETE' }).catch(() => {}); view.token = null; }
        try {
          const value = await request('/api/project-bundles/imports', file, { signal: view.controller.signal, binary: true });
          if (view.closed || !panel.isConnected) return;
          view.token = value.token; panel.querySelector('[data-bundle-report]').innerHTML = reportMarkup(value.report);
          status.textContent = '检查通过，可以恢复。';
          panel.querySelector('[data-bundle-title]').value = `${value.report.project.title || '未命名项目'}（恢复副本）`.slice(0, 120);
          panel.querySelector('[data-bundle-name]').hidden = false; restore.disabled = !value.report.ok;
        } catch (error) {
          if (view.closed || error.name === 'AbortError') return;
          status.textContent = error.message; status.classList.add('is-error'); panel.querySelector('[data-bundle-report]').innerHTML = reportMarkup(error.report);
        } finally { busy = false; if (!view.closed && panel.isConnected) pick.disabled = false; fileInput.value = ''; }
      };
      restore.onclick = async () => {
        if (busy || !view.token || view.restored) return;
        const title = panel.querySelector('[data-bundle-title]').value.trim();
        if (!title) { status.textContent = '请填写恢复后的项目名称'; panel.querySelector('[data-bundle-title]').focus(); return; }
        busy = true; pick.disabled = true; restore.disabled = true; status.classList.remove('is-error'); status.innerHTML = '<span class="spinner"></span> 正在恢复项目…';
        try {
          const value = await request(`/api/project-bundles/imports/${view.token}/restore`, { confirm: true, title }); view.restored = true; finalReport = value.report;
          try { await onRestored(value); }
          catch { toast('项目已恢复，列表刷新失败，请稍后查看。'); }
          if (view.closed || !panel.isConnected) return;
          status.textContent = '已恢复为新项目。'; panel.querySelector('[data-bundle-report]').innerHTML = reportMarkup(value.report);
          panel.querySelector('[data-bundle-name]').hidden = true; restore.hidden = true; pick.hidden = true;
          panel.querySelector('[data-bundle-close]').textContent = '完成'; panel.querySelector('[data-bundle-save-report]').hidden = false;
        } catch (error) { if (view.closed) return; status.textContent = error.message; status.classList.add('is-error'); restore.disabled = false; }
        finally { busy = false; if (!view.closed && panel.isConnected && !view.restored) pick.disabled = false; }
      };
      panel.querySelector('[data-bundle-save-report]').onclick = () => { if (finalReport) void saveFile('Gx-项目恢复核验.json', JSON.stringify(finalReport, null, 2), 'application/json'); };
    } });
  }
  return { openExport, openRestore, dispose() { disposed = true; closeActive(); } };
}

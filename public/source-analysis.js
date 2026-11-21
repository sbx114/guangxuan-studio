import { api, escapeHtml as h, icon, showModal, toast } from './ui.js';

const endpoint = id => `/api/projects/${encodeURIComponent(id)}/source-analysis`;
const final = job => !job || ['complete', 'cancelled', 'error'].includes(job.status);
const timecode = seconds => {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const finite = value => Number.isFinite(Number(value));
const safeFrameUrl = (projectId, item, frame) => /^[a-f0-9]{64}$/.test(item.cacheKey) && /^f\d{3}\.jpg$/.test(frame.id) ? `${endpoint(projectId)}/frames/${item.cacheKey}/${frame.id}` : '';

function styles() {
  if (document.querySelector('link[data-source-analysis]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/source-analysis.css'; link.dataset.sourceAnalysis = ''; document.head.append(link);
}
function plainResult(item) {
  return [`${item.name} [${item.range?.timecode || ''}]`, item.summary?.text || '', item.summary?.coverageNote || item.coverage?.note || '',
    ...(item.shots || []).map(shot => `[${shot.timecode}] ${shot.description || (shot.boundary === 'detected' ? '检测到画面变化' : '采样区间，尚无内容描述')}`),
    ...(item.transcript?.segments || []).map(segment => `[${segment.timecode}] ${segment.text}${segment.timing === 'chunk' ? '（音频分块范围）' : ''}`),
    ...(item.warnings || []).map(warning => `提示：${warning}`)].filter(Boolean).join('\n');
}

/** A small client for local shot evidence and explicitly enabled provider analysis. */
export function createSourceAnalysis({ getSettings = () => ({}), onChanged } = {}) {
  const sessions = new Map();
  let modal = null, disposed = false;
  styles();
  function sessionFor(project) {
    const id = typeof project === 'string' ? project : project?.id;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id || '')) throw new Error('请先打开一个项目。');
    let session = sessions.get(id);
    if (!session) {
      session = { id, title: typeof project === 'object' ? project.title || '当前项目' : '当前项目', assets: [], items: [], selected: new Set(), ranges: new Map(), loaded: false, loading: false, starting: false, job: null, error: '', resultStamp: '', startPromise: null, timer: null, polling: false, failures: 0,
        options: { transcribe: false, transcriptionModel: '', language: '', visualSummary: false, model: '' } };
      sessions.set(id, session);
    }
    return session;
  }
  const panelFor = session => modal?.session === session && modal.panel?.isConnected ? modal.panel : null;
  const busy = session => session.starting || session.loading || !final(session.job);
  function accept(session, data) {
    session.assets = Array.isArray(data.assets) ? data.assets.filter(asset => asset && ['video', 'audio', 'image'].includes(asset.type)) : [];
    session.items = Array.isArray(data.items) ? data.items : [];
    session.loaded = true;
    session.limits = data.limits || { maxRangeSeconds: 1800, maxTotalSeconds: 3600 };
    session.runtimeAvailable = data.runtimeAvailable !== false;
    for (const asset of session.assets) if (!session.ranges.has(asset.id)) session.ranges.set(asset.id, { start: '0', end: String(Math.min(Number(asset.duration) || 0, 1800)) });
    session.selected = new Set([...session.selected].filter(id => session.assets.some(asset => asset.id === id)));
    if (!session.selected.size && session.assets[0]) session.selected.add(session.assets[0].id);
    const active = (Array.isArray(data.jobs) ? data.jobs : []).filter(job => !final(job)).at(-1);
    if (active) { session.job = active; poll(session); }
  }
  async function load(project, { force = false } = {}) {
    const session = sessionFor(project);
    if (session.loading) return session.loadPromise;
    if (session.loaded && !force) return session;
    session.loading = true; session.error = ''; paint(session);
    session.loadPromise = api(endpoint(session.id)).then(data => { accept(session, data); paintAssets(session); return session; })
      .catch(error => { session.error = error.message; throw error; })
      .finally(() => { session.loading = false; paint(session); });
    return session.loadPromise;
  }
  function paintAssets(session) {
    const panel = panelFor(session), host = panel?.querySelector('[data-sa-assets]');
    if (!host) return;
    host.innerHTML = session.assets.length ? session.assets.map(asset => {
      const range = session.ranges.get(asset.id);
      return `<div class="sa-asset" data-sa-asset="${h(asset.id)}"><label class="sa-asset-check"><input type="checkbox" data-sa-select="${h(asset.id)}" ${session.selected.has(asset.id) ? 'checked' : ''}><span><strong>${h(asset.name)}</strong><small>${h(({ video: '视频', audio: '音频', image: '图片' })[asset.type])} · ${timecode(asset.duration)}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}</small></span></label><div class="sa-range"><label>从 / 秒<input type="number" min="0" max="${Number(asset.duration) || 0}" step="0.01" data-sa-start="${h(asset.id)}" value="${h(range.start)}"></label><span>—</span><label>到 / 秒<input type="number" min="0" max="${Number(asset.duration) || 0}" step="0.01" data-sa-end="${h(asset.id)}" value="${h(range.end)}"></label></div>${Number(asset.duration) > 1800 ? '<small class="sa-long">默认分析前30分钟，可调整起止位置；每次单段不超过30分钟。</small>' : ''}</div>`;
    }).join('') : '<p class="sa-empty">请先导入视频、图片或音频，再刷新素材列表。</p>';
    updateSelection(session);
  }
  function updateSelection(session) {
    const panel = panelFor(session); if (!panel) return;
    for (const row of panel.querySelectorAll('[data-sa-asset]')) {
      const selected = session.selected.has(row.dataset.saAsset);
      row.classList.toggle('is-selected', selected);
      row.querySelectorAll('.sa-range input').forEach(input => { input.disabled = busy(session) || !selected; });
    }
    paint(session);
  }
  function resultMarkup(session, item, index) {
    const states = { complete: '已完成', partial: '部分完成', error: '未完成', unavailable: '未配置', skipped: '未启用', 'not-applicable': '不适用' };
    const transcript = item.transcript || {};
    return `<article class="sa-result"><header><div><h3>${h(item.name)}</h3><span>${h(item.range?.timecode)}${item.cached ? ' · 已有分析' : ''}</span></div><div class="sa-result-actions"><button class="btn small" type="button" data-sa-copy="${index}">复制时间码摘要</button><button class="btn small" type="button" data-sa-download="${index}">保存结果</button></div></header><p class="sa-summary">${h(item.summary?.text)}</p><p class="sa-evidence-note">${h(item.summary?.coverageNote || item.coverage?.note || '')}</p>${item.warnings?.length ? `<ul class="sa-warnings">${[...new Set(item.warnings)].map(warning => `<li>${h(warning)}</li>`).join('')}</ul>` : ''}<div class="sa-frames">${(item.keyframes || []).map(frame => `<figure><img src="${h(safeFrameUrl(session.id, item, frame))}" alt="${h(item.name)} ${h(frame.timecode)}的抽样画面" loading="lazy"><figcaption>${h(frame.timecode)} · ${h(frame.shotId)}</figcaption></figure>`).join('')}</div><details><summary>镜头与采样区间 · ${(item.shots || []).length} 段</summary>${item.shots?.length ? `<div class="sa-shot-list">${item.shots.map(shot => `<div><code>${h(shot.timecode)}</code><span class="sa-boundary">${h(({ range: '区间起点', detected: '画面变化估计', interval: '间隔采样' })[shot.boundary] || '采样')}</span><p>${h(shot.description || '尚无画面内容描述。')}</p></div>`).join('')}</div>` : '<p>此素材没有视频镜头。</p>'}</details><details ${transcript.text ? 'open' : ''}><summary>语音转写 · ${h(states[transcript.status] || '未启用')}</summary>${transcript.timingNote ? `<p class="sa-evidence-note">${h(transcript.timingNote)}</p>` : ''}${transcript.segments?.length ? `<div class="sa-transcript">${transcript.segments.slice(0, 300).map(segment => `<p><code>${h(segment.timecode)}${segment.timing === 'chunk' ? ' · 分块范围' : ''}</code><span>${h(segment.text)}</span></p>`).join('')}${transcript.segments.length > 300 ? '<p>窗口先显示前300段，保存结果可查看全部转写。</p>' : ''}</div>` : `<p>${h(transcript.warning || '暂无转写内容。')}</p>`}</details></article>`;
  }
  function paint(session) {
    const panel = panelFor(session); if (!panel) return;
    const running = busy(session), status = panel.querySelector('[data-sa-status]'), job = session.job;
    status.textContent = session.error || (session.loading ? '正在读取素材和已有分析…' : session.starting ? '正在创建分析任务…' : job?.message || '选择素材和区间。');
    status.classList.toggle('is-error', Boolean(session.error || job?.status === 'error'));
    panel.querySelector('[data-sa-form]').disabled = running;
    for (const row of panel.querySelectorAll('[data-sa-asset]')) row.querySelectorAll('.sa-range input').forEach(input => { input.disabled = running || !session.selected.has(row.dataset.saAsset); });
    panel.querySelector('[data-sa-run]').disabled = running || !session.selected.size || !session.runtimeAvailable;
    panel.querySelector('[data-sa-refresh]').disabled = running || !session.selected.size || !session.runtimeAvailable;
    panel.querySelector('[data-sa-reload]').disabled = running;
    const cancel = panel.querySelector('[data-sa-cancel]'); cancel.hidden = !job || final(job); cancel.disabled = session.cancelling === true;
    const progress = panel.querySelector('[data-sa-progress]'); progress.hidden = !job; progress.value = Number(job?.progress) || 0;
    panel.querySelector('[data-sa-progress-text]').textContent = job ? `${Math.round((Number(job.progress) || 0) * 100)}% · ${hPhase(job.phase)}` : '';
    const stamp = session.items.map(item => `${item.cacheKey}:${item.analyzedAt}:${Boolean(item.cached)}`).join('|');
    if (stamp !== session.resultStamp || !panel.querySelector('[data-sa-results]').children.length) {
      session.resultStamp = stamp;
      panel.querySelector('[data-sa-results]').innerHTML = session.items.length ? session.items.map((item, index) => resultMarkup(session, item, index)).join('') : '<p class="sa-empty">暂无分析结果。</p>';
    }
  }
  const hPhase = value => ({ queued: '排队中', preparing: '准备素材', scenes: '本地镜头分析', keyframes: '抽取关键帧', transcribing: '语音转写', summarizing: 'AI内容摘要', saving: '保存结果', complete: '已完成', cancelled: '已取消', error: '未完成' })[value] || '等待中';
  function mergeResults(session, items) {
    const keys = new Set(items.map(item => item.cacheKey));
    session.items = [...items, ...session.items.filter(item => !keys.has(item.cacheKey))].slice(0, 60);
    session.resultStamp = ''; paint(session);
  }
  function poll(session) {
    if (disposed || !session.job || final(session.job) || session.polling && session.pollToken?.id === session.job.id) return;
    clearTimeout(session.timer);
    const token = { id: session.job.id }; session.pollToken = token;
    session.polling = true;
    const next = async () => {
      if (session.pollToken !== token) return;
      if (disposed || !session.job || final(session.job)) { session.polling = false; return; }
      try {
        const job = await api(`${endpoint(session.id)}/jobs/${encodeURIComponent(token.id)}`);
        if (disposed || session.pollToken !== token || session.job?.id !== token.id) return;
        session.job = job; session.failures = 0;
        if (job.status === 'error') session.error = job.error || '素材分析未完成，请重试。';
        if (job.status === 'complete' && job.result) {
          session.error = ''; mergeResults(session, job.result.items || []);
          try { onChanged?.(session.id, job.result); } catch { /* Optional host observer. */ }
        }
        paint(session);
      } catch (error) { if (session.pollToken === token) { session.error = error.message; session.failures++; paint(session); } }
      finally {
        if (session.pollToken === token) {
          if (!disposed && !final(session.job) && session.failures < 10) session.timer = setTimeout(next, session.failures ? 1800 : 700);
          else session.polling = false;
        }
      }
    };
    void next();
  }
  async function start(session, refresh = false) {
    if (busy(session)) return;
    session.error = '';
    const sources = [...session.selected].map(assetId => {
      const range = session.ranges.get(assetId) || {};
      if (!finite(range.start) || !finite(range.end) || Number(range.end) <= Number(range.start)) throw new Error('请填写有效的分析起止秒数。');
      return { assetId, start: Number(range.start), end: Number(range.end) };
    });
    if (!sources.length || sources.length > 8) throw new Error('每次请选择1至8个项目素材。');
    session.starting = true; paint(session);
    session.startPromise = (async () => {
      const settings = await getSettings();
      const job = await api(endpoint(session.id), { sources, options: { ...session.options }, refresh, ...(session.options.transcribe || session.options.visualSummary ? { settings } : {}) });
      session.job = job; session.failures = 0; poll(session); return job;
    })().catch(error => { session.error = error.message; throw error; }).finally(() => { session.starting = false; paint(session); });
    return session.startPromise;
  }
  async function cancel(session) {
    if (!session.job || final(session.job) || session.cancelling) return;
    session.cancelling = true; paint(session);
    try { session.job = await api(`${endpoint(session.id)}/jobs/${encodeURIComponent(session.job.id)}/cancel`, {}); session.error = ''; }
    catch (error) { session.error = error.message; }
    finally { session.cancelling = false; paint(session); }
  }
  async function show(project, focus = {}) {
    if (disposed) return;
    const session = sessionFor(project); session.resultStamp = '';
    if (focus.assetId) { session.selected = new Set([focus.assetId]); if (finite(focus.start) && finite(focus.end)) session.ranges.set(focus.assetId, { start: String(focus.start), end: String(focus.end) }); }
    showModal({ title: '素材分析', kicker: '语音 · 镜头 · 时间码', wide: true,
      body: `<div class="source-analysis"><p class="sa-intro">在本地分析镜头和关键帧，可选语音转写与内容摘要。结果仅覆盖所选区间。</p><div class="sa-heading"><h3>选择项目素材</h3><button class="btn small" type="button" data-sa-reload>${icon('refresh')}刷新素材</button></div><p data-sa-status class="sa-status" role="status" aria-live="polite"></p><fieldset data-sa-form><div data-sa-assets></div><div class="sa-options"><label class="sa-toggle"><input type="checkbox" data-sa-option="transcribe" ${session.options.transcribe ? 'checked' : ''}>语音转写</label><p>仅将所选区间的音频发送至当前转写服务。</p><label>转写模型（选填）<input type="text" maxlength="300" data-sa-option="transcriptionModel" value="${h(session.options.transcriptionModel)}" placeholder="留空使用当前模型，需支持语音转写"></label><label>转写语言<select data-sa-option="language"><option value="">自动识别</option><option value="zh" ${session.options.language === 'zh' ? 'selected' : ''}>中文</option><option value="en" ${session.options.language === 'en' ? 'selected' : ''}>英语</option></select></label><label class="sa-toggle"><input type="checkbox" data-sa-option="visualSummary" ${session.options.visualSummary ? 'checked' : ''}>生成AI内容摘要</label><p>将抽样画面和转写文字发送至当前模型，摘要仅覆盖这些内容。</p><label>摘要模型（选填）<input type="text" maxlength="300" data-sa-option="model" value="${h(session.options.model)}" placeholder="留空使用当前模型，视频需支持图片输入"></label></div></fieldset><div class="sa-actions"><button class="btn primary" type="button" data-sa-run>${icon('spark')}开始分析</button><button class="btn" type="button" data-sa-refresh>刷新所选分析</button><button class="btn danger" type="button" data-sa-cancel hidden>取消分析</button><span data-sa-progress-text></span><progress data-sa-progress max="1" value="0" hidden></progress></div><p class="sa-footnote">最多8项，每段30分钟，合计60分钟。关闭后继续分析，可在任务中心查看。</p><h3>分析结果</h3><section data-sa-results aria-label="带时间码的分析结果"></section></div>`,
      onClose: () => { if (modal?.session === session) modal = null; },
      onMount(panel) {
        modal = { session, panel };
        panel.querySelector('[data-sa-reload]').onclick = () => { void load(project, { force: true }).catch(() => {}); };
        for (const [attribute, refresh] of [['data-sa-run', false], ['data-sa-refresh', true]]) panel.querySelector(`[${attribute}]`).onclick = () => { void start(session, refresh).catch(error => { session.error = error.message; paint(session); }); };
        panel.querySelector('[data-sa-cancel]').onclick = () => { void cancel(session); };
        panel.addEventListener('change', event => {
          const input = event.target;
          if (input.dataset.saSelect) { input.checked ? session.selected.add(input.dataset.saSelect) : session.selected.delete(input.dataset.saSelect); updateSelection(session); }
          if (input.dataset.saOption) session.options[input.dataset.saOption] = input.type === 'checkbox' ? input.checked : input.value;
        });
        panel.addEventListener('input', event => {
          const input = event.target, assetId = input.dataset.saStart || input.dataset.saEnd;
          if (assetId) { const range = session.ranges.get(assetId); if (range) range[input.dataset.saStart ? 'start' : 'end'] = input.value; }
          if (input.dataset.saOption && input.type !== 'checkbox') session.options[input.dataset.saOption] = input.value;
        });
        panel.addEventListener('click', event => {
          const copy = event.target.closest('[data-sa-copy]'), save = event.target.closest('[data-sa-download]');
          if (copy) { const item = session.items[Number(copy.dataset.saCopy)]; if (item) { if (!navigator.clipboard?.writeText) toast('无法复制，可保存结果后查看。', 'error'); else void navigator.clipboard.writeText(plainResult(item)).then(() => toast('时间码摘要已复制'), () => toast('无法复制，可保存结果后查看。', 'error')); } }
          if (save) {
            const item = session.items[Number(save.dataset.saDownload)]; if (!item) return;
            const url = URL.createObjectURL(new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' })), link = document.createElement('a');
            link.href = url; link.download = `${String(item.name || '素材').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}-时间码分析.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        });
        paintAssets(session); paint(session);
      },
    });
    await load(project, { force: true }).catch(() => {});
    if (focus.jobId) {
      try { const job = await api(`${endpoint(session.id)}/jobs/${encodeURIComponent(focus.jobId)}`); session.job = job; if (job.result?.items) mergeResults(session, job.result.items); poll(session); paint(session); } catch (error) { session.error = error.message; paint(session); }
    }
  }
  return {
    show, load,
    async flush(project) { const session = sessionFor(project); await session.startPromise?.catch(() => {}); return session.job; },
    async context(project) { const session = await load(project, { force: true }); return { items: session.items }; },
    dispose() { disposed = true; for (const session of sessions.values()) clearTimeout(session.timer); sessions.clear(); modal = null; },
  };
}

export const createSourceAnalysisClient = createSourceAnalysis;

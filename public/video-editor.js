import { api, toast, showModal, icon, escapeHtml, uid, clone, timecode, saveFile, safeName } from './ui.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const seconds = value => Math.round((Number(value) || 0) * 1000) / 1000;
const TYPES = { video: '视频', image: '图片', audio: '音频' };
const SCENES = { title: '标题', steps: '步骤', bars: '图表', quote: '重点', outro: '结尾' };
const h = escapeHtml;

export function createVideoEditor({ getSettings, requireConnection, callAi, saveProject, onWriting }) {
  let container = null, project = null, assets = [], selected = null, sourcePreview = null;
  let playhead = 0, playing = false, clockBase = 0, clockStart = 0, frame = null;
  let pxPerSecond = 34, mediaFilter = 'all', search = '', undo = [], runtime = null;
  let epoch = 0, resizeObserver = null, pendingScript = null, importing = false;
  let activeMediaKey = null, mountedEvents = null, pendingMediaTime = 0, modalCloser = null;
  const polls = new Set();
  const saveTimers = new Map();

  const data = () => project.video;
  const assetById = id => assets.find(asset => asset.id === id);
  const duration = () => data().timeline.reduce((sum, clip) => sum + Math.max(0, Number(clip.end) - Number(clip.start)), 0);
  const effectiveDuration = () => sourcePreview ? (assetById(sourcePreview)?.duration || 0) : duration();
  const connected = () => Boolean(container?.isConnected && project);
  function ensureVideo(target) {
    target.video = { timeline: [], captions: [], aspect: '16:9', resolution: '720', sourceVolume: 1, music: null, script: '', animationPlan: null, ...target.video };
    if (!Array.isArray(target.video.timeline)) target.video.timeline = [];
    if (!Array.isArray(target.video.captions)) target.video.captions = [];
    target.video.timeline.forEach(clip => { if (!clip.id) clip.id = uid(); });
    target.history ||= []; target.runs ||= [];
  }
  function persist(target = project, immediate = false) {
    if (!target) return;
    clearTimeout(saveTimers.get(target.id)); saveTimers.delete(target.id);
    const write = () => Promise.resolve(saveProject(target)).catch(error => toast(`项目保存失败：${error.message}`, 'error'));
    if (immediate) return write();
    saveTimers.set(target.id, setTimeout(() => { saveTimers.delete(target.id); write(); }, 300));
  }
  function log(target, label) {
    target.history ||= [];
    target.history.unshift({ id: uid(), at: new Date().toISOString(), type: 'video', label });
    target.history = target.history.slice(0, 100);
  }
  function commit(label, change) {
    pause();
    undo.push(clone(data())); if (undo.length > 40) undo.shift();
    change(data()); sourcePreview = null;
    playhead = clamp(playhead, 0, duration());
    log(project, label); persist(); render();
  }
  function rememberRun(target, task, result, label) {
    target.runs ||= [];
    target.runs.unshift({ id: uid(), at: new Date().toISOString(), task, ...result.meta, meta: result.meta, prompt: result.prompt, label });
    target.runs = target.runs.slice(0, 60); log(target, label); persist(target);
  }
  function undoChange() {
    if (!undo.length) return;
    pause(); project.video = undo.pop(); sourcePreview = null; selected = null;
    playhead = clamp(playhead, 0, duration()); log(project, '撤销上一步剪辑'); persist(); render();
  }
  function clipAt(value = playhead) {
    if (sourcePreview) {
      const asset = assetById(sourcePreview);
      return asset ? { clip: { id: 'preview', assetId: asset.id, start: 0, end: asset.duration }, asset, local: clamp(value, 0, asset.duration - 0.001), offset: 0, index: -1 } : null;
    }
    let offset = 0;
    for (let index = 0; index < data().timeline.length; index++) {
      const clip = data().timeline[index], length = clip.end - clip.start;
      if (value < offset + length || index === data().timeline.length - 1) return { clip, asset: assetById(clip.assetId), local: clamp(value - offset, 0, Math.max(0, length - 0.015)), offset, index };
      offset += length;
    }
    return null;
  }
  function offsetOf(id) {
    let value = 0;
    for (const clip of data().timeline) { if (clip.id === id) return value; value += clip.end - clip.start; }
    return value;
  }
  function stopElements() { container?.querySelectorAll('video,audio').forEach(media => media.pause()); }
  function pause() {
    playing = false; if (frame !== null) cancelAnimationFrame(frame); frame = null; stopElements(); updateTransport();
  }
  function play() {
    if (!effectiveDuration()) return toast('先将素材加入时间线，或选择一个素材预览。');
    if (playhead >= effectiveDuration() - 0.025) playhead = 0;
    playing = true; clockBase = playhead; clockStart = performance.now(); syncPreview(true); updateTransport();
    frame = requestAnimationFrame(tick);
  }
  function tick(now) {
    if (!playing || !connected()) return;
    playhead = Math.min(effectiveDuration(), clockBase + (now - clockStart) / 1000);
    syncPreview(); updateTransport();
    if (playhead >= effectiveDuration()) { pause(); return; }
    frame = requestAnimationFrame(tick);
  }
  function seek(value) {
    playhead = clamp(value, 0, effectiveDuration()); clockBase = playhead; clockStart = performance.now();
    syncPreview(true); updateTransport();
  }
  function updateTransport() {
    if (!connected()) return;
    const position = container.querySelector('[data-position]'); if (position) position.textContent = `${timecode(playhead)} / ${timecode(effectiveDuration())}`;
    const button = container.querySelector('[data-action="play"]'); if (button) { button.innerHTML = icon(playing ? 'pause' : 'play'); button.setAttribute('aria-label', playing ? '暂停' : '播放'); }
    const head = container.querySelector('.playhead'); if (head) { head.style.left = `${89 + (sourcePreview ? 0 : playhead) * pxPerSecond}px`; head.style.display = sourcePreview ? 'none' : ''; }
    const caption = container.querySelector('.preview-caption');
    if (caption) {
      const text = sourcePreview ? '' : data().captions.filter(item => playhead >= item.start && playhead < item.end).map(item => item.text).join('\n');
      caption.textContent = text; caption.classList.toggle('hidden', !text);
    }
    if (playing && !sourcePreview) {
      const scroll = container.querySelector('.timeline-scroll');
      if (scroll) { const x = 89 + playhead * pxPerSecond; if (x > scroll.scrollLeft + scroll.clientWidth - 55 || x < scroll.scrollLeft + 89) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.35); }
    }
  }
  function fitMonitor() {
    const stage = container?.querySelector('.monitor-stage'), canvas = container?.querySelector('.monitor-canvas');
    if (!stage || !canvas) return;
    const asset = sourcePreview && assetById(sourcePreview);
    const ratio = asset?.width && asset?.height ? asset.width / asset.height : ({ '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 })[data().aspect] || 16 / 9;
    const maxW = Math.max(80, stage.clientWidth - 50), maxH = Math.max(80, stage.clientHeight - 22);
    const width = Math.min(maxW, maxH * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${width / ratio}px`; canvas.style.aspectRatio = String(ratio);
  }
  function syncPreview(force = false) {
    if (!connected()) return;
    const current = clipAt(), video = container.querySelector('[data-preview-video]'), image = container.querySelector('[data-preview-image]'), audio = container.querySelector('[data-preview-audio]'), music = container.querySelector('[data-music-audio]'), placeholder = container.querySelector('.monitor-placeholder');
    if (!video || !image || !audio) return;
    const asset = current?.asset;
    const key = asset ? `${current.clip.id}:${asset.id}` : '';
    if (key !== activeMediaKey) {
      activeMediaKey = key; video.pause(); audio.pause();
      video.classList.add('hidden'); image.classList.add('hidden'); placeholder.classList.add('hidden');
      if (!asset) {
        video.removeAttribute('src'); audio.removeAttribute('src'); image.removeAttribute('src');
        placeholder.classList.remove('hidden'); placeholder.innerHTML = `${icon('animation')}<p>导入素材，或用 AI 生成动画画面。</p><span class="tiny">双击素材即可加入时间线</span>`;
      } else if (asset.type === 'image') {
        image.src = asset.url; image.classList.remove('hidden');
      } else if (asset.type === 'video') {
        video.src = asset.url; video.classList.remove('hidden'); video.load();
      } else {
        audio.src = asset.url; audio.load(); placeholder.classList.remove('hidden'); placeholder.innerHTML = `${icon('audio')}<p>${h(asset.name)}</p><span class="tiny">音频素材预览</span>`;
      }
      fitMonitor(); force = true;
    }
    const player = asset?.type === 'video' ? video : asset?.type === 'audio' ? audio : null;
    pendingMediaTime = current ? current.clip.start + current.local : 0;
    if (player) {
      player.volume = sourcePreview ? 1 : clamp(data().sourceVolume, 0, 1);
      if (player.readyState >= 1 && (force || Math.abs(player.currentTime - pendingMediaTime) > 0.3)) {
        try { player.currentTime = pendingMediaTime; } catch { /* Wait until metadata is loaded. */ }
      }
      if (playing && player.paused) void player.play().catch(() => {}); else if (!playing) player.pause();
    }
    const musicAsset = !sourcePreview && data().music?.assetId ? assetById(data().music.assetId) : null;
    if (musicAsset) {
      if (music.dataset.assetId !== musicAsset.id) { music.src = musicAsset.url; music.dataset.assetId = musicAsset.id; music.load(); }
      music.loop = true; music.volume = clamp(data().music.volume ?? 0.2, 0, 1);
      const target = playhead % Math.max(0.1, musicAsset.duration);
      if (music.readyState >= 1 && (force || Math.abs(music.currentTime - target) > 0.4)) try { music.currentTime = target; } catch { /* Metadata may still be loading. */ }
      if (playing && music.paused) void music.play().catch(() => {}); else if (!playing) music.pause();
    } else { music.pause(); music.dataset.assetId = ''; music.removeAttribute('src'); }
    const label = container.querySelector('[data-monitor-label]'); if (label) label.textContent = sourcePreview ? `素材预览 · ${asset?.name || ''}` : current ? `项目预览 · ${current.index + 1} / ${data().timeline.length}` : '项目预览';
    updateTransport();
  }

  function render() {
    if (!connected()) return;
    stopElements(); activeMediaKey = null;
    const status = runtime === null ? '检查媒体组件…' : runtime.ready ? '本地媒体组件就绪' : '媒体组件未就绪';
    container.innerHTML = `<section class="video-room">
      <header class="video-toolbar"><div class="row"><span class="pill">${icon('video')} EDIT</span><input class="video-project-name" data-field="title" value="${h(project.title || '未命名剪辑')}" aria-label="项目名称" maxlength="100"></div><div class="row wrap"><button class="btn small" data-action="ai-edit">${icon('spark')} AI 粗剪</button><button class="btn small olive" data-action="ai-animation">${icon('animation')} AI 动画</button><button class="btn small primary" data-action="export">${icon('download')} 导出视频</button></div></header>
      <div class="video-ai-strip">${icon('spark')}<span class="grow">AI 依据素材名称、时长与文案编排；动画用 Remotion 渲染成真实画面。</span><button class="btn small subtle" data-action="script">${icon('text')} 旁白脚本</button></div>
      <div class="video-upper"><aside class="media-panel"><div class="panel-caption"><span>项目素材 <span class="muted" data-media-count>${assets.length}</span></span><button class="icon-btn" data-action="refresh-assets" aria-label="刷新素材">${icon('refresh')}</button></div><div class="media-tools"><button class="btn small full" data-action="import" ${importing ? 'disabled' : ''}>${icon('plus')} ${importing ? '正在导入…' : '导入本地素材'}</button><input type="search" data-field="media-search" placeholder="搜索素材" value="${h(search)}" aria-label="搜索素材"><select data-field="media-filter" aria-label="素材类型"><option value="all">全部素材</option><option value="video" ${mediaFilter === 'video' ? 'selected' : ''}>视频</option><option value="image" ${mediaFilter === 'image' ? 'selected' : ''}>图片</option><option value="audio" ${mediaFilter === 'audio' ? 'selected' : ''}>音频</option></select></div><div class="media-list"></div></aside>
      <section class="monitor-panel"><div class="monitor-head"><span data-monitor-label>项目预览</span><span>${h(data().aspect)} · ${h(data().resolution)}P</span></div><div class="monitor-stage"><div class="monitor-canvas"><video data-preview-video playsinline preload="metadata" class="hidden"></video><img data-preview-image class="hidden" alt="图片素材预览"><audio data-preview-audio preload="metadata"></audio><audio data-music-audio preload="metadata"></audio><div class="monitor-placeholder"></div><div class="preview-caption hidden"></div></div></div><div class="monitor-controls"><span class="mono" data-position>00:00.0 / 00:00.0</span><div class="transport"><button class="icon-btn" data-action="start" aria-label="回到开头">${icon('back')}</button><button class="icon-btn" data-action="play" aria-label="播放">${icon('play')}</button><button class="icon-btn" data-action="project-preview" aria-label="查看项目时间线" title="查看项目时间线">${icon('layers')}</button></div><button class="btn small subtle" data-action="captions">${icon('text')} 字幕</button></div></section>
      <aside class="inspector-panel"><div class="panel-caption">片段与项目设置</div><div class="inspector-content"></div></aside></div>
      <section class="timeline-area"><div class="timeline-toolbar"><div class="row"><button class="btn small" data-action="undo" ${undo.length ? '' : 'disabled'} title="撤销 Ctrl+Z">${icon('undo')}</button><button class="btn small" data-action="split" ${data().timeline.length ? '' : 'disabled'}>${icon('cut')} 分割</button><button class="btn small" data-action="remove" ${selected ? '' : 'disabled'}>${icon('trash')} 删除</button><button class="btn small" data-action="move-left" ${selected ? '' : 'disabled'} aria-label="片段左移">${icon('back')}</button><button class="btn small" data-action="move-right" ${selected ? '' : 'disabled'} aria-label="片段右移">${icon('arrow')}</button></div><div class="range-inline"><span>缩放</span><input type="range" min="12" max="96" value="${pxPerSecond}" data-field="zoom" aria-label="时间线缩放"><span data-zoom-label>${pxPerSecond}px/s</span></div></div><div class="timeline-scroll"><div class="timeline-content"></div></div><div class="timeline-footer"><span data-runtime-status>${h(status)}</span><span>拖动排序 · 拖动片段边缘裁剪 · 空格播放</span></div></section>
    </section>`;
    renderMedia(); renderInspector(); renderTimeline();
    for (const player of container.querySelectorAll('[data-preview-video],[data-preview-audio]')) {
      player.onloadedmetadata = () => { if (!connected()) return; try { player.currentTime = pendingMediaTime; } catch {} if (playing) void player.play().catch(() => {}); };
      player.onerror = () => { if (player.getAttribute('src')) toast('当前素材编码无法预览。可转换为常见 MP4 后重新导入。', 'error'); };
    }
    resizeObserver?.disconnect(); resizeObserver = new ResizeObserver(fitMonitor); resizeObserver.observe(container.querySelector('.monitor-stage'));
    syncPreview(true);
  }
  function renderMedia() {
    const list = container?.querySelector('.media-list'); if (!list) return;
    const shown = assets.filter(asset => (mediaFilter === 'all' || asset.type === mediaFilter) && asset.name.toLowerCase().includes(search.toLowerCase()));
    list.innerHTML = shown.length ? shown.map(asset => `<div class="media-tile" tabindex="0" role="button" draggable="true" data-media-id="${h(asset.id)}" aria-label="预览 ${h(asset.name)}" title="单击预览，双击加入时间线"><div class="media-thumb">${asset.type === 'image' ? `<img src="${h(asset.url)}" loading="lazy" alt="">` : icon(asset.type === 'audio' ? 'audio' : 'video')}${asset.generated ? '<span class="generated-marker">REMOTION</span>' : ''}<span class="media-duration">${timecode(asset.duration)}</span></div><div class="media-name" style="padding-right:25px">${h(asset.name)}</div><button class="icon-btn" style="position:absolute;right:1px;bottom:0;min-width:25px;min-height:25px" data-action="add-media" data-id="${h(asset.id)}" aria-label="添加 ${h(asset.name)}">${icon('plus')}</button></div>`).join('') : `<div class="media-empty">${icon('folder')}<p>${assets.length ? '没有匹配的素材。' : '还没有素材。导入视频、图片或音频，也可以先生成一段 AI 动画。'}</p>${assets.length ? '' : '<button class="btn small" data-action="template">体验动画模板</button>'}</div>`;
    const count = container.querySelector('[data-media-count]'); if (count) count.textContent = assets.length;
  }
  function renderInspector() {
    const panel = container?.querySelector('.inspector-content'); if (!panel) return;
    const clip = data().timeline.find(item => item.id === selected), asset = clip ? assetById(clip.assetId) : assetById(sourcePreview);
    panel.innerHTML = `${clip && asset ? `<span class="eyebrow">SELECTED CLIP</span><h3 style="font-size:13px;line-height:1.8;margin:10px 0">${h(asset.name)}</h3><div class="form-grid"><div class="form-field"><label>入点 / 秒</label><input type="number" min="0" step="0.1" data-field="clip-start" value="${seconds(clip.start)}" ${asset.type === 'image' ? 'disabled' : ''}></div><div class="form-field"><label>${asset.type === 'image' ? '展示时长' : '出点'} / 秒</label><input type="number" min="0.1" step="0.1" data-field="clip-end" value="${seconds(clip.end)}"></div></div><p>片段时长 ${timecode(clip.end - clip.start)}<br>素材 ${asset.type === 'image' ? `${asset.width} × ${asset.height}` : timecode(asset.duration)}</p><button class="btn small full" data-action="remove">${icon('trash')} 移除此片段</button>` : asset ? `<span class="eyebrow">SOURCE MEDIA</span><h3 style="font-size:13px;margin-top:12px;line-height:1.8">${h(asset.name)}</h3><p>${TYPES[asset.type]} · ${timecode(asset.duration)}${asset.width ? `<br>${asset.width} × ${asset.height}` : ''}</p><button class="btn small full" data-action="add-media" data-id="${h(asset.id)}">${icon('plus')} ${asset.type === 'audio' ? '设为配乐' : '加入时间线'}</button>` : `<span class="eyebrow">INSPECTOR</span><p style="margin-top:12px">选择时间线中的片段，可调整入点、出点与顺序。</p>`}<hr class="video-divider"><div class="form-field"><label>项目画幅</label><select data-field="aspect">${['16:9', '9:16', '1:1'].map(value => `<option ${data().aspect === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="form-field"><label>导出分辨率</label><select data-field="resolution"><option value="720" ${data().resolution === '720' ? 'selected' : ''}>720P</option><option value="1080" ${data().resolution === '1080' ? 'selected' : ''}>1080P</option></select></div><div class="form-field"><label>原声音量 · ${Math.round(data().sourceVolume * 100)}%</label><input type="range" min="0" max="1" step="0.05" value="${data().sourceVolume}" data-field="source-volume"></div><button class="btn small full" data-action="music">${icon('audio')} ${data().music ? '调整配乐' : '添加配乐'}</button><p>${data().music ? `当前：${h(assetById(data().music.assetId)?.name || '素材不可用')}` : '配乐会循环覆盖时间线。'}</p><button class="btn small full" data-action="script">${icon('pen')} 编辑旁白脚本</button>`;
  }
  function renderTimeline() {
    const content = container?.querySelector('.timeline-content'), scroll = container?.querySelector('.timeline-scroll'); if (!content) return;
    const oldScroll = scroll.scrollLeft;
    const total = duration(), span = Math.max(30, total + 4, ((scroll.clientWidth || 1000) - 89) / pxPerSecond), width = span * pxPerSecond;
    const step = pxPerSecond >= 60 ? 1 : pxPerSecond >= 25 ? 5 : 10;
    const ticks = [];
    for (let value = 0; value <= span; value += step) ticks.push(`<span class="ruler-tick" style="left:${value * pxPerSecond}px">${timecode(value).slice(0, 5)}</span>`);
    content.style.width = `${width + 89}px`;
    content.innerHTML = `<div class="timeline-ruler" data-ruler>${ticks.join('')}</div><div class="track-row" data-track="video"><span class="track-label">${icon('video')} V1</span>${data().timeline.map((clip, index) => { const asset = assetById(clip.assetId); return `<div role="button" tabindex="0" draggable="true" class="timeline-clip ${selected === clip.id ? 'selected' : ''}" data-clip-id="${h(clip.id)}" style="width:${(clip.end - clip.start) * pxPerSecond}px;min-width:0" title="${h(asset?.name || '素材不可用')} · ${timecode(clip.end - clip.start)}"><b>${String(index + 1).padStart(2, '0')} ${h(asset?.name || '素材不可用')}</b><small>${timecode(clip.end - clip.start)}</small><i class="edge left" data-edge="left" aria-label="调整入点"></i><i class="edge right" data-edge="right" aria-label="调整出点"></i></div>`; }).join('')}${!data().timeline.length ? '<span class="track-placeholder">将素材拖到这里，或双击素材添加</span>' : ''}</div><div class="track-row audio-track" data-track="captions"><span class="track-label">${icon('text')} T1</span>${data().captions.map((caption, index) => `<button class="caption-block" style="left:${caption.start * pxPerSecond}px;width:${Math.max(6, (caption.end - caption.start) * pxPerSecond)}px" data-action="captions" data-caption-index="${index}" title="${h(caption.text)}">${h(caption.text)}</button>`).join('')}${!data().captions.length ? '<span class="track-placeholder">导入 SRT，或根据旁白脚本拟定字幕</span>' : ''}</div><div class="track-row audio-track" data-track="music"><span class="track-label">${icon('audio')} A1</span>${data().music ? `<button class="music-block" data-action="music" style="width:${Math.max(80, total * pxPerSecond)}px">${h(assetById(data().music.assetId)?.name || '配乐素材不可用')} · ${Math.round((data().music.volume ?? 0.2) * 100)}%</button>` : '<span class="track-placeholder">音频素材可拖入作为配乐</span>'}</div><div class="playhead"></div>`;
    scroll.scrollLeft = oldScroll; updateTransport();
  }

  async function refreshAssets(showNotice = false) {
    const currentEpoch = epoch;
    const [library, status] = await Promise.all([api('/api/video/assets'), api('/api/video/status')]);
    if (currentEpoch !== epoch || !connected()) return;
    assets = library.assets || []; runtime = status; renderMedia(); renderInspector(); renderTimeline(); syncPreview(true);
    const label = container.querySelector('[data-runtime-status]'); if (label) label.textContent = runtime.ready ? '本地媒体组件就绪' : '媒体组件未就绪，请使用完整桌面包';
    if (showNotice) toast('素材库已刷新');
  }
  async function importMedia(pathsInput) {
    if (importing) return;
    pause();
    if (!pathsInput && !window.desktopApi?.chooseMedia) {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
      input.accept = 'video/*,audio/*,image/png,image/jpeg,image/webp,image/bmp,.mkv,.mov,.avi,.flac'; input.hidden = true; document.body.append(input);
      input.onchange = async () => { const files = [...input.files]; input.remove(); try { if (files.length) await importFiles(files); } catch (error) { toast(error.message, 'error'); } };
      input.addEventListener('cancel', () => input.remove(), { once: true }); input.click(); return;
    }
    const selectedPaths = pathsInput || await window.desktopApi.chooseMedia();
    const paths = Array.isArray(selectedPaths) ? selectedPaths : selectedPaths?.paths || [];
    if (!paths.length) return;
    importing = true; const target = project, currentEpoch = epoch; render();
    try {
      let importedCount = 0;
      for (let index = 0; index < paths.length; index += 50) {
        const result = await api('/api/video/import-local', { paths: paths.slice(index, index + 50) });
        importedCount += result.assets?.length || 0;
        for (const asset of result.assets || []) { const old = assets.findIndex(item => item.id === asset.id); if (old >= 0) assets[old] = asset; else assets.push(asset); }
      }
      log(target, `导入 ${importedCount} 个素材`); persist(target); toast(`已导入 ${importedCount} 个素材`);
    } finally { importing = false; if (currentEpoch === epoch) render(); }
  }
  async function importFiles(filesInput) {
    if (importing) return;
    const files = Array.from(filesInput || []); if (!files.length) return;
    if (files.some(file => file.size > 2 * 1024 * 1024 * 1024)) throw new Error('单个媒体文件请小于 2 GB。');
    pause(); importing = true; const target = project, currentEpoch = epoch; render();
    let count = 0;
    try {
      for (const file of files) {
        const response = await fetch('/api/video/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `素材上传失败（${response.status}）。`);
        for (const asset of result.assets || []) { const old = assets.findIndex(item => item.id === asset.id); if (old >= 0) assets[old] = asset; else assets.push(asset); count++; }
      }
      log(target, `导入 ${count} 个本地素材`); persist(target); toast(`已导入 ${count} 个素材`);
    } catch (error) { if (count) toast(`已导入 ${count} 个素材，其余文件未完成。`); throw error; }
    finally { importing = false; if (currentEpoch === epoch) render(); }
  }
  function addAsset(id, index = data().timeline.length) {
    const asset = assetById(id); if (!asset) return toast('素材不存在，请刷新素材库。', 'error');
    if (asset.type === 'audio') { commit('设置配乐', video => { video.music = { assetId: id, volume: 0.2 }; }); return; }
    const clip = { id: uid(), assetId: id, start: 0, end: asset.type === 'image' ? 4 : asset.duration };
    commit('添加时间线片段', video => { video.timeline.splice(clamp(index, 0, video.timeline.length), 0, clip); selected = clip.id; });
    seek(offsetOf(clip.id));
  }
  function selectClip(id, seekTo = true) {
    pause(); sourcePreview = null; selected = id; if (seekTo) playhead = offsetOf(id);
    renderInspector(); renderTimeline(); syncPreview(true);
    for (const action of ['remove', 'move-left', 'move-right']) { const button = container.querySelector(`[data-action="${action}"]`); if (button) button.disabled = false; }
  }
  function removeClip() {
    if (!selected) return;
    commit('删除时间线片段', video => { video.timeline = video.timeline.filter(clip => clip.id !== selected); selected = null; });
  }
  function moveClip(delta) {
    const index = data().timeline.findIndex(clip => clip.id === selected), target = index + delta;
    if (index < 0 || target < 0 || target >= data().timeline.length) return;
    commit('调整片段顺序', video => { const [clip] = video.timeline.splice(index, 1); video.timeline.splice(target, 0, clip); });
    seek(offsetOf(selected));
  }
  function splitClip() {
    sourcePreview = null; const current = clipAt(); if (!current) return;
    const split = seconds(current.clip.start + current.local);
    if (split - current.clip.start < 0.05 || current.clip.end - split < 0.05) return toast('请将播放头移到片段内部再分割。');
    commit('在播放头处分割', video => {
      const original = video.timeline[current.index];
      const second = { ...original, id: uid(), start: split };
      if (current.asset?.type === 'image') { second.start = 0; second.end = seconds(original.end - split); original.end = seconds(split - original.start); original.start = 0; }
      else original.end = split;
      video.timeline.splice(current.index + 1, 0, second); selected = second.id;
    });
  }
  function trimSelected(field, value) {
    const clip = data().timeline.find(item => item.id === selected), asset = clip && assetById(clip.assetId); if (!clip || !asset) return;
    const start = field === 'clip-start' ? Number(value) : clip.start, end = field === 'clip-end' ? Number(value) : clip.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 0.05 || end > (asset.type === 'image' ? 120 : asset.duration) + 0.001 || (asset.type === 'image' && start !== 0)) { toast('入点、出点须在素材范围内，且片段至少保留 0.05 秒。', 'error'); renderInspector(); return; }
    commit('调整片段裁剪', () => { clip.start = seconds(start); clip.end = seconds(end); });
  }
  function beginTrim(event, edge) {
    const element = edge.closest('[data-clip-id]'), clip = data().timeline.find(item => item.id === element.dataset.clipId), asset = clip && assetById(clip.assetId); if (!clip || !asset) return;
    event.preventDefault(); event.stopPropagation(); pause(); sourcePreview = null; selected = clip.id;
    const before = clone(data()), initialX = event.clientX, original = { ...clip }, side = edge.dataset.edge;
    const move = e => {
      const delta = (e.clientX - initialX) / pxPerSecond;
      if (side === 'left' && asset.type !== 'image') clip.start = seconds(clamp(original.start + delta, 0, original.end - 0.05));
      else clip.end = seconds(clamp(original.end + (side === 'left' ? -delta : delta), original.start + 0.05, asset.type === 'image' ? 120 : asset.duration));
      renderTimeline(); renderInspector(); syncPreview(true);
    };
    let finished = false;
    const trimSignal = mountedEvents.signal;
    const end = () => {
      if (finished) return; finished = true;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
      trimSignal.removeEventListener('abort', end);
      if (original.start !== clip.start || original.end !== clip.end) { undo.push(before); if (undo.length > 40) undo.shift(); log(project, '拖动边缘裁剪片段'); persist(); }
      render();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, { once: true });
    trimSignal.addEventListener('abort', end, { once: true });
  }

  function wireEvents() {
    mountedEvents = new AbortController(); const options = { signal: mountedEvents.signal };
    container.addEventListener('click', event => {
      const action = event.target.closest('[data-action]');
      if (action) { event.stopPropagation(); Promise.resolve(handleAction(action.dataset.action, action)).catch(error => toast(error.message, 'error')); return; }
      const tile = event.target.closest('[data-media-id]');
      if (tile) { pause(); sourcePreview = tile.dataset.mediaId; selected = null; playhead = 0; renderInspector(); syncPreview(true); return; }
      const clip = event.target.closest('[data-clip-id]'); if (clip) selectClip(clip.dataset.clipId, false);
    }, options);
    container.addEventListener('dblclick', event => { const tile = event.target.closest('[data-media-id]'); if (tile && !event.target.closest('[data-action]')) addAsset(tile.dataset.mediaId); }, options);
    container.addEventListener('input', event => {
      if (event.target.dataset.field === 'zoom') { pxPerSecond = Number(event.target.value); container.querySelector('[data-zoom-label]').textContent = `${pxPerSecond}px/s`; renderTimeline(); }
      if (event.target.dataset.field === 'media-search') { search = event.target.value; renderMedia(); }
    }, options);
    container.addEventListener('change', event => {
      const field = event.target.dataset.field, value = event.target.value;
      if (field === 'title') { project.title = value.trim() || '未命名剪辑'; persist(); }
      else if (field === 'media-filter') { mediaFilter = value; renderMedia(); }
      else if (field === 'clip-start' || field === 'clip-end') trimSelected(field, value);
      else if (field === 'aspect' || field === 'resolution') commit('调整项目画面', video => { video[field] = value; });
      else if (field === 'source-volume') commit('调整原声音量', video => { video.sourceVolume = clamp(value, 0, 1); });
    }, options);
    container.addEventListener('pointerdown', event => {
      const edge = event.target.closest('[data-edge]'); if (edge) return beginTrim(event, edge);
      const ruler = event.target.closest('[data-ruler]');
      if (ruler) {
        pause(); sourcePreview = null;
        const update = e => seek((e.clientX - ruler.getBoundingClientRect().left) / pxPerSecond);
        update(event); const end = () => { window.removeEventListener('pointermove', update); window.removeEventListener('pointerup', end); };
        window.addEventListener('pointermove', update); window.addEventListener('pointerup', end, { once: true }); mountedEvents.signal.addEventListener('abort', end, { once: true });
      }
    }, options);
    container.addEventListener('dragstart', event => {
      const tile = event.target.closest('[data-media-id]'), clip = event.target.closest('[data-clip-id]');
      if (event.target.closest('[data-edge]')) return event.preventDefault();
      if (tile) event.dataTransfer.setData('application/x-guangxuan-media', tile.dataset.mediaId);
      else if (clip) event.dataTransfer.setData('application/x-guangxuan-clip', clip.dataset.clipId);
      event.dataTransfer.effectAllowed = 'copyMove';
    }, options);
    container.addEventListener('dragover', event => { if (event.target.closest('.timeline-area')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }, options);
    container.addEventListener('drop', event => {
      if (!event.target.closest('.timeline-area')) return;
      event.preventDefault();
      const assetId = event.dataTransfer.getData('application/x-guangxuan-media'), clipId = event.dataTransfer.getData('application/x-guangxuan-clip');
      const over = event.target.closest('[data-clip-id]'); let index = over ? data().timeline.findIndex(clip => clip.id === over.dataset.clipId) : data().timeline.length;
      if (over && event.clientX > over.getBoundingClientRect().left + over.clientWidth / 2) index++;
      if (assetId) return addAsset(assetId, index);
      if (clipId) {
        const old = data().timeline.findIndex(clip => clip.id === clipId); if (old < 0) return;
        if (old < index) index--;
        if (old !== index) commit('拖动调整片段顺序', video => { const [clip] = video.timeline.splice(old, 1); video.timeline.splice(index, 0, clip); selected = clip.id; });
      } else if (event.dataTransfer.files.length) void importFiles(event.dataTransfer.files).catch(error => toast(error.message, 'error'));
    }, options);
    document.addEventListener('keydown', event => {
      if (!connected() || document.querySelector('#modal-root')?.childElementCount || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
      if (event.code === 'Space') { event.preventDefault(); playing ? pause() : play(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoChange(); }
      else if (event.key === 'Delete') removeClip();
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(playhead - 1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seek(playhead + 1); }
    }, options);
  }
  async function handleAction(action, button) {
    if (action === 'import') return importMedia();
    if (action === 'refresh-assets') return refreshAssets(true);
    if (action === 'add-media') return addAsset(button.dataset.id);
    if (action === 'play') return playing ? pause() : play();
    if (action === 'start') { pause(); seek(0); return; }
    if (action === 'project-preview') { pause(); sourcePreview = null; playhead = 0; syncPreview(true); return; }
    if (action === 'undo') return undoChange();
    if (action === 'remove') return removeClip();
    if (action === 'move-left') return moveClip(-1);
    if (action === 'move-right') return moveClip(1);
    if (action === 'split') return splitClip();
    if (action === 'captions') return captionsDialog(Number(button.dataset.captionIndex) || 0);
    if (action === 'music') return musicDialog();
    if (action === 'script') return scriptDialog();
    if (action === 'ai-edit') return editDialog();
    if (action === 'ai-animation') return animationDialog(false);
    if (action === 'template') return animationDialog(true);
    if (action === 'export') return exportDialog();
  }

  function dialog(options) {
    modalCloser?.();
    const close = showModal({ ...options, onMount: (root, closeModal) => options.onMount?.(root.querySelector('.modal'), closeModal), onClose: () => { if (modalCloser === close) modalCloser = null; options.onClose?.(); } });
    modalCloser = close; return close;
  }
  function scriptDialog() {
    pause();
    dialog({ title: '旁白与剪辑脚本', body: `<p class="small muted">AI 粗剪会结合这份文案和素材信息编排片段。字幕时间需要在时间线中检查。</p><div class="form-field"><label>旁白 / 剪辑说明</label><textarea data-script rows="12" maxlength="30000" placeholder="粘贴旁白、讲解提纲或活动脚本…">${h(data().script)}</textarea></div><div class="modal-actions"><button class="btn" data-writing>${icon('pen')} 打开文案工作台</button><button class="btn primary" data-save>保存脚本</button></div>`, onMount: (root, close) => {
      root.querySelector('[data-save]').onclick = () => { const text = root.querySelector('[data-script]').value; commit('更新旁白脚本', video => { video.script = text; }); close(); toast('脚本已保存'); };
      root.querySelector('[data-writing]').onclick = () => { const text = root.querySelector('[data-script]').value; commit('更新旁白脚本', video => { video.script = text; }); close(); onWriting?.(); };
    } });
  }
  function applyScript(videoScript, sourceTitle) {
    const shots = Array.isArray(videoScript?.shots) ? videoScript.shots : null;
    let captions = [], script;
    if (shots) {
      let cursor = 0;
      for (const shot of shots) {
        const length = Math.max(0.5, Number(shot.duration) || 5), text = String(shot.caption || shot.narration || '').trim();
        if (text) captions.push({ start: seconds(cursor), end: seconds(cursor + length), text });
        cursor += length;
      }
      script = shots.map(shot => shot.narration || shot.caption || '').join('\n');
    } else script = typeof videoScript === 'string' ? videoScript : videoScript?.text || '';
    commit('接收文案工作台分镜', video => { video.script = script; if (shots) { video.captions = captions; video.captionSource = 'script-draft'; } });
    if (sourceTitle && (!project.title || /未命名|新建剪辑/.test(project.title))) { project.title = `${sourceTitle} · 视频`; persist(); render(); }
    toast(shots ? '分镜和拟定字幕已接收，请核对画面与字幕时间。' : '旁白脚本已接收。');
  }
  function parseSrt(text) {
    const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
    const result = [];
    const parse = parts => Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(String(parts[3] || '0').padEnd(3, '0')) / 1000;
    for (const block of blocks) {
      const lines = block.split('\n'); const index = lines.findIndex(line => line.includes('-->')); if (index < 0) continue;
      const match = lines[index].match(/(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/);
      if (!match) throw new Error('SRT 时间格式无法识别，请使用 00:00:01,000 --> 00:00:03,000。');
      const start = parse(match.slice(1, 5)), end = parse(match.slice(5, 9)), content = lines.slice(index + 1).join('\n').replace(/<\/?(?:i|b|u)>/gi, '').trim();
      if (content && end > start) result.push({ start, end, text: content });
    }
    if (!result.length) throw new Error('没有读取到有效字幕，请检查 SRT 文件。');
    if (result.length > 2000) throw new Error('字幕超过 2000 条，请拆分后导入。');
    return result.sort((a, b) => a.start - b.start);
  }
  function srtTime(value) {
    const ms = Math.max(0, Math.round(value * 1000));
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  }
  function captionsDialog(focusIndex = 0) {
    pause(); let draft = clone(data().captions), source = data().captionSource || 'manual';
    dialog({ title: '字幕编辑', wide: true, body: `<div class="row spread wrap"><p class="small muted grow">时间以项目时间线为准，单位为秒。导入 SRT 保留原有时间；脚本拟定的时间需手动核对。</p><button class="btn small" data-import-srt>${icon('upload')} 导入 SRT</button><input type="file" accept=".srt" data-srt-file hidden></div><div class="row wrap" style="margin-bottom:15px"><button class="btn small" data-add-caption>${icon('plus')} 添加字幕</button><button class="btn small" data-draft-caption>${icon('text')} 按脚本拟定</button><button class="btn small" data-trim-caption>裁至时间线</button><span class="small muted">时间线 ${timecode(duration())}</span></div><div data-caption-list style="max-height:430px;overflow:auto"></div><div data-caption-error class="notice error hidden"></div><div class="modal-actions"><button class="btn" data-export-srt>${icon('download')} 导出 SRT</button><button class="btn primary" data-save-captions>保存字幕</button></div>`, onMount: (root, close) => {
      const list = root.querySelector('[data-caption-list]');
      const read = () => { draft = [...list.querySelectorAll('[data-caption-row]')].map(row => ({ start: Number(row.querySelector('[data-start]').value), end: Number(row.querySelector('[data-end]').value), text: row.querySelector('[data-text]').value.trim() })); };
      const renderRows = () => { list.innerHTML = draft.length ? `<div class="caption-editor-row muted tiny"><span>开始</span><span>结束</span><span>字幕文字</span></div>${draft.map((caption, index) => `<div class="caption-editor-row" data-caption-row><input type="number" min="0" step="0.1" data-start value="${seconds(caption.start)}" aria-label="第${index + 1}条开始时间"><input type="number" min="0" step="0.1" data-end value="${seconds(caption.end)}" aria-label="第${index + 1}条结束时间"><textarea rows="1" data-text style="min-height:33px;padding:6px;font-size:12px" maxlength="1000" aria-label="第${index + 1}条字幕">${h(caption.text)}</textarea><button class="icon-btn" data-remove-caption="${index}" aria-label="删除第${index + 1}条字幕">${icon('close')}</button></div>`).join('')}` : '<div class="empty-state"><p>添加一条字幕，或导入已有 SRT 文件。</p></div>'; };
      const validate = () => {
        if (draft.some(item => !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || !item.text || item.text.length > 1000)) throw new Error('每条字幕需要有效起止时间和非空文字，结束时间须晚于开始时间。');
        draft.sort((a, b) => a.start - b.start);
      };
      const report = error => { const box = root.querySelector('[data-caption-error]'); box.textContent = error.message; box.classList.remove('hidden'); };
      renderRows();
      list.querySelectorAll('[data-caption-row]')[focusIndex]?.scrollIntoView({ block: 'nearest' });
      list.onclick = event => { const button = event.target.closest('[data-remove-caption]'); if (button) { read(); draft.splice(Number(button.dataset.removeCaption), 1); renderRows(); } };
      root.querySelector('[data-add-caption]').onclick = () => { read(); const start = seconds(Math.min(playhead, Math.max(0, duration() - 1))); draft.push({ start, end: seconds(start + 3), text: '' }); source = 'manual'; renderRows(); list.lastElementChild?.scrollIntoView({ block: 'nearest' }); };
      root.querySelector('[data-import-srt]').onclick = () => root.querySelector('[data-srt-file]').click();
      root.querySelector('[data-srt-file]').onchange = async event => {
        try { const file = event.target.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) throw new Error('SRT 文件请小于 2 MB。'); draft = parseSrt(await file.text()); source = 'srt-import'; renderRows(); toast(`已读取 ${draft.length} 条字幕，点击保存后应用。`); } catch (error) { report(error); }
      };
      root.querySelector('[data-draft-caption]').onclick = () => {
        const paragraphs = String(data().script || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
        if (!paragraphs.length) return report(new Error('请先在旁白脚本中填写文字。'));
        const parts = paragraphs.flatMap(line => { const chars = Array.from(line), lines = []; for (let index = 0; index < chars.length; index += 38) lines.push(chars.slice(index, index + 38).join('')); return lines; });
        if (parts.length > 200) return report(new Error('脚本过长，请先缩短为不超过 200 个字幕段落。'));
        const total = duration() || Math.max(15, parts.length * 4), weight = parts.reduce((sum, part) => sum + part.length, 0);
        let offset = 0; draft = parts.map(text => { const start = offset; offset += total * text.length / weight; return { start: seconds(start), end: seconds(offset), text }; }); source = 'script-draft'; renderRows(); toast('已按文字长度拟定字幕时间，请人工检查。');
      };
      root.querySelector('[data-trim-caption]').onclick = () => { read(); const total = duration(); if (!total) return report(new Error('先将素材加入时间线。')); draft = draft.filter(item => item.start < total && item.end > 0).map(item => ({ ...item, start: Math.max(0, item.start), end: Math.min(total, item.end) })).filter(item => item.end > item.start); renderRows(); };
      root.querySelector('[data-save-captions]').onclick = () => { try { read(); validate(); commit('更新字幕', video => { video.captions = draft; video.captionSource = source; }); close(); toast(`已保存 ${draft.length} 条字幕`); } catch (error) { report(error); } };
      root.querySelector('[data-export-srt]').onclick = async () => { try { read(); validate(); const content = draft.map((item, index) => `${index + 1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${item.text}`).join('\n\n'); await saveFile(`${safeName(project.title)}.srt`, content); } catch (error) { report(error); } };
    } });
  }
  function musicDialog() {
    pause(); const choices = assets.filter(asset => asset.hasAudio), current = data().music;
    let previewAudio = null;
    dialog({ title: '配乐与混音', body: `<p class="small muted">配乐从时间线开头播放，长度不足时循环。可与素材原声混合。</p><div class="form-field"><label>音频来源</label><select data-music-select><option value="">不使用配乐</option>${choices.map(asset => `<option value="${h(asset.id)}" ${asset.id === current?.assetId ? 'selected' : ''}>${h(asset.name)} · ${timecode(asset.duration)}</option>`).join('')}</select></div><audio controls data-music-preview style="width:100%;height:38px" ${current ? `src="${h(assetById(current.assetId)?.url || '')}"` : ''}></audio><div class="form-field" style="margin-top:20px"><label>配乐音量 <span data-volume-label>${Math.round((current?.volume ?? 0.2) * 100)}%</span></label><input type="range" min="0" max="1" step="0.05" value="${current?.volume ?? 0.2}" data-music-volume></div><div class="modal-actions"><button class="btn" data-import-audio>${icon('upload')} 导入音频</button><button class="btn primary" data-save-music>应用配乐</button></div>`, onClose: () => previewAudio?.pause(), onMount: (root, close) => {
      previewAudio = root.querySelector('[data-music-preview]');
      root.querySelector('[data-music-select]').onchange = event => { previewAudio.pause(); const asset = assetById(event.target.value); if (asset) { previewAudio.src = asset.url; previewAudio.load(); } else previewAudio.removeAttribute('src'); };
      root.querySelector('[data-music-volume]').oninput = event => { root.querySelector('[data-volume-label]').textContent = `${Math.round(event.target.value * 100)}%`; previewAudio.volume = Number(event.target.value); };
      root.querySelector('[data-save-music]').onclick = () => { const assetId = root.querySelector('[data-music-select]').value, volume = Number(root.querySelector('[data-music-volume]').value); commit('调整背景配乐', video => { video.music = assetId ? { assetId, volume } : null; }); close(); };
      root.querySelector('[data-import-audio]').onclick = async () => { close(); try { await importMedia(); if (connected()) musicDialog(); } catch (error) { toast(error.message, 'error'); } };
    } });
  }
  function editDialog() {
    pause(); const visualAssets = assets.filter(asset => asset.type !== 'audio');
    if (!visualAssets.length) return dialog({ title: '先准备画面素材', body: `<p>AI 粗剪需要已导入的视频或图片。你可以导入本地素材，也可以生成一段 Remotion 动画。</p><div class="modal-actions"><button class="btn" data-import>${icon('upload')} 导入素材</button><button class="btn primary" data-animation>${icon('animation')} AI 动画</button></div>`, onMount: (root, close) => { root.querySelector('[data-import]').onclick = async () => { close(); try { await importMedia(); } catch (error) { toast(error.message, 'error'); } }; root.querySelector('[data-animation]').onclick = () => { close(); animationDialog(false); }; } });
    const target = project; let plan = clone(data().lastEditPlan || null), pending = false;
    dialog({ title: 'AI 粗剪', wide: true, body: `<p class="small muted">根据素材名称、时长与旁白脚本安排片段。AI 未识别实际画面和语音，应用前请核对。</p><div class="form-field"><label>剪辑要求</label><textarea data-edit-instruction rows="3" maxlength="6000" placeholder="例如：做成节奏清楚的活动预告，先介绍主题，再展示活动亮点，最后留下参与信息。">${h(data().lastEditInstruction || '')}</textarea></div><div class="form-grid"><div class="form-field"><label>目标时长 / 秒</label><input type="number" data-edit-duration min="5" max="3600" value="${Math.min(90, Math.max(15, Math.round(duration()) || 30))}"></div><div class="form-field"><label>当前输入</label><p class="small muted">${visualAssets.length} 个画面素材 · ${data().script.length} 字脚本<br>旁白可在主界面右侧编辑</p></div></div><button class="btn primary" data-generate-edit>${icon('spark')} 生成剪辑建议</button><div data-edit-result style="margin-top:20px"></div><div data-edit-error class="notice error hidden"></div><div class="modal-actions"><button class="btn" data-close-edit>关闭</button><button class="btn olive" data-apply-edit ${plan ? '' : 'disabled'}>应用到时间线，可撤销</button></div>`, onMount: (root, close) => {
      const display = () => { root.querySelector('[data-edit-result]').innerHTML = plan ? `<div class="animation-plan-header"><strong>${h(plan.title)}</strong><p class="small" style="margin:10px 0 0">${h(plan.summary)}</p></div><div style="max-height:270px;overflow:auto">${plan.timeline.map((clip, index) => `<div class="history-row"><span>${String(index + 1).padStart(2, '0')} · ${h(assetById(clip.assetId)?.name || clip.assetId)}<br><span class="muted">${h(clip.reason || '')}</span></span><span class="mono">${timecode(clip.start)}–${timecode(clip.end)}</span></div>`).join('')}</div><p class="small muted">拟定 ${plan.captions.length} 条字幕。${h((plan.warnings || []).join(' '))}</p>` : ''; root.querySelector('[data-apply-edit]').disabled = !plan || pending; };
      display(); root.querySelector('[data-close-edit]').onclick = close;
      root.querySelector('[data-generate-edit]').onclick = async event => {
        if (pending) return; if (!requireConnection()) return close();
        const instruction = root.querySelector('[data-edit-instruction]').value.trim() || '根据已有素材与脚本编排一段清楚、紧凑的宣传短片。';
        const preferred = [...new Set([...target.video.timeline.map(clip => clip.assetId), ...visualAssets.map(asset => asset.id)])].map(assetById).filter(Boolean).filter(asset => asset.type !== 'audio').slice(0, 100);
        pending = true; event.currentTarget.disabled = true; event.currentTarget.innerHTML = '<span class="spinner"></span> 正在生成建议…'; root.querySelector('[data-edit-error]').classList.add('hidden'); display();
        try {
          const result = await callAi('edit-plan', { instruction, script: target.video.script || '', assets: preferred.map(({ id, name, type, duration, width, height }) => ({ id, name, type, duration, width, height })), timeline: target.video.timeline.map(({ assetId, start, end }) => ({ assetId, start, end })), durationTarget: Number(root.querySelector('[data-edit-duration]').value) });
          plan = result.data; target.video.lastEditPlan = clone(plan); target.video.lastEditInstruction = instruction; rememberRun(target, 'edit-plan', result, '生成 AI 剪辑建议');
        } catch (error) { if (root.isConnected) { const box = root.querySelector('[data-edit-error]'); box.textContent = error.message; box.classList.remove('hidden'); } }
        finally { pending = false; if (root.isConnected) { const button = root.querySelector('[data-generate-edit]'); button.disabled = false; button.innerHTML = `${icon('spark')} 重新生成建议`; display(); } }
      };
      root.querySelector('[data-apply-edit]').onclick = () => {
        if (!plan || project !== target) return;
        commit('应用 AI 剪辑建议', video => { video.timeline = plan.timeline.map(clip => ({ id: uid(), assetId: clip.assetId, start: clip.start, end: clip.end })); video.captions = clone(plan.captions); video.captionSource = 'ai-draft'; selected = video.timeline[0]?.id || null; });
        playhead = 0; syncPreview(true); close(); toast('剪辑建议已应用，可用撤销恢复原时间线。');
      };
    } });
  }

  function jobMarkup(job, kind) {
    if (!job) return '';
    const finished = job.status === 'complete', failed = job.status === 'error';
    const progress = Math.round(clamp(job.progress, 0, 1) * 100);
    return `<div class="job-box"><div class="row spread"><strong>${failed ? '处理未完成' : finished ? '处理完成' : job.status === 'queued' ? '任务已排队' : '正在处理'}</strong><span class="mono">${failed ? '' : `${progress}%`}</span></div>${!failed ? `<div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>` : ''}<p class="small muted" style="margin:12px 0 0">${failed ? h(job.error || '任务未完成，请重试。') : finished ? `${job.width || ''}${job.width ? ' × ' : ''}${job.height || ''}${job.duration ? ` · ${timecode(job.duration)}` : ''} · MP4` : '进度来自本地渲染任务；可关闭此窗口，稍后回来查看。'}</p>${finished ? `<div class="row wrap" style="margin-top:15px">${kind === 'animation' && job.asset ? `<button class="btn small olive" data-add-rendered>${icon('plus')} 加入时间线</button>` : ''}<button class="btn small" data-save-rendered>${icon('download')} 保存 MP4</button></div>` : ''}${failed ? '<button class="btn small" style="margin-top:14px" data-retry-render>重试当前任务</button>' : ''}</div>`;
  }
  function watchJob(target, field, jobId, { onUpdate, onComplete, onError, alive = () => true } = {}) {
    let stopped = false, timer = null, wake = null, controller = null;
    const stop = () => { if (stopped) return; stopped = true; clearTimeout(timer); wake?.(); controller?.abort(); polls.delete(stop); };
    polls.add(stop);
    void (async () => {
      try {
        while (!stopped && alive()) {
          controller = new AbortController();
          const job = await api(`/api/video/jobs/${encodeURIComponent(jobId)}`, undefined, { signal: controller.signal });
          if (stopped) return;
          target.video[field] = { ...target.video[field], ...job }; onUpdate?.(job);
          if (job.status === 'complete') {
            if (job.asset) { const index = assets.findIndex(asset => asset.id === job.asset.id); if (index < 0) assets.push(job.asset); else assets[index] = job.asset; }
            log(target, field === 'lastAnimationJob' ? 'Remotion 动画渲染完成' : '视频导出完成'); persist(target, true); onComplete?.(job); break;
          }
          if (job.status === 'error') { persist(target, true); onError?.(new Error(job.error || '渲染失败，请重试。')); break; }
          await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 900); }); wake = null;
        }
      } catch (error) {
        if (!stopped && error.name !== 'AbortError') { target.video[field] = { ...target.video[field], jobId, status: 'error', error: error.message }; persist(target, true); onUpdate?.(target.video[field]); onError?.(error); }
      } finally { polls.delete(stop); clearTimeout(timer); }
    })();
    return stop;
  }
  async function saveJob(job, name) {
    if (!job?.exportId || job.status !== 'complete') throw new Error('任务尚未完成。');
    if (window.desktopApi?.saveExport) {
      const result = await window.desktopApi.saveExport({ exportId: job.exportId, name: `${safeName(name)}.mp4` });
      if (!result?.canceled) toast('MP4 已保存'); return;
    }
    const anchor = document.createElement('a'); anchor.href = job.downloadUrl || `/api/video/exports/${encodeURIComponent(job.exportId)}/file`; anchor.download = `${safeName(name)}.mp4`; anchor.click();
  }
  function presetAnimation() {
    return { title: '光宣动画示例', aspect: data().aspect, fps: 30, theme: 'paper', scenes: [
      { type: 'title', duration: 5, title: '从一份素材开始', subtitle: '清楚表达每一个重要信息' },
      { type: 'steps', duration: 7, title: '内容制作流程', items: ['确认关键信息', '组织内容结构', '检查并导出'] },
      { type: 'outro', duration: 4, title: '让好内容被看见', subtitle: '光宣工作台 · 预置动画示例' },
    ] };
  }
  function animationDialog(useTemplate) {
    pause(); const target = project;
    let plan = useTemplate ? presetAnimation() : clone(data().animationPlan || null), origin = useTemplate ? 'preset' : data().animationOrigin || 'ai';
    let busy = false, stopWatch = null, job = useTemplate ? null : clone(data().lastAnimationJob || null);
    dialog({ title: useTemplate ? '体验 Remotion 动画模板' : 'AI 动画画面', wide: true, onClose: () => stopWatch?.(), body: `<p class="small muted">AI 先组织场景，你可以修改文字和时长，再由 Remotion 渲染成 MP4，加入剪辑素材库。</p>${useTemplate ? '<div class="notice">这是可编辑的预置示例，不调用模型。点击“渲染动画”体验完整流程。</div>' : ''}<div class="form-field"><label>动画要求</label><textarea data-animation-instruction rows="3" maxlength="10000" placeholder="例如：做一段介绍学院活动的动画，先展示主题，再用三个步骤讲清参与方式，最后给出邀请。">${h(useTemplate ? '体验一份素材的内容制作流程动画。' : data().animationInstruction || '')}</textarea></div><div class="form-grid"><div class="form-field"><label>目标时长 / 秒</label><input type="number" min="3" max="90" value="${plan ? seconds(plan.scenes.reduce((sum, scene) => sum + scene.duration, 0)) : 30}" data-animation-duration></div><div class="form-field"><label>画幅</label><select data-animation-aspect>${['16:9', '9:16', '1:1'].map(value => `<option ${value === (plan?.aspect || data().aspect) ? 'selected' : ''}>${value}</option>`).join('')}</select></div></div><div class="row spread wrap" style="margin-bottom:18px"><div class="form-field" style="min-width:180px;margin:0"><label>视觉主题</label><select data-animation-theme><option value="paper" ${plan?.theme !== 'dark' ? 'selected' : ''}>纸感浅色</option><option value="dark" ${plan?.theme === 'dark' ? 'selected' : ''}>深色舞台</option></select></div><span class="small muted">使用旁白脚本 ${target.video.script.length} 字</span><button class="btn primary" data-generate-animation>${icon('spark')} ${plan ? 'AI 重新编排' : 'AI 生成场景'}</button></div><div data-animation-error class="notice error hidden"></div><div data-animation-editor></div><div data-animation-job></div><div class="modal-actions"><button class="btn" data-save-plan ${plan ? '' : 'disabled'}>${icon('file')} 保存方案</button><button class="btn olive" data-render-animation ${plan ? '' : 'disabled'}>${icon('play')} 渲染动画</button></div>`, onMount: (root, close) => {
      const editor = root.querySelector('[data-animation-editor]'), errorBox = root.querySelector('[data-animation-error]');
      const report = error => { if (!root.isConnected) return; errorBox.textContent = error.message; errorBox.classList.remove('hidden'); };
      const renderEditor = () => {
        editor.innerHTML = plan ? `<div class="animation-plan-header"><div class="row spread"><strong>${origin === 'preset' ? '预置方案' : '场景方案'}</strong><span class="pill">${plan.scenes.length} 场 · ${seconds(plan.scenes.reduce((sum, scene) => sum + scene.duration, 0))} 秒</span></div><input data-plan-title maxlength="80" style="margin-top:13px;width:100%" value="${h(plan.title)}" aria-label="动画标题"></div><div class="animation-scenes">${plan.scenes.map((scene, index) => `<section class="animation-scene" data-animation-scene="${index}"><div class="row spread"><span class="small">${String(index + 1).padStart(2, '0')} · ${SCENES[scene.type] || scene.type}</span><label class="small">时长 <input type="number" min="3" max="12" step="0.5" value="${scene.duration}" data-scene-duration style="width:62px;margin:0 3px"> 秒</label></div><input data-scene-title maxlength="40" value="${h(scene.title)}" placeholder="场景标题" aria-label="第${index + 1}场标题"><input data-scene-subtitle maxlength="100" value="${h(scene.subtitle || '')}" placeholder="补充说明（可选）" aria-label="第${index + 1}场副标题">${scene.items ? `<textarea data-scene-items rows="${Math.max(2, scene.items.length)}" placeholder="每行一个要点，最多五项">${h(scene.items.join('\n'))}</textarea>` : ''}${scene.type === 'bars' ? `<div style="margin-top:12px">${(scene.data || []).map(item => `<div class="form-grid" data-chart-row style="gap:8px"><input data-chart-label maxlength="24" value="${h(item.label)}" aria-label="数据名称"><input type="number" min="0" data-chart-value value="${item.value}" aria-label="数据数值"></div>`).join('')}<span class="tiny muted">数值需有真实依据。</span></div>` : ''}${scene.note ? `<input data-scene-note maxlength="180" value="${h(scene.note)}" placeholder="补充说明">` : ''}</section>`).join('')}</div>` : '<div class="empty-state"><p>描述需要表达的内容，AI 会生成可编辑场景。</p><button class="btn small" data-use-preset>先体验预置模板</button></div>';
        const running = job && !['complete', 'error'].includes(job.status);
        root.querySelector('[data-save-plan]').disabled = !plan || busy;
        root.querySelector('[data-render-animation]').disabled = !plan || busy || Boolean(running);
        editor.querySelector('[data-use-preset]')?.addEventListener('click', () => { plan = presetAnimation(); origin = 'preset'; job = null; renderEditor(); toast('已载入预置模板，不调用模型。'); });
      };
      const readPlan = () => {
        if (!plan) throw new Error('请先生成场景或选择预置模板。');
        const next = clone(plan); next.title = root.querySelector('[data-plan-title]').value.trim(); next.aspect = root.querySelector('[data-animation-aspect]').value; next.theme = root.querySelector('[data-animation-theme]').value; next.fps = 30;
        next.scenes = [...editor.querySelectorAll('[data-animation-scene]')].map((row, index) => {
          const scene = { ...next.scenes[index], title: row.querySelector('[data-scene-title]').value.trim(), subtitle: row.querySelector('[data-scene-subtitle]').value.trim(), duration: Number(row.querySelector('[data-scene-duration]').value) };
          if (!scene.title || !Number.isFinite(scene.duration) || scene.duration < 3 || scene.duration > 12) throw new Error('每个场景需要标题，时长为 3—12 秒。');
          if (row.querySelector('[data-scene-items]')) { scene.items = row.querySelector('[data-scene-items]').value.split('\n').map(text => text.trim()).filter(Boolean); if (!scene.items.length || scene.items.length > 5 || scene.items.some(text => text.length > 50)) throw new Error('每场最多五个要点，每项不超过 50 字。'); }
          if (scene.type === 'bars') { scene.data = [...row.querySelectorAll('[data-chart-row]')].map(item => ({ label: item.querySelector('[data-chart-label]').value.trim(), value: Number(item.querySelector('[data-chart-value]').value) })); if (!scene.data.length || scene.data.some(item => !item.label || !Number.isFinite(item.value) || item.value < 0)) throw new Error('请检查图表标签与非负数值。'); }
          if (row.querySelector('[data-scene-note]')) scene.note = row.querySelector('[data-scene-note]').value.trim();
          return scene;
        });
        if (!next.title || !next.scenes.length || next.scenes.length > 8 || next.scenes.reduce((sum, scene) => sum + scene.duration, 0) > 90) throw new Error('动画需要标题，最多八场，总时长不超过 90 秒。');
        return next;
      };
      const storePlan = () => { plan = readPlan(); target.video.animationPlan = clone(plan); target.video.animationOrigin = origin; target.video.animationInstruction = root.querySelector('[data-animation-instruction]').value; persist(target); };
      const updateJob = next => { job = { ...job, ...next }; if (!root.isConnected) return; root.querySelector('[data-animation-job]').innerHTML = jobMarkup(job, 'animation'); root.querySelector('[data-render-animation]').disabled = !plan || busy || !['complete', 'error'].includes(job.status); };
      const beginWatch = () => { if (!root.isConnected) return; stopWatch?.(); stopWatch = watchJob(target, 'lastAnimationJob', job.jobId, { alive: () => root.isConnected, onUpdate: updateJob, onComplete: completed => { updateJob(completed); if (connected()) { renderMedia(); renderInspector(); } toast('Remotion 动画已生成，可加入时间线。'); }, onError: report }); };
      const renderAnimation = async () => {
        try {
          storePlan(); errorBox.classList.add('hidden');
          const result = await api('/api/video/render-animation', { plan, prompt: target.video.animationInstruction || '', model: origin === 'preset' ? 'preset-template' : target.video.animationModel || getSettings().model || '' });
          job = { jobId: result.jobId, status: 'queued', progress: 0, title: plan.title, createdAt: new Date().toISOString() }; target.video.lastAnimationJob = clone(job); log(target, origin === 'preset' ? '开始渲染预置动画' : '开始渲染 AI 动画'); persist(target, true); updateJob(job); beginWatch();
        } catch (error) { report(error); }
      };
      renderEditor(); if (job) { updateJob(job); if (!['complete', 'error'].includes(job.status)) beginWatch(); }
      root.querySelector('[data-generate-animation]').onclick = async event => {
        if (busy) return; if (!requireConnection()) return close();
        const instruction = root.querySelector('[data-animation-instruction]').value.trim();
        if (!instruction && !target.video.script.trim()) return report(new Error('请填写动画要求，或先准备旁白脚本。'));
        const payload = { instruction, script: target.video.script, aspect: root.querySelector('[data-animation-aspect]').value, theme: root.querySelector('[data-animation-theme]').value, durationTarget: Number(root.querySelector('[data-animation-duration]').value) };
        busy = true; event.currentTarget.disabled = true; event.currentTarget.innerHTML = '<span class="spinner"></span> 正在组织场景…'; errorBox.classList.add('hidden');
        try {
          const result = await callAi('animation-plan', payload); plan = result.data; origin = 'ai'; target.video.animationPlan = clone(plan); target.video.animationOrigin = origin; target.video.animationInstruction = instruction; target.video.animationModel = result.meta?.model || getSettings().model; rememberRun(target, 'animation-plan', result, '生成 Remotion 动画方案');
        } catch (error) { report(error); }
        finally { busy = false; if (root.isConnected) { const button = root.querySelector('[data-generate-animation]'); button.disabled = false; button.innerHTML = `${icon('spark')} AI 重新编排`; renderEditor(); } }
      };
      root.querySelector('[data-save-plan]').onclick = () => { try { storePlan(); log(target, '保存动画场景修改'); persist(target, true); toast('动画方案已保存'); } catch (error) { report(error); } };
      root.querySelector('[data-render-animation]').onclick = renderAnimation;
      root.querySelector('[data-animation-job]').onclick = async event => {
        try {
          if (event.target.closest('[data-add-rendered]') && job?.asset) { if (project !== target) return; addAsset(job.asset.id); close(); }
          else if (event.target.closest('[data-save-rendered]')) await saveJob(job, job.title || plan?.title || '光宣动画');
          else if (event.target.closest('[data-retry-render]')) await renderAnimation();
        } catch (error) { report(error); }
      };
    } });
  }
  function exportDialog() {
    pause(); const target = project, total = duration();
    if (!target.video.timeline.length) return dialog({ title: '先完成一段时间线', body: '<p>将视频或图片加入时间线后，就可以导出 MP4。也可以先生成一段动画作为画面素材。</p><div class="modal-actions"><button class="btn" data-import>导入素材</button><button class="btn primary" data-animation>生成动画</button></div>', onMount: (root, close) => { root.querySelector('[data-import]').onclick = async () => { close(); try { await importMedia(); } catch (error) { toast(error.message, 'error'); } }; root.querySelector('[data-animation]').onclick = () => { close(); animationDialog(false); }; } });
    let job = clone(data().lastExportJob || null), stopWatch = null, pending = false;
    dialog({ title: '导出视频', onClose: () => stopWatch?.(), body: `<div class="form-grid"><div class="form-field"><label>文件名</label><input data-export-name value="${h(project.title)}" maxlength="100"></div><div class="form-field"><label>分辨率</label><select data-export-resolution><option value="720" ${data().resolution === '720' ? 'selected' : ''}>720P</option><option value="1080" ${data().resolution === '1080' ? 'selected' : ''}>1080P</option></select></div></div><div class="notice"><span>${h(data().aspect)} · ${timecode(total)} · ${data().timeline.length} 个片段 · ${data().captions.length} 条字幕<br>导出会拼接片段，并应用字幕、原声和配乐设置。</span></div><div data-export-error class="notice error hidden"></div><div data-export-job></div><div class="modal-actions"><button class="btn" data-caption-settings>检查字幕</button><button class="btn primary" data-start-export>${icon('download')} 开始导出</button></div>`, onMount: (root, close) => {
      const errorBox = root.querySelector('[data-export-error]');
      const report = error => { if (!root.isConnected) return; errorBox.textContent = error.message; errorBox.classList.remove('hidden'); };
      const update = state => { job = { ...job, ...state }; if (!root.isConnected) return; root.querySelector('[data-export-job]').innerHTML = jobMarkup(job, 'export'); root.querySelector('[data-start-export]').disabled = pending || !['complete', 'error'].includes(state.status); };
      const beginWatch = () => { if (!root.isConnected) return; stopWatch?.(); stopWatch = watchJob(target, 'lastExportJob', job.jobId, { alive: () => root.isConnected, onUpdate: update, onComplete: done => { update(done); toast('视频已导出，点击“保存 MP4”选择保存位置。'); }, onError: report }); };
      const start = async () => {
        if (pending) return;
        try {
          const currentDuration = target.video.timeline.reduce((sum, clip) => sum + clip.end - clip.start, 0);
          if (target.video.captions.some(caption => caption.start >= currentDuration || caption.end > currentDuration + 0.05)) throw new Error('有字幕超出时间线。请在字幕编辑中调整时间，或使用“裁至时间线”。');
          if (target.video.timeline.some(clip => !assetById(clip.assetId))) throw new Error('时间线中有不可用素材，请重新导入后替换。');
          pending = true; root.querySelector('[data-start-export]').disabled = true; errorBox.classList.add('hidden');
          const title = root.querySelector('[data-export-name]').value.trim() || target.title, resolution = root.querySelector('[data-export-resolution]').value;
          const result = await api('/api/video/export', { title, timeline: clone(target.video.timeline), captions: clone(target.video.captions), aspect: target.video.aspect, resolution, sourceVolume: target.video.sourceVolume, music: target.video.music ? clone(target.video.music) : null });
          target.video.resolution = resolution; job = { jobId: result.jobId, status: 'queued', progress: 0, title }; target.video.lastExportJob = clone(job); log(target, '开始导出视频'); persist(target, true); pending = false; update(job); beginWatch();
        } catch (error) { pending = false; if (root.isConnected) root.querySelector('[data-start-export]').disabled = false; report(error); }
      };
      root.querySelector('[data-start-export]').onclick = start;
      root.querySelector('[data-caption-settings]').onclick = () => { close(); captionsDialog(); };
      root.querySelector('[data-export-job]').onclick = async event => { try { if (event.target.closest('[data-save-rendered]')) await saveJob(job, root.querySelector('[data-export-name]').value || target.title); else if (event.target.closest('[data-retry-render]')) await start(); } catch (error) { report(error); } };
      if (job) { update(job); if (!['complete', 'error'].includes(job.status)) beginWatch(); }
    } });
  }

  return {
    async mount(element, target) {
      this.unmount(); container = element; project = target; ensureVideo(project); epoch++; selected = null; sourcePreview = null; playhead = 0; undo = [];
      wireEvents(); render();
      if (pendingScript) { const queued = pendingScript; pendingScript = null; applyScript(queued.script, queued.title); }
      try { await refreshAssets(); } catch (error) { if (connected()) { runtime = { ready: false }; toast(error.message, 'error'); render(); } }
    },
    unmount() {
      pause(); epoch++; mountedEvents?.abort(); mountedEvents = null; resizeObserver?.disconnect(); resizeObserver = null;
      for (const stop of polls) stop(); polls.clear(); modalCloser?.(); modalCloser = null;
      if (project) persist(project, true);
      container?.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
      container = null; project = null; activeMediaKey = null;
    },
    receiveScript(videoScript, sourceTitle = '') {
      if (!project) { pendingScript = { script: clone(videoScript), title: sourceTitle }; return; }
      applyScript(videoScript, sourceTitle);
    },
  };
}

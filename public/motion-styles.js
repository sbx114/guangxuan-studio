import { parseTimecode, formatTimecode } from './time-range.js';

const h = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const MOTION_STYLE_EDITOR_OPTIONS = Object.freeze({
  palette: [['original', '原版配色'], ['ocean', '海蓝'], ['amber', '暖铜'], ['plum', '梅紫']],
  font: [['original', '原版字体'], ['sans', '无衬线'], ['serif', '衬线'], ['mono', '等宽']],
  reveal: [['original', '沿用模板'], ['fade', '淡入'], ['rise', '上升'], ['mask', '遮罩'], ['typewriter', '逐字']],
  pace: [['calm', '舒缓'], ['normal', '标准'], ['brisk', '利落']],
  easing: [['smooth', '柔和'], ['linear', '匀速'], ['out', '快速进入'], ['inOut', '渐入渐出']],
  camera: [['none', '固定'], ['push', '轻推近'], ['pan-left', '向左缓移'], ['pan-right', '向右缓移']],
  transition: [['original', '沿用模板'], ['cut', '直接切换'], ['fade', '叠化'], ['wipe', '横向擦入']],
});
const DEFAULTS = { reveal: 'original', pace: 'normal', easing: 'smooth', camera: 'none', amount: .5, transition: 'original', transitionDuration: .4 };
function styles() {
  if (document.querySelector('link[data-motion-style-editor]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/motion-styles.css'; link.dataset.motionStyleEditor = ''; document.head.append(link);
}
function selected(key, value, attributes) {
  return `<select ${attributes}>${MOTION_STYLE_EDITOR_OPTIONS[key].map(([id, label]) => `<option value="${id}" ${value === id ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
}
function validateChoice(key, value) { if (!MOTION_STYLE_EDITOR_OPTIONS[key].some(([id]) => id === value)) throw new Error('请选择有效的动效风格。'); return value; }
function validateMotion(value) {
  const result = {};
  for (const key of ['reveal', 'pace', 'easing', 'camera', 'transition']) result[key] = validateChoice(key, value[key]);
  for (const [key, min, max] of [['amount', 0, 1], ['transitionDuration', .1, 1]]) {
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error(key === 'amount' ? '镜头运动幅度应为0至1。' : '转场时长应为0.1至1秒。');
    result[key] = key === 'transitionDuration' ? Math.round(number * 30) / 30 : number;
  }
  return result;
}

/** An embedded foldout; read(basePlan) preserves the host's current text/data. */
export function createMotionStyleEditor({ host, plan, onChange } = {}) {
  if (!host?.append || !plan || !Array.isArray(plan.scenes)) throw new Error('请先生成有效动画方案再编辑风格。');
  styles();
  const root = document.createElement('details'); root.className = 'motion-style-editor'; host.append(root);
  let base = structuredClone(plan), disposed = false, brandDirty = false, brandReset = false, sceneDirty = new Set(), sceneReset = new Set();
  let brand, motion;
  function initialize(value) {
    base = structuredClone(value); brandDirty = false; brandReset = false; sceneDirty = new Set(); sceneReset = new Set();
    const defaults = base.theme === 'dark' ? { background: '#080a08', ink: '#e8e5e1', accent: '#b2bb95' } : { background: '#e8e5e1', ink: '#080a08', accent: '#565c46' };
    brand = { palette: 'original', font: 'original', ...defaults, ...(base.brand || {}), custom: Boolean(base.brand?.background || base.brand?.ink || base.brand?.accent) };
    motion = base.scenes.map(scene => ({ ...DEFAULTS, ...(scene.motion || {}) }));
    paint();
  }
  function read(basePlan = base) {
    if (disposed) throw new Error('动效风格编辑器已关闭。');
    if (!basePlan || !Array.isArray(basePlan.scenes)) throw new Error('动画方案格式不正确。');
    if (basePlan.scenes.length !== base.scenes.length) throw new Error('场景数量已变化，请重新载入动效编辑器。');
    const result = structuredClone(basePlan);
    if (brandDirty) {
      if (brandReset) delete result.brand;
      else {
        result.brand = { palette: validateChoice('palette', brand.palette), font: validateChoice('font', brand.font) };
        if (brand.custom) for (const key of ['background', 'ink', 'accent']) {
          if (typeof brand[key] !== 'string' || !/^#[a-f0-9]{6}$/i.test(brand[key])) throw new Error('品牌颜色需要六位十六进制颜色。');
          result.brand[key] = brand[key].toLowerCase();
        }
      }
    }
    result.scenes = result.scenes.map((scene, index) => {
      if (!sceneDirty.has(index)) return scene;
      const next = { ...scene };
      if (sceneReset.has(index)) delete next.motion;
      else next.motion = validateMotion(motion[index]);
      return next;
    });
    return result;
  }
  function changed() {
    const status = root.querySelector('[data-ms-error]');
    try { const result = read(); status.textContent = ''; onChange?.(result); }
    catch (error) { status.textContent = error.message || '动效参数无效。'; }
  }
  function paint() {
    const open = root.open;
    root.innerHTML = `<summary><span>动效风格</span><small>品牌 · 文字 · 镜头 · 转场</small></summary><div class="ms-body"><div class="ms-heading"><p>保持原版即可沿用现有五种模板。所有动效按项目时间计算，分镜预览与导出使用相同参数。</p><button type="button" class="btn small" data-ms-reset>恢复原版</button></div><div class="ms-brand"><label>配色预设${selected('palette', brand.palette, 'data-ms-brand="palette"')}</label><label>字体预设${selected('font', brand.font, 'data-ms-brand="font"')}</label><label class="ms-check"><input type="checkbox" data-ms-brand="custom" ${brand.custom ? 'checked' : ''}>自定义品牌颜色</label><div class="ms-colors" ${brand.custom ? '' : 'hidden'}><label>背景<input type="color" data-ms-brand="background" value="${h(brand.background)}"></label><label>文字<input type="color" data-ms-brand="ink" value="${h(brand.ink)}"></label><label>强调<input type="color" data-ms-brand="accent" value="${h(brand.accent)}"></label></div></div><div class="ms-scenes">${base.scenes.map((scene, index) => `<details class="ms-scene"><summary>第 ${index + 1} 场 · ${h(scene.title || scene.type || '场景')}</summary><div class="ms-grid"><label>文字揭示${selected('reveal', motion[index].reveal, `data-ms-scene="${index}" data-ms-key="reveal"`)}</label><label>动效节奏${selected('pace', motion[index].pace, `data-ms-scene="${index}" data-ms-key="pace"`)}</label><label>入场转场${selected('transition', motion[index].transition, `data-ms-scene="${index}" data-ms-key="transition"`)}</label><label>转场时长 / 秒<input type="number" min="0.1" max="1" step="0.05" data-ms-scene="${index}" data-ms-key="transitionDuration" value="${h(motion[index].transitionDuration)}"></label></div><details class="ms-more"><summary>镜头与缓动</summary><div class="ms-grid"><label>缓动${selected('easing', motion[index].easing, `data-ms-scene="${index}" data-ms-key="easing"`)}</label><label>镜头${selected('camera', motion[index].camera, `data-ms-scene="${index}" data-ms-key="camera"`)}</label><label>运动幅度<input type="number" min="0" max="1" step="0.05" data-ms-scene="${index}" data-ms-key="amount" value="${h(motion[index].amount)}"></label><button type="button" class="btn small" data-ms-scene-reset="${index}">此场恢复原版</button></div></details></details>`).join('')}</div><p class="ms-note">轻推近最大约5%，缓移最大约画幅2%；字体使用本机预设与后备字体。入场转场不改变场景总时长，结尾保留原淡出。</p><p data-ms-error class="ms-error" role="status" aria-live="polite"></p></div>`;
    root.open = open;
  }
  const input = event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (event.type === 'input' && target instanceof HTMLSelectElement || event.type === 'change' && target instanceof HTMLInputElement && target.type !== 'checkbox') return;
    if (target.dataset.msBrand) {
      const key = target.dataset.msBrand;
      brand[key] = target.type === 'checkbox' ? target.checked : target.value;
      brandDirty = true; brandReset = false;
      if (key === 'custom') root.querySelector('.ms-colors').hidden = !brand.custom;
      changed();
    } else if (target.dataset.msScene !== undefined && target.dataset.msKey) {
      const index = Number(target.dataset.msScene), key = target.dataset.msKey;
      if (!motion[index] || !Object.hasOwn(DEFAULTS, key)) return;
      motion[index][key] = key === 'amount' || key === 'transitionDuration' ? Number(target.value) : target.value;
      sceneDirty.add(index); sceneReset.delete(index); changed();
    }
  };
  const click = event => {
    if (event.target.closest('[data-ms-reset]')) {
      const original = structuredClone(base); delete original.brand;
      original.scenes.forEach(scene => { delete scene.motion; });
      initialize(original); brandDirty = true; brandReset = true;
      base.scenes.forEach((_, index) => { sceneDirty.add(index); sceneReset.add(index); });
      changed();
    }
    const reset = event.target.closest('[data-ms-scene-reset]');
    if (reset) {
      const index = Number(reset.dataset.msSceneReset); motion[index] = { ...DEFAULTS }; sceneDirty.add(index); sceneReset.add(index);
      paint();
      changed();
    }
  };
  root.addEventListener('input', input); root.addEventListener('change', input); root.addEventListener('click', click);
  initialize(base);
  return {
    read,
    update(next) { if (!disposed) initialize(next); },
    dispose() { if (disposed) return; disposed = true; root.removeEventListener('input', input); root.removeEventListener('change', input); root.removeEventListener('click', click); root.remove(); },
  };
}

async function requestMotionPreview(payload, { signal } = {}) {
  const response = await fetch('/api/video/preview-animation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
  let result;
  try { result = await response.json(); } catch { throw new Error('分镜预览未返回有效结果。'); }
  if (!response.ok) throw new Error(result.error || '分镜预览未完成，请稍后重试。');
  return result;
}

/** Review real renderer frames before starting the longer MP4 render. */
export function createMotionPreviewUI({ host, getPlan, requestPreview = requestMotionPreview } = {}) {
  if (!host?.append || typeof getPlan !== 'function' || typeof requestPreview !== 'function') throw new Error('分镜预览需要动画方案。');
  styles();
  const root = document.createElement('section'); root.className = 'motion-preview'; host.append(root);
  root.innerHTML = `<div class="mp-heading"><div><h4>分镜预览</h4><p>先检查实际渲染的画面，再生成视频。时间均为整部动画的时间码。</p></div></div><div class="mp-controls"><label>取帧方式<select data-mp-mode><option value="scenes">每场中间一帧</option><option value="times">指定时间点</option></select></label><label data-mp-times-label hidden>项目时间点<input data-mp-times placeholder="例如 0.5, 00:03, 6.5" autocomplete="off"><small>用逗号分隔，最多16个时间点。</small></label><div class="mp-actions"><button type="button" class="btn small" data-mp-start>生成分镜预览</button><button type="button" class="btn small" data-mp-cancel hidden>取消预览</button></div></div><p data-mp-status class="mp-status" role="status" aria-live="polite"></p><div data-mp-frames class="mp-frames"></div>`;
  const mode = root.querySelector('[data-mp-mode]'), times = root.querySelector('[data-mp-times]'), status = root.querySelector('[data-mp-status]'), gallery = root.querySelector('[data-mp-frames]');
  const start = root.querySelector('[data-mp-start]'), cancel = root.querySelector('[data-mp-cancel]');
  let controller, disposed = false, generation = 0;
  function busy(value) {
    start.disabled = value; cancel.hidden = !value; mode.disabled = value; times.disabled = value;
    root.setAttribute('aria-busy', String(value));
  }
  function invalidate() {
    if (disposed) return;
    generation++;
    const hadPreview = gallery.childElementCount || controller;
    if (controller) { controller.abort(); controller = null; busy(false); }
    if (hadPreview) { gallery.replaceChildren(); status.textContent = '方案已修改，请重新生成预览。'; }
  }
  async function generate() {
    if (disposed || controller) return;
    const requestId = ++generation;
    let payload, fingerprint;
    try {
      const plan = structuredClone(getPlan());
      if (!plan || !Array.isArray(plan.scenes) || !plan.scenes.length) throw new Error('请先生成并保存有效动画场景。');
      payload = { plan }; fingerprint = JSON.stringify(plan);
      if (mode.value === 'times') {
        const values = times.value.trim().split(/[,，;；\s]+/).filter(Boolean);
        if (!values.length || values.length > 16) throw new Error('请输入1至16个时间点。');
        payload.times = values.map(parseTimecode);
        const duration = plan.scenes.reduce((sum, scene) => sum + Number(scene.duration), 0);
        if (payload.times.some(value => value > duration)) throw new Error('预览时间点不能超过动画总时长。');
      }
    } catch (error) { status.textContent = error.message || '动画方案格式不正确。'; return; }
    const active = new AbortController(); controller = active;
    gallery.replaceChildren(); status.textContent = '正在生成实际分镜帧，首次预览需要准备渲染器…'; busy(true);
    try {
      const result = await requestPreview(payload, { signal: active.signal });
      if (disposed || requestId !== generation || active.signal.aborted) return;
      if (JSON.stringify(getPlan()) !== fingerprint) { status.textContent = '方案已修改，请重新生成预览。'; return; }
      if (!Array.isArray(result?.frames) || !result.frames.length || result.frames.length > 16 || result.frames.some(frame => !/^\/api\/video\/previews\/[a-f0-9-]{36}\/frame-\d{2}\.png$/.test(frame.url) || !Number.isInteger(frame.index) || frame.index < 0 || !Number.isFinite(frame.time) || frame.time < 0)) throw new Error('分镜预览返回了无效图像。');
      gallery.innerHTML = result.frames.map(frame => `<figure><a href="${h(frame.url)}" target="_blank" rel="noopener" title="打开原尺寸分镜帧"><img src="${h(frame.url)}" alt="第${frame.index + 1}场，${h(formatTimecode(frame.time))}" loading="lazy"></a><figcaption><strong>第 ${frame.index + 1} 场 · ${h(formatTimecode(frame.time))}</strong><span>${h(frame.label || '')}</span><a href="${h(frame.url)}" target="_blank" rel="noopener">打开原尺寸</a></figcaption></figure>`).join('');
      status.textContent = `已生成 ${result.frames.length} 帧 · ${Number(result.width) || ''} × ${Number(result.height) || ''}。静帧用于检查排版与取景，运动效果请检查渲染的视频。`;
    } catch (error) {
      if (disposed || requestId !== generation) return;
      status.textContent = active.signal.aborted ? '分镜预览已取消。' : error.message || '分镜预览未完成。';
    } finally { if (!disposed && requestId === generation) { controller = null; busy(false); } }
  }
  mode.onchange = () => { root.querySelector('[data-mp-times-label]').hidden = mode.value !== 'times'; };
  start.onclick = generate;
  cancel.onclick = () => { controller?.abort(); status.textContent = '正在取消预览…'; };
  return {
    generate, invalidate,
    dispose() { if (disposed) return; disposed = true; generation++; controller?.abort(); controller = null; mode.onchange = null; start.onclick = null; cancel.onclick = null; root.remove(); },
  };
}

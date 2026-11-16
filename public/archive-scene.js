import { icon } from './ui.js';

const ENTRIES = [
  { id: 'video', number: '01', code: 'GX–001', name: '视频剪辑', english: 'VIDEO STUDIO', note: 'AI 粗剪与 Remotion 动画', symbol: 'video' },
  { id: 'writer', number: '02', code: 'GX–002', name: '文案写作', english: 'WRITING DESK', note: '素材核对与多种内容生成', symbol: 'pen' },
];

export function archiveSceneMarkup() {
  const sheets = Array.from({ length: 3 }, (_, column) => Array.from({ length: 10 }, (_, row) => {
    const x = 38 + column * 276, y = row * 33 + (column === 1 ? -28 : column === 2 ? -52 : 0);
    const height = 164 + ((row + column) % 4) * 7;
    return `<div class="archive-sheet" aria-hidden="true" style="--sheet-x:${x}px;--sheet-y:${y}px;--sheet-h:${height}px;--sheet-index:${row}"><span class="archive-sheet-code">G / X</span><span class="archive-sheet-line"></span><span class="archive-sheet-stamp"></span></div>`;
  }).join('')).join('');
  const files = ENTRIES.map((entry, index) => `<button class="archive-file" data-archive-entry="${entry.id}" data-archive-open="${entry.id}" style="--file-x:${38 + index * 276}px;--file-y:${330 - index * 28}px" aria-label="进入${entry.name}"><span class="archive-file-top"><span>${entry.code}</span><span>${icon(entry.symbol)}</span></span><span class="archive-file-number">${entry.number}</span><span class="archive-file-title">${entry.name}</span><span class="archive-file-subtitle">${entry.english}</span><span class="archive-file-rule"></span><span class="archive-file-foot"><span>OPEN FILE</span>${icon('arrow')}</span></button>`).join('');
  return `<div class="archive-stage" data-archive-stage role="group" aria-label="立体创作档案，选择视频剪辑或文案写作">
    <div class="archive-atmosphere" aria-hidden="true"></div>
    <div class="archive-array" data-archive-array><div class="archive-floor" aria-hidden="true"></div>${sheets}${files}<div class="archive-file archive-file-planned" style="--file-x:590px;--file-y:278px" aria-hidden="true"><span class="archive-file-top"><span>GX–003</span>${icon('science')}</span><span class="archive-file-number">03</span><span class="archive-file-title">科普工作室</span><span class="archive-file-subtitle">SCIENCE LAB</span><span class="archive-file-rule"></span><span class="archive-file-foot">规划中</span></div></div>
    <div class="archive-stage-fade" aria-hidden="true"></div>
    <span class="archive-coordinate" aria-hidden="true">CREATIVE ARCHIVE / G–X</span>
  </div>
  <div class="archive-controls"><div class="archive-current"><span class="eyebrow">ARCHIVE / SELECT</span><span class="archive-count"><strong data-archive-count>01</strong><span>/ 02</span></span></div><div class="archive-step-controls"><button class="icon-btn" data-archive-step="-1" aria-label="上一份创作档案">${icon('back')}</button><span class="archive-ticks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><button class="icon-btn" data-archive-step="1" aria-label="下一份创作档案">${icon('arrow')}</button></div><div class="archive-caption"><span class="eyebrow" data-archive-code>FILE GX–001</span><strong data-archive-name>视频剪辑</strong></div><button class="archive-open" data-archive-open="video" data-archive-current-open>进入档案 ${icon('arrow')}</button></div>`;
}

export function mountArchiveScene(root, { onOpen } = {}) {
  if (!root) return () => {};
  const events = new AbortController();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const stage = root.querySelector('[data-archive-stage]');
  const array = root.querySelector('[data-archive-array]');
  let active = 0, frame = 0, timer = 0, destroyed = false, opening = false;
  let currentX = 0, currentY = 0, targetX = 0, targetY = 0;
  const options = { signal: events.signal };

  function select(index) {
    if (opening) return;
    active = (index + ENTRIES.length) % ENTRIES.length;
    const entry = ENTRIES[active]; root.dataset.archiveActive = entry.id;
    root.querySelector('[data-archive-count]').textContent = entry.number;
    root.querySelector('[data-archive-code]').textContent = `FILE ${entry.code}`;
    root.querySelector('[data-archive-name]').textContent = entry.name;
    root.querySelector('[data-archive-current-open]').dataset.archiveOpen = entry.id;
    root.querySelectorAll('[data-archive-entry]').forEach(element => element.classList.toggle('is-current', element.dataset.archiveEntry === entry.id));
  }
  function resetMotion() {
    if (frame) cancelAnimationFrame(frame); frame = 0;
    currentX = currentY = targetX = targetY = 0;
    array.style.setProperty('--pointer-x', '0deg'); array.style.setProperty('--pointer-y', '0deg');
  }
  function animate() {
    frame = 0;
    if (destroyed || reduced.matches || document.hidden) return;
    currentX += (targetX - currentX) * 0.16; currentY += (targetY - currentY) * 0.16;
    array.style.setProperty('--pointer-x', `${currentX.toFixed(3)}deg`);
    array.style.setProperty('--pointer-y', `${currentY.toFixed(3)}deg`);
    if (Math.abs(targetX - currentX) + Math.abs(targetY - currentY) > 0.015) frame = requestAnimationFrame(animate);
  }
  function queueMotion() { if (!frame && !reduced.matches) frame = requestAnimationFrame(animate); }
  function open(id) {
    const index = ENTRIES.findIndex(entry => entry.id === id); if (index < 0 || opening) return;
    select(index); opening = true; root.classList.add('archive-opening');
    if (reduced.matches) onOpen?.(id);
    else timer = setTimeout(() => { if (!destroyed) onOpen?.(id); }, 180);
  }
  root.querySelectorAll('[data-archive-entry]').forEach(element => {
    const update = () => select(ENTRIES.findIndex(entry => entry.id === element.dataset.archiveEntry));
    element.addEventListener('pointerenter', update, options);
    element.addEventListener('focus', update, options);
  });
  root.addEventListener('click', event => {
    const entry = event.target.closest('[data-archive-open]'); if (entry) return open(entry.dataset.archiveOpen);
    const step = event.target.closest('[data-archive-step]'); if (step) select(active + Number(step.dataset.archiveStep));
  }, options);
  root.addEventListener('keydown', event => {
    if (!event.target.closest('.archive-stage,.archive-controls,.archive-entry') || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); select(active + (event.key === 'ArrowLeft' ? -1 : 1));
      root.querySelector(`.archive-file[data-archive-entry="${ENTRIES[active].id}"]`)?.focus({ preventScroll: true });
    }
  }, options);
  stage.addEventListener('pointermove', event => {
    if (reduced.matches || !finePointer.matches || opening) return;
    const bounds = stage.getBoundingClientRect();
    targetX = (Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) - 0.5) * 5;
    targetY = (Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) - 0.5) * -3;
    queueMotion();
  }, options);
  stage.addEventListener('pointerleave', () => { targetX = targetY = 0; queueMotion(); }, options);
  reduced.addEventListener('change', resetMotion, options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetMotion(); }, options);

  const resize = new ResizeObserver(() => {
    array.style.setProperty('--archive-scale', String(Math.max(0.58, Math.min(1.02, stage.clientWidth / 940))));
  });
  resize.observe(stage);
  const observer = new MutationObserver(() => { if (!root.isConnected) dispose(); });
  observer.observe(document.querySelector('#app') || document.body, { childList: true, subtree: true });
  function dispose() {
    if (destroyed) return; destroyed = true;
    events.abort(); clearTimeout(timer); if (frame) cancelAnimationFrame(frame);
    resize.disconnect(); observer.disconnect();
  }
  window.addEventListener('pagehide', dispose, options);
  select(0); root.classList.add('archive-ready');
  return dispose;
}

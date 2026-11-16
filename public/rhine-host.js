const VIEWS = new Set(['video', 'writer', 'archive', 'settings']);

export function rhineCommand(data, origin, source, expectedOrigin, expectedSource) {
  if (!expectedSource || origin !== expectedOrigin || source !== expectedSource || !data || typeof data !== 'object') return null;
  if (data.type === 'guangxuan:ready') return { type: 'ready' };
  if (data.type !== 'guangxuan:open' || !VIEWS.has(data.view)) return null;
  return { type: 'open', view: data.view };
}

export function mountRhineHome(container, { skipBoot = false, onOpen, onReady } = {}) {
  const lifecycle = new AbortController();
  let loaded = false, disposed = false;
  container.innerHTML = `<section class="rhine-home" aria-label="光宣工作台"><div class="rhine-home-wait" role="status"><span class="spinner"></span><span>正在打开</span></div><iframe class="rhine-home-frame" title="光宣创作档案" sandbox="allow-scripts allow-same-origin allow-downloads" allow="autoplay; fullscreen" allowfullscreen></iframe><div class="rhine-home-error" hidden><p>首页暂时未能打开。</p><div class="rhine-home-error-actions"><button class="btn small" data-home-retry>重试</button><button class="btn small" data-home-view="video">剪辑</button><button class="btn small" data-home-view="writer">写作</button></div></div></section>`;
  const frame = container.querySelector('iframe');
  const errorPanel = container.querySelector('.rhine-home-error');
  let timer;
  function ready() {
    if (disposed || loaded) return;
    loaded = true; clearTimeout(timer); errorPanel.hidden = true;
    container.querySelector('.rhine-home-wait')?.remove();
    onReady?.();
  }
  function load() {
    loaded = false; errorPanel.hidden = true; clearTimeout(timer);
    const url = new URL('/rhine/index.html', location.origin);
    url.searchParams.set('embed', '1');
    if (skipBoot) url.searchParams.set('skipBoot', '1');
    frame.src = url.href;
    timer = setTimeout(() => { if (!disposed && !loaded) errorPanel.hidden = false; }, 25000);
  }
  window.addEventListener('message', event => {
    const command = rhineCommand(event.data, event.origin, event.source, location.origin, frame.contentWindow);
    if (!command || disposed) return;
    if (command.type === 'ready') ready();
    if (command.type === 'open') { ready(); onOpen?.(command.view); }
  }, { signal: lifecycle.signal });
  frame.addEventListener('load', () => {
    try { if (!frame.contentDocument?.getElementById('viewport')) errorPanel.hidden = false; }
    catch { errorPanel.hidden = false; }
  }, { signal: lifecycle.signal });
  frame.addEventListener('error', () => { errorPanel.hidden = false; }, { signal: lifecycle.signal });
  container.querySelector('[data-home-retry]').addEventListener('click', load, { signal: lifecycle.signal });
  container.querySelectorAll('[data-home-view]').forEach(button => button.addEventListener('click', () => onOpen?.(button.dataset.homeView), { signal: lifecycle.signal }));
  load();
  return () => { disposed = true; clearTimeout(timer); lifecycle.abort(); };
}

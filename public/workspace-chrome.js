import { icon } from './ui.js';

export const WORKSPACES = [
  { view: 'video', kind: 'video', label: '视频剪辑', icon: 'video' },
  { view: 'writer', kind: 'writing', label: '文案写作', icon: 'pen' },
  { view: 'science', kind: 'science', label: '科普', icon: 'science' },
];

export function installWorkspaceTools(root) {
  const actions = root.querySelector('.gx-workspace-header .header-right');
  if (!actions) return;
  if (!actions.querySelector('[data-open-assistant]')) {
    const assistant = document.createElement('button');
    assistant.type = 'button'; assistant.className = 'gx-header-link gx-assistant-global-entry'; assistant.dataset.openAssistant = '';
    assistant.setAttribute('aria-label', '全局 AI 助手'); assistant.title = 'AI 助手';
    assistant.innerHTML = icon('spark') + '<span>AI 助手</span>';
    actions.prepend(assistant);
  }
  if (actions.querySelector('[data-tasks]')) return;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'gx-header-link'; button.dataset.tasks = '';
  button.setAttribute('aria-label', '任务中心'); button.title = '任务中心';
  button.innerHTML = icon('clock') + '<span>任务</span>';
  actions.prepend(button);
}

export function workspaceHeader(view) {
  const current = WORKSPACES.find(item => item.view === view)?.label || ({ settings: '模型连接', archive: '项目列表' })[view] || '';
  return `<header class="app-header gx-workspace-header"><div class="gx-workspace-identity"><button class="brand" data-nav="home" aria-label="Gx · 返回档案"><span class="brand-mark"><img src="/mark.svg" alt="Gx" width="40" height="40"></span></button>${current ? `<span class="gx-current-workspace">${current}</span>` : ''}</div><div class="header-right"><button class="gx-header-link" data-nav="home">${icon('back')}<span>返回档案</span></button><button class="gx-header-link" data-nav="archive" aria-label="项目列表" title="项目列表">${icon('folder')}</button><button class="gx-header-link" data-nav="settings" aria-label="模型连接" title="模型连接">${icon('settings')}</button></div></header>`;
}

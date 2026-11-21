import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { nextWorkspace, workspaceProjects, workspaceLane, workspaceForLane } from '../integrations/rhinelab-ui/src/workspace-navigation.ts';
import { records, setProjects, fileLocation, projectAtCell, columnFiles } from '../integrations/rhinelab-ui/src/data.ts';
import { selectionCell } from '../integrations/rhinelab-ui/src/archive-loop.ts';

const fixtures = [
  { id: 'video-one', title: '视频一', kind: 'video', createdAt: '2026-11-16T01:00:00Z' },
  { id: 'writing-one', title: '文案一', kind: 'writing', createdAt: '2026-11-16T02:00:00Z' },
  { id: 'science-one', title: '科普一', kind: 'science', createdAt: '2026-11-16T03:00:00Z' },
  { id: 'video-two', title: '视频二', kind: 'video', createdAt: '2026-11-16T04:00:00Z' },
];

test('left/right reaches every workspace even when the current or next category has no projects', () => {
  const onlyScience = fixtures.filter(project => project.kind === 'science');
  setProjects(onlyScience);
  assert.equal(fileLocation(0).lane, 2, 'The only populated workspace still belongs to the physical science wave');
  assert.deepEqual(columnFiles(0), []);
  assert.deepEqual(columnFiles(1), []);
  assert.deepEqual(columnFiles(2), [0]);
  let view = 'video';
  assert.equal(workspaceProjects(onlyScience, view).length, 0);
  view = nextWorkspace(view, 1);
  assert.equal(view, 'writer');
  assert.equal(workspaceProjects(onlyScience, view).length, 0);
  view = nextWorkspace(view, 1);
  assert.equal(view, 'science');
  assert.equal(workspaceProjects(onlyScience, view)[0].id, 'science-one');
  assert.equal(nextWorkspace(view, 1), 'video');
  assert.equal(nextWorkspace('video', -1), 'science');
  assert.equal(nextWorkspace('writer', -1), 'video');
  assert.equal(workspaceLane('video'), 0);
  assert.equal(workspaceLane('writer'), 1);
  assert.equal(workspaceLane('science'), 2);
  assert.equal(workspaceForLane(0), 'video');
  assert.equal(workspaceForLane(1), 'writer');
  assert.equal(workspaceForLane(2), 'science');
  assert.equal(workspaceForLane(3), null);
});

test('all workspaces remain in distinct physical waves while selecting a category', () => {
  const before = structuredClone(fixtures);
  setProjects(fixtures);
  const cells = records.map((project, index) => ({ id: project.id, ...fileLocation(index) }));
  assert.deepEqual(cells.map(({ id, lane, row }) => ({ id, lane, row })), [
    { id: 'video-one', lane: 0, row: 12 },
    { id: 'writing-one', lane: 1, row: 12 },
    { id: 'science-one', lane: 2, row: 12 },
    { id: 'video-two', lane: 0, row: 13 },
  ]);
  assert.deepEqual(columnFiles(0).map(index => records[index].id), ['video-one', 'video-two']);
  assert.deepEqual(columnFiles(1).map(index => records[index].id), ['writing-one']);
  assert.deepEqual(columnFiles(2).map(index => records[index].id), ['science-one']);
  for (const [view, lane] of [['video', 0], ['writer', 1], ['science', 2]]) {
    const category = workspaceProjects(fixtures, view);
    assert.deepEqual(columnFiles(lane).map(index => records[index].id), category.map(project => project.id));
    assert.equal(records.length, fixtures.length, 'Choosing a lane must not remove the other workspaces from the scene');
  }
  const writingIndex = projectAtCell({ lane: 1, row: 12 });
  assert.equal(records[writingIndex].id, 'writing-one');
  assert.deepEqual(selectionCell(writingIndex, { lane: 0, row: 13 }, { cell: { lane: 1, row: 12 } }), { lane: 1, row: 12 });
  assert.deepEqual(fixtures, before);
});

test('every project of one kind remains in that same wave across all rows', () => {
  const videos = Array.from({ length: 37 }, (_, index) => ({ ...fixtures[0], id: `video-${index}`, createdAt: new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString() }));
  setProjects([...videos, ...fixtures.filter(project => project.kind !== 'video')]);
  const videoIndices = columnFiles(0);
  assert.equal(records.length, videos.length + 2);
  assert.equal(videoIndices.length, videos.length);
  assert.equal(new Set(records.map(project => project.id)).size, records.length);
  for (const [rowOffset, index] of videoIndices.entries()) {
    assert.equal(records[index].kind, 'video');
    assert.equal(fileLocation(index).lane, 0);
    assert.equal(fileLocation(index).row, 12 + rowOffset);
    assert.equal(projectAtCell(fileLocation(index)), index);
  }
  assert.equal(records[projectAtCell({ lane: 1, row: 12 })].kind, 'writing');
  assert.equal(records[projectAtCell({ lane: 2, row: 12 })].kind, 'science');
  assert.equal(records[projectAtCell({ lane: 0, row: 44 })].id, 'video-32', 'Projects past the decorative 32-row period must not wrap onto an earlier project');
  assert.equal(projectAtCell({ lane: 3, row: 12 }), -1, 'Decorative waves must not acquire a real project');
});

test('creating and deleting records only compacts rows within their own physical workspace', () => {
  setProjects(fixtures);
  const newVideo = { ...fixtures[0], id: 'video-three', createdAt: '2026-11-16T05:00:00Z' };
  setProjects([...fixtures, newVideo]);
  assert.equal(records[projectAtCell({ lane: 0, row: 14 })].id, newVideo.id);
  assert.equal(records[projectAtCell({ lane: 1, row: 12 })].id, 'writing-one');
  assert.equal(records[projectAtCell({ lane: 2, row: 12 })].id, 'science-one');
  setProjects([...fixtures.filter(project => project.id !== 'video-one'), newVideo]);
  assert.deepEqual(columnFiles(0).map(index => records[index].id), ['video-two', 'video-three']);
  assert.equal(records[projectAtCell({ lane: 0, row: 12 })].id, 'video-two');
  assert.equal(records[projectAtCell({ lane: 1, row: 12 })].id, 'writing-one');
  assert.equal(records[projectAtCell({ lane: 2, row: 12 })].id, 'science-one');
  setProjects(fixtures.filter(project => project.kind !== 'writing'));
  assert.deepEqual(columnFiles(1), []);
  assert.equal(projectAtCell({ lane: 1, row: 12 }), -1);
  assert.equal(records[projectAtCell({ lane: 2, row: 12 })].id, 'science-one');
});

test('metadata refreshes preserve each ID in the same functional wave and row', () => {
  setProjects(fixtures);
  const before = records.map((project, index) => ({ id: project.id, location: fileLocation(index) }));
  setProjects(fixtures.slice().reverse().map(project => ({ ...project, title: '更新后的名称', updatedAt: '2026-12-01T00:00:00Z', cover: 'paper' })));
  assert.deepEqual(records.map((project, index) => ({ id: project.id, location: fileLocation(index) })), before);
});

const workspaceSource = (await fs.readFile(new URL('../public/project-workspace.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\s*$/gm, '').replace('export function createProjectWorkspace', 'function createProjectWorkspace');

function node() {
  const classes = new Set();
  return {
    dataset: {}, hidden: false, innerHTML: '',
    classList: { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value) },
    remove() {}, setAttribute() {}, querySelector: () => null,
  };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function controller(t, options = {}) {
  const calls = [], notices = [], opened = [], serverProjects = new Map(fixtures.map(project => [project.id, structuredClone(project)]));
  const integrations = {};
  const state = { view: 'home', projects: [], summaries: structuredClone(fixtures), writerId: 'writing-one', videoId: 'video-one', scienceId: 'science-one', saveQueue: Promise.resolve(), saveTimer: null };
  const native = {
    prepare: async project => { calls.push(`prepare:${project.id}`); if (options.prepare) await options.prepare(project); },
    flush: async () => { calls.push('flush-native'); if (options.flushNative) await options.flushNative(); },
    setVisible() {}, updateProject(project) { calls.push(`native-project:${project.id}`); }, dispose() {},
    getProject: () => serverProjects.get(state.videoId),
    seek: async target => { integrations.lastSeek = target; calls.push('native-seek'); },
    setSourceVersionStatus: (id, value) => { integrations.lastSourceStatus = { id, value }; calls.push(`source-status:${id}`); },
  };
  const home = Object.assign(() => {}, { setProjects() {}, setVisible() {}, editorStatus() {}, selectProject() {}, projectUpdated() {} });
  const context = {
    document: Object.assign(new EventTarget(), { createElement: node, body: { insertBefore() {}, append() {} } }),
    window: { matchMedia: () => ({ matches: true }) },
    api: async (path, body) => {
      calls.push(`api:${path}`);
      if (path === '/api/projects/summary') return { projects: [...serverProjects.values()] };
      const id = decodeURIComponent(path.split('/').at(-1));
      if (body) { const project = { ...serverProjects.get(id), ...body, id }; serverProjects.set(id, project); return { project: structuredClone(project) }; }
      if (!serverProjects.has(id)) throw Object.assign(new Error('项目不存在'), { code: 'PROJECT_NOT_FOUND' });
      return { project: structuredClone(serverProjects.get(id)) };
    },
    icon: () => '', escapeHtml: String, showModal: () => calls.push('new-project-dialog'), toast: message => notices.push(message), uid: () => 'new-test-project',
    mountRhineHome: () => home,
    createNativeStudio: (container, handlers) => { integrations.native = handlers; return native; },
    createOpenfilmActions: handlers => { integrations.actions = handlers; return { dispose() {}, importScript: async project => calls.push(`import-script:${project.id}`), showAnimation: project => calls.push(`show-animation:${project.id}`) }; },
    createEditorAssistant: () => ({ flush: async () => {}, dispose() {}, cancelProject: async () => {}, isBusy: () => false, updateProject: project => { calls.push(`assistant-project:${project.id}`); integrations.assistantProject = project; } }),
    createAppAssistant: handlers => { integrations.globalAssistant = handlers; return { open: value => { integrations.assistantSelection = value; calls.push('show-assistant'); }, dispose() {}, cancelProject: async () => {}, isBusy: () => false }; },
    createEditorReferences: () => ({
      async flush() { calls.push('flush-references'); await options.flushReferences?.(); },
      async cancelProject() {}, dispose() {},
    }),
    createSourceAnalysis: handlers => { integrations.analysis = handlers; return { show: async project => calls.push(`show-analysis:${project.id}`), dispose() {} }; },
    createSourceVersions: handlers => { integrations.versions = handlers; return { open: async project => calls.push(`show-versions:${project.id}`), status: async id => { calls.push(`compare-source:${id}`); return options.sourceStatus?.(id) || { projectId: id, status: 'in-sync', changes: [] }; }, dispose() {} }; },
    createExportPreflightUI: handlers => { integrations.preflight = handlers; return { open: async id => calls.push(`show-preflight:${id}`), beforeExport: async (id, spec) => { calls.push(`before-export:${id}`); return options.beforeExport ? options.beforeExport(id, spec) : true; }, dispose() {} }; },
    createProjectBundles: handlers => { integrations.bundles = handlers; return { openExport: project => calls.push(`backup:${project.id}`), openRestore: () => calls.push('restore-project'), dispose() {} }; },
    createTaskCenter: handlers => { integrations.tasks = handlers; return { open: value => { integrations.taskScope = { projectId: handlers.getProjectId(), options: value }; calls.push('show-tasks'); }, dispose() {} }; },
    requestAnimationFrame: options.requestAnimationFrame || (fn => queueMicrotask(fn)), setTimeout, clearTimeout, performance, DOMException, structuredClone, AbortController,
  };
  vm.createContext(context);
  vm.runInContext(workspaceSource, context);
  const desk = context.createProjectWorkspace({
    app: node(), state,
    saveProject: async project => { calls.push(`save:${project.id}`); return options.saveProject ? options.saveProject(project) : project; },
    beforeLeave: async params => { calls.push('before-leave'); await options.beforeLeave?.(params); },
    onLeave: view => { calls.push(`left:${view}`); options.onLeave?.(view); },
    onWriting: project => opened.push({ view: 'writer', project }), onScience: project => opened.push({ view: 'science', project }), onOtherView() {},
  });
  t.after(() => { clearTimeout(state.saveTimer); desk.dispose(); });
  return { desk, state, calls, opened, notices, serverProjects, integrations };
}

test('switching away from writing drains the pending edit before preparing the video editor', async t => {
  const saving = deferred();
  const run = controller(t, { saveProject: () => saving.promise });
  const draft = { ...fixtures[1], source: { text: '刚输入、尚未等到防抖保存的正文' } };
  run.desk.putProject(draft); run.state.view = 'writer';
  run.state.saveTimer = setTimeout(() => assert.fail('Navigation must drain this timer'), 30000);
  const opening = run.desk.enterEditor('video-one');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(run.calls.includes('save:writing-one'));
  assert.equal(run.calls.some(call => call.startsWith('prepare:')), false);
  saving.resolve(draft);
  await opening;
  assert.equal(run.state.saveTimer, null);
  assert.equal(run.state.view, 'video');
  assert.ok(run.calls.indexOf('save:writing-one') < run.calls.indexOf('prepare:video-one'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.integrations.lastSourceStatus.id, 'video-one', 'The version indicator must refresh for the video that actually opened');
});

test('failed pending writing saves keep the draft and prevent navigation', async t => {
  const run = controller(t, { saveProject: async () => null });
  const draft = { ...fixtures[1], source: { text: '保存失败也要保留的正文' } };
  run.desk.putProject(draft); run.state.view = 'writer'; run.state.saveTimer = setTimeout(() => {}, 30000);
  await run.desk.enterEditor('video-one');
  assert.equal(run.state.view, 'writer');
  assert.equal(run.calls.some(call => call.startsWith('prepare:')), false);
  assert.equal(run.state.projects.find(project => project.id === draft.id), draft);
  assert.match(run.notices.join('\n'), /尚未保存/);
});

test('reference saves finish before changing native projects and failures keep the current editor', async t => {
  const saving = deferred();
  const run = controller(t, { flushReferences: () => saving.promise });
  run.state.view = 'video'; run.state.videoId = 'video-one';
  const opening = run.desk.enterEditor('video-two');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(run.calls.includes('flush-references'));
  assert.equal(run.calls.some(call => call === 'prepare:video-two'), false);
  saving.reject(new Error('参考重点尚未保存'));
  await opening;
  assert.equal(run.state.videoId, 'video-one');
  assert.equal(run.calls.some(call => call === 'prepare:video-two'), false);
  assert.ok(run.notices.some(text => text.includes('参考重点尚未保存')));
});

test('a science project keeps its edited object when revisiting after another workspace', async t => {
  const run = controller(t);
  const project = { ...fixtures[2], science: { step: 'explain', result: { explanation: '尚在当前缓存中的讲解' } } };
  run.desk.putProject(project);
  await run.desk.enterEditor(project.id);
  await run.desk.enterEditor('writing-one');
  await run.desk.enterEditor(project.id);
  const scienceEntries = run.opened.filter(entry => entry.view === 'science');
  assert.equal(scienceEntries.length, 2);
  assert.equal(scienceEntries[0].project, project);
  assert.equal(scienceEntries[1].project, project);
  assert.equal(run.calls.includes(`api:/api/projects/${project.id}`), false);
});

test('switching native projects acknowledges the old edits before opening the next project', async t => {
  const draining = deferred();
  const run = controller(t, { flushNative: () => draining.promise });
  run.state.view = 'video';
  const opening = run.desk.enterEditor('video-two');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(run.calls.includes('flush-native'));
  assert.equal(run.calls.includes('api:/api/projects/video-two'), false);
  assert.equal(run.calls.includes('prepare:video-two'), false);
  draining.resolve();
  await opening;
  assert.ok(run.calls.indexOf('flush-native') < run.calls.indexOf('prepare:video-two'));
});

test('a converted video remembered by the writing workspace cannot displace an actual writing project', async t => {
  const run = controller(t);
  run.state.writerId = 'video-one';
  await run.desk.openLast('writer');
  assert.equal(run.opened.at(-1)?.view, 'writer');
  assert.equal(run.opened.at(-1)?.project.id, 'writing-one');
  assert.equal(run.opened.at(-1)?.project.kind, 'writing');
});

test('a failed video load leaves the current science workspace active and usable', async t => {
  const run = controller(t, { prepare: async () => { throw new Error('暂时无法载入剪辑项目'); } });
  run.state.view = 'science';
  await run.desk.enterEditor('video-one');
  assert.equal(run.state.view, 'science');
  assert.equal(run.calls.some(call => call.startsWith('left:')), false, 'The old workspace must only deactivate after its replacement is ready');
  assert.match(run.notices.join('\n'), /无法载入/);
});

test('a video transition waiting for paint cannot replace a newer workspace choice', async t => {
  const frames = [];
  const run = controller(t, { requestAnimationFrame: fn => frames.push(fn) });
  const enteringVideo = run.desk.enterEditor('video-one');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.length, 1, 'The video is ready but has not yet been painted');
  await run.desk.enterEditor('writing-one');
  assert.equal(run.state.view, 'writer');
  while (frames.length) frames.shift()();
  await enteringVideo;
  assert.equal(run.state.view, 'writer');
  assert.equal(run.calls.includes('left:writer'), false);
});

test('reading a backup cannot replace the cached project held by a background science operation', async t => {
  const run = controller(t);
  const active = await run.desk.loadProject('science-one');
  active.science = { result: null };
  await run.desk.enterEditor(active.id);
  const backup = await run.desk.readBackup(active.id);
  assert.notStrictEqual(backup, active);
  assert.strictEqual(await run.desk.loadProject(active.id), active);
  active.science.result = { title: '后台生成完成' };
  await run.desk.enterEditor('writing-one');
  await run.desk.enterEditor(active.id);
  assert.strictEqual(run.opened.at(-1).project, active);
  assert.equal(run.opened.at(-1).project.science.result.title, '后台生成完成');
});

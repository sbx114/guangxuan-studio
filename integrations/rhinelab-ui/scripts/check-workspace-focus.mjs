import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

// Vite resolves the existing extensionless TypeScript imports. Match that
// resolution for focused state tests without creating a renderer or browser.
const hook = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { ArchiveScene } = await import('../src/scene.ts');
const { setProjects } = await import('../src/data.ts');
hook.deregister();

function state() {
  const scene = {
    workspaceFocus: null, selectedCell: { lane: 0, row: 12 }, selectedProjectId: 'video-a', selectedSlot: 0, projectTopology: '',
    model: { visible: true }, outgoing: [], pulses: [], drawnCells: [], pendingPulse: null, hoverLifts: new Map(),
    lift: { value: .4, velocity: 0 }, rotation: 0, targetRotation: 0, returnY: null, targetDetail: 0, canInspect: false,
    columnCamera: { value: -7.5, velocity: .3 }, rail: { value: .2, velocity: -.1 }, laneFocus: { value: .2, velocity: .1 }, shoulder: { value: 12.2, velocity: .1 },
    clock: 10, lastInteraction: 0, targetReveal: 0, looping: false, loaded: true, deferSelectionPulse: false,
    cancelPointer() {}, setHover() {}, scene: { remove() {} }, appearance: { dispose() {} },
    decryption: { leave() {}, select() {} }, coverImages: { select() {} }, renderState: { invalidate() {} },
    emitPulse(cell) { this.pulses.push(cell); }, drawLabel(index) { this.drawnLabel = index; },
  };
  scene.focusWorkspace = ArchiveScene.prototype.focusWorkspace.bind(scene);
  scene.select = ArchiveScene.prototype.select.bind(scene);
  scene.syncProjects = ArchiveScene.prototype.syncProjects.bind(scene);
  return scene;
}

test('empty workspace focus moves only the target lane and preserves boot visibility and camera springs', () => {
  setProjects([{ id: 'video-a', title: '视频', kind: 'video', createdAt: '2026-01-01' }, { id: 'science-a', title: '科普', kind: 'science', createdAt: '2026-01-02' }]);
  const scene = state();
  const motion = structuredClone({ columnCamera: scene.columnCamera, rail: scene.rail, laneFocus: scene.laneFocus, shoulder: scene.shoulder });
  scene.focusWorkspace(1);
  assert.deepEqual(scene.selectedCell, { lane: 1, row: 12 }); assert.equal(scene.model.visible, false);
  assert.equal(scene.selectedProjectId, null); assert.equal(scene.selectedSlot, -1);
  assert.equal(scene.targetReveal, 0); assert.equal(scene.looping, false);
  assert.deepEqual({ columnCamera: scene.columnCamera, rail: scene.rail, laneFocus: scene.laneFocus, shoulder: scene.shoulder }, motion);
  scene.syncProjects(-1);
  assert.equal(scene.selectedProjectId, null); assert.equal(scene.selectedCell.lane, 1);
  scene.focusWorkspace(99); assert.equal(scene.selectedCell.lane, 1);
});

test('selecting a real project after an empty wave restores its model without cloning a synthetic outgoing project', () => {
  setProjects([{ id: 'video-a', title: '视频', kind: 'video', createdAt: '2026-01-01' }, { id: 'science-a', title: '科普', kind: 'science', createdAt: '2026-01-02' }]);
  const scene = state(); scene.focusWorkspace(1); scene.looping = true; scene.targetReveal = 1;
  scene.lift.value = .4; // The empty wave may have continued its ordinary spring simulation.
  scene.select(1);
  assert.equal(scene.selectedProjectId, 'science-a'); assert.equal(scene.model.visible, true);
  assert.equal(scene.workspaceFocus, null); assert.equal(scene.selectedCell.lane, 2);
  assert.equal(scene.drawnLabel, 1); assert.equal(scene.outgoing.length, 0);
  assert.equal(scene.targetReveal, 1); assert.equal(scene.looping, true);
});

test('an explicit no-selection sync cannot silently select the first project in another category', () => {
  setProjects([{ id: 'video-a', title: '视频', kind: 'video' }]);
  const scene = state(); scene.selectedCell = { lane: 2, row: 12 };
  scene.syncProjects(-1);
  assert.equal(scene.selectedProjectId, null); assert.equal(scene.selectedSlot, -1);
  assert.equal(scene.selectedCell.lane, 2); assert.equal(scene.model.visible, false);
});

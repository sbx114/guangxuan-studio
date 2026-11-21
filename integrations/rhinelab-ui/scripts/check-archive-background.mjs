import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ArchiveVisibility } from '../src/archive-visibility.ts';
import { records, setProjects, projectCells, projectAtCell } from '../src/data.ts';
import { fileAtCell, poolCell, LOOP_COLUMNS, LOOP_ROWS, COLUMN_SPACING, ROW_SPACING } from '../src/archive-loop.ts';

function visiblePool(width, height, selected = { lane: 2, row: 12 }) {
  const camera = new THREE.PerspectiveCamera(3, width / height, 5, 300);
  const distance = 140, span = width < height ? 12 : 7.33;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(span / (2 * distance)));
  camera.position.copy(new THREE.Vector3(-.81, .326, .487).normalize().multiplyScalar(distance));
  camera.lookAt(0, 0, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const visibility = new ArchiveVisibility();
  return visibility.update(camera, distance + 25, (selected.lane - 2) * COLUMN_SPACING, -2.17 - (selected.row - 15.5) * ROW_SPACING, false);
}

test('empty projects retain a dense original lattice without selectable project IDs', () => {
  setProjects([]);
  const opening = Array.from({ length: LOOP_COLUMNS * LOOP_ROWS }, (_, index) => poolCell(index));
  assert.equal(opening.length, 288);
  for (const [width, height] of [[1440, 940], [1920, 1080], [390, 844]]) {
    const cells = visiblePool(width, height);
    assert.ok(cells.length > 100, `${width}x${height} should retain the wave field`);
    assert.equal(new Set(cells.map(cell => `${cell.lane}:${cell.row}`)).size, cells.length);
    assert.ok(cells.every(cell => projectAtCell(cell) === -1 && fileAtCell(cell) === -1));
  }
  assert.equal(records.length, 0); assert.equal(projectCells().length, 0);
});

test('dense background cells do not duplicate or renumber the two real projects', () => {
  setProjects([{ id: 'real-a', title: '项目甲', kind: 'video', createdAt: '2026-01-01' }, { id: 'real-b', title: '项目乙', kind: 'video', createdAt: '2026-01-02' }]);
  const actual = projectCells();
  for (const selected of actual) {
    const cells = visiblePool(1440, 940, selected);
    const ids = cells.map(cell => records[projectAtCell(cell)]?.id).filter(Boolean);
    assert.ok(cells.length > actual.length * 20);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(records[projectAtCell(selected)].id));
    assert.ok(ids.every(id => id === 'real-a' || id === 'real-b'));
  }
  assert.equal(records.length, 2); assert.equal(actual.length, 2);
  assert.equal(projectAtCell({ lane: 2, row: 12 }), -1);
});

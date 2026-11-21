import assert from 'node:assert/strict';
import { test } from 'node:test';
import { records, setProjects, mergeProject, projectCells, projectAtCell, fileLocation, fileAtSlot, columnFiles } from '../src/data.ts';
import { fileAtCell, selectionCell } from '../src/archive-loop.ts';
import { normalizeQuality, qualityPresets, matchingPreset } from '../src/render-quality.ts';

function project(index, extra = {}) {
  return { id: `project-${String(index).padStart(4, '0')}`, title: `项目 ${index}`, kind: index % 2 ? 'writing' : 'video', description: '', createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), updatedAt: '2026-11-16T08:00:00.000Z', duration: 12, clipCount: 3, wordCount: 150, outputCount: 4, ...extra };
}

test('empty archive has no record, cell or selectable placeholder', () => {
  setProjects([]);
  assert.equal(records.length, 0); assert.equal(projectCells().length, 0);
  assert.equal(fileAtSlot(0), -1); assert.equal(projectAtCell({ lane: 2, row: 12 }), -1);
});

test('each real project has exactly one canonical cell without row or column wrapping', () => {
  setProjects(Array.from({ length: 27 }, (_, index) => project(index)));
  assert.equal(records.length, 27);
  assert.equal(new Set(projectCells().map(cell => `${cell.lane}:${cell.row}`)).size, 27);
  records.forEach((record, index) => {
    const cell = projectCells()[index];
    assert.equal(projectAtCell(cell), index); assert.equal(fileAtCell(cell), index);
    assert.equal(fileAtSlot(fileLocation(index).slot), index);
    assert.deepEqual(selectionCell(index, { lane: -100, row: 300 }), cell);
    assert.equal(fileAtCell({ lane: cell.lane + 5, row: cell.row }), -1);
    assert.equal(fileAtCell({ lane: cell.lane, row: cell.row + 32 }), -1);
  });
  assert.deepEqual(columnFiles(0), Array.from({ length: 14 }, (_, index) => index * 2));
  assert.deepEqual(columnFiles(1), Array.from({ length: 13 }, (_, index) => index * 2 + 1));
  assert.deepEqual(columnFiles(2), []);
});

test('one physical wave holds every project of one kind while all kinds stay in records', () => {
  setProjects([project(0), project(1), project(2, { kind: 'science' }), project(3, { kind: 'video' }), project(4, { kind: 'writing' }), project(5, { kind: 'science' })]);
  assert.equal(records.length, 6);
  assert.deepEqual(projectCells(), [{ lane: 0, row: 12 }, { lane: 1, row: 12 }, { lane: 2, row: 12 }, { lane: 0, row: 13 }, { lane: 1, row: 13 }, { lane: 2, row: 13 }]);
  assert.deepEqual(columnFiles(0), [0, 3]); assert.deepEqual(columnFiles(1), [1, 4]); assert.deepEqual(columnFiles(2), [2, 5]);
  const before = projectCells().map(cell => ({ ...cell }));
  for (const lane of [2, 1, 0, 1, 2]) for (const index of columnFiles(lane)) assert.equal(fileLocation(index).lane, lane);
  assert.deepEqual(projectCells(), before, 'browsing another wave must not filter or reposition records');
  setProjects([...records, project(6, { kind: 'video' })]);
  assert.equal(projectAtCell({ lane: 1, row: 13 }), 4); assert.equal(projectAtCell({ lane: 2, row: 13 }), 5);
  assert.equal(projectAtCell({ lane: 0, row: 14 }), 6);
});

test('an empty category has no project and kind updates relocate only the affected lanes', () => {
  setProjects([project(0), project(1, { kind: 'video' }), project(2, { kind: 'science' })]);
  assert.deepEqual(columnFiles(1), []); assert.equal(projectAtCell({ lane: 1, row: 12 }), -1);
  mergeProject({ id: records[1].id, kind: 'writing' });
  assert.deepEqual(columnFiles(0), [0]); assert.deepEqual(columnFiles(1), [1]); assert.deepEqual(columnFiles(2), [2]);
  assert.equal(projectAtCell({ lane: 0, row: 13 }), -1); assert.equal(projectAtCell({ lane: 1, row: 12 }), 1);
});

test('metadata-only updates retain createdAt + id layout order', () => {
  const original = Array.from({ length: 8 }, (_, index) => project(index));
  setProjects(original); const before = records.map(record => ({ id: record.id, cell: fileLocation(records.indexOf(record)) }));
  setProjects(original.slice().reverse().map(record => ({ ...record, title: '重命名 ' + record.title, updatedAt: '2026-12-31T23:59:00.000Z' })));
  assert.deepEqual(records.map((record, index) => ({ id: record.id, cell: fileLocation(index) })), before);
  assert.match(records[0].title, /重命名/);
});

test('duplicate/invalid IDs and kinds never create duplicate cubes', () => {
  setProjects([project(0), project(0, { title: '重复' }), project(1), project(2, { id: '../escape' }), project(3, { kind: 'unavailable' })]);
  assert.deepEqual(records.map(record => record.id), ['project-0000', 'project-0001']);
  assert.equal(projectCells().length, 2);
});

test('metadata keeps only public summary fields, and edits preserve statistics', () => {
  setProjects([project(0, { source: { text: '正文不应传入' }, apiKey: 'synthetic-secret', description: '原简介' })]);
  assert.equal(records[0].source, ''); assert.equal('apiKey' in records[0], false);
  const updated = mergeProject({ id: 'project-0000', title: '已保存名称', description: '新简介', apiKey: 'synthetic-secret' });
  assert.equal(updated.title, '已保存名称'); assert.equal(updated.description, '新简介'); assert.equal(updated.clipCount, 3);
  assert.equal('apiKey' in updated, false);
  assert.equal(mergeProject({ id: 'missing', title: '不会创建' }), null);
});

test('removing all projects removes every finite mapping', () => {
  setProjects([project(0), project(1)]); setProjects([]);
  assert.equal(projectCells().length, 0); assert.equal(projectAtCell({ lane: 0, row: 12 }), -1);
});

test('unknown duration stays unknown rather than becoming zero', () => {
  setProjects([project(0, { duration: null }), project(1, { duration: 0 })]);
  assert.equal(records[0].duration, null);
  assert.equal(records[1].duration, 0);
  mergeProject({ id: 'project-0000', title: '名称更新' });
  assert.equal(records[0].duration, null);
});

test('science projects and per-project covers survive archive updates while unknown covers fall back', () => {
  setProjects([project(0, { kind: 'science', cover: 'blueprint' }), project(1, { cover: 'unknown-legacy-cover' }), project(2)]);
  assert.equal(records[0].kind, 'science');
  assert.equal(records[0].category, '科普项目');
  assert.equal(records[0].department, '科普');
  assert.equal(records[0].en, 'SCIENCE PROJECT');
  assert.equal(records[0].cover, 'blueprint');
  assert.equal(records[1].cover, 'classic');
  assert.equal(records[2].cover, 'classic');
  mergeProject({ id: records[0].id, title: '改名后仍保留封面' });
  assert.equal(records[0].cover, 'blueprint');
  mergeProject({ id: records[0].id, cover: 'film' });
  assert.equal(records[0].cover, 'film');
  assert.equal(records[1].cover, 'classic');
});

test('original is the default while explicit quality presets survive normalization', () => {
  const original = normalizeQuality(undefined);
  assert.equal(matchingPreset(original), 'original'); assert.equal(original.aoSamples, 32); assert.equal(original.aoResolution, 1); assert.equal(original.pixelRatio, 1.5);
  assert.deepEqual(normalizeQuality(qualityPresets.high), qualityPresets.high);
  assert.deepEqual(normalizeQuality(qualityPresets.original), qualityPresets.original);
});

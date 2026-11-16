import test from 'node:test';
import assert from 'node:assert/strict';
import { rhineCommand, publicProjectSummary } from '../public/rhine-host.js';

test('a project-entry message preserves the exact archive ID and cannot become a generic editor command', () => {
  const frame = {}, origin = 'http://127.0.0.1:4417';
  for (const projectId of ['project-a', 'project-b']) {
    assert.deepEqual(rhineCommand({ type: 'guangxuan:edit-project', projectId, view: 'settings' }, origin, frame, origin, frame), { type: 'edit-project', projectId });
  }
  assert.equal(rhineCommand({ type: 'guangxuan:edit-project', projectId: '../other' }, origin, frame, origin, frame), null);
  assert.equal(rhineCommand({ type: 'guangxuan:edit-project', projectId: 'project-a' }, 'https://outside.example', frame, origin, frame), null);
});

test('rename requests validate the editable metadata and retain the acknowledgement ID', () => {
  const frame = {}, origin = 'http://127.0.0.1:4417';
  const command = rhineCommand({ type: 'guangxuan:update-project', projectId: 'project-a', requestId: 'request-a', title: '  校园短片  ', description: '制作说明', apiKey: 'not-forwarded' }, origin, frame, origin, frame);
  assert.deepEqual(command, { type: 'update-project', projectId: 'project-a', requestId: 'request-a', title: '校园短片', description: '制作说明' });
  const invalid = rhineCommand({ type: 'guangxuan:update-project', projectId: 'project-a', requestId: 'request-b', title: ' ', description: '说明' }, origin, frame, origin, frame);
  assert.ok(invalid.error);
  assert.equal(invalid.requestId, 'request-b');
});

test('the 3D archive receives metadata rather than writing contents, credentials or native capabilities', () => {
  const summary = publicProjectSummary({ id: 'project-a', title: '项目', kind: 'video', description: '简介', createdAt: '2026-11-16', updatedAt: '2026-11-16', duration: null, clipCount: 2, wordCount: 3, outputCount: 1,
    source: { text: 'private writing contents' }, apiKey: 'private-key', editorUrl: 'http://127.0.0.1:9999/?key=private', nativeProjectId: 'native-a' });
  assert.equal(summary.duration, null);
  assert.equal(summary.clipCount, 2);
  assert.equal('source' in summary, false);
  assert.equal('apiKey' in summary, false);
  assert.equal('editorUrl' in summary, false);
  assert.equal('nativeProjectId' in summary, false);
  assert.equal(publicProjectSummary({ id: 'project-b', kind: 'video', duration: 0 }).duration, 0);
});

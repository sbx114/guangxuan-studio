import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code = await fs.readFile(new URL('../public/openfilm-shell.js', import.meta.url), 'utf8');
function shell() {
  const sent = [], forwarded = [], events = {};
  const parent = { postMessage: data => sent.push(data) }, editor = { postMessage: data => forwarded.push(data) };
  const studio = { src: 'http://127.0.0.1:50000/projects/native-a?key=test-capability', contentWindow: editor, addEventListener: (name, fn) => events['studio-' + name] = fn };
  const scope = { URL, location: { origin: 'http://127.0.0.1:4437' }, document: { querySelector: () => studio, body: { dataset: { projectId: 'root-a', nativeProjectId: 'native-a', sessionId: 'session-a' } } }, window: { parent, addEventListener: (name, fn) => events[name] = fn } };
  vm.runInNewContext(code, scope);
  return { sent, forwarded, parent, editor, emit: (data, from = editor, origin = 'http://127.0.0.1:50000') => events.message({ data, source: from, origin }) };
}

test('native and compound views resolve to the same root project without exposing the native capability', () => {
  const s = shell();
  s.emit({ type: 'guangxuan:studio-ready', nativeProjectId: 'native-a' });
  s.emit({ type: 'guangxuan:studio-ready', nativeProjectId: 'compound-a', ownerNativeProjectId: 'native-a' });
  assert.equal(s.sent.length, 2);
  for (const message of s.sent) {
    assert.equal(message.projectId, 'root-a'); assert.equal(message.sessionId, 'session-a');
    assert.equal('nativeProjectId' in message, false); assert.equal('key' in message, false);
  }
});

test('an unrelated native project cannot silently retain the old outer project identity', () => {
  const s = shell();
  s.emit({ type: 'guangxuan:studio-ready', nativeProjectId: 'native-a' });
  s.emit({ type: 'guangxuan:studio-ready', nativeProjectId: 'native-b' });
  assert.equal(s.sent.at(-1).type, 'guangxuan:studio-unexpected-project');
  s.emit({ type: 'guangxuan:studio-ready', nativeProjectId: 'native-a' }, {}, 'https://outside.example');
  assert.equal(s.sent.length, 2);
});

test('metadata does not navigate native views and flush errors are preserved', () => {
  const s = shell();
  s.emit({ type: 'guangxuan:studio-metadata', projectId: 'root-a', nativeProjectId: 'native-a', title: '新名称' }, s.parent, 'http://127.0.0.1:4437');
  assert.equal(s.forwarded.at(-1).type, 'guangxuan:studio-metadata');
  s.emit({ type: 'guangxuan:studio-flushed', requestId: 'request-a', error: '尚未保存' });
  assert.equal(s.sent.at(-1).error, '尚未保存');
});

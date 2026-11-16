import test from 'node:test';
import assert from 'node:assert/strict';
import { rhineCommand } from '../public/rhine-host.js';

test('the homepage can only navigate through the expected same-origin frame', () => {
  const source = {}, otherFrame = {};
  const origin = 'http://127.0.0.1:4417';
  const data = { type: 'guangxuan:open', view: 'video', apiKey: 'must-not-propagate' };
  assert.deepEqual(rhineCommand(data, origin, source, origin, source), { type: 'open', view: 'video' });
  assert.equal(rhineCommand(data, 'https://untrusted.example', source, origin, source), null);
  assert.equal(rhineCommand(data, origin, otherFrame, origin, source), null);
});

test('homepage navigation rejects arbitrary actions, paths, and incomplete modules', () => {
  const source = {}, origin = 'http://127.0.0.1:4417';
  for (const view of ['https://untrusted.example', '../settings', 'science', 'delete', '__proto__']) {
    assert.equal(rhineCommand({ type: 'guangxuan:open', view }, origin, source, origin, source), null);
  }
  assert.equal(rhineCommand({ type: 'save-key', view: 'settings' }, origin, source, origin, source), null);
  assert.deepEqual(rhineCommand({ type: 'guangxuan:ready' }, origin, source, origin, source), { type: 'ready' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';

test('project summary reflects newer native film/canvas changes without rewriting the original JSON', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-native-summary-'));
  let app;
  t.after(async () => {
    await app?.close();
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-native-summary-')) throw new Error('Refusing unsafe cleanup target');
    await rm(resolved, { recursive: true, force: true });
  });
  app = await startServer({ dataDir, port: 0 });
  const created = await fetch(`${app.url}/api/projects/native-timestamp`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Native timestamp fixture', kind: 'video', source: { text: 'Keep this exact original project.' }, video: { timeline: [] } }) });
  assert.equal(created.status, 200);
  const { project } = await created.json();
  const jsonPath = path.join(dataDir, 'projects/native-timestamp.json');
  const originalBytes = await readFile(jsonPath);
  const nativeDirectory = path.join(dataDir, 'openfilm/projects/native-timestamp');
  await mkdir(path.join(nativeDirectory, '.film'), { recursive: true });
  const film = path.join(nativeDirectory, 'film.html');
  const canvas = path.join(nativeDirectory, '.film/canvas.json');
  await writeFile(film, '<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"></head><body></body></html>');
  const base = Math.floor(Date.parse(project.updatedAt) / 1000) * 1000;
  async function setTime(filename, timestamp) { const date = new Date(timestamp); await utimes(filename, date, date); }
  async function summary() {
    const response = await fetch(`${app.url}/api/projects/summary`);
    assert.equal(response.status, 200);
    return (await response.json()).projects.find(item => item.id === project.id);
  }

  await setTime(film, base - 60000);
  assert.equal((await summary()).updatedAt, project.updatedAt, 'An older native file must not replace newer root metadata');
  await setTime(film, base + 60000);
  assert.equal((await summary()).updatedAt, new Date(base + 60000).toISOString());
  await writeFile(canvas, JSON.stringify({ nodes: [] }));
  await setTime(canvas, base + 120000);
  assert.equal((await summary()).updatedAt, new Date(base + 120000).toISOString());
  await setTime(canvas, base - 30000);
  assert.equal((await summary()).updatedAt, new Date(base + 60000).toISOString(), 'An older canvas cannot move the summary timestamp backwards');
  assert.deepEqual(await readFile(jsonPath), originalBytes, 'Summary reads must never rewrite the legacy project JSON');
});

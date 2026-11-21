import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { prepareNativeExportDownload } from '../lib/native-export-download.mjs';

export function storedZipEntries(bytes) {
  const entries = new Map(); let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), start = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.subarray(start, start + length)); offset = start + length;
  }
  return entries;
}
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-native-export-download-')), exportsRoot = path.join(directory, 'exports');
  await mkdir(exportsRoot);
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-native-export-download-')); await rm(directory, { recursive: true, force: true }); });
  const job = outputs => ({ id: 'job-one', project: 'owner', name: '完整导出', status: 'done', outputs });
  return { directory, exportsRoot, job, prepare: value => prepareNativeExportDownload({ exportsRoot, projectId: 'owner', job: value }) };
}

test('one finished media output downloads unchanged with correct MIME', async t => {
  const f = await fixture(t), filename = path.join(f.exportsRoot, 'movie.webm'), bytes = Buffer.from('one-media-file'); await writeFile(filename, bytes);
  const result = await f.prepare(f.job([filename]));
  assert.equal(result.path, filename); assert.equal(result.contentType, 'video/webm'); assert.equal(result.size, bytes.length); assert.deepEqual(await readFile(result.path), bytes);
});

test('NLE XML and media outputs download as one ZIP retaining project-relative folders', async t => {
  const f = await fixture(t), folder = path.join(f.exportsRoot, 'Editorial'), media = path.join(folder, 'media'); await mkdir(media, { recursive: true });
  const xml = path.join(folder, 'Editorial.xml'), movie = path.join(media, 'clip.mov'); await writeFile(xml, '<xmeml/>'); await writeFile(movie, 'mov-bytes');
  const result = await f.prepare(f.job([xml, movie])), entries = storedZipEntries(await readFile(result.path));
  assert.equal(result.contentType, 'application/zip'); assert.equal(result.name, '完整导出.zip');
  assert.deepEqual([...entries.keys()].sort(), ['Editorial/Editorial.xml', 'Editorial/media/clip.mov']);
  assert.equal(entries.get('Editorial/media/clip.mov').toString(), 'mov-bytes');
  assert.equal((await f.prepare(f.job([xml, movie]))).path, result.path, 'An unchanged finished export reuses its prepared archive.');
});

test('project-folder export downloads all nested files in a ZIP', async t => {
  const f = await fixture(t), folder = path.join(f.exportsRoot, 'NativeProject'); await mkdir(path.join(folder, 'pages'), { recursive: true });
  await writeFile(path.join(folder, 'film.html'), '<html>film</html>'); await writeFile(path.join(folder, 'pages', 'scene.html'), '<html>scene</html>');
  const result = await f.prepare(f.job([folder])), entries = storedZipEntries(await readFile(result.path));
  assert.deepEqual([...entries.keys()].sort(), ['NativeProject/film.html', 'NativeProject/pages/scene.html']);
});

for (const kind of ['audio stems', 'individual stills']) test(`${kind} export downloads every file together`, async t => {
  const f = await fixture(t), first = path.join(f.exportsRoot, kind + '-one.wav'), second = path.join(f.exportsRoot, kind + '-two.wav');
  await writeFile(first, 'first'); await writeFile(second, 'second');
  const entries = storedZipEntries(await readFile((await f.prepare(f.job([first, second]))).path));
  assert.equal(entries.size, 2); assert.equal(entries.get(path.basename(first)).toString(), 'first'); assert.equal(entries.get(path.basename(second)).toString(), 'second');
});

test('only the owning project finished outputs are downloadable', async t => {
  const f = await fixture(t), filename = path.join(f.exportsRoot, 'video.mp4'); await writeFile(filename, 'owned');
  for (const job of [{ ...f.job([filename]), project: 'other' }, { ...f.job([filename]), status: 'running' }, f.job([])]) await assert.rejects(f.prepare(job), { status: 404 });
  const outside = path.join(f.directory, 'outside.txt'); await writeFile(outside, 'private');
  await assert.rejects(f.prepare(f.job([outside])), { status: 403, code: 'OPENFILM_EXPORT_STORAGE' });
  await assert.rejects(f.prepare(f.job(['relative.txt'])), { status: 403, code: 'OPENFILM_EXPORT_STORAGE' });
  await assert.rejects(f.prepare(f.job([f.exportsRoot])), { status: 403, code: 'OPENFILM_EXPORT_STORAGE' });
});

test('directory junctions cannot cause external files to enter an export ZIP', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'outside'), folder = path.join(f.exportsRoot, 'Project');
  await mkdir(outside); await mkdir(folder); await writeFile(path.join(outside, 'private.txt'), 'private');
  await symlink(outside, path.join(folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.prepare(f.job([folder])), { status: 403, code: 'OPENFILM_EXPORT_STORAGE' });
  assert.deepEqual(await readdir(outside), ['private.txt']);
});

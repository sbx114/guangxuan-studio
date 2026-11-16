import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
// Strip only known upstream demo / PWA assets from this build output.
for (const relative of ['audio/typing-preview.wav', 'audio/typing-source.json', 'icons', 'archives', 'manifest.webmanifest', 'sw.js']) {
  const target = path.resolve(output, relative);
  if (!target.startsWith(output + path.sep)) throw new Error('Invalid build cleanup path');
  await rm(target, { recursive: true, force: true });
}
await mkdir(path.join(output, 'licenses'), { recursive: true });
await copyFile(path.join(root, 'LICENSE'), path.join(output, 'licenses', 'RhineLabUI-MIT.txt'));
await copyFile(path.join(root, 'node_modules', 'three', 'LICENSE'), path.join(output, 'licenses', 'Three-MIT.txt'));
const noticePath = path.join(output, 'fonts', 'NOTICE.txt');
const notice = await readFile(noticePath, 'utf8');
await writeFile(noticePath, '本软件使用 MiSans 字体。\n\n' + notice, 'utf8');
const audioReadme = '# Original music and synthesized interface sounds\n\nThe atmosphere, motif and pulse Ogg tracks are original works distributed under the upstream MIT license.\nThis embedded build uses locally synthesized typing cues. It includes no third-party PV typing recording.\n';
await writeFile(path.join(output, 'audio', 'README.md'), audioReadme, 'utf8');
console.log('Prepared embedded portal assets and bundled notices.');

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(await readFile(new URL('./reference-downloader-manifest.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2), index = args.indexOf('--output-dir');
if (index < 0 || !args[index + 1] || !path.isAbsolute(args[index + 1]) || args.some((value, i) => i !== index && i !== index + 1)) {
  throw new Error('Provide exactly --output-dir <absolute directory>; this script never installs or executes the tool.');
}
const output = path.resolve(args[index + 1]);
await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink() || await realpath(output) !== output) throw new Error('Use an ordinary output directory, not a linked directory.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function response(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['github.com', 'api.github.com', 'www.gnu.org'].includes(parsed.hostname)) throw new Error('Unexpected tool source.');
  const result = await fetch(parsed, { headers: { 'User-Agent': 'GuangxuanStudio-reference-tools' }, signal: AbortSignal.timeout(120000) });
  if (!result.ok) throw new Error(`Official download failed: HTTP ${result.status} (${parsed.hostname})`);
  return result;
}
async function smallText(url, limit = 2 * 1024 * 1024) {
  const result = await response(url), chunks = []; let size = 0;
  for await (const chunk of Readable.fromWeb(result.body)) { size += chunk.length; if (size > limit) throw new Error('Official text response exceeds its limit.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
async function repoText(name) {
  const result = JSON.parse(await smallText(`https://api.github.com/repos/yt-dlp/yt-dlp/contents/${name}?ref=${manifest.version}`));
  if (result.encoding !== 'base64' || typeof result.content !== 'string') throw new Error('Unexpected official repository response.');
  return Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

const sums = await smallText(manifest.checksumsUrl);
if (digest(sums) !== manifest.checksumsSha256) throw new Error('The official checksum file differs from the pinned release.');
const checksum = sums.split(/\r?\n/).find(line => new RegExp(`\\s+\\*?${manifest.filename.replace('.', '\\.')}\\s*$`).test(line))?.trim().split(/\s+/)[0];
if (checksum !== manifest.sha256) throw new Error('Pinned executable checksum does not match the official checksum list.');
const [license, readme, gpl] = await Promise.all([repoText('LICENSE'), repoText('README.md'), smallText(manifest.gplLicenseUrl)]);
if (!gpl.includes('GNU GENERAL PUBLIC LICENSE') || !gpl.includes('Version 3')) throw new Error('The GPL license response is incomplete.');
const destination = path.join(output, manifest.filename);
let exists = false;
try { const info = await lstat(destination); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Executable target is not an ordinary file.'); exists = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (exists && await fileDigest(destination) !== manifest.sha256) throw new Error('A different executable exists at the target; it was not overwritten.');
if (!exists) {
  const temporary = path.join(output, `.yt-dlp-${randomUUID()}.partial`);
  try {
    const result = await response(manifest.downloadUrl); let size = 0;
    const limiter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > manifest.bytes ? new Error('Executable exceeds pinned release size.') : null, chunk); } });
    await pipeline(Readable.fromWeb(result.body), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (size !== manifest.bytes || await fileDigest(temporary) !== manifest.sha256) throw new Error('Executable size or SHA256 verification failed.');
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
for (const [name, text] of [
  ['SHA2-256SUMS', sums],
  ['yt-dlp-SOURCE-LICENSE.txt', license],
  ['yt-dlp-BINARY-GPL-3.0.txt', gpl],
  ['yt-dlp-README.md', readme],
]) await writeFile(path.join(output, name), text, 'utf8');
await writeFile(path.join(output, 'reference-downloader.json'), JSON.stringify({ ...manifest, verifiedAt: new Date().toISOString(), verifiedSha256: await fileDigest(destination), setupScript: path.basename(fileURLToPath(import.meta.url)) }, null, 2));
console.log(JSON.stringify({ executable: destination, version: manifest.version, sha256: manifest.sha256, verified: true, executed: false, license: manifest.standaloneBinaryLicense }));

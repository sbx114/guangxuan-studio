import { Worker } from 'node:worker_threads';
import { AppError, boundedString, requireObject } from './errors.mjs';

const MAX_FILE = 10 * 1024 * 1024;
/** Reuses the local bounded document parser; importing never calls a model. */
export function importWritingDocument(input, { signal, timeoutMs = 45000 } = {}) {
  requireObject(input);
  const name = boundedString(input.name, '文件名', 300);
  const encoded = boundedString(input.contentBase64, '文件内容', Math.ceil(MAX_FILE * 4 / 3) + 8);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new AppError(400, '文件编码不正确，请重新选择原文件。', 'WRITING_IMPORT_ENCODING');
  const bytes = Buffer.from(encoded, 'base64'), format = name.split('.').at(-1).toLowerCase();
  if (!bytes.length || bytes.length > MAX_FILE) throw new AppError(413, '请选择非空且不超过10 MiB的材料文件。', 'WRITING_IMPORT_SIZE');
  if (!['pdf', 'docx', 'txt', 'md', 'markdown'].includes(format)) throw new AppError(415, '支持PDF、Word、TXT和Markdown；也可以直接粘贴文字。', 'WRITING_IMPORT_FORMAT');
  if (signal?.aborted) throw new AppError(499, '材料导入已取消。', 'WRITING_IMPORT_CANCELLED');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./science-document-worker.mjs', import.meta.url), { workerData: { bytes: new Uint8Array(bytes), format }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
    let settled = false;
    const timer = setTimeout(() => finish(new AppError(408, '材料解析较慢，请尝试较小的文件或粘贴所需部分。', 'WRITING_IMPORT_TIMEOUT')), Math.max(50, Math.min(120000, Number(timeoutMs) || 45000)));
    const stop = () => finish(new AppError(499, '材料导入已取消。', 'WRITING_IMPORT_CANCELLED'));
    async function finish(error, result) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); await worker.terminate().catch(() => {});
      error ? reject(error) : resolve(result);
    }
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    worker.on('message', value => {
      if (!value?.ok) return finish(new AppError(400, value?.error?.message || '未能提取材料文字，请换一个文件或粘贴正文。', ['SCIENCE_PDF_NO_TEXT', 'SCIENCE_DOCUMENT_EMPTY'].includes(value?.error?.code) ? 'WRITING_IMPORT_NO_TEXT' : value?.error?.code || 'WRITING_IMPORT_FAILED'));
      const text = (value.result?.pages || []).map(page => page.text || '').join('\n\n').trim();
      if (!text) return finish(new AppError(422, '未提取到正文文字。图片型或扫描文件请换成文字版本，或粘贴需要的内容。', 'WRITING_IMPORT_NO_TEXT'));
      if (text.length > 60000) return finish(new AppError(413, '材料超过60000字，请节选本次需要的部分后导入，不会自动截断原文。', 'WRITING_IMPORT_TOO_LONG'));
      finish(null, { name, text, characterCount: text.length, pageCount: value.result?.pageCount, warnings: (value.result?.warnings || []).slice(0, 40) });
    });
    worker.on('error', () => finish(new AppError(413, '文件解析超过可用资源，请使用较小材料或复制正文。', 'WRITING_IMPORT_RESOURCE')));
    worker.on('exit', () => { if (!settled) finish(new AppError(422, '材料解析未完成，原文件没有改动。', 'WRITING_IMPORT_FAILED')); });
  });
}

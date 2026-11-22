import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { directingCueText, directingMaterialCues } from './remotion-directing.mjs';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remotion-references', 'shotcraft');
const keyPattern = /^[a-z0-9][a-z0-9-]{0,80}$/;
const sourceFilePattern = /^[A-Za-z0-9._-]+\.source\.txt$/;
const fail = (status, message, code) => new AppError(status, message, code);
export const REMOTION_REFERENCE_ORIGIN = Object.freeze({ repository: 'https://github.com/Vincentwei1021/video-shotcraft', commit: '075b548c2405a07b77129eb448b0b504fc60dea3', license: 'Apache-2.0' });
let manifestPromise;

async function manifest() {
  manifestPromise ||= (async () => {
    const value = JSON.parse(await readFile(path.join(directory, 'origin-manifest.json'), 'utf8'));
    if (value.schemaVersion !== 1 || value.commit !== REMOTION_REFERENCE_ORIGIN.commit || value.repository !== REMOTION_REFERENCE_ORIGIN.repository || !Array.isArray(value.references) || !value.sources || typeof value.sources !== 'object') throw fail(500, '本机Remotion参考资料不完整。', 'REMOTION_REFERENCE_INVALID');
    const seen = new Set();
    for (const reference of value.references) {
      if (!keyPattern.test(reference.key) || seen.has(reference.key) || !value.sources[reference.sourcePath] || !Array.isArray(reference.tags) || !Array.isArray(reference.relatedPaths)) throw fail(500, '本机Remotion参考索引不完整。', 'REMOTION_REFERENCE_INVALID');
      seen.add(reference.key);
      for (const name of [reference.sourcePath, ...reference.relatedPaths]) {
        const source = value.sources[name];
        if (!source || !sourceFilePattern.test(source.file) || source.file.includes('..') || source.path !== name || source.commit !== value.commit || !/^[a-f0-9]{64}$/.test(source.sha256)) throw fail(500, '本机Remotion参考索引包含无效路径。', 'REMOTION_REFERENCE_INVALID');
      }
    }
    return value;
  })().catch(error => { manifestPromise = null; throw error; });
  return manifestPromise;
}
function origin(source) {
  return { repository: source.repository, commit: source.commit, path: source.path, url: source.url, sha256: source.sha256, gitBlobSha: source.gitBlobSha, bytes: source.bytes, license: source.license };
}
function summary(reference, index) {
  return { key: reference.key, title: reference.title, tags: [...reference.tags], summary: reference.summary, kind: reference.kind, source: origin(index.sources[reference.sourcePath]) };
}
async function verifiedText(source) {
  // The caller can supply a key only. Filenames come exclusively from the
  // pinned bundled index, are flat .source.txt data and are never imported.
  const filename = path.join(directory, source.file), root = await realpath(directory), info = await lstat(filename);
  const actual = await realpath(filename), relative = path.relative(root, actual);
  if (!info.isFile() || info.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative)) throw fail(500, '本机Remotion参考源码不是普通资料文件。', 'REMOTION_REFERENCE_INVALID');
  const bytes = await readFile(filename);
  if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw fail(409, '本机Remotion参考源码与固定版本不一致。', 'REMOTION_REFERENCE_CHANGED');
  return bytes.toString('utf8');
}

/** Local metadata search; no network, code execution or scene selection occurs. */
export async function searchRemotionReferences(query, { limit = 3 } = {}) {
  if (typeof query !== 'string' || query.length > 20000 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw fail(400, '参考检索需要文字要求，数量为1至10。', 'REMOTION_REFERENCE_QUERY');
  const index = await manifest(), text = query.toLowerCase().normalize('NFKC').trim();
  const all = !text || /^(?:全部|所有|all|list)$/.test(text), words = [...new Set(text.match(/[a-z][a-z0-9._-]{1,}/g) || [])];
  const matches = index.references.map((reference, position) => {
    let score = 0;
    for (const tag of reference.tags) if (text.includes(tag.toLowerCase())) score += 8;
    const content = `${reference.key} ${reference.title} ${reference.summary} ${reference.tags.join(' ')}`.toLowerCase();
    for (const word of words) if (content.includes(word)) score += 2;
    return { reference, position, score };
  }).filter(item => all || item.score > 0).sort((a, b) => b.score - a.score || a.position - b.position).slice(0, limit);
  return matches.map(item => summary(item.reference, index));
}

/** Retrieve reviewed upstream source as plain text for independent adaptation. */
export async function readRemotionReference(key) {
  if (typeof key !== 'string' || !keyPattern.test(key)) throw fail(404, '没有这个Remotion源码参考。', 'REMOTION_REFERENCE_NOT_FOUND');
  const index = await manifest(), reference = index.references.find(item => item.key === key);
  if (!reference) throw fail(404, '没有这个Remotion源码参考。', 'REMOTION_REFERENCE_NOT_FOUND');
  const source = index.sources[reference.sourcePath];
  return { ...summary(reference, index), code: await verifiedText(source), dependencies: [...reference.dependencies], adaptation: [...reference.adaptation],
    relatedSources: await Promise.all(reference.relatedPaths.map(async name => ({ source: origin(index.sources[name]), code: await verifiedText(index.sources[name]) }))),
    usage: '仅作为真实源码参考，按当前工程和素材独立改写；不是可执行内置模板，不会自动复制、运行或限制场景类型。',
  };
}

// Search is a literal user-facing catalogue tool. Generation also has a brief,
// existing source and reference observations, so it must not rely on the last
// short message (often just “精修” or “重试”) to discover useful source code.
const briefSignals = [
  ['motion-signals', /动画|动效|运动|移动|轨迹|机械|光路|连接|跟随|惯性|物理|animation|motion|trajectory/i],
  ['motion-polish', /质感|精修|优化|提升|自然|细腻|缓动|拖影|模糊|效果|质量|polish|quality|easing|blur/i],
  ['page-camera', /相机|运镜|镜头|空间|景深|层次|透视|页面|截图|网页|推近|特写|2[.．]5\s*d|camera|parallax|depth|screenshot/i],
  ['video-surface', /视频|实拍|素材|交叉淡化|音画|video|footage|crossfade|offthreadvideo/i],
  ['digit-roll', /数字|数据|计数|指标|增长|百分比|图表|digit|counter|odometer|\d+(?:[,.]\d+)?\s*%/i],
  ['type-assemble', /文字|标题|排版|字标|词组|字体|字幕|文案|typography|headline|baseline|text|title|font/i],
  ['vertical-ticker', /滚动墙|滚动列|多列|瀑布流|透视墙|ticker|scrolling\s+(?:wall|columns)/i],
  ['whip-brake', /节奏|急刹|甩镜|转场|快慢|冲击|预告|广告|宣传|rhythm|whip|brake|transition|trailer/i],
  ['editable-timebase', /剪辑|编辑|精修|变速|裁切|裁入|时间线|timing|timebase|trim|speed|edit/i],
  ['manifest-tracks', /多轨|剪辑|拆解|镜头|字幕|音轨|可编辑|编辑|精修|时间表|时间线|tracks|manifest|timeline|edit/i],
];
const plainText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

/** Full verified mechanisms, selected from the current production context. */
export async function buildRemotionReferenceContext(input = {}, { limit, maxCodeChars = 80000 } = {}) {
  const instruction = plainText(input.instruction, 16000), explicitLibrary = /video[\s_-]*shotcraft|videocraft|shotcraft|充分(?:利用|参考)|全部(?:手法|机制)/i.test(instruction);
  const matchingInstruction = instruction.replace(/video[\s_-]*shotcraft|videocraft|shotcraft/gi, '');
  limit ??= explicitLibrary ? 10 : 6;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isInteger(maxCodeChars) || maxCodeChars < 12000 || maxCodeChars > 100000) throw fail(400, '源码参考上下文预算无效。', 'REMOTION_REFERENCE_QUERY');
  const index = await manifest();
  const existing = Array.isArray(input.existingProject?.files) ? input.existingProject.files : [];
  const sourceText = existing.map(file => plainText(file?.content, 20000)).join('\n').slice(0, 60000);
  const focus = (input.visualReferences?.items || []).slice(0, 8).map(item => [item.name, item.focus, ...(item.aspects || [])].filter(value => typeof value === 'string').join(' ')).join('\n').slice(0, 8000);
  const materialText = directingCueText(input), materialCues = directingMaterialCues(input);
  const brief = [plainText(input.title, 300), plainText(input.script, 30000), focus, materialText].join('\n');
  const scores = new Map(index.references.map(reference => [reference.key, { score: 0, reasons: [] }]));
  const boost = (key, amount, reason) => { const found = scores.get(key); if (found) { found.score += amount; found.reasons.push(reason); } };
  for (const [key, pattern] of briefSignals) {
    if (pattern.test(matchingInstruction)) boost(key, 30, '本次要求');
    if (pattern.test(brief)) boost(key, 14, '项目脚本或参考重点');
    if (pattern.test(sourceText)) boost(key, 8, '现有动画源码');
    if (pattern.test(materialText)) boost(key, 18, '当前素材的可追溯画面cue');
  }
  if (materialCues.some(cue => cue.motion.status === 'paired-observation' && cue.motion.direction !== 'unknown')) { boost('motion-signals', 20, '成对素材观察的运动方向'); boost('whip-brake', 14, '素材主动作到落点的速度安排'); }
  if (materialCues.some(cue => cue.composition.shotSize !== 'unknown' || cue.composition.negativeSpace !== 'unknown')) boost('page-camera', 18, '素材镜头尺度与负空间');
  if (materialCues.some(cue => cue.usableSegments.length)) boost('manifest-tracks', 16, '可追溯候选选段与镜头时间表');
  for (const match of await searchRemotionReferences(matchingInstruction, { limit: 10 })) boost(match.key, 10, '源码目录匹配');
  if ((input.assets || []).some(asset => asset?.type === 'video')) boost('video-surface', 15, '当前视频素材');
  if (/\bOffthreadVideo\b|<(?:Video|Audio)\b|staticFile\([^)]*\.(?:mp4|webm|mov|wav|mp3)/i.test(sourceText)) boost('video-surface', 16, '现有媒体组件的帧时基');
  if ((input.assets || []).some(asset => asset?.type === 'image') && /页面|截图|网页|空间|景深|透视|camera|depth/i.test(instruction + '\n' + brief)) boost('page-camera', 8, '当前图像素材');
  if (existing.length) { boost('editable-timebase', 10, '现有可编辑工程'); boost('manifest-tracks', 10, '现有镜头结构'); }
  // These are pure motion/settling building blocks, not defaults for scenes,
  // effects, palette or layouts. A terse quality request must still receive code.
  boost('motion-signals', 12, '确定性轨迹基础');
  boost('motion-polish', 6, '落定与材质基础');
  if (explicitLibrary) for (const reference of index.references) boost(reference.key, 5, '指定Shotcraft机制参考');
  const ranked = index.references.map((reference, position) => ({ reference, position, ...scores.get(reference.key) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.position - b.position);
  const chosen = ranked.slice(0, limit);
  const references = [], supplied = new Set(); let codeChars = 0;
  // First retain each selected primary module intact. Helpers then use the
  // remaining budget; never slice through a TSX function or lose the algorithm
  // because a large decorative related file happened to precede it.
  for (const item of chosen) {
    const reference = await readRemotionReference(item.reference.key);
    if (codeChars + reference.code.length > maxCodeChars) continue;
    codeChars += reference.code.length; supplied.add(reference.source.sha256);
    references.push({ key: reference.key, kind: reference.kind, title: reference.title, source: reference.source.url, sourceMetadata: reference.source,
      summary: reference.summary, selectionReasons: [...new Set(item.reasons)], adaptation: reference.adaptation, dependencies: reference.dependencies,
      code: reference.code, partial: false, relatedSources: [], omittedSources: [], _related: reference.relatedSources });
  }
  for (const reference of references) {
    for (const related of reference._related) {
      if (supplied.has(related.source.sha256)) continue;
      if (codeChars + related.code.length <= maxCodeChars) { codeChars += related.code.length; supplied.add(related.source.sha256); reference.relatedSources.push(related); }
      else reference.omittedSources.push({ ...related.source, reason: '本次源码预算未包含完整模块；按适配说明自行实现必要函数，不猜测外部文件。' });
    }
    delete reference._related;
  }
  const selectedKeys = references.map(reference => reference.key);
  return { references, library: { origin: REMOTION_REFERENCE_ORIGIN, catalog: index.references.map(reference => summary(reference, index)), selectedKeys, codeChars, maxCodeChars,
    contextUsed: { instruction: Boolean(instruction), script: Boolean(input.script), existingSource: Boolean(existing.length), referenceFocus: Boolean(focus), assets: (input.assets || []).length > 0, materialCues: materialCues.length > 0 },
    note: '目录列出可借鉴的机制，不要求全部使用；依据本片镜头意图选择、组合或自行改写。已提供源码均为完整固定版本，相关模块未提供时明确列出，不是可执行模板。' } };
}

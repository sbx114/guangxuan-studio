import { AppError } from './errors.mjs';

const fail = message => new AppError(400, message, 'INVALID_OPENFILM_EXPORT');
const enumeration = (...values) => ({ type: 'string', enum: values });
const number = (minimum, maximum) => ({ type: 'number', minimum, ...(maximum === undefined ? {} : { maximum }) });
const bool = { type: 'boolean' };
const text = maxLength => ({ type: 'string', maxLength });
const seconds = number(0);
const range = { type: 'array', minItems: 2, maxItems: 2, items: seconds, description: '作品起止秒数，结束必须晚于开始。' };
const common = { name: text(120), label: text(120) };
const timing = { range, ranges: { type: 'array', minItems: 1, maxItems: 100, items: range, description: '按给定顺序拼接所选区间；不能与range或clip同时使用。' } };
const framing = { frame: { type: 'string', maxLength: 24, description: 'native，或宽高比W:H；比例在1:4至4:1之间，如16:9、9:16、2.39:1。' }, fill: enumeration('contain', 'cover'), burnSubtitles: bool };
const size = { shortEdge: number(64, 4096) };
const motion = { samples: { type: 'integer', minimum: 1, maximum: 64 }, shutter: number(0, 1) };
const definitions = [
  ['video', '视频', '编码器可用性以本机检查为准；VP9、ProRes4444、HEVC Alpha和PNG支持透明输出。', { ...timing, ...framing, ...size, ...motion, codec: enumeration('h264', 'hevc', 'vp9', 'prores422hq', 'prores4444', 'hevc_alpha', 'png'), fps: number(1, 120), scale: number(.25, 4), quality: enumeration('standard', 'high', 'master'), audio: bool, hardware: bool, clip: { ...text(200), minLength: 1 }, preset: text(60), sidecar: enumeration('srt', 'vtt'), loudness: number(-70, -5) }],
  ['gif', 'GIF动图', '按完整时间线或一个/多个选定区间导出动图。', { ...timing, ...framing, width: number(64, 1920), fps: number(1, 50) }],
  ['audio', '混音和分轨音频', 'WAV、M4A或MP3；可导出混音、对白/音乐/音效/原素材声分轨。', { ...timing, format: enumeration('wav', 'm4a', 'mp3'), mix: bool, stems: bool }],
  ['stills', '静帧图片', '指定秒点或各画面片段中点，输出独立图片或ZIP。', { ...framing, ...size, as: enumeration('files', 'zip'), format: enumeration('png', 'jpg'), at: { type: 'array', maxItems: 500, items: seconds } }],
  ['poster', '封面图片', '指定一个作品秒点，缺省使用中点。', { ...framing, ...size, format: enumeration('png', 'jpg'), at: seconds }],
  ['subtitles', '字幕和文字稿', '导出已有字幕，支持SRT、VTT和TXT；区间拼接时同步映射时间。', { ...timing, format: enumeration('srt', 'vtt', 'txt') }],
  ['slides', '幻灯片和PDF', '指定秒点或各画面片段中点，输出PPTX或PDF。', { ...framing, ...size, format: enumeration('pptx', 'pdf'), at: { type: 'array', maxItems: 200, items: seconds } }],
  ['nle', '剪辑工程', '完整时间线导出Premiere/Resolve XML、Final Cut XML或剪映/CapCut草稿；不支持局部时间段。', { format: enumeration('xml', 'fcpxml', 'jianying', 'capcut'), fps: number(1, 120), audio: enumeration('clips', 'stems'), media: enumeration('copy', 'link'), subtitles: bool, alpha: enumeration('auto', 'png', 'prores', 'prores4444'), footage: enumeration('source', 'render') }],
  ['project', '原生项目包', '完整原生项目，支持ZIP或受控导出目录，可带历史/聊天/日志。', { as: enumeration('zip', 'folder'), parts: { type: 'array', maxItems: 3, uniqueItems: true, items: enumeration('history', 'chat', 'logs') } }],
];
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export const NATIVE_EXPORT_CATALOG = freeze(definitions.map(([kind, label, description, fields]) => ({
  kind, label, description,
  parameters: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: kind, type: 'string' }, ...common, ...fields } },
})));
export const NATIVE_EXPORT_SCHEMA = freeze({ oneOf: NATIVE_EXPORT_CATALOG.map(item => item.parameters), description: '原生编辑器全部九类导出。参数为一条导出要求；目录由应用控制。视频默认software编码(hardware:false)。' });

function check(value, schema, label) {
  if (schema.type === 'boolean') { if (typeof value !== 'boolean') throw fail(`${label}须为true或false。`); return value; }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? Infinity) || value.length < (schema.minLength || 0) || /[\x00-\x1f]/.test(value)) throw fail(`${label}格式不正确。`);
    if (schema.enum && !schema.enum.includes(value)) throw fail(`${label}须选择${schema.enum.join('、')}。`);
    return value;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value) || value < schema.minimum || value > (schema.maximum ?? Infinity)) throw fail(`${label}数值超出支持范围。`);
    return value;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) throw fail(`${label}项目数量超出支持范围。`);
    const result = value.map((item, index) => check(item, schema.items, `${label}[${index}]`));
    if (schema.uniqueItems && new Set(result).size !== result.length) throw fail(`${label}不能重复。`);
    return result;
  }
  throw fail(`${label}不是可用导出参数。`);
}
function validateRange(value) { if (value[1] <= value[0]) throw fail('导出区间的结束时间须晚于开始时间。'); }

/** All exported paths remain chosen by the local service, never by model output. */
export function normalizeNativeExport(spec = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw fail('导出设置须为对象。');
  const kind = spec.kind === undefined ? 'video' : spec.kind;
  const definition = NATIVE_EXPORT_CATALOG.find(item => item.kind === kind);
  if (!definition) throw fail('请选择视频、GIF、音频、静帧、封面、字幕、幻灯片、剪辑工程或原生项目包。');
  const ask = { kind };
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'kind') continue;
    if (!Object.hasOwn(definition.parameters.properties, key)) throw fail(`此类导出不支持参数${key}。`);
    if (value !== undefined) ask[key] = check(value, definition.parameters.properties[key], key);
  }
  if (ask.frame !== undefined && ask.frame !== 'native') {
    const parts = /^(\d{1,4}(?:\.\d{1,3})?):(\d{1,4}(?:\.\d{1,3})?)$/.exec(ask.frame);
    const ratio = parts ? Number(parts[1]) / Number(parts[2]) : NaN;
    if (!Number.isFinite(ratio) || ratio < .25 || ratio > 4) throw fail('导出画幅须为native或1:4至4:1之间的W:H比例。');
  }
  if (ask.range) validateRange(ask.range);
  if (ask.ranges) {
    if (ask.range !== undefined || ask.clip) throw fail('多个导出区间不能与range或clip同时使用。');
    ask.ranges.forEach(validateRange);
  }
  if (kind === 'video' && ask.hardware === undefined) ask.hardware = false;
  if (kind === 'audio' && ask.mix === false && !ask.stems) throw fail('音频至少需要选择混音或分轨。');
  if (kind === 'nle' && ask.alpha !== undefined) {
    const format = ask.format || 'xml';
    const allowed = format === 'fcpxml' ? ['prores4444'] : ['jianying', 'capcut'].includes(format) ? ['auto', 'png', 'prores'] : ['prores4444', 'png'];
    if (!allowed.includes(ask.alpha)) throw fail(`${format}不支持所选透明素材编码，请选择${allowed.join('、')}。`);
  }
  return ask;
}

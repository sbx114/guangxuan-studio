import { AppError } from './errors.mjs';
import { cuePlain, timedText, withSettings } from '../integrations/openfilm/packages/openfilm/src/captions.mjs';
import { FILM_SUBTITLE_LOOKS, FILM_SUBTITLE_DEFAULT, subtitleStyleVtt } from '../integrations/openfilm/packages/openfilm/studio/server/film-subtitle.mjs';
import { cueRule, setCueRule, withIds, placeCues, resizeCues } from './native-caption-edits.mjs';
import { CAPTION_DEFAULTS, varsOf, captionLookSet, lookVars } from './native-caption-look.mjs';
import { TEXT_DEFAULTS, LOOK_VARS } from './native-text-look.mjs';
import { WORD_EFFECTS, withWordEffect, withWordColor, wordEffectOf } from './native-word-effects.mjs';
import { CAPTION_LIBRARY } from './native-caption-library.mjs';

const fail = (message, code = 'NATIVE_SUBTITLE_STYLE_INVALID', status = 400) => new AppError(status, message, code);
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('字幕样式需要JSON对象。'); return value; };
const numeric = (value, min, max, label) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(label + '数值超出范围。'); return value; };
const css = value => { if (typeof value !== 'string' || value.length > 2000 || /[;{}<>\\\x00-\x1f]|\/\*|@|url\s*\(|(?:https?|file|javascript|data|blob)\s*:|expression\s*\(/i.test(value)) throw fail('新增样式值不能包含可执行内容或外部资源。'); return value; };
const variables = Object.keys(TEXT_DEFAULTS);
const motions = Object.fromEntries(['in', 'loop', 'out'].map(slot => [slot, CAPTION_LIBRARY.filter(item => item.kind === 'textmotion' && item.group === slot)]));
const basicLooks = Object.entries(FILM_SUBTITLE_LOOKS).map(([id, look]) => ({ id: 'caption:' + id, name: id, vars: lookVars(subtitleStyleVtt({ ...FILM_SUBTITLE_DEFAULT, ...look }).css) }));
const looks = [...basicLooks, ...CAPTION_LIBRARY.filter(item => item.kind === 'textstyle').map(item => ({ ...item }))];
const aliases = { '--font': ['font-family'], '--size': ['font-size'], '--weight': ['font-weight'], '--italic': ['font-style'], '--color': ['color'], '--box': ['background', 'background-color'], '--stroke': ['-webkit-text-stroke'], '--stroke-color': ['-webkit-text-stroke'], '--shadow': ['text-shadow'], '--spacing': ['letter-spacing'], '--box-pad': ['padding'], '--box-radius': ['border-radius'], '--glow': ['filter'] };
const plainKeys = [...new Set([...Object.values(aliases).flat(), 'font', 'text-decoration', 'line-height', 'paint-order', 'animation', 'display'])];
const valueSchema = { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] };
function namedKeepingOrder(vtt) {
  const named = withIds({ ...vtt, cues: vtt.cues.map((cue, sourceIndex) => ({ ...cue, sourceIndex })) });
  return { ...named, cues: named.cues.sort((a, b) => a.sourceIndex - b.sourceIndex).map(({ sourceIndex: _index, ...cue }) => cue) };
}
const variableSchema = Object.fromEntries(variables.map(name => [name, valueSchema]));
for (const slot of ['in', 'loop', 'out']) variableSchema['--' + slot] = { anyOf: [{ type: 'string', enum: [...new Set(motions[slot].map(item => item.vars['--' + slot]))] }, { type: 'null' }] };
export const SUBTITLE_STYLE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  variables: { type: 'object', additionalProperties: false, properties: variableSchema }, css: { type: 'object', additionalProperties: false, properties: Object.fromEntries(plainKeys.map(name => [name, valueSchema])) },
  lookId: { type: 'string', enum: ['none', ...looks.map(item => item.id)] },
  motion: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['in', 'loop', 'out'].map(slot => [slot, { type: 'object', additionalProperties: false, properties: { id: { type: 'string', enum: ['none', ...motions[slot].map(item => item.id)] }, duration: { type: 'number', minimum: .1, maximum: 5 } } }])) },
  align: { type: 'string', enum: ['left', 'center', 'right'] }, line: { type: 'number', minimum: 0, maximum: 100 }, position: { type: 'number', minimum: 0, maximum: 100 }, width: { type: 'number', minimum: 5, maximum: 100 },
  move: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number', minimum: -100, maximum: 100 }, y: { type: 'number', minimum: -100, maximum: 100 } } },
  wordEffect: { type: 'string', enum: WORD_EFFECTS.map(item => item.id) }, wordColor: { type: 'string', maxLength: 100 }, timeWords: { type: 'boolean' }, clearOwn: { type: 'boolean' },
} };
export const SUBTITLE_STYLE_CATALOG = { schema: SUBTITLE_STYLE_SCHEMA, variables: Object.fromEntries(variables.map(name => [name, { default: CAPTION_DEFAULTS[name], ...(name === '--size' ? { unit: 'cqmin，UI字幕字号为画面短边百分比，1..20' } : {}), ...(name.endsWith('-time') ? { unit: 's，UI时长0.1..5秒' } : {}) }])), plainCss: plainKeys, looks: looks.map(({ id, name }) => ({ id, name })), motions: Object.fromEntries(Object.entries(motions).map(([slot, items]) => [slot, items.map(({ id, name, vars }) => ({ id, name, value: vars['--' + slot] }))])), wordEffects: WORD_EFFECTS.map(({ id, color }) => ({ id, color: !!color })), notes: ['字段与当前CaptionInspector/TextInspector/CaptionWords及library/index.json一致。', '省略cueIndices修改整轨；给cueIndices只改这些句子。逐字效果是原生整轨效果。', '原词时间、未知STYLE和区域/NOTE保留；timeWords=true才按原生UI规则重新分配词时间，并非音频转写。', 'variables/null或css/null仅移除所请求字段；clearOwn=true明确移除所选句子整个自有规则，恢复继承。'] };

function requestedKeys(value, allowed) { object(value); if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('字幕样式包含当前UI未提供的字段。'); }
function checkedVariables(input) {
  requestedKeys(input, variables); const out = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === null) { out[name] = null; continue; } css(value);
    if (['--in', '--loop', '--out'].includes(name) && !motions[name.slice(2)].some(item => item.vars[name] === value)) throw fail('动画名称必须来自原生字幕目录。');
    if (name.endsWith('-time') && (!/^\d+(?:\.\d+)?s$/.test(value) || Number.parseFloat(value) < .1 || Number.parseFloat(value) > 5)) throw fail('字幕动画时长需要0.1至5秒的s值。');
    if (name === '--size' && (!/^\d+(?:\.\d+)?cqmin$/.test(value) || Number.parseFloat(value) < 1 || Number.parseFloat(value) > 20)) throw fail('字幕字号需要1至20cqmin。');
    if (name === '--weight' && !/^(?:[2-9]00)$/.test(value)) throw fail('字幕字重使用200至900之间的百位数。');
    if (name === '--italic' && !['normal', 'italic'].includes(value) || name === '--align' && !['left', 'center', 'right'].includes(value)) throw fail('字幕字体或对齐枚举无效。');
    out[name] = value;
  }
  return out;
}
function variablePatch(rule, set, parent = {}) {
  const patch = { ...set }, converted = varsOf(rule);
  if (rule.font && Object.keys(set).some(key => ['--font', '--size', '--weight', '--italic'].includes(key))) {
    for (const name of ['--font', '--size', '--weight']) if (!Object.hasOwn(set, name) && converted[name] !== undefined) patch[name] = converted[name];
    if (!Object.hasOwn(set, '--italic') && /(?:^|\s)italic(?:\s|$)/.test(rule.font)) patch['--italic'] = 'italic'; patch.font = null;
  }
  if (rule['-webkit-text-stroke'] && ['--stroke', '--stroke-color'].some(name => Object.hasOwn(set, name))) for (const name of ['--stroke', '--stroke-color']) if (!Object.hasOwn(set, name) && converted[name] !== undefined) patch[name] = converted[name];
  for (const name of Object.keys(set)) for (const alias of aliases[name] || []) patch[alias] = null;
  const expressions = { '--font': ['font-family', 'var(--font)'], '--size': ['font-size', 'var(--size)'], '--weight': ['font-weight', 'var(--weight)'], '--italic': ['font-style', 'var(--italic)'], '--color': ['color', 'var(--color)'], '--box': ['background', 'var(--box)'], '--shadow': ['text-shadow', 'var(--shadow)'], '--spacing': ['letter-spacing', 'var(--spacing)'], '--box-pad': ['padding', 'var(--box-pad)'], '--box-radius': ['border-radius', 'var(--box-radius)'] };
  for (const [name, value] of Object.entries(set)) {
    if (value === null) continue;
    const parents = [...(aliases[name] || []), ...(['--font', '--size', '--weight', '--italic'].includes(name) ? ['font'] : [])];
    if (expressions[name] && parents.some(key => parent[key] !== undefined)) patch[expressions[name][0]] = expressions[name][1];
    if (['--stroke', '--stroke-color'].includes(name) && parent['-webkit-text-stroke']) {
      const inherited = varsOf({ ...parent, ...rule }); for (const key of ['--stroke', '--stroke-color']) if (!Object.hasOwn(set, key) && inherited[key] !== undefined) patch[key] = inherited[key];
      patch['-webkit-text-stroke'] = 'var(--stroke, 0) var(--stroke-color, transparent)';
    }
  }
  return patch;
}

/** Use the native inspector's pure rules and registry; retain properties not requested. */
export function applySubtitleStyle(original, input, { cueIndices, editScope } = {}) {
  requestedKeys(input, Object.keys(SUBTITLE_STYLE_SCHEMA.properties));
  if (!Object.keys(input).length) throw fail('请提供至少一个字幕样式修改。');
  const all = cueIndices === undefined;
  if (!all && (!Array.isArray(cueIndices) || !cueIndices.length || cueIndices.length > 2000 || new Set(cueIndices).size !== cueIndices.length || cueIndices.some(index => !Number.isInteger(index) || index < 0 || index >= original.cues.length))) throw fail('请使用读取结果中的真实字幕index。');
  const selected = new Set(all ? original.cues.map((_, index) => index) : cueIndices), range = editScope?.placement;
  if (range?.mode === 'range' && original.cues.some((cue, index) => selected.has(index) && (cue.start < range.start || cue.end > range.end))) throw fail('样式修改包含本轮对话范围外的字幕。', 'NATIVE_SUBTITLE_STYLE_SCOPE', 403);
  if (!all && (input.wordEffect !== undefined || input.wordColor !== undefined)) throw fail('原生逐字效果作用于整轨；请明确以整轨范围设置。', 'NATIVE_SUBTITLE_STYLE_SCOPE', 403);
  let out = namedKeepingOrder(structuredClone(original)); const ids = new Set(out.cues.filter((_, index) => selected.has(index)).map(cue => cue.id));
  if (!all) out.cues = out.cues.map((cue, index) => selected.has(index) ? cue : { ...cue, id: original.cues[index].id });
  if (input.clearOwn !== undefined && typeof input.clearOwn !== 'boolean' || input.timeWords !== undefined && typeof input.timeWords !== 'boolean') throw fail('字幕开关需要布尔值。');
  if (input.clearOwn) for (const id of ids) out = setCueRule(out, `::cue(#${id})`, null);
  let set = input.variables === undefined ? {} : checkedVariables(input.variables);
  if (input.lookId !== undefined) {
    const look = looks.find(item => item.id === input.lookId); if (!look && input.lookId !== 'none') throw fail('请选择真实的原生字幕字效ID。');
    set = { ...(look ? captionLookSet(look.vars) : Object.fromEntries(LOOK_VARS.map(name => [name, null]))), ...set };
  }
  if (input.motion !== undefined) { requestedKeys(input.motion, ['in', 'loop', 'out']); for (const [slot, motion] of Object.entries(input.motion)) { requestedKeys(motion, ['id', 'duration']); if (motion.id !== undefined) { const selectedMotion = motions[slot].find(item => item.id === motion.id); if (!selectedMotion && motion.id !== 'none') throw fail('请选择该时段真实的原生动画ID。'); Object.assign(set, selectedMotion?.vars || { ['--' + slot]: 'none' }); } if (motion.duration !== undefined) set['--' + slot + '-time'] = numeric(motion.duration, .1, 5, '动画时长') + 's'; } }
  const own = input.css === undefined ? {} : object(input.css); requestedKeys(own, plainKeys); for (const value of Object.values(own)) if (value !== null) css(value);
  const applyRule = prelude => { out = setCueRule(out, prelude, { ...variablePatch(cueRule(out, prelude), set, prelude === '::cue' ? {} : cueRule(out, '::cue')), ...own }); };
  if (Object.keys(set).length || Object.keys(own).length) {
    if (all) {
      applyRule('::cue');
      for (const id of ids) { const selector = `::cue(#${id})`, drop = { ...variablePatch(cueRule(out, selector), Object.fromEntries(Object.keys(set).map(name => [name, null]))), ...Object.fromEntries(Object.keys(own).map(name => [name, null])) }; out = setCueRule(out, selector, drop); }
    } else for (const id of ids) applyRule(`::cue(#${id})`);
  }
  if (input.align !== undefined && !['left', 'center', 'right'].includes(input.align)) throw fail('字幕对齐方式无效。');
  if (input.line !== undefined || input.position !== undefined || input.align !== undefined) out = { ...out, cues: out.cues.map(cue => ids.has(cue.id) ? { ...cue, settings: withSettings(cue.settings, { ...(input.line !== undefined ? { region: null, line: numeric(input.line, 0, 100, '字幕纵向位置') + '%' } : {}), ...(input.position !== undefined ? { region: null, position: numeric(input.position, 0, 100, '字幕横向位置') + '%' } : {}), ...(input.align ? { align: { left: 'start', center: 'center', right: 'end' }[input.align] } : {}) }) } : cue) };
  if (input.move !== undefined) { requestedKeys(input.move, ['x', 'y']); out = placeCues(out, all ? null : ids, numeric(input.move.x, -100, 100, '字幕横移'), numeric(input.move.y, -100, 100, '字幕纵移')); }
  if (input.width !== undefined) out = resizeCues(out, all ? null : ids, numeric(input.width, 5, 100, '字幕宽度'));
  if (input.timeWords) out = { ...out, cues: out.cues.map(cue => ids.has(cue.id) ? { ...cue, text: timedText(cuePlain(cue.text), cue.start, cue.end) } : cue) };
  if (input.wordColor !== undefined) css(input.wordColor);
  if (input.wordEffect !== undefined) {
    if (!WORD_EFFECTS.some(effect => effect.id === input.wordEffect)) throw fail('逐字效果不在原生UI目录中。');
    const owned = new Set(['--wfx-color', ...WORD_EFFECTS.flatMap(effect => [...Object.keys(effect.past || {}), ...Object.keys(effect.future || {})])]);
    const extras = Object.fromEntries(['::cue(:past)', '::cue(:future)'].map(selector => [selector, Object.fromEntries(Object.entries(cueRule(out, selector)).filter(([key]) => !owned.has(key)))]));
    out = withWordEffect(out, input.wordEffect, input.wordColor ?? wordEffectOf(out).color);
    for (const [selector, values] of Object.entries(extras)) if (Object.keys(values).length) out = setCueRule(out, selector, values);
  } else if (input.wordColor !== undefined) out = withWordColor(out, input.wordColor);
  return out;
}

export function subtitleStyleSummary(vtt, { offset = 0, limit = 100 } = {}) {
  const named = namedKeepingOrder(vtt);
  return { trackRule: cueRule(vtt, '::cue'), uiTrackVariables: { ...CAPTION_DEFAULTS, ...varsOf(cueRule(vtt, '::cue')) }, wordEffect: wordEffectOf(vtt), cues: named.cues.slice(offset, offset + limit).map((cue, index) => ({ index: offset + index, id: cue.id, settings: cue.settings, ownRule: cueRule(vtt, `::cue(#${cue.id})`) })), note: 'uiTrackVariables是原生UI变量模型；完整既有CSS在trackRule/ownRule，未知规则保留。' };
}

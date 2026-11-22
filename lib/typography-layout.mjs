import { AppError } from './errors.mjs';
import { CAPTION_LIBRARY } from './native-caption-library.mjs';

const roles = ['headline', 'subtitle', 'label'];
const looks = CAPTION_LIBRARY.filter(item => item.kind === 'textstyle');
const motions = ['text/motions/in-none', 'text/motions/in-fade', 'text/motions/in-rise', 'text/motions/in-drop', 'text/motions/in-pop', 'text/motions/in-zoom'];
const round = value => Math.round(value * 1000) / 1000;
const fail = (model, message) => { throw new AppError(model ? 502 : 400, message, model ? 'MODEL_TYPOGRAPHY_INVALID' : 'TYPOGRAPHY_INVALID'); };
const graphemes = value => Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value), item => item.segment);

export const TYPOGRAPHY_SCHEMA = {
  role: 'headline|subtitle|label', anchor: 'top|center|bottom', align: 'left|center|right',
  safeMargin: 0.07, maxWidth: 0.86, maxLines: 2, lineHeight: 1.25,
  fontSize: '可省略，按画幅和文字量自动排版；指定时是实际画布像素，不会偷偷缩小',
  color: '#FFFFFF', background: 'none|scrim|panel', lookId: '原生text/looks/... ID，省略时采用当前文字角色',
  motionId: motions.join('|'), motionDuration: 0.4,
};

export function normalizeTypographyLayout(input = {}, { placement = 'bottom', model = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(model, '文字排版参数需要对象。');
  const allowed = ['role', 'anchor', 'align', 'safeMargin', 'maxWidth', 'maxLines', 'lineHeight', 'fontSize', 'color', 'background', 'lookId', 'motionId', 'motionDuration'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail(model, '文字排版只支持目录中的参数，不能传入CSS或资源地址。');
  const role = input.role ?? (placement === 'title' ? 'headline' : 'subtitle');
  const anchor = input.anchor ?? (placement === 'title' ? 'top' : placement === 'center' ? 'center' : 'bottom'), align = input.align ?? 'center';
  if (!roles.includes(role) || !['top', 'center', 'bottom'].includes(anchor) || !['left', 'center', 'right'].includes(align)) fail(model, '文字角色、锚点或对齐无效。');
  const number = (key, fallback, min, max, integer = false) => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) fail(model, `文字${key}参数无效。`);
    return value;
  };
  const color = input.color, background = input.background ?? 'none';
  if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) || !['none', 'scrim', 'panel'].includes(background)) fail(model, '文字颜色或背景无效。');
  const lookId = input.lookId ?? { headline: 'text/looks/title', subtitle: 'text/looks/lower', label: 'text/looks/note' }[role];
  if (!looks.some(look => look.id === lookId)) fail(model, '请选择真实的原生文字样式ID。');
  const motionId = input.motionId ?? 'text/motions/in-none';
  if (!motions.includes(motionId)) fail(model, '文字入场动效不在可执行目录中。');
  return { role, anchor, align, safeMargin: number('safeMargin', role === 'headline' ? .075 : .055, .04, .16),
    maxWidth: number('maxWidth', role === 'label' ? .62 : role === 'headline' ? .82 : .88, .4, .92),
    maxLines: number('maxLines', 2, 1, 4, true), lineHeight: number('lineHeight', role === 'headline' ? 1.16 : 1.28, 1.05, 1.6),
    ...(input.fontSize !== undefined ? { fontSize: number('fontSize', 32, 8, 200) } : {}), ...(color ? { color } : {}), background, lookId, motionId,
    motionDuration: number('motionDuration', .4, .1, 1.5) };
}

/** Approximation is used before render; callers can supply Canvas measureText for the actual font. */
export function estimatedTextWidth(value, size) {
  return graphemes(value).reduce((width, char) => width + size * (/\s/u.test(char) ? .28 : /^[a-z]$/i.test(char) ? /^[A-Z]$/.test(char) ? .64 : .54 : /^[0-9]$/.test(char) ? .58 : /^[.,:;!'"\-]$/.test(char) ? .32 : 1), 0);
}

export function wrapTypographyText(value, width, size, measureText = estimatedTextWidth) {
  const lines = [], closing = /^[，。！？、；：）】》」』,.!?;:)\]\}]/u, opening = /[（【《「『(\[\{]$/u;
  for (const paragraph of String(value).replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    const chars = graphemes(paragraph); let start = 0;
    while (start < chars.length) {
      let end = start + 1;
      while (end < chars.length && measureText(chars.slice(start, end + 1).join(''), size) <= width) end++;
      if (end < chars.length) {
        const segment = chars.slice(start, end).join('');
        if (/^[A-Za-z0-9]$/.test(chars[end]) && /[A-Za-z0-9]$/.test(segment)) {
          const space = segment.lastIndexOf(' '); if (space > 0) end = start + graphemes(segment.slice(0, space + 1)).length;
        }
        while (end > start + 1 && (closing.test(chars[end]) || opening.test(chars[end - 1]))) end--;
      }
      lines.push(chars.slice(start, end).join('')); start = end;
    }
  }
  return lines;
}

export function fitTypography(value, { width, height, layout = {}, placement = 'bottom', measureText = estimatedTextWidth } = {}) {
  const normalized = normalizeTypographyLayout(layout, { placement });
  if (![width, height].every(dimension => typeof dimension === 'number' && Number.isFinite(dimension) && dimension > 0)) fail(false, '文字排版需要实际画布尺寸。');
  const side = Math.min(width, height), marginX = width * normalized.safeMargin, marginY = height * normalized.safeMargin;
  const boxWidth = Math.min(width * normalized.maxWidth, width - marginX * 2), availableHeight = height - marginY * 2;
  const preferred = normalized.fontSize ?? side * { headline: .078, subtitle: .047, label: .034 }[normalized.role];
  const minimum = normalized.fontSize ?? side * { headline: .052, subtitle: .032, label: .027 }[normalized.role];
  const at = size => {
    const padding = normalized.background === 'panel' ? size * .55 : 0, contentWidth = boxWidth - 2 * padding;
    const lines = wrapTypographyText(value, contentWidth, size, measureText), h = lines.length * size * normalized.lineHeight + (normalized.background === 'panel' ? size * .6 : 0);
    return { size, lines, height: h, contentWidth, fits: contentWidth > 0 && lines.length <= normalized.maxLines && h <= availableHeight && lines.every(line => measureText(line, size) <= contentWidth + .001) };
  };
  let best = at(minimum), low = minimum, high = Math.max(minimum, preferred);
  if (best.fits) for (let step = 0; step < 12; step++) { const middle = (low + high) / 2, candidate = at(middle); if (candidate.fits) { best = candidate; low = middle; } else high = middle; }
  const x = normalized.align === 'left' ? marginX : normalized.align === 'right' ? width - marginX - boxWidth : (width - boxWidth) / 2;
  const y = normalized.anchor === 'top' ? marginY : normalized.anchor === 'center' ? (height - best.height) / 2 : height - marginY - best.height;
  return { ...normalized, fontSize: round(best.size), lines: best.lines, box: { x: round(x), y: round(y), width: round(boxWidth), height: round(best.height) },
    contentWidth: round(best.contentWidth), overflow: !best.fits, measurement: measureText === estimatedTextWidth ? 'estimated-before-render' : 'measured-font',
    notes: best.fits ? [] : ['文字在最低可读字号与行数下放不下；需拆成多条、增加行数或缩短屏幕文字，不能截断正文。'] };
}

export function buildTypographyBrief({ width = 1280, height = 720 } = {}) {
  return { stage: { width, height }, schema: TYPOGRAPHY_SCHEMA,
    roles: roles.map(role => ({ role, ...fitTypography('文字层级 Text', { width, height, layout: { role }, placement: role === 'headline' ? 'title' : 'bottom' }) })),
    availableLookIds: looks.map(look => ({ id: look.id, name: look.name })), supportedMotionIds: motions,
    rules: ['按主视觉、标题、说明、标签分配主次；主体所在区域不叠正文，优先使用真实素材cue的负空间。', '标题和字幕保留安全边距与可读字号；中英按语义断行，不能靠无限缩字或截断解决拥挤。', '字幕时间为最终时间线位置；源转写须按所选入出点、实际speed和放置偏移映射。', '入场有落定，正文阅读期间保持稳定；逐字动效不表示已获得语音逐字对齐。'] };
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function buildCaptionPage(text, stage, duration, input = {}, placement = 'bottom') {
  const fit = fitTypography(text, { width: stage.w, height: stage.h, layout: input, placement });
  if (fit.overflow) fail(false, fit.notes[0]);
  const look = looks.find(item => item.id === fit.lookId), vars = Object.fromEntries(Object.entries(look.vars).filter(([key]) => !['--size', '--in', '--out', '--loop', '--wrap'].includes(key)));
  if (fit.color) vars['--color'] = fit.color;
  const root = Object.entries(vars).map(([key, value]) => `${key}:${value}`).join(';'), padding = fit.background === 'panel' ? '.3em .55em' : '0';
  const background = fit.background === 'panel' ? 'rgba(0,0,0,.62)' : fit.background === 'scrim' ? 'linear-gradient(90deg,transparent,rgba(0,0,0,.65),transparent)' : 'var(--box,transparent)';
  const effect = CAPTION_LIBRARY.find(item => item.id === fit.motionId)?.vars['--in'] || 'none';
  const motionDuration = Math.min(fit.motionDuration, duration * .35);
  const sourceText = JSON.stringify(text).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const minimum = input.fontSize ?? Math.min(stage.w, stage.h) * { headline: .052, subtitle: .032, label: .027 }[fit.role];
  const actualFit = `const graphemes=${graphemes.toString()};${wrapTypographyText.toString()};let raw=${sourceText},lastText=${JSON.stringify(fit.lines.join('\n')).replace(/</g, '\\u003c')},lastSize='',signature='';function fitActual(n){const c=getComputedStyle(n),key=n.textContent+'|'+c.fontFamily+'|'+c.fontWeight+'|'+n.style.fontSize;if(key===signature)return;if(n.textContent!==lastText)raw=n.textContent;const manual=!!n.style.fontSize&&n.style.fontSize!==lastSize,preferred=manual?parseFloat(c.fontSize):${fit.fontSize},minimum=manual?preferred:${minimum},canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');const at=size=>{ctx.font=c.fontWeight+' '+size+'px '+c.fontFamily;const pad=${fit.background === 'panel' ? '.55' : '0'}*size,lines=wrapTypographyText(raw,${fit.box.width}-pad*2,size,s=>ctx.measureText(s).width),height=lines.length*size*${fit.lineHeight}+${fit.background === 'panel' ? '.6' : '0'}*size;return{size,lines,fits:lines.length<=${fit.maxLines}&&height<=${stage.h * (1 - 2 * fit.safeMargin)}&&lines.every(s=>ctx.measureText(s).width<=${fit.box.width}-pad*2+.01)}};let best=at(minimum),low=minimum,high=Math.max(minimum,preferred);if(best.fits)for(let i=0;i<10;i++){const v=at((low+high)/2);if(v.fits){best=v;low=v.size}else high=v.size}n.style.fontSize=best.size+'px';n.textContent=best.lines.join('\\n');n.dataset.overflow=String(!best.fits);lastText=n.textContent;lastSize=n.style.fontSize;signature=n.textContent+'|'+c.fontFamily+'|'+c.fontWeight+'|'+lastSize;}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>:root{${root}}html,body{margin:0;width:100%;height:100%;background:transparent}body{display:flex;box-sizing:border-box;align-items:${{ top: 'flex-start', center: 'center', bottom: 'flex-end' }[fit.anchor]};justify-content:${{ left: 'flex-start', center: 'center', right: 'flex-end' }[fit.align]};padding:${stage.h * fit.safeMargin}px ${stage.w * fit.safeMargin}px;font-family:var(--font,"Microsoft YaHei",sans-serif)}#caption{box-sizing:border-box;width:${fit.box.width}px;padding:${padding};white-space:pre-wrap;text-align:${fit.align};font-size:${fit.fontSize}px;font-weight:var(--weight,700);line-height:${fit.lineHeight};color:var(--color,#fff);-webkit-text-stroke:var(--stroke,0) var(--stroke-color,#000);paint-order:stroke fill;text-shadow:var(--shadow,0 2px 4px #000);filter:var(--glow,none);background:${background};border-radius:var(--box-radius,.25em);transform-origin:center}#caption[data-fill=true]{background:var(--fill);background-clip:text;-webkit-background-clip:text}</style></head><body><div id="caption" class="t" data-fill="${vars['--fill'] && vars['--fill'] !== 'none' ? 'true' : 'false'}">${escape(fit.lines.join('\n'))}</div><script>${actualFit}window.film={duration:${duration},frame(t){const n=document.getElementById('caption');fitActual(n);const p=${effect === 'none' ? '1' : `Math.max(0,Math.min(1,t/${motionDuration}))`},q=1-Math.pow(1-p,3);n.style.opacity=String(p);n.style.transform=${effect === 'rise' ? '`translateY(${(1-q)*.45}em)`' : effect === 'drop' ? '`translateY(${-(1-q)*.45}em)`' : effect === 'pop' ? '`scale(${.72+q*.28})`' : effect === 'zoom' ? '`scale(${1.08-q*.08})`' : "'none'"};}};</script></body></html>`;
  return { html, layout: fit };
}

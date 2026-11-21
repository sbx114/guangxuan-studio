import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { ANIMATION_FONTS, ANIMATION_PACE, ANIMATION_THEMES, animationPalette } from '../styles.mjs';

export const smooth = Easing.bezier(0.18, 0.92, 0.22, 1);
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
export const themes = ANIMATION_THEMES;
export const SceneStyleContext = React.createContext({ brand: null, motion: null, projectFrame: null, startFrame: 0, durationInFrames: 150 });
const EASINGS = { smooth, linear: Easing.linear, out: Easing.bezier(.16, 1, .3, 1), inOut: Easing.bezier(.65, 0, .35, 1) };

export function useSceneTimelineFrame() {
  const local = useCurrentFrame(), style = React.useContext(SceneStyleContext);
  return style.projectFrame === null ? local : style.projectFrame - style.startFrame;
}
export function useSceneFrame() { const frame = useSceneTimelineFrame(), style = React.useContext(SceneStyleContext); return frame * (ANIMATION_PACE[style.motion?.pace] || 1); }
export function useSceneEasing() { const style = React.useContext(SceneStyleContext); return EASINGS[style.motion?.easing] || smooth; }

export function useSceneStyle(theme) {
  const config = useVideoConfig();
  const style = React.useContext(SceneStyleContext);
  const scale = Math.min(config.width, config.height) / 720;
  return { ...config, scale, portrait: config.height > config.width, palette: animationPalette(theme, style.brand), fontFamily: ANIMATION_FONTS[style.brand?.font || 'original'] || ANIMATION_FONTS.original };
}

export function fittedSize(text, preferred, availableWidth, maxLines = 3, minimum = 28) {
  const units = [...String(text)].reduce((total, char) => total + (/\p{Script=Han}|[\u3000-\u303f\uff00-\uffef]/u.test(char) ? 1 : 0.56), 0);
  return Math.max(minimum, Math.min(preferred, (availableWidth * maxLines) / Math.max(1, units)));
}

export function Reveal({ children, delay = 0, style = {}, distance = 20 }) {
  const frame = useSceneFrame(), motionEasing = useSceneEasing(), settings = React.useContext(SceneStyleContext);
  if (settings.motion?.reveal && settings.motion.reveal !== 'original') return <EditableReveal type={settings.motion.reveal} delay={delay} style={style} distance={distance}>{children}</EditableReveal>;
  return <div style={{ ...style, opacity: interpolate(frame, [delay, delay + 18], [0, 1], { ...clamp, easing: motionEasing }), translate: `0 ${interpolate(frame, [delay, delay + 26], [distance, 0], { ...clamp, easing: motionEasing })}px` }}>{children}</div>;
}

export function MaskReveal({ children, delay = 0, style = {}, color = '#080a08', duration = 26 }) {
  const frame = useSceneFrame(), motionEasing = useSceneEasing(), settings = React.useContext(SceneStyleContext);
  if (settings.motion?.reveal && settings.motion.reveal !== 'original') return <EditableReveal type={settings.motion.reveal} delay={delay} style={style} duration={duration} color={color}>{children}</EditableReveal>;
  const begin = delay + Math.round(duration * 0.28);
  const reveal = interpolate(frame, [begin, delay + duration], [0, 1], { ...clamp, easing: motionEasing });
  const cover = interpolate(frame, [delay, begin], [0, 1], { ...clamp, easing: motionEasing });
  return <div style={{ ...style, position: 'relative', overflow: 'hidden', textWrap: 'balance' }}>
    <div style={{ clipPath: `inset(0 ${(1 - reveal) * 100}% 0 0)`, translate: `0 ${12 * (1 - reveal)}px` }}>{children}</div>
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, backgroundColor: color, transformOrigin: 'left', scale: `${cover} 1`, translate: `${reveal * 102}% 0` }} />
  </div>;
}

function EditableReveal({ children, type, delay = 0, duration = 26, distance = 20, color = '#080a08', style = {} }) {
  const frame = useSceneFrame(), easing = useSceneEasing(), settings = React.useContext(SceneStyleContext);
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : null;
  const characters = React.useMemo(() => text === null ? [] : typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map(part => part.segment) : [...text], [text]);
  const typingDuration = Math.max(1, Math.min(Math.max(duration, characters.length * 1.2), settings.durationInFrames * .55 - delay));
  if (type === 'typewriter' && text !== null) return <div aria-label={text} style={{ ...style, position: 'relative' }}>
    <span aria-hidden="true" style={{ visibility: 'hidden' }}>{text}</span>
    <span aria-hidden="true" style={{ position: 'absolute', inset: 0, whiteSpace: 'pre-wrap' }}>{characters.slice(0, Math.floor(interpolate(frame, [delay, delay + typingDuration], [0, characters.length], { ...clamp, easing }))).join('')}</span>
  </div>;
  if (type === 'mask') return <div style={{ ...style, position: 'relative', overflow: 'hidden', textWrap: 'balance' }}>
    <div style={{ clipPath: `inset(0 ${interpolate(frame, [delay + duration * .28, delay + duration], [100, 0], { ...clamp, easing })}% 0 0)`, translate: `0 ${interpolate(frame, [delay + duration * .28, delay + duration], [12, 0], { ...clamp, easing })}px` }}>{children}</div>
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, backgroundColor: color, transformOrigin: 'left', scale: `${interpolate(frame, [delay, delay + duration * .28], [0, 1], { ...clamp, easing })} 1`, translate: `${interpolate(frame, [delay + duration * .28, delay + duration], [0, 102], { ...clamp, easing })}% 0` }} />
  </div>;
  return <div style={{ ...style, opacity: interpolate(frame, [delay, delay + duration], [0, 1], { ...clamp, easing }), ...(type === 'rise' ? { translate: `0 ${interpolate(frame, [delay, delay + duration], [distance, 0], { ...clamp, easing })}px` } : {}) }}>{children}</div>;
}

function ArchiveAtmosphere({ palette, portrait }) {
  const frame = useSceneFrame(), motionEasing = useSceneEasing();
  const unfold = interpolate(frame, [0, 48], [0, 1], { ...clamp, easing: motionEasing });
  return <svg aria-hidden="true" viewBox="0 0 700 720" style={{ position: 'absolute', right: portrait ? '-34%' : '-5%', top: portrait ? '7%' : '-5%', width: portrait ? '95%' : '56%', height: '100%', opacity: 0.26, pointerEvents: 'none' }}>
    {[0, 1, 2, 3].map(layer => <g key={layer} style={{ translate: `${(layer - 1.5) * (18 + 9 * unfold)}px ${-layer * 13 * unfold}px` }}>
      <path d="M280 70 555 180 460 650 185 540Z" fill={layer === 3 ? palette.glass : 'none'} stroke={palette.line} strokeWidth="1" />
      <path d="M280 70 555 180 565 192 290 82Z" fill={palette.glassEdge} opacity="0.75" />
    </g>)}
    <path d="M510 200 530 208 M502 240 522 248 M494 280 514 288 M486 320 506 328" stroke={palette.brass} strokeWidth="2" opacity="0.7" />
  </svg>;
}

export function OpticalArchive({ theme = 'paper', index = 0, mode = 'extract', style = {} }) {
  const { palette } = useSceneStyle(theme);
  const frame = useSceneFrame(), motionEasing = useSceneEasing();
  const pull = interpolate(frame, [2, 44], [0, 1], { ...clamp, easing: motionEasing });
  const layers = mode === 'seal' ? interpolate(frame, [4, 42], [1, 0.25], { ...clamp, easing: motionEasing }) : interpolate(frame, [4, 42], [0.1, 1], { ...clamp, easing: motionEasing });
  const ringTurn = interpolate(frame, [12, 58], [-18, 0], { ...clamp, easing: motionEasing });
  const id = `gx-optic-${theme}-${index}-${mode}`;
  return <svg aria-hidden="true" viewBox="0 0 420 470" style={{ display: 'block', width: '100%', height: '100%', overflow: 'visible', ...style }}>
    <defs>
      <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={palette.glassEdge} stopOpacity="0.7" /><stop offset="0.48" stopColor={palette.background} stopOpacity="0.06" /><stop offset="1" stopColor={palette.glassEdge} stopOpacity="0.35" /></linearGradient>
      <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={palette.glassEdge} /><stop offset="0.4" stopColor={palette.line} /><stop offset="0.73" stopColor={palette.glassEdge} /><stop offset="1" stopColor={palette.muted} /></linearGradient>
      <filter id={`${id}-shadow`} x="-35%" y="-30%" width="180%" height="180%"><feDropShadow dx="10" dy="18" stdDeviation="12" floodColor={palette.shade} floodOpacity="0.18" /></filter>
    </defs>
    <g style={{ translate: `${12 * (1 - pull)}px ${30 * (1 - pull)}px`, opacity: interpolate(frame, [0, 20], [0, 1], clamp) }}>
      {[2, 1].map(layer => <g key={layer} style={{ translate: `${layer * 16 * layers}px ${layer * 15 * layers}px` }}>
        <path d="M75 77 309 39 350 363 116 401Z" fill={palette.glass} stroke={palette.line} strokeWidth="1.4" />
        <path d="M116 401 350 363 355 369 121 407Z" fill={palette.line} opacity="0.44" />
      </g>)}
      <g filter={`url(#${id}-shadow)`} style={{ translate: `${-9 * layers}px ${-11 * layers}px` }}>
        <path d="M75 77 309 39 350 363 116 401Z" fill={`url(#${id}-glass)`} stroke={palette.glassEdge} strokeWidth="2.5" />
        <path d="M80 84 305 47 344 357 120 394Z" fill="none" stroke={palette.line} strokeWidth="0.8" />
        <g style={{ rotate: `${ringTurn}deg`, transformOrigin: '211px 223px' }}>
          <path d="M176 199 244 261" fill="none" stroke={palette.line} strokeWidth="22" /><path d="M176 199 244 261" fill="none" stroke={palette.glassEdge} strokeWidth="12" />
          <ellipse cx="177" cy="179" rx="62" ry="69" fill="none" stroke={`url(#${id}-metal)`} strokeWidth="15" transform="rotate(-12 177 179)" />
          <ellipse cx="246" cy="279" rx="62" ry="69" fill="none" stroke={`url(#${id}-metal)`} strokeWidth="15" transform="rotate(-12 246 279)" />
          <ellipse cx="177" cy="179" rx="49" ry="56" fill="none" stroke={palette.line} strokeWidth="1" transform="rotate(-12 177 179)" />
          <ellipse cx="246" cy="279" rx="49" ry="56" fill="none" stroke={palette.line} strokeWidth="1" transform="rotate(-12 246 279)" />
        </g>
        <path d="M94 108 119 104 M98 121 135 115 M285 331 320 325 M287 344 309 340" stroke={palette.line} strokeWidth="1.2" />
        <rect x="285" y="61" width="9" height="9" fill={palette.brass} transform="rotate(-9 285 61)" />
        <circle cx="98" cy="91" r="3.4" fill={palette.muted} opacity="0.65" /><circle cx="329" cy="350" r="3.4" fill={palette.muted} opacity="0.65" />
        <path d="M96 91h4 M327 350h4" stroke={palette.glassEdge} strokeWidth="1" />
        <text x="128" y="376" fill={palette.muted} fontFamily="Consolas, monospace" fontSize="10" letterSpacing="2" transform="rotate(-9 128 376)">{String(index + 1).padStart(2, '0')}</text>
      </g>
    </g>
  </svg>;
}

export function SceneShell({ children, scene, index, count, theme }) {
  const { scale, portrait, palette, fontFamily } = useSceneStyle(theme);
  const frame = useSceneTimelineFrame();
  const progress = interpolate(frame, [0, scene.duration * 30], [0, 1], clamp);
  return <AbsoluteFill style={{ backgroundColor: palette.background, color: palette.ink, fontFamily, padding: `${portrait ? 62 * scale : 42 * scale}px ${portrait ? 52 * scale : 72 * scale}px`, overflow: 'hidden', fontWeight: 400 }}>
    <ArchiveAtmosphere palette={palette} portrait={portrait} />
    <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 34 * scale, flexShrink: 0, color: palette.muted }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 13 * scale, fontVariantNumeric: 'tabular-nums' }}><span style={{ fontSize: 29 * scale, color: palette.ink, fontWeight: 300 }}>{String(index + 1).padStart(2, '0')}</span><span style={{ fontSize: 16 * scale }}>/</span><span style={{ fontSize: 16 * scale }}>{String(count).padStart(2, '0')}</span></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 * scale }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 * scale }}>{Array.from({ length: 8 }, (_, tick) => <i key={tick} style={{ display: 'block', width: 1, height: (tick % 3 === 0 ? 12 : 6) * scale, backgroundColor: palette.line }} />)}</div>
        <svg width={27 * scale} height={27 * scale} viewBox="0 0 30 30"><circle cx="15" cy="15" r="11" fill="none" stroke={palette.line} /><path d="M15 4V15L23 21" fill="none" stroke={palette.muted} strokeWidth="1" /><circle cx="15" cy="15" r="11" fill="none" stroke={palette.brass} strokeWidth="1.7" strokeDasharray="69.12" strokeDashoffset={69.12 * (1 - progress)} transform="rotate(-90 15 15)" /></svg>
      </div>
    </div>
    <div style={{ position: 'relative', zIndex: 1, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, justifyContent: 'center', padding: `${18 * scale}px 0` }}>{children}</div>
    <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'flex-start', gap: 12 * scale, minHeight: 28 * scale, maxHeight: 70 * scale, fontSize: 14 * scale, lineHeight: 1.55, color: palette.muted, flexShrink: 0, overflowWrap: 'anywhere' }}><i style={{ width: 4 * scale, height: 4 * scale, marginTop: 8 * scale, backgroundColor: palette.brass, flexShrink: 0 }} /><span>{scene.note}</span></div>
  </AbsoluteFill>;
}

export function SceneHeading({ scene, palette, scale, width, portrait }) {
  const available = width - (portrait ? 104 : 144) * scale;
  return <div style={{ marginBottom: 30 * scale, flexShrink: 0 }}>
    <MaskReveal delay={3} color={palette.ink} style={{ fontSize: fittedSize(scene.title, (portrait ? 49 : 57) * scale, available, 2, 30 * scale), lineHeight: 1.23, letterSpacing: -1 * scale, fontWeight: 650, overflowWrap: 'anywhere' }}>{scene.title}</MaskReveal>
    {scene.subtitle && <Reveal delay={18} distance={10 * scale} style={{ marginTop: 16 * scale, fontSize: fittedSize(scene.subtitle, 23 * scale, available, 2, 18 * scale), lineHeight: 1.55, color: palette.muted }}>{scene.subtitle}</Reveal>}
  </div>;
}

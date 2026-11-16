import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export const smooth = Easing.bezier(0.16, 1, 0.3, 1);
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
export const themes = {
  paper: { background: '#e8e5e1', ink: '#151713', muted: '#5b604d', line: '#bfc0b4', soft: '#d8d8cd', accent: '#5b604d', opposite: '#eeeae3' },
  dark: { background: '#151713', ink: '#e8e5e1', muted: '#c0c4b1', line: '#454b3c', soft: '#303627', accent: '#b6c193', opposite: '#151713' },
};

export function useSceneStyle(theme) {
  const config = useVideoConfig();
  const scale = Math.min(config.width, config.height) / 720;
  return { ...config, scale, portrait: config.height > config.width, palette: themes[theme] || themes.paper };
}

export function fittedSize(text, preferred, availableWidth, maxLines = 3, minimum = 28) {
  const units = [...String(text)].reduce((total, char) => total + (/\p{Script=Han}|[\u3000-\u303f\uff00-\uffef]/u.test(char) ? 1 : 0.56), 0);
  return Math.max(minimum, Math.min(preferred, (availableWidth * maxLines) / Math.max(1, units)));
}

export function Reveal({ children, delay = 0, style = {}, distance = 28 }) {
  const frame = useCurrentFrame();
  return <div style={{
    ...style,
    opacity: interpolate(frame, [delay, delay + 20], [0, 1], { ...clamp, easing: smooth }),
    translate: `0 ${interpolate(frame, [delay, delay + 24], [distance, 0], { ...clamp, easing: smooth })}px`,
  }}>{children}</div>;
}

export function SceneShell({ children, scene, index, count, theme }) {
  const { width, height, scale, portrait, palette } = useSceneStyle(theme);
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{
    backgroundColor: palette.background, color: palette.ink,
    fontFamily: '"Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", sans-serif',
    padding: `${portrait ? 68 * scale : 46 * scale}px ${portrait ? 52 * scale : 72 * scale}px`,
    overflow: 'hidden', fontWeight: 400,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 26 * scale, flexShrink: 0, color: palette.muted, fontSize: 16 * scale, letterSpacing: 2 }}>
      <span>{String(index + 1).padStart(2, '0')} / {String(count).padStart(2, '0')}</span>
      <div style={{ width: 72 * scale, height: 2 * scale, backgroundColor: palette.line, overflow: 'hidden' }}>
        <div style={{ height: '100%', backgroundColor: palette.accent, width: `${interpolate(frame, [0, scene.duration * 30], [0, 100], clamp)}%` }} />
      </div>
    </div>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, justifyContent: 'center', padding: `${16 * scale}px 0` }}>{children}</div>
    <div style={{ minHeight: 28 * scale, maxHeight: 64 * scale, fontSize: 15 * scale, lineHeight: 1.5, color: palette.muted, flexShrink: 0, overflowWrap: 'anywhere' }}>{scene.note}</div>
  </AbsoluteFill>;
}

export function SceneHeading({ scene, palette, scale, width, portrait }) {
  return <Reveal delay={4} style={{ marginBottom: 30 * scale, flexShrink: 0 }}>
    <div style={{ fontSize: fittedSize(scene.title, (portrait ? 52 : 60) * scale, width - (portrait ? 104 : 144) * scale, 2, 32 * scale), lineHeight: 1.2, letterSpacing: -1 * scale, fontWeight: 700, overflowWrap: 'anywhere' }}>{scene.title}</div>
    {scene.subtitle && <div style={{ marginTop: 14 * scale, fontSize: 24 * scale, lineHeight: 1.5, color: palette.muted }}>{scene.subtitle}</div>}
  </Reveal>;
}

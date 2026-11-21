import React from 'react';
import { interpolate } from 'remotion';
import { MaskReveal, Reveal, SceneShell, clamp, fittedSize, useSceneEasing, useSceneFrame, useSceneStyle } from './shared.jsx';

export function QuoteScene(props) {
  const { scene } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  const frame = useSceneFrame(), motionEasing = useSceneEasing();
  const textWidth = width - (portrait ? 138 : 196) * scale;
  return <SceneShell {...props}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 22 * scale, marginBottom: 17 * scale }}><Reveal delay={1} distance={5 * scale} style={{ fontFamily: 'Georgia, serif', height: 64 * scale, fontSize: 108 * scale, lineHeight: 1, color: palette.brass }}>“</Reveal><span style={{ height: 1, width: 132 * scale, backgroundColor: palette.line, transformOrigin: 'left', scale: `${interpolate(frame, [6, 29], [0, 1], { ...clamp, easing: motionEasing })} 1` }} /></div>
    <div style={{ position: 'relative', paddingLeft: 24 * scale }}>
      <i style={{ position: 'absolute', left: 0, top: 4 * scale, bottom: 2 * scale, width: 1, backgroundColor: palette.line, transformOrigin: 'top', scale: `1 ${interpolate(frame, [5, 40], [0, 1], { ...clamp, easing: motionEasing })}` }} />
      <MaskReveal delay={8} duration={29} color={palette.ink} style={{ fontSize: fittedSize(scene.title, (portrait ? 57 : 68) * scale, textWidth, portrait ? 7 : 4, 30 * scale), lineHeight: 1.48, fontWeight: 500, letterSpacing: -0.7 * scale, overflowWrap: 'anywhere' }}>{scene.title}</MaskReveal>
    </div>
    {scene.subtitle && <Reveal delay={28} distance={11 * scale} style={{ marginTop: 33 * scale, color: palette.muted, paddingLeft: 26 * scale, fontSize: fittedSize(scene.subtitle, 24 * scale, textWidth, 3, 18 * scale), lineHeight: 1.65 }}>{scene.subtitle}</Reveal>}
  </SceneShell>;
}
